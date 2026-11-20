import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrar } from "./migrar.js";

const carpeta = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migraciones");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL en .env");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });

try {
  const r = await migrar(pool, carpeta);
  console.log(`Migraciones aplicadas: ${r.aplicadas.length}, ya estaban: ${r.yaAplicadas.length}`);
  for (const n of r.aplicadas) console.log(`  + ${n}`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
