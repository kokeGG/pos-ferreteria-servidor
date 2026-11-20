/**
 * Recorrido de PUNTA A PUNTA con el POS real (rama `demo/pruebas`).
 *
 * Levanta un servidor DESECHABLE (base `pos_humo_pos` con todas las
 * migraciones y el catálogo, y una carpeta temporal de archivos) en el puerto
 * 3000, que es al que apunta el `.env` del POS, y corre contra él la prueba
 * de integración del POS (`src/lib/nube-servidor.test.ts`): las cajas del POS
 * (SQLite real) sincronizan, venden, facturan y cancelan con el mismo código
 * que usa la app. Al terminar apaga el servidor y borra la base y los archivos.
 *
 *   npm run humo:pos
 *
 * Variables opcionales:
 *   POS_DIR=<ruta del repo del POS>   por omisión ../OneDrive/Documentos/pos-ferreteria
 *   HUMO_SIN_FACTURAR=1               no toca el sandbox de Factura.com
 *   HUMO_CONSERVAR=1                  no borra la base ni los archivos
 *   HUMO_PUERTO=3101                  otro puerto (si el 3000 ya está en uso)
 *
 * Necesita TERMINAL_EMAIL / TERMINAL_PASSWORD en el .env (los mismos que el
 * POS lleva en VITE_TERMINAL_*). No imprime llaves ni contraseñas.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { construirApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { leerConfig } from "./config.js";
import { migrar } from "./migrar.js";

// Por omisión 3000, el que trae el `.env` del POS. Con HUMO_PUERTO se usa otro
// (y se le dice al POS con VITE_API_URL) para correr mientras un `npm run dev`
// real sigue en el 3000, sin tocar su base.
const PUERTO = Number(process.env.HUMO_PUERTO ?? 3000);
const NOMBRE_BASE = "pos_humo_pos";
const CARPETA_MIGRACIONES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migraciones");
const POS_DIR = process.env.POS_DIR ?? path.resolve("..", "OneDrive", "Documentos", "pos-ferreteria");

const config = leerConfig();
const email = process.env.TERMINAL_EMAIL ?? "";
const password = process.env.TERMINAL_PASSWORD ?? "";
if (!email || !password) {
  console.error("Faltan TERMINAL_EMAIL / TERMINAL_PASSWORD en .env.");
  process.exit(1);
}

/** Si ya hay algo escuchando en el puerto (un `npm run dev` real), NO se pisa. */
const puertoOcupado = await new Promise<boolean>((resolve) => {
  const s = net.connect(PUERTO, "127.0.0.1");
  s.once("connect", () => (s.destroy(), resolve(true)));
  s.once("error", () => resolve(false));
});
if (puertoOcupado) {
  console.error(`Ya hay un servidor en el puerto ${PUERTO}. Apágalo antes: este recorrido necesita ese puerto para su servidor desechable.`);
  process.exit(1);
}

const urlDe = (base: string) => {
  const u = new URL(config.databaseUrl);
  u.pathname = `/${base}`;
  return u.toString();
};

const admin = new pg.Pool({ connectionString: urlDe("postgres"), max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_BASE} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${NOMBRE_BASE}`);
const pool = new pg.Pool({ connectionString: urlDe(NOMBRE_BASE) });
const almacenDir = await mkdtemp(path.join(tmpdir(), "humo-pos-"));
let codigo = 1;

try {
  console.log("Preparando base temporal (migraciones y catálogo)…");
  await migrar(pool, CARPETA_MIGRACIONES);
  await pool.query("INSERT INTO terminales (email, password_hash) VALUES ($1, $2)", [email, await hashPassword(password)]);

  const app = construirApp({ pool, jwtSecret: config.jwtSecret, almacenDir, entorno: process.env });
  await app.listen({ port: PUERTO, host: "127.0.0.1" });
  console.log(`Servidor desechable en http://127.0.0.1:${PUERTO}`);

  try {
    const facturar = process.env.HUMO_SIN_FACTURAR !== "1" && process.env.PAC_PROVEEDOR === "facturacom";
    console.log(`POS: ${POS_DIR}${facturar ? " (con facturación en el sandbox)" : " (sin facturar)"}\n`);
    codigo = await new Promise<number>((resolve) => {
      const hijo = spawn("npx", ["vitest", "run", "--reporter=verbose", "src/lib/nube-servidor.test.ts"], {
        cwd: POS_DIR,
        stdio: "inherit",
        shell: true,
        env: {
          ...process.env,
          POS_SERVIDOR: "1",
          VITE_API_URL: `http://127.0.0.1:${PUERTO}`,
          ...(facturar ? { POS_FACTURAR: "1", POS_CORREO: process.env.GMAIL_USER ?? "" } : {}),
        },
      });
      hijo.on("exit", (c) => resolve(c ?? 1));
      hijo.on("error", (e) => (console.error(e.message), resolve(1)));
    });
  } finally {
    await app.close();
  }
} catch (e) {
  console.error("\nEl recorrido se detuvo:", e instanceof Error ? e.message : e);
} finally {
  await pool.end();
  if (process.env.HUMO_CONSERVAR === "1") {
    console.log(`\nConservado: base ${NOMBRE_BASE} y archivos en ${almacenDir}`);
  } else {
    await admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_BASE} WITH (FORCE)`).catch(() => undefined);
    await rm(almacenDir, { recursive: true, force: true });
  }
  await admin.end();
}

console.log(codigo === 0 ? "\nPOS y servidor de punta a punta: todo bien." : "\nFalló el recorrido de punta a punta.");
process.exitCode = codigo;
