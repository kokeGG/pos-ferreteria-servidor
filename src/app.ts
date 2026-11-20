/**
 * Servidor HTTP del POS (reemplaza a Supabase para la rama demo).
 *
 * Fase 2: salud y autenticación de terminales. Fase 3: API de sincronización
 * (`sync.ts`). Fase 4: almacenamiento (`almacen*.ts`). Fase 5: `POST /timbrar`
 * (`timbrar/`).
 */

import jwt from "@fastify/jwt";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { HASH_DE_RELLENO, hashToken, nuevoRefreshToken, verificarPassword } from "./auth.js";
import { Almacen } from "./almacen.js";
import { registrarAlmacen } from "./almacen-rutas.js";
import { registrarSincronizacion } from "./sync.js";
import type { Entorno } from "./timbrar/entorno.js";
import { registrarTimbrar, type OpcionesTimbrar } from "./timbrar/rutas.js";

/** Vida del access token. La caja lo renueva sola con el refresh token. */
export const ACCESS_SEGUNDOS = 60 * 60;
/** Una caja que no se conecta en 90 días vuelve a iniciar sesión sola. */
export const REFRESH_DIAS = 90;

interface Terminal {
  id: string;
  email: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; email: string };
    user: { sub: string; email: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler: exige un access token válido de una terminal activa. */
    autenticar: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Archivos en disco (CFDI y actualizador); `timbrar` escribe aquí directo. */
    almacen: Almacen;
  }
}

const MENSAJE_CREDENCIALES = "Correo o contraseña incorrectos";

export function construirApp(opts: {
  pool: Pool;
  jwtSecret: string;
  almacenDir?: string;
  logger?: boolean;
  /** Variables de `timbrar` (PAC, emisor, correo). Por omisión, ninguna: `/timbrar` responde 501. */
  entorno?: Entorno;
  /** Solo pruebas: PAC y transporte de correo sustitutos. */
  timbrar?: Omit<OpcionesTimbrar, "entorno">;
}) {
  const { pool } = opts;
  // Por defecto Fastify borra en silencio los campos que el esquema no
  // declara; preferimos rechazarlos: un campo de más es un error del cliente.
  const app = Fastify({
    logger: opts.logger ?? false,
    ajv: { customOptions: { removeAdditional: false, allowUnionTypes: true } },
    // `inicializar_inventario_global` sube la existencia de todo el catálogo.
    bodyLimit: 10 * 1024 * 1024,
  });

  // El webview del POS (Tauri) es otro origen: el navegador manda un preflight
  // OPTIONS antes de cada POST con Authorization. Sin esto la petición real
  // nunca sale (se ve como "Failed to fetch", sin rastro en el servidor). La
  // autenticación es por cabecera Authorization, no por cookies, así que
  // `*` no abre nada que el token no proteja.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("access-control-allow-origin", "*");
    if (req.method === "OPTIONS") {
      return reply
        .header("access-control-allow-headers", "authorization, apikey, content-type, x-client-info")
        .header("access-control-allow-methods", "GET, POST, PUT, OPTIONS")
        .header("access-control-max-age", "86400")
        .code(204)
        .send();
    }
  });

  app.register(jwt, { secret: opts.jwtSecret, sign: { expiresIn: ACCESS_SEGUNDOS } });

  app.decorate("autenticar", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Sesión inválida o vencida" });
    }
    // Desactivar una terminal debe cortarla ya, no cuando venza su token.
    const { rows } = await pool.query("SELECT 1 FROM terminales WHERE id = $1 AND activa", [req.user.sub]);
    if (rows.length === 0) return reply.code(401).send({ error: "Terminal desactivada" });
  });

  async function emitirSesion(terminal: Terminal) {
    const access_token = app.jwt.sign({ sub: terminal.id, email: terminal.email });
    const { token, hash } = nuevoRefreshToken();
    await pool.query(
      `INSERT INTO sesiones (terminal_id, token_hash, expira_en)
       VALUES ($1, $2, now() + make_interval(days => $3))`,
      [terminal.id, hash, REFRESH_DIAS],
    );
    return {
      access_token,
      refresh_token: token,
      expires_in: ACCESS_SEGUNDOS,
      user: { id: terminal.id, email: terminal.email },
    };
  }

  app.get("/salud", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false, error: "Sin conexión a la base" });
    }
  });

  const cuerpoLogin = {
    type: "object",
    required: ["email", "password"],
    additionalProperties: false,
    properties: {
      email: { type: "string", minLength: 1, maxLength: 320 },
      password: { type: "string", minLength: 1, maxLength: 1024 },
    },
  } as const;

  app.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    { schema: { body: cuerpoLogin } },
    async (req, reply) => {
      const { rows } = await pool.query<Terminal & { password_hash: string; activa: boolean }>(
        "SELECT id, email, password_hash, activa FROM terminales WHERE lower(email) = lower($1)",
        [req.body.email],
      );
      const t = rows[0];
      // Siempre se corre scrypt, exista o no la terminal (ver HASH_DE_RELLENO).
      const ok = await verificarPassword(req.body.password, t?.password_hash ?? HASH_DE_RELLENO);
      if (!t || !ok || !t.activa) return reply.code(401).send({ error: MENSAJE_CREDENCIALES });
      return emitirSesion(t);
    },
  );

  const cuerpoRefresh = {
    type: "object",
    required: ["refresh_token"],
    additionalProperties: false,
    properties: { refresh_token: { type: "string", minLength: 1, maxLength: 512 } },
  } as const;

  app.post<{ Body: { refresh_token: string } }>(
    "/auth/refresh",
    { schema: { body: cuerpoRefresh } },
    async (req, reply) => {
      // Rotación: el token usado se revoca en el mismo UPDATE que lo valida,
      // así dos peticiones con el mismo token no pueden ganar las dos.
      const { rows } = await pool.query<{ terminal_id: string }>(
        `UPDATE sesiones SET revocada_en = now()
          WHERE token_hash = $1 AND revocada_en IS NULL AND expira_en > now()
          RETURNING terminal_id`,
        [hashToken(req.body.refresh_token)],
      );
      const sesion = rows[0];
      if (!sesion) return reply.code(401).send({ error: "Sesión inválida o vencida" });

      const { rows: ts } = await pool.query<Terminal>(
        "SELECT id, email FROM terminales WHERE id = $1 AND activa",
        [sesion.terminal_id],
      );
      const t = ts[0];
      if (!t) return reply.code(401).send({ error: "Terminal desactivada" });
      return emitirSesion(t);
    },
  );

  app.post<{ Body: { refresh_token: string } }>(
    "/auth/logout",
    { schema: { body: cuerpoRefresh } },
    async (req, reply) => {
      await pool.query("UPDATE sesiones SET revocada_en = now() WHERE token_hash = $1 AND revocada_en IS NULL", [
        hashToken(req.body.refresh_token),
      ]);
      return reply.code(204).send();
    },
  );

  app.get("/auth/yo", { preHandler: app.autenticar }, async (req) => ({
    id: req.user.sub,
    email: req.user.email,
  }));

  registrarSincronizacion(app, pool);
  const almacen = new Almacen(opts.almacenDir ?? "almacen");
  registrarAlmacen(app, almacen, opts.jwtSecret);
  app.decorate("almacen", almacen);
  registrarTimbrar(app, pool, almacen, { entorno: opts.entorno ?? {}, ...opts.timbrar });

  return app;
}
