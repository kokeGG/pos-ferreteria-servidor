import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { huella, migrar, ordenarMigraciones } from "../src/migrar.js";
import { baseLimpia, CARPETA_MIGRACIONES } from "./ayudas.js";

describe("migraciones reales sobre una base vacía", () => {
  let base: Awaited<ReturnType<typeof baseLimpia>>;

  beforeAll(async () => {
    base = await baseLimpia("pos_test_migrar_reales");
  });
  afterAll(async () => base.cerrar());

  it("aplica todas, y una segunda corrida no aplica nada", async () => {
    const archivos = (await readdir(CARPETA_MIGRACIONES)).filter((f) => f.endsWith(".sql"));
    const primera = await migrar(base.pool, CARPETA_MIGRACIONES);
    expect(primera.aplicadas).toHaveLength(archivos.length);

    const segunda = await migrar(base.pool, CARPETA_MIGRACIONES);
    expect(segunda.aplicadas).toEqual([]);
    expect(segunda.yaAplicadas).toHaveLength(archivos.length);
  });

  it("deja el esquema del POS y las credenciales de terminales", async () => {
    const { rows } = await base.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tablas = rows.map((r) => r.table_name);
    for (const t of [
      "ventas",
      "venta_detalles",
      "venta_pagos",
      "productos",
      "clientes",
      "facturas_globales",
      "config_nube",
      "terminales",
      "sesiones",
    ]) {
      expect(tablas, `falta la tabla ${t}`).toContain(t);
    }
  });

  it("carga el catálogo y los clientes iniciales", async () => {
    const { rows } = await base.pool.query<{ p: string; c: string }>(
      "SELECT (SELECT count(*) FROM productos) AS p, (SELECT count(*) FROM clientes) AS c",
    );
    expect(Number(rows[0]!.p)).toBeGreaterThan(0);
    expect(Number(rows[0]!.c)).toBeGreaterThan(0);
  });

  it("las funciones que la caja invoca por rpc existen", async () => {
    const { rows } = await base.pool.query<{ proname: string }>(
      "SELECT proname FROM pg_proc WHERE proname IN ('aplicar_movimientos_inventario', 'inicializar_inventario_global')",
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([
      "aplicar_movimientos_inventario",
      "inicializar_inventario_global",
    ]);
  });
});

describe("reglas del aplicador (con migraciones de juguete)", () => {
  let base: Awaited<ReturnType<typeof baseLimpia>>;
  let carpeta: string;

  beforeAll(async () => {
    base = await baseLimpia("pos_test_migrar_reglas");
  });
  afterAll(async () => base.cerrar());

  async function carpetaNueva(archivos: Record<string, string>): Promise<string> {
    carpeta = await mkdtemp(path.join(os.tmpdir(), "mig-"));
    for (const [n, sql] of Object.entries(archivos)) await writeFile(path.join(carpeta, n), sql);
    return carpeta;
  }

  async function limpiar(): Promise<void> {
    await base.pool.query("DROP TABLE IF EXISTS _migraciones, a, b, c");
    await rm(carpeta, { recursive: true, force: true });
  }

  it("aplica en orden de nombre aunque los archivos se creen al revés", async () => {
    const dir = await carpetaNueva({
      "002_b.sql": "CREATE TABLE b (x int); INSERT INTO b SELECT count(*) FROM a;",
      "001_a.sql": "CREATE TABLE a (x int); INSERT INTO a VALUES (1);",
    });
    const r = await migrar(base.pool, dir);
    expect(r.aplicadas).toEqual(["001_a.sql", "002_b.sql"]);
    await limpiar();
  });

  it("rechaza una migración aplicada que cambió, y no aplica las nuevas", async () => {
    const dir = await carpetaNueva({ "001_a.sql": "CREATE TABLE a (x int);" });
    await migrar(base.pool, dir);

    await writeFile(path.join(dir, "001_a.sql"), "CREATE TABLE a (x int, y int);");
    await writeFile(path.join(dir, "002_b.sql"), "CREATE TABLE b (x int);");
    await expect(migrar(base.pool, dir)).rejects.toThrow(/001_a\.sql.*cambió/);

    const { rows } = await base.pool.query("SELECT to_regclass('public.b') AS b");
    expect(rows[0].b).toBeNull();
    await limpiar();
  });

  it("los saltos de línea CRLF no cuentan como cambio", async () => {
    const dir = await carpetaNueva({ "001_a.sql": "CREATE TABLE a (x int);\nSELECT 1;\n" });
    await migrar(base.pool, dir);
    await writeFile(path.join(dir, "001_a.sql"), "CREATE TABLE a (x int);\r\nSELECT 1;\r\n");
    const r = await migrar(base.pool, dir);
    expect(r.yaAplicadas).toEqual(["001_a.sql"]);
    expect(huella("a\r\nb")).toBe(huella("a\nb"));
    await limpiar();
  });

  it("ordena por nombre y descarta lo que no es .sql, sin depender del sistema de archivos", () => {
    expect(ordenarMigraciones(["20261101_c.sql", "notas.txt", "00_base.sql", "20260101_a.sql"])).toEqual([
      "00_base.sql",
      "20260101_a.sql",
      "20261101_c.sql",
    ]);
  });

  it("el cambio de esquema y su registro entran juntos: si el registro falla, el cambio se deshace", async () => {
    await base.pool.query("CREATE TABLE _migraciones (nombre TEXT PRIMARY KEY, huella TEXT NOT NULL, aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now())");
    await base.pool.query("ALTER TABLE _migraciones ADD CONSTRAINT no_esa CHECK (nombre <> '001_a.sql')");
    const dir = await carpetaNueva({ "001_a.sql": "CREATE TABLE a (x int);" });

    await expect(migrar(base.pool, dir)).rejects.toThrow(/001_a\.sql/);

    const { rows } = await base.pool.query("SELECT to_regclass('public.a') AS a");
    expect(rows[0].a).toBeNull();
    await limpiar();
  });

  it("una migración que falla se deshace completa y no queda registrada", async () => {
    const dir = await carpetaNueva({
      "001_a.sql": "CREATE TABLE a (x int);",
      "002_mala.sql": "CREATE TABLE b (x int); SELECT esto_no_existe();",
    });
    await expect(migrar(base.pool, dir)).rejects.toThrow(/002_mala\.sql/);

    const { rows } = await base.pool.query("SELECT to_regclass('public.b') AS b");
    expect(rows[0].b).toBeNull();
    const reg = await base.pool.query("SELECT nombre FROM _migraciones ORDER BY nombre");
    expect(reg.rows.map((r) => r.nombre)).toEqual(["001_a.sql"]);
    await limpiar();
  });
});
