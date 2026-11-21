/**
 * Crea la base de datos que dice `DATABASE_URL`, si todavía no existe, dentro
 * del mismo Postgres que ya corre en Docker. Cada negocio/versión usa su propia
 * base en ese mismo servidor; no hace falta otro contenedor.
 *
 *   npm run db:crear
 *   npm run migrar
 */

import pg from "pg";
import { leerConfig } from "./config.js";

const { databaseUrl } = leerConfig();
const url = new URL(databaseUrl);
const nombre = decodeURIComponent(url.pathname.replace(/^\//, ""));
// El nombre va en un CREATE DATABASE (no admite parámetros): se restringe a lo seguro.
if (!/^[a-z][a-z0-9_]{0,62}$/.test(nombre)) {
  console.error(`Nombre de base no permitido: "${nombre}" (minúsculas, números y guion bajo).`);
  process.exit(1);
}

url.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: url.toString(), max: 1 });
try {
  const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [nombre]);
  if (rows.length > 0) {
    console.log(`La base "${nombre}" ya existe: no se toca.`);
  } else {
    await admin.query(`CREATE DATABASE ${nombre}`);
    console.log(`Base "${nombre}" creada. Siguiente: npm run migrar`);
  }
} finally {
  await admin.end();
}
