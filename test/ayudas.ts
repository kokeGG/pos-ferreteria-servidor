import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const CARPETA_MIGRACIONES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migraciones");

function urlDe(base: string): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Falta TEST_DATABASE_URL (ver .env.example) y que Postgres esté arriba: npm run db:up");
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

/** Crea una base vacía con ese nombre (borrando la anterior) y devuelve su pool. */
export async function baseLimpia(nombre: string): Promise<{ pool: pg.Pool; cerrar: () => Promise<void> }> {
  const admin = new pg.Pool({ connectionString: urlDe("postgres"), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${nombre}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: urlDe(nombre) });
  return {
    pool,
    cerrar: async () => {
      await pool.end();
      const a = new pg.Pool({ connectionString: urlDe("postgres"), max: 1 });
      try {
        await a.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
