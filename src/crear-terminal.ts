/**
 * Da de alta (o cambia la contraseña de) una terminal.
 *
 *   TERMINAL_EMAIL=caja-a@ferreteria.local TERMINAL_PASSWORD=… npm run terminal:crear
 *
 * La contraseña se pasa por variable de entorno, no como argumento, para que no
 * quede en el historial de la terminal ni en la lista de procesos.
 */

import pg from "pg";
import { hashPassword } from "./auth.js";

const email = process.env.TERMINAL_EMAIL ?? "";
const password = process.env.TERMINAL_PASSWORD ?? "";
const url = process.env.DATABASE_URL ?? "";

if (!email || !password || !url) {
  console.error("Faltan TERMINAL_EMAIL, TERMINAL_PASSWORD o DATABASE_URL.");
  process.exit(1);
}
if (password.length < 12) {
  console.error("La contraseña debe tener al menos 12 caracteres.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
try {
  const { rows } = await pool.query<{ creada: boolean }>(
    `INSERT INTO terminales (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (lower(email)) DO UPDATE SET password_hash = excluded.password_hash, activa = TRUE
     RETURNING (xmax = 0) AS creada`,
    [email, await hashPassword(password)],
  );
  console.log(rows[0]?.creada ? `Terminal creada: ${email}` : `Contraseña actualizada: ${email}`);
} finally {
  await pool.end();
}
