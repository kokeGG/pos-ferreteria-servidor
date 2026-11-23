/**
 * Sube el esquema, el catálogo de productos nuevo y los clientes al proyecto de
 * Supabase de la DEMO, y comprueba que la llave pública no vea nada.
 *
 *   npm run supabase:aplicar
 *
 * Necesita en el .env (NO en el chat):
 *   SUPABASE_DB_URL   cadena de conexión de Postgres del proyecto
 *                     (Supabase → Connect → "Session pooler"; lleva la contraseña
 *                     de la base). No sirve la "Transaction pooler" (puerto 6543).
 *
 * Qué arma, en orden de nombre:
 *   1. las migraciones de Supabase del POS (supabase/migrations del repo del POS),
 *      SIN las dos que cargan los productos de Ferretería La Base;
 *   2. el catálogo de productos nuevo (migraciones/20261121000001_catalogo_dh.sql);
 *   3. el endurecimiento de acceso (supabase-demo/*.sql): cierra lo que la llave
 *      pública podía ver o ejecutar (ver ese archivo).
 *
 * Es re-ejecutable: el aplicador guarda la huella de cada migración y solo
 * aplica las nuevas. Solo AGREGA; no borra nada.
 *
 * Variables opcionales:
 *   POS_DIR                   ruta del repo del POS
 *   SUPABASE_PERMITIR_OTRO=1  deja correr contra una base que no es de Supabase
 *                             (solo para el ensayo local)
 */

import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrar } from "./migrar.js";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const POS_DIR = realpathSync.native(process.env.POS_DIR ?? path.resolve(RAIZ, "..", "OneDrive", "Documentos", "pos-ferreteria"));

/** Productos de La Base: la demo usa su propio catálogo. */
const EXCLUIDAS = new Set(["20260923025747_seed_catalogo.sql", "20261028190951_actualizar_catalogo.sql"]);

const cadena = process.env.SUPABASE_DB_URL ?? "";
if (!cadena) {
  console.error("Falta SUPABASE_DB_URL en .env (Supabase → Connect → Session pooler). No la pegues en el chat.");
  process.exit(1);
}

/**
 * La cadena se separa a mano en usuario, contraseña, host, puerto y base, y se
 * entrega al cliente por partes. Así la contraseña llega tal cual está escrita
 * (con un signo de pesos, una admiración, etc.) y no depende de cómo cada
 * librería interprete la URL; solo se decodifica si trae secuencias %XX
 * (contraseña escapada).
 */
function partesDe(c: string) {
  const m = c.match(/^postgres(?:ql)?:\/\/([^:]+):(.*)@([^@/]+)\/([^?]*)/);
  if (!m) throw new Error("SUPABASE_DB_URL no tiene la forma postgresql://usuario:contraseña@host:puerto/base");
  const [, usuario, crudo, anfitrion, base] = m as unknown as [string, string, string, string, string];
  const [host, puerto] = anfitrion.split(":");
  return {
    user: decodeURIComponent(usuario),
    password: /%[0-9A-Fa-f]{2}/.test(crudo) ? decodeURIComponent(crudo) : crudo,
    host: host!,
    port: Number(puerto ?? 5432),
    database: base || "postgres",
  };
}

const destino = partesDe(cadena);
const esSupabase = /(^|\.)supabase\.(co|com)$/.test(destino.host);
if (!esSupabase && process.env.SUPABASE_PERMITIR_OTRO !== "1") {
  console.error(`El destino (${destino.host}) no parece de Supabase. Si es a propósito: SUPABASE_PERMITIR_OTRO=1.`);
  process.exit(1);
}
if (esSupabase && destino.port === 6543) {
  console.error("Esa es la 'Transaction pooler' (6543): no sirve para migraciones. Usa la 'Session pooler' (5432).");
  process.exit(1);
}

// No hay forma de saber desde aquí si la base es la de la demo o la de producción:
// se exige que sea del MISMO proyecto que SUPABASE_URL y se muestra a dónde va.
const esperado = (process.env.SUPABASE_URL ?? "").match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (esSupabase && esperado && !destino.user.includes(esperado) && !destino.host.includes(esperado)) {
  console.error(`La cadena de conexión NO es del mismo proyecto que SUPABASE_URL (${esperado}). No se aplica nada.`);
  process.exit(1);
}
console.log(`Destino: ${destino.host}:${destino.port}/${destino.database}  (usuario ${destino.user})`);

