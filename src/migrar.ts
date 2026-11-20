/**
 * Aplicador de migraciones SQL.
 *
 * Mismas reglas que la app de caja (db/README.md del POS):
 *  - Se aplican en orden de nombre de archivo.
 *  - Cada una corre en su propia transacción: o entra completa o no entra.
 *  - Se guarda la huella (SHA-256) de lo aplicado. Una migración ya aplicada
 *    NO se edita: si su texto cambió, se rechaza todo con un error claro en
 *    lugar de seguir con un esquema que ya no es el que dice el archivo.
 *  - Los saltos de línea no cuentan (CRLF/LF dan la misma huella), porque
 *    git con `autocrlf` cambia los finales de línea según el checkout.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export interface ResultadoMigrar {
  aplicadas: string[];
  yaAplicadas: string[];
}

export function huella(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Solo los .sql, por nombre. El orden lo da el nombre, no el sistema de
 * archivos: `readdir` en Linux no garantiza ninguno.
 */
export function ordenarMigraciones(nombres: string[]): string[] {
  return nombres.filter((f) => f.endsWith(".sql")).sort();
}

export async function migrar(pool: Pool, carpeta: string): Promise<ResultadoMigrar> {
  const archivos = ordenarMigraciones(await readdir(carpeta));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migraciones (
      nombre     TEXT PRIMARY KEY,
      huella     TEXT NOT NULL,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const previas = new Map<string, string>(
    (await pool.query<{ nombre: string; huella: string }>("SELECT nombre, huella FROM _migraciones")).rows.map(
      (r) => [r.nombre, r.huella],
    ),
  );

  // Revisar TODAS antes de aplicar nada: una migración alterada debe frenar
  // incluso a las nuevas que vengan después.
  const sqls = new Map<string, string>();
  for (const nombre of archivos) {
    const sql = await readFile(path.join(carpeta, nombre), "utf8");
    sqls.set(nombre, sql);
    const guardada = previas.get(nombre);
    if (guardada !== undefined && guardada !== huella(sql)) {
      throw new Error(
        `La migración ${nombre} ya se aplicó y su contenido cambió. ` +
          `No se edita una migración aplicada: crea una nueva con el cambio.`,
      );
    }
  }

  const resultado: ResultadoMigrar = { aplicadas: [], yaAplicadas: [] };
  for (const nombre of archivos) {
    if (previas.has(nombre)) {
      resultado.yaAplicadas.push(nombre);
      continue;
    }
    const sql = sqls.get(nombre)!;
    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query(sql);
      await cliente.query("INSERT INTO _migraciones (nombre, huella) VALUES ($1, $2)", [nombre, huella(sql)]);
      await cliente.query("COMMIT");
    } catch (e) {
      await cliente.query("ROLLBACK");
      throw new Error(`Falló la migración ${nombre}: ${(e as Error).message}`);
    } finally {
      cliente.release();
    }
    resultado.aplicadas.push(nombre);
  }
  return resultado;
}
