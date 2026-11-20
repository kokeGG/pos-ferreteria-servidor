import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { construirApp } from "../src/app.js";
import { hashPassword, verificarPassword } from "../src/auth.js";
import { migrar } from "../src/migrar.js";
import { baseLimpia, CARPETA_MIGRACIONES } from "./ayudas.js";

const EMAIL = "caja-a@ferreteria.local";
const PASSWORD = "contraseña-de-prueba-1";
const SECRETO = "s".repeat(40);

let base: Awaited<ReturnType<typeof baseLimpia>>;
let app: ReturnType<typeof construirApp>;
let terminalId: string;

beforeAll(async () => {
  base = await baseLimpia("pos_test_auth");
  await migrar(base.pool, CARPETA_MIGRACIONES);
  app = construirApp({ pool: base.pool, jwtSecret: SECRETO });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await base.cerrar();
});

beforeEach(async () => {
  await base.pool.query("DELETE FROM terminales");
  const { rows } = await base.pool.query<{ id: string }>(
    "INSERT INTO terminales (email, password_hash) VALUES ($1, $2) RETURNING id",
    [EMAIL, await hashPassword(PASSWORD)],
  );
  terminalId = rows[0]!.id;
});

const login = (email = EMAIL, password = PASSWORD) =>
  app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
const refrescar = (refresh_token: string) =>
  app.inject({ method: "POST", url: "/auth/refresh", payload: { refresh_token } });