// --- armar el juego de migraciones
const temporal = await mkdtemp(path.join(tmpdir(), "supabase-demo-"));
const pool = new pg.Pool({ ...destino, max: 1, ssl: esSupabase ? { rejectUnauthorized: false } : undefined });
let codigo = 0;
try {
  const origen = path.join(POS_DIR, "supabase", "migrations");
  const heredadas = (await readdir(origen)).filter((f) => f.endsWith(".sql") && !EXCLUIDAS.has(f));
  for (const f of heredadas) await copyFile(path.join(origen, f), path.join(temporal, f));
  await copyFile(path.join(RAIZ, "migraciones", "20261121000001_catalogo_dh.sql"), path.join(temporal, "20261121000001_catalogo_dh.sql"));
  const propias = (await readdir(path.join(RAIZ, "supabase-demo"))).filter((f) => f.endsWith(".sql"));
  for (const f of propias) await copyFile(path.join(RAIZ, "supabase-demo", f), path.join(temporal, f));
  console.log(`Migraciones armadas: ${heredadas.length} del POS (sin ${EXCLUIDAS.size} de productos de La Base) + catálogo DH + ${propias.length} de endurecimiento.`);

  const r = await migrar(pool, temporal);
  console.log(`Aplicadas ahora: ${r.aplicadas.length}; ya estaban: ${r.yaAplicadas.length}`);
  for (const a of r.aplicadas) console.log(`  + ${a}`);

  // --- verificación: lo que ve el rol `anon` (la llave pública)
  const q = async (sql: string) => (await pool.query(sql)).rows;
  const problemas: string[] = [];

  const sinRls = await q(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
  );
  if (sinRls.length) problemas.push(`tablas SIN seguridad por fila: ${sinRls.map((t) => t.relname).join(", ")}`);

  const tablasAbiertas = await q(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND has_table_privilege('anon', c.oid, 'SELECT')`,
  );
  if (tablasAbiertas.length) problemas.push(`la llave pública puede leer: ${tablasAbiertas.map((t) => t.relname).join(", ")}`);

  const funcionesAbiertas = await q(
    `SELECT p.oid::regprocedure::text AS firma FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        AND has_function_privilege('anon', p.oid, 'EXECUTE')`,
  );
  if (funcionesAbiertas.length) problemas.push(`la llave pública puede ejecutar: ${funcionesAbiertas.map((f) => f.firma).join(", ")}`);

  const vistasInseguras = await q(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'v'
        AND NOT COALESCE((SELECT 'security_invoker=true' = ANY(c.reloptions)), false)`,
  );
  if (vistasInseguras.length) problemas.push(`vistas que se saltan la seguridad por fila: ${vistasInseguras.map((v) => v.relname).join(", ")}`);

  // Lo contrario también importa: la terminal de la app (authenticated) tiene que PODER usar las
  // tablas y la función de timbrado (service_role) también; si no, todo daría "permission denied".
  for (const rol of ["authenticated", "service_role"]) {
    const sinPermiso = await q(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND c.relname <> '_migraciones'
          AND NOT has_table_privilege('${rol}', c.oid, 'SELECT')`,
    );
    if (sinPermiso.length) problemas.push(`el rol ${rol} NO puede leer: ${sinPermiso.map((t) => t.relname).join(", ")}`);
  }
  const cuenta = (await q("SELECT (SELECT count(*) FROM productos)::int AS p, (SELECT count(*) FROM clientes)::int AS c")) as { p: number; c: number }[];
  console.log(`Datos: ${cuenta[0]!.p} productos, ${cuenta[0]!.c} clientes.`);
  const buckets = await q("SELECT id FROM storage.buckets ORDER BY id").catch(() => []);
  console.log(`Buckets de archivos: ${buckets.map((b) => b.id).join(", ") || "(ninguno)"}`);

  if (problemas.length) {
    console.error("\nVERIFICACIÓN DE SEGURIDAD FALLÓ:");
    for (const p of problemas) console.error("  - " + p);
    codigo = 1;
  } else {
    console.log("Verificación de seguridad: la llave pública (anon) no ve ni ejecuta nada. Todo bien.");
  }
} catch (e) {
  console.error("\nSe detuvo:", e instanceof Error ? e.message : e);
  codigo = 1;
} finally {
  await pool.end();
  await rm(temporal, { recursive: true, force: true });
}
process.exitCode = codigo;
