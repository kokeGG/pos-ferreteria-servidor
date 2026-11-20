/**
 * Prueba de humo contra la base REAL (`DATABASE_URL`) con las credenciales de
 * `TERMINAL_EMAIL` / `TERMINAL_PASSWORD` del `.env`. Levanta el servidor en un
 * puerto libre, recorre login -> yo -> refresh -> logout por HTTP de verdad y
 * se apaga solo. No imprime tokens ni contraseñas.
 *
 *   npm run humo
 */

import type { AddressInfo } from "node:net";
import pg from "pg";
import { construirApp } from "./app.js";
import { leerConfig } from "./config.js";

const config = leerConfig();
const email = process.env.TERMINAL_EMAIL ?? "";
const password = process.env.TERMINAL_PASSWORD ?? "";
if (!email || !password) {
  console.error("Faltan TERMINAL_EMAIL / TERMINAL_PASSWORD en .env (crea la terminal con npm run terminal:crear).");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = construirApp({ pool, jwtSecret: config.jwtSecret });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

let fallos = 0;
function verificar(nombre: string, ok: boolean): void {
  console.log(`${ok ? "OK   " : "FALLA"} ${nombre}`);
  if (!ok) fallos++;
}
const post = (ruta: string, cuerpo: unknown) =>
  fetch(base + ruta, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) });

try {
  verificar("GET /salud", (await fetch(`${base}/salud`)).status === 200);

  const mala = await post("/auth/login", { email, password: password + "x" });
  verificar("login con contraseña mala -> 401", mala.status === 401);

  const l = await post("/auth/login", { email, password });
  const sesion = (await l.json()) as { access_token: string; refresh_token: string };
  verificar("login correcto -> 200 con tokens", l.status === 200 && !!sesion.access_token && !!sesion.refresh_token);

  const yo = await fetch(`${base}/auth/yo`, { headers: { authorization: `Bearer ${sesion.access_token}` } });
  verificar("GET /auth/yo con token -> 200", yo.status === 200 && ((await yo.json()) as { email: string }).email === email);
  verificar("GET /auth/yo sin token -> 401", (await fetch(`${base}/auth/yo`)).status === 401);

  // Sincronización (solo lectura: no ensucia la base de la demo).
  const conToken = (ruta: string, cuerpo?: unknown) =>
    fetch(base + ruta, {
      method: cuerpo === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${sesion.access_token}` },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  const { rows: total } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM productos");
  const esperados = Number(total[0]!.n);
  const vistos = new Set<string>();
  let despues: object | undefined;
  for (;;) {
    const p = await conToken("/sync/productos/consultar", {
      despues: despues ?? { col: "actualizado_en", valor: "1970-01-01T00:00:00.000Z" },
      limite: 500,
    });
    const { filas } = (await p.json()) as { filas: { id: string; actualizado_en: string }[] };
    if (p.status !== 200 || filas.length === 0) break;
    for (const f of filas) vistos.add(f.id);
    const u = filas[filas.length - 1]!;
    despues = { col: "actualizado_en", valor: u.actualizado_en, llave_valor: u.id };
    if (filas.length < 500) break;
  }
  verificar(`catálogo paginado completo (${vistos.size} de ${esperados} productos, sin repetir)`, vistos.size === esperados);
  verificar("tabla fuera de la lista -> 404", (await conToken("/sync/terminales/consultar", {})).status === 404);
  verificar("GET /config/correo_publico_general -> 200", (await conToken("/config/correo_publico_general")).status === 200);
  verificar("sync sin token -> 401", (await post("/sync/productos/consultar", {})).status === 401);

  // Almacenamiento (sin escribir nada en la carpeta real).
  const inexistente = `2026/09/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.xml`;
  verificar("/storage sin token -> 401", (await fetch(`${base}/storage/cfdi-xml/${inexistente}`)).status === 401);
  verificar("archivo inexistente -> 404", (await conToken(`/storage/cfdi-xml/${inexistente}`)).status === 404);
  verificar("firmar un archivo inexistente -> 404", (await conToken("/storage/cfdi-xml/firmar", { ruta: inexistente })).status === 404);
  verificar("traversal en /actualizaciones no sirve el .env", (await fetch(`${base}/actualizaciones/..%2f..%2f.env`)).status !== 200);
  verificar("/actualizaciones no acepta escrituras", (await fetch(`${base}/actualizaciones/latest.json`, { method: "PUT", body: "{}" })).status === 404);

  const r = await post("/auth/refresh", { refresh_token: sesion.refresh_token });
  const nueva = (await r.json()) as { refresh_token: string };
  verificar("refresh -> 200 con token nuevo", r.status === 200 && nueva.refresh_token !== sesion.refresh_token);
  verificar("el refresh viejo ya no sirve", (await post("/auth/refresh", { refresh_token: sesion.refresh_token })).status === 401);

  verificar("logout -> 204", (await post("/auth/logout", { refresh_token: nueva.refresh_token })).status === 204);
  verificar("tras logout el refresh no sirve", (await post("/auth/refresh", { refresh_token: nueva.refresh_token })).status === 401);
} finally {
  await app.close();
  await pool.end();
}

console.log(fallos === 0 ? "\nTodo bien." : `\n${fallos} verificación(es) fallaron.`);
process.exitCode = fallos === 0 ? 0 : 1;