const yo = (token?: string) =>
  app.inject({ method: "GET", url: "/auth/yo", headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("contraseñas", () => {
  it("se guardan con scrypt y sal: nunca en claro, y dos hashes de la misma contraseña difieren", async () => {
    const { rows } = await base.pool.query("SELECT password_hash FROM terminales WHERE id = $1", [terminalId]);
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("verifican la correcta y rechazan la incorrecta o un hash mal formado", async () => {
    const h = await hashPassword("abc");
    expect(await verificarPassword("abc", h)).toBe(true);
    expect(await verificarPassword("abd", h)).toBe(false);
    expect(await verificarPassword("abc", "basura")).toBe(false);
  });
});

describe("POST /auth/login", () => {
  it("entrega access y refresh token con la contraseña correcta", async () => {
    const r = await login();
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.access_token).toBeTruthy();
    expect(b.refresh_token).toBeTruthy();
    expect(b.expires_in).toBe(3600);
    expect(b.user).toEqual({ id: terminalId, email: EMAIL });
  });

  it("no distingue mayúsculas en el correo", async () => {
    expect((await login("CAJA-A@Ferreteria.LOCAL")).statusCode).toBe(200);
  });

  it("contraseña mala y correo inexistente dan 401 con el MISMO mensaje", async () => {
    const mala = await login(EMAIL, "otra-contraseña");
    const inexistente = await login("nadie@ferreteria.local", PASSWORD);
    expect(mala.statusCode).toBe(401);
    expect(inexistente.statusCode).toBe(401);
    expect(mala.json()).toEqual(inexistente.json());
  });

  it("una terminal desactivada no entra aunque la contraseña sea correcta", async () => {
    await base.pool.query("UPDATE terminales SET activa = FALSE");
    expect((await login()).statusCode).toBe(401);
  });

  it("rechaza cuerpos incompletos o con campos de más", async () => {
    const sinPass = await app.inject({ method: "POST", url: "/auth/login", payload: { email: EMAIL } });
    expect(sinPass.statusCode).toBe(400);
    const extra = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: EMAIL, password: PASSWORD, admin: true },
    });
    expect(extra.statusCode).toBe(400);
  });

  it("guarda solo el hash del refresh token, no el token", async () => {
    const { refresh_token } = (await login()).json();
    const { rows } = await base.pool.query("SELECT token_hash FROM sesiones");
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(refresh_token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("GET /auth/yo", () => {
  it("responde con la terminal si el token es bueno", async () => {
    const { access_token } = (await login()).json();
    const r = await yo(access_token);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: terminalId, email: EMAIL });
  });

  it("401 sin token, con token alterado o firmado con otro secreto", async () => {
    expect((await yo()).statusCode).toBe(401);
    const { access_token } = (await login()).json();
    expect((await yo(access_token.slice(0, -2) + "xx")).statusCode).toBe(401);

    const otro = construirApp({ pool: base.pool, jwtSecret: "z".repeat(40) });
    await otro.ready();
    const ajeno = otro.jwt.sign({ sub: terminalId, email: EMAIL });
    await otro.close();
    expect((await yo(ajeno)).statusCode).toBe(401);
  });

  it("401 de inmediato si la terminal se desactiva, sin esperar a que venza el token", async () => {
    const { access_token } = (await login()).json();
    await base.pool.query("UPDATE terminales SET activa = FALSE");
    expect((await yo(access_token)).statusCode).toBe(401);
  });

  it("401 si el access token ya venció", async () => {
    const corto = construirApp({ pool: base.pool, jwtSecret: SECRETO });
    await corto.ready();
    // Emitido hace 2 h: con la vida de 1 h, venció hace 1 h.
    const vencido = corto.jwt.sign({ sub: terminalId, email: EMAIL, iat: Math.floor(Date.now() / 1000) - 7200 } as never);
    await corto.close();
    expect((await yo(vencido)).statusCode).toBe(401);
  });
});

describe("POST /auth/refresh", () => {
  it("entrega una sesión nueva y el token viejo deja de servir (rotación)", async () => {
    const { refresh_token: viejo } = (await login()).json();
    const r = await refrescar(viejo);
    expect(r.statusCode).toBe(200);
    const nuevo = r.json();
    expect(nuevo.refresh_token).not.toBe(viejo);
    expect((await yo(nuevo.access_token)).statusCode).toBe(200);

    expect((await refrescar(viejo)).statusCode).toBe(401);
    expect((await refrescar(nuevo.refresh_token)).statusCode).toBe(200);
  });

  it("dos usos simultáneos del mismo token: solo uno gana", async () => {
    const { refresh_token } = (await login()).json();
    const [a, b] = await Promise.all([refrescar(refresh_token), refrescar(refresh_token)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
  });

  it("rechaza un token inventado o vencido", async () => {
    expect((await refrescar("inventado")).statusCode).toBe(401);
    const { refresh_token } = (await login()).json();
    await base.pool.query("UPDATE sesiones SET expira_en = now() - interval '1 second'");
    expect((await refrescar(refresh_token)).statusCode).toBe(401);
  });

  it("no renueva a una terminal desactivada", async () => {
    const { refresh_token } = (await login()).json();
    await base.pool.query("UPDATE terminales SET activa = FALSE");
    expect((await refrescar(refresh_token)).statusCode).toBe(401);
  });

  it("la sesión nueva dura 90 días", async () => {
    await login();
    const { rows } = await base.pool.query<{ dias: number }>(
      "SELECT extract(epoch FROM (expira_en - creado_en)) / 86400 AS dias FROM sesiones",
    );
    expect(Math.round(Number(rows[0]!.dias))).toBe(90);
  });
});

describe("POST /auth/logout", () => {
  it("revoca el refresh token", async () => {
    const { refresh_token } = (await login()).json();
    const out = await app.inject({ method: "POST", url: "/auth/logout", payload: { refresh_token } });
    expect(out.statusCode).toBe(204);
    expect((await refrescar(refresh_token)).statusCode).toBe(401);
  });
});

describe("GET /salud", () => {
  it("responde ok con la base arriba", async () => {
    const r = await app.inject({ method: "GET", url: "/salud" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("503 si la base no contesta", async () => {
    const caida = {
      query: async () => {
        throw new Error("sin base");
      },
    };
    const a = construirApp({ pool: caida as never, jwtSecret: SECRETO });
    const r = await a.inject({ method: "GET", url: "/salud" });
    expect(r.statusCode).toBe(503);
    await a.close();
  });
});
