import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { construirApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { migrar } from "../src/migrar.js";
import { aErrorHttp, aIsoConMicros, TABLAS } from "../src/sync.js";
import { baseLimpia, CARPETA_MIGRACIONES } from "./ayudas.js";

const SECRETO = "s".repeat(40);

let base: Awaited<ReturnType<typeof baseLimpia>>;
let app: ReturnType<typeof construirApp>;
let token: string;

beforeAll(async () => {
  base = await baseLimpia("pos_test_sync");
  await migrar(base.pool, CARPETA_MIGRACIONES);
  app = construirApp({ pool: base.pool, jwtSecret: SECRETO });
  await app.ready();
  await base.pool.query("INSERT INTO terminales (email, password_hash) VALUES ($1, $2)", [
    "caja@ferreteria.local",
    await hashPassword("x-contraseña-1"),
  ]);
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "caja@ferreteria.local", password: "x-contraseña-1" },
  });
  token = r.json().access_token;
});

afterAll(async () => {
  await app.close();
  await base.cerrar();
});

const auth = () => ({ authorization: `Bearer ${token}` });

function consultar(tabla: string, cuerpo: object = {}) {
  return app.inject({ method: "POST", url: `/sync/${tabla}/consultar`, headers: auth(), payload: cuerpo });
}
function upsert(tabla: string, filas: object[]) {
  return app.inject({ method: "POST", url: `/sync/${tabla}/upsert`, headers: auth(), payload: { filas } });
}
function rpc(nombre: string, cuerpo: object) {
  return app.inject({ method: "POST", url: `/rpc/${nombre}`, headers: auth(), payload: cuerpo });
}
const q = <T = unknown>(sql: string, params: unknown[] = []) =>
  base.pool.query(sql, params).then((r) => r.rows as T[]);

const producto = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  clave_interna: `T-${randomUUID().slice(0, 8)}`,
  nombre: "Producto de prueba",
  precio_venta_cent: 1500,
  clave_prod_serv: "27111500",
  clave_unidad: "H87",
  ...extra,
});

describe("autenticación", () => {
  it("toda ruta de esta fase exige token", async () => {
    const rutas: [string, string][] = [
      ["POST", "/sync/productos/consultar"],
      ["POST", "/sync/productos/upsert"],
      ["POST", "/rpc/aplicar_movimientos_inventario"],
      ["POST", "/rpc/inicializar_inventario_global"],
      ["GET", "/config/correo_publico_general"],
      ["PUT", "/config/correo_publico_general"],
    ];
    for (const [method, url] of rutas) {
      const sin = await app.inject({ method: method as "GET", url, payload: method === "GET" ? undefined : {} });
      expect(sin.statusCode, `${method} ${url}`).toBe(401);
      // Un cuerpo inválido sin token también es 401: se autentica ANTES de validar.
      const invalido = await app.inject({ method: method as "GET", url, payload: method === "GET" ? undefined : { campo_de_mas: 1 } });
      expect(invalido.statusCode, `${method} ${url} con cuerpo inválido`).toBe(401);
      const mala = await app.inject({
        method: method as "GET",
        url,
        headers: { authorization: "Bearer basura" },
        payload: method === "GET" ? undefined : {},
      });
      expect(mala.statusCode, `${method} ${url} con token malo`).toBe(401);
    }
  });

  it("una terminal desactivada pierde el acceso aunque su token no haya vencido", async () => {
    await base.pool.query("UPDATE terminales SET activa = false");
    expect((await consultar("productos", { limite: 1 })).statusCode).toBe(401);
    await base.pool.query("UPDATE terminales SET activa = true");
    expect((await consultar("productos", { limite: 1 })).statusCode).toBe(200);
  });
});

describe("lectura: tipos de salida", () => {
  it("bigint sale como número y los booleanos como booleanos", async () => {
    const p = producto({ precio_venta_cent: 123456789012 });
    expect((await upsert("productos", [p])).statusCode).toBe(200);
    const r = await consultar("productos", { filtros: [{ col: "id", op: "eq", valor: p.id }] });
    const fila = r.json().filas[0];
    expect(fila.precio_venta_cent).toBe(123456789012);
    expect(typeof fila.activo).toBe("boolean");
  });

  it("aIsoConMicros conserva los microsegundos y normaliza otras zonas", () => {
    expect(aIsoConMicros("2026-11-01 10:00:00.123456+00")).toBe("2026-11-01T10:00:00.123456+00:00");
    expect(aIsoConMicros("2026-11-01 10:00:00+00")).toBe("2026-11-01T10:00:00+00:00");
    expect(aIsoConMicros("2026-11-01 04:00:00.5-06")).toBe("2026-11-01T10:00:00.500Z");
    expect(aIsoConMicros("infinity")).toBe("infinity");
  });

  it("las fechas conservan los microsegundos de la base", async () => {
    const id = randomUUID();
    await q(
      `INSERT INTO clientes (id, rfc, razon_social, codigo_postal, regimen_fiscal, actualizado_en)
       VALUES ($1, 'XAXX010101000', 'MICROS', '64000', '616', '2026-11-01 10:00:00.123456+00')`,
      [id],
    );
    const r = await consultar("clientes", { filtros: [{ col: "id", op: "eq", valor: id }] });
    expect(r.json().filas[0].actualizado_en).toBe("2026-11-01T10:00:00.123456+00:00");
  });
});

describe("lectura: cursor (actualizado_en, llave)", () => {
  const EPOCA = "1970-01-01T00:00:00.000Z";

  /** Pagina como lo hace `jalar()` del POS. */
  async function paginar(tabla: string, limite: number, llave = "id") {
    const vistos: string[] = [];
    let marca = EPOCA;
    let ultimo: string | null = null;
    for (let vueltas = 0; vueltas < 1000; vueltas++) {
      const cuerpo: object = ultimo
        ? { despues: { col: "actualizado_en", valor: marca, llave_valor: ultimo }, limite }
        : { filtros: [{ col: "actualizado_en", op: "gt", valor: marca }], orden: [{ col: "actualizado_en" }, { col: llave }], limite };
      const r = await consultar(tabla, cuerpo);
      expect(r.statusCode).toBe(200);
      const filas = r.json().filas as Record<string, string>[];
      if (filas.length === 0) break;
      vistos.push(...filas.map((f) => f[llave]!));
      marca = filas.at(-1)!.actualizado_en!;
      ultimo = filas.at(-1)![llave]!;
      if (filas.length < limite) break;
    }
    return vistos;
  }

  it("recorre el catálogo sembrado (miles de filas con la misma marca) sin saltar ni repetir", async () => {
    const { n, marcas } = (await q<{ n: string; marcas: string }>(
      "SELECT count(*) n, count(DISTINCT actualizado_en) marcas FROM productos",
    ))[0]!;
    // La prueba solo vale si de verdad hay muchas filas con la misma marca.
    expect(Number(n)).toBeGreaterThan(1000);
    expect(Number(marcas)).toBeLessThan(Number(n) / 10);

    const vistos = await paginar("productos", 500);
    expect(vistos.length).toBe(Number(n));
    expect(new Set(vistos).size).toBe(Number(n));
  });

  it("filas que comparten el mismo microsegundo se reparten por llave, con páginas de 1", async () => {
    const ids: string[] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of ids) {
      await q(
        `INSERT INTO usuarios (id, nombre, pin_hash, actualizado_en)
         VALUES ($1, 'U', 'x', '2099-01-01 00:00:00.000001+00')`,
        [id],
      );
    }
    const r = await consultar("usuarios", {
      filtros: [{ col: "actualizado_en", op: "gt", valor: "2098-12-31T00:00:00.000Z" }],
      limite: 1,
    });
    expect(r.json().filas).toHaveLength(1);
    const vistos = await paginar("usuarios", 1).then((v) => v.filter((id) => ids.includes(id)));
    expect(vistos).toEqual(ids);
  });

  it("sin llave_valor solo avanza por la marca", async () => {
    const r = await consultar("usuarios", { despues: { col: "actualizado_en", valor: "2099-01-01T00:00:00.000001+00:00" } });
    expect(r.json().filas).toHaveLength(0);
  });

  it("`despues` no se combina con `orden`", async () => {
    const r = await consultar("usuarios", {
      despues: { col: "actualizado_en", valor: EPOCA },
      orden: [{ col: "id" }],
    });
    expect(r.statusCode).toBe(400);
  });

  it("producto_codigos se ordena y pagina por su llave `codigo`", async () => {
    const prodC = producto();
    await upsert("productos", [prodC]);
    for (let i = 0; i < 6; i++) await upsert("producto_codigos", [{ codigo: `ZC-${6 - i}`, producto_id: prodC.id }]);
    const r = await consultar("producto_codigos", { limite: 5, orden: [{ col: "actualizado_en" }, { col: "codigo" }] });
    expect(r.statusCode).toBe(200);
    expect(r.json().filas.length).toBe(5);
    const sin = await consultar("producto_codigos", { limite: 3 });
    const codigos = sin.json().filas.map((f: { codigo: string }) => f.codigo);
    expect(codigos).toEqual([...codigos].sort());
  });

  it("el límite por omisión y el máximo se respetan", async () => {
    expect((await consultar("productos")).json().filas).toHaveLength(500);
    expect((await consultar("productos", { limite: 1001 })).statusCode).toBe(400);
    expect((await consultar("productos", { limite: 0 })).statusCode).toBe(400);
  });
});

describe("lectura: filtros puntuales del POS", () => {
  it("hijas por lote: in(venta_id, [...])", async () => {
    const venta = await crearVenta({ folio_local: 9001 });
    const prodId = (await q<{ id: string }>("SELECT id FROM productos LIMIT 1"))[0]!.id;
    const detalle = {
      id: randomUUID(),
      venta_id: venta.id,
      producto_id: prodId,
      renglon: 1,
      clave_interna: "X",
      descripcion: "x",
      clave_prod_serv: "27111500",
      clave_unidad: "H87",
      unidad_medida: "PIEZA",
      objeto_imp: "02",
      tipo_factor: "Tasa",
      tasa_iva_ppm: 160000,
      cantidad_mil: 1000,
      precio_unit_cent: 100,
      importe_cent: 100,
      iva_cent: 16,
      total_cent: 116,
    };
    const subida = await upsert("venta_detalles", [detalle]);
    expect(subida.statusCode, subida.body).toBe(200);
    const r = await consultar("venta_detalles", {
      filtros: [{ col: "venta_id", op: "in", valor: [venta.id, randomUUID()] }],
    });
    expect(r.json().filas.map((f: { id: string }) => f.id)).toEqual([detalle.id]);
    // Lista vacía: no trae nada (y no es un error).
    const vacia = await consultar("venta_detalles", { filtros: [{ col: "venta_id", op: "in", valor: [] }] });
    expect(vacia.json().filas).toEqual([]);
  });

  it("folio máximo por serie: eq + eq + orden desc + limite 1", async () => {
    await crearVenta({ folio_local: 9100, caja_id: "F", requiere_factura: false });
    await crearVenta({ folio_local: 9102, caja_id: "F", requiere_factura: false });
    await crearVenta({ folio_local: 9300, caja_id: "F", requiere_factura: true, cliente_id: await clienteId() });
    const r = await consultar("ventas", {
      columnas: ["folio_local"],
      filtros: [
        { col: "caja_id", op: "eq", valor: "F" },
        { col: "requiere_factura", op: "eq", valor: false },
      ],
      orden: [{ col: "folio_local", desc: true }],
      limite: 1,
    });
    expect(r.json().filas).toEqual([{ folio_local: 9102 }]);
  });

  it("existencias: stock_version > N ordenado, solo tres columnas", async () => {
    const r = await consultar("productos", {
      columnas: ["id", "stock_mil", "stock_version"],
      filtros: [{ col: "stock_version", op: "gt", valor: -1 }],
      orden: [{ col: "stock_version" }],
      limite: 3,
    });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json().filas[0]).sort()).toEqual(["id", "stock_mil", "stock_version"]);
  });

  it("estado del inventario global: sin corte devuelve lista vacía", async () => {
    const r = await consultar("inventario_global", { columnas: ["corte_en", "caja_id"], limite: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().filas).toEqual([]);
  });

  it("gt/gte/lt/lte: los bordes se incluyen o excluyen como dice el operador", async () => {
    const ps = [1000, 2000, 3000].map((precio_venta_cent) => producto({ precio_venta_cent, nombre: "BORDE" }));
    await upsert("productos", ps);
    const con = async (op: string) =>
      (
        await consultar("productos", {
          columnas: ["precio_venta_cent"],
          filtros: [
            { col: "nombre", op: "eq", valor: "BORDE" },
            { col: "precio_venta_cent", op, valor: 2000 },
          ],
          orden: [{ col: "precio_venta_cent" }],
        })
      )
        .json()
        .filas.map((f: { precio_venta_cent: number }) => f.precio_venta_cent);
    expect(await con("gt")).toEqual([3000]);
    expect(await con("gte")).toEqual([2000, 3000]);
    expect(await con("lt")).toEqual([1000]);
    expect(await con("lte")).toEqual([1000, 2000]);
    expect(await con("eq")).toEqual([2000]);
  });

  it("eq con null compara IS NULL", async () => {
    const r = await consultar("ventas", { filtros: [{ col: "uuid_sat", op: "eq", valor: null }], limite: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().filas.length).toBe(1);
  });
});

async function clienteId(): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO clientes (id, rfc, razon_social, codigo_postal, regimen_fiscal)
     VALUES ($1, 'XAXX010101000', 'CLIENTE', '64000', '616')`,
    [id],
  );
  return id;
}

async function crearVenta(extra: Record<string, unknown> = {}) {
  const v = {
    id: randomUUID(),
    caja_id: "A",
    folio_local: 1,
    subtotal_cent: 100,
    total_cent: 116,
    impuestos_cent: 16,
    ...extra,
  };
  const r = await upsert("ventas", [v]);
  expect(r.statusCode, r.body).toBe(200);
  return v;
}

describe("escritura: upsert", () => {
  it("inserta y luego actualiza la misma fila (ON CONFLICT en la llave)", async () => {
    const p = producto();
    expect((await upsert("productos", [p])).json()).toEqual({ guardadas: 1 });
    expect((await upsert("productos", [{ ...p, nombre: "Cambiado", activo: false }])).statusCode).toBe(200);
    const [fila] = await q<{ nombre: string; activo: boolean }>("SELECT nombre, activo FROM productos WHERE id = $1", [p.id]);
    expect(fila).toEqual({ nombre: "Cambiado", activo: false });
  });

  it("producto_codigos usa `codigo` como llave", async () => {
    const p = producto();
    await upsert("productos", [p]);
    const codigo = `COD-${randomUUID().slice(0, 8)}`;
    expect((await upsert("producto_codigos", [{ codigo, producto_id: p.id }])).statusCode).toBe(200);
    expect((await upsert("producto_codigos", [{ codigo, producto_id: p.id, activo: false }])).statusCode).toBe(200);
    const [fila] = await q<{ activo: boolean }>("SELECT activo FROM producto_codigos WHERE codigo = $1", [codigo]);
    expect(fila!.activo).toBe(false);
  });

  it("una columna ausente en una fila completa no se toca (ni se pone en NULL)", async () => {
    const v = await crearVenta({ folio_local: 9200, serie_folio_sat: "S-1" });
    const { serie_folio_sat: _omitida, ...sin } = v as Record<string, unknown>;
    const r = await upsert("ventas", [{ ...sin, url_pdf: "ruta/x.pdf" }]);
    expect(r.statusCode, r.body).toBe(200);
    const [fila] = await q<{ serie_folio_sat: string; url_pdf: string }>(
      "SELECT serie_folio_sat, url_pdf FROM ventas WHERE id = $1",
      [v.id],
    );
    expect(fila).toEqual({ serie_folio_sat: "S-1", url_pdf: "ruta/x.pdf" });
  });

  it("una fila con solo la llave se rechaza (no hay nada que guardar)", async () => {
    expect((await upsert("productos", [{ id: randomUUID() }])).statusCode).toBe(400);
  });

  it("la existencia que manda la caja se ignora (la mueve solo la RPC)", async () => {
    const p = producto({ stock_mil: 99_000, stock_version: 77 });
    await upsert("productos", [p]);
    const [fila] = await q<{ stock_mil: number; stock_version: number }>(
      "SELECT stock_mil::int, stock_version::int FROM productos WHERE id = $1",
      [p.id],
    );
    expect(fila).toEqual({ stock_mil: 0, stock_version: 0 });
  });

  it("un lote entra completo o no entra", async () => {
    const buena = producto();
    const mala = producto({ precio_venta_cent: -1 });
    const r = await upsert("productos", [buena, mala]);
    expect(r.statusCode).toBe(400);
    expect(await q("SELECT 1 FROM productos WHERE id = $1", [buena.id])).toHaveLength(0);
  });

  it("recibido_en lo pone el servidor: la caja no puede fijarlo", async () => {
    const r = await upsert("productos", [producto({ recibido_en: "2000-01-01T00:00:00Z" })]);
    expect(r.statusCode).toBe(400);
  });
});

describe("rechazos: SQLSTATE original y estado HTTP", () => {
  const rechazo = async (r: Awaited<ReturnType<typeof upsert>>) => ({ estado: r.statusCode, code: r.json().code });

  it("23505 única (folio repetido) -> 409", async () => {
    await crearVenta({ folio_local: 9400, caja_id: "U" });
    const r = await upsert("ventas", [{ id: randomUUID(), caja_id: "U", folio_local: 9400, subtotal_cent: 1, total_cent: 1 }]);
    expect(await rechazo(r)).toEqual({ estado: 409, code: "23505" });
    expect(r.json().message).toContain("ux_ventas_folio");
  });

  it("23514 CHECK -> 400", async () => {
    expect(await rechazo(await upsert("productos", [producto({ precio_venta_cent: -5 })]))).toEqual({ estado: 400, code: "23514" });
  });

  it("23502 NOT NULL -> 400", async () => {
    expect(await rechazo(await upsert("productos", [producto({ nombre: null })]))).toEqual({ estado: 400, code: "23502" });
  });

  it("22P02 texto que no es uuid -> 400", async () => {
    expect(await rechazo(await upsert("productos", [producto({ id: "no-es-uuid" })]))).toEqual({ estado: 400, code: "22P02" });
  });

  it("23503 llave foránea -> 400 (la caja lo trata como transitorio: llegará el padre)", async () => {
    const r = await upsert("producto_codigos", [{ codigo: `Z-${randomUUID()}`, producto_id: randomUUID() }]);
    expect(await rechazo(r)).toEqual({ estado: 400, code: "23503" });
  });

  it("el cuerpo conserva exactamente los códigos que la caja trata como definitivos", () => {
    // 23505 23514 23502 22P02 42501: ver RECHAZOS_DEFINITIVOS en sync.ts del POS.
    for (const code of ["23505", "23514", "23502", "22P02", "42501"]) {
      const e = Object.assign(new Error("x"), { code, severity: "ERROR" });
      const { estado, cuerpo } = aErrorHttp(e);
      expect(cuerpo.code).toBe(code);
      expect(estado).toBeGreaterThanOrEqual(400);
      expect(estado).toBeLessThan(500);
    }
  });

  it("lo transitorio es 5xx y no se confunde con un rechazo", () => {
    for (const code of ["40001", "40P01", "08006", "53300", "57P01"]) {
      const { estado, cuerpo } = aErrorHttp(Object.assign(new Error("x"), { code, severity: "ERROR" }));
      expect(estado, code).toBe(503);
      expect(cuerpo.code).toBe(code);
    }
    expect(aErrorHttp(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).estado).toBe(503);
    expect(aErrorHttp(new Error("cualquier cosa")).estado).toBe(500);
  });

  it("un error nuestro (SQL inválido, 42xxx) no filtra detalles al cliente", () => {
    const { estado, cuerpo } = aErrorHttp(
      Object.assign(new Error('column "secreto" does not exist'), { code: "42703", severity: "ERROR" }),
    );
    expect(estado).toBe(500);
    expect(cuerpo.message).not.toContain("secreto");
  });
});

describe("seguridad: lista blanca", () => {
  const SIEMPRE_EXISTEN = async () => {
    const r = await q<{ n: string }>("SELECT count(*) n FROM information_schema.tables WHERE table_name IN ('productos','terminales','sesiones')");
    expect(r[0]!.n).toBe("3");
  };

  it("tabla fuera de la lista -> 404, en lectura y escritura", async () => {
    for (const t of ["terminales", "sesiones", "_migraciones", "pg_user", "config_nube", "constructor", "__proto__", "toString"]) {
      expect((await consultar(t)).statusCode, t).toBe(404);
      expect((await upsert(t, [{ id: randomUUID(), x: 1 }])).statusCode, t).toBe(404);
    }
  });

  it("nombres con comillas, punto y coma o esquema no llegan al SQL", async () => {
    for (const t of ['productos"', "productos;DROP TABLE productos", "public.productos", "productos--", "%22productos%22"]) {
      const r = await app.inject({ method: "POST", url: `/sync/${encodeURIComponent(t)}/consultar`, headers: auth(), payload: {} });
      expect([400, 404], t).toContain(r.statusCode);
    }
    await SIEMPRE_EXISTEN();
  });

  it("columna fuera de la lista (inexistente, con comillas, con ;) -> 400", async () => {
    const malas = ["inexistente", 'id"', "id; DROP TABLE productos", "id) OR (1=1", "*", "ID", "1=1"];
    for (const c of malas) {
      expect((await consultar("productos", { columnas: [c] })).statusCode, `columnas ${c}`).toBe(400);
      expect((await consultar("productos", { filtros: [{ col: c, op: "eq", valor: 1 }] })).statusCode, `filtro ${c}`).toBe(400);
      expect((await consultar("productos", { orden: [{ col: c }] })).statusCode, `orden ${c}`).toBe(400);
      expect((await consultar("productos", { despues: { col: c, valor: "a" } })).statusCode, `despues ${c}`).toBe(400);
      expect((await upsert("productos", [{ id: randomUUID(), [c]: 1 }])).statusCode, `upsert ${c}`).toBe(400);
    }
    await SIEMPRE_EXISTEN();
  });

  it("una columna de OTRA tabla tampoco vale", async () => {
    expect((await consultar("productos", { columnas: ["password_hash"] })).statusCode).toBe(400);
    expect((await consultar("productos", { columnas: ["token_hash"] })).statusCode).toBe(400);
  });

  it("operador desconocido -> 400", async () => {
    expect((await consultar("productos", { filtros: [{ col: "id", op: "like", valor: "%" }] })).statusCode).toBe(400);
    expect((await consultar("productos", { filtros: [{ col: "id", op: "= 1 OR 1=1 --", valor: 1 }] })).statusCode).toBe(400);
  });

  it("un valor malicioso es solo un valor: no inyecta", async () => {
    const r = await consultar("productos", { filtros: [{ col: "nombre", op: "eq", valor: "x' OR '1'='1" }] });
    expect(r.statusCode).toBe(200);
    expect(r.json().filas).toEqual([]);
    const sembrado = producto({ nombre: "Robert'); DROP TABLE productos;--" });
    expect((await upsert("productos", [sembrado])).statusCode).toBe(200);
    const [fila] = await q<{ nombre: string }>("SELECT nombre FROM productos WHERE id = $1", [sembrado.id]);
    expect(fila!.nombre).toBe("Robert'); DROP TABLE productos;--");
    await SIEMPRE_EXISTEN();
  });

  it("campos de más en el cuerpo -> 400; valores anidados no entran a una fila", async () => {
    expect((await consultar("productos", { extra: 1 })).statusCode).toBe(400);
    expect((await upsert("productos", [{ id: randomUUID(), nombre: { a: 1 } }])).statusCode).toBe(400);
    expect((await upsert("productos", [{ id: randomUUID(), nombre: ["a"] }])).statusCode).toBe(400);
  });

  it("falta la llave en la fila -> 400", async () => {
    expect((await upsert("productos", [{ nombre: "sin id" }])).statusCode).toBe(400);
    const nula = await upsert("productos", [{ id: null, nombre: "id nulo" }]);
    expect(nula.statusCode).toBe(400);
    expect(nula.json().code).toBe("PETICION_INVALIDA");
  });

  it("tablas de solo lectura no aceptan upsert", async () => {
    expect((await upsert("inventario_global", [{ id: true, corte_en: "2020-01-01T00:00:00Z", caja_id: "A" }])).statusCode).toBe(403);
    expect((await upsert("movimientos_inventario", [{ id: randomUUID(), notas: "x" }])).statusCode).toBe(403);
  });

  it("la lista de tablas escribibles es exactamente la que sube el POS", () => {
    const escribibles = Object.entries(TABLAS).filter(([, t]) => t.escribible).map(([n]) => n).sort();
    expect(escribibles).toEqual(
      [
        "clientes", "cotizacion_detalles", "cotizaciones", "facturas_globales", "producto_codigos",
        "producto_precios", "productos", "turnos", "usuarios", "venta_detalles", "venta_pagos", "ventas",
      ].sort(),
    );
  });

  it("las rutas de RPC solo existen para las dos funciones de inventario", async () => {
    for (const nombre of ["pg_sleep", "otra_funcion", "aplicar_movimientos_inventario;x"]) {
      const r = await rpc(nombre, {});
      expect(r.statusCode, nombre).toBe(404);
    }
  });
});

describe("rpc de inventario", () => {
  let prod: string;
  const corte = "2026-10-01T00:00:00.000Z";

  const movimiento = (producto_id: string, cantidad_mil: number, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    producto_id,
    tipo: "VENTA",
    cantidad_mil,
    saldo_mil: 0,
    creado_en: "2026-11-01T12:00:00.000Z",
    ...extra,
  });
  const stock = async (id: string) =>
    Number((await q<{ stock_mil: string }>("SELECT stock_mil FROM productos WHERE id = $1", [id]))[0]!.stock_mil);

  beforeAll(async () => {
    const p = producto();
    await upsert("productos", [p]);
    prod = p.id;
  });

  it("sin corte inicial responde P0001 (rechazo no definitivo para la caja) y no aplica nada", async () => {
    const r = await rpc("aplicar_movimientos_inventario", { p_movimientos: [movimiento(prod, -1000)], p_caja_id: "A" });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("P0001");
  });

  it("inicializar fija la existencia; una segunda vez da 23505", async () => {
    const r = await rpc("inicializar_inventario_global", {
      p_caja_id: "A",
      p_corte_en: corte,
      p_existencias: [{ producto_id: prod, stock_mil: 10_000 }],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().productos).toBe(1);
    expect(await stock(prod)).toBe(10_000);

    const otra = await rpc("inicializar_inventario_global", { p_caja_id: "B", p_corte_en: corte, p_existencias: [] });
    expect(otra.statusCode).toBe(409);
    expect(otra.json().code).toBe("23505");

    const estado = await consultar("inventario_global", { columnas: ["corte_en", "caja_id"], limite: 1 });
    expect(estado.json().filas).toEqual([{ corte_en: "2026-10-01T00:00:00+00:00", caja_id: "A" }]);
  });

  it("aplica un movimiento y lo devuelve como la caja lo espera; reenviarlo da YA_APLICADO", async () => {
    const m = movimiento(prod, -2000);
    const r = await rpc("aplicar_movimientos_inventario", { p_movimientos: [m], p_caja_id: "A" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual([
      expect.objectContaining({ id: m.id, producto_id: prod, estado: "APLICADO", aplicado_mil: -2000, stock_mil: 8000 }),
    ]);
    expect(typeof r.json()[0].stock_version).toBe("number");

    const otra = await rpc("aplicar_movimientos_inventario", { p_movimientos: [m], p_caja_id: "A" });
    expect(otra.json()[0]).toMatchObject({ id: m.id, estado: "YA_APLICADO", stock_mil: 8000 });
    expect(await stock(prod)).toBe(8000);
  });

  it("un movimiento anterior al corte no tiene efecto", async () => {
    const m = movimiento(prod, -1000, { creado_en: "2026-09-01T00:00:00.000Z" });
    const r = await rpc("aplicar_movimientos_inventario", { p_movimientos: [m], p_caja_id: "A" });
    expect(r.json()[0].estado).toBe("ANTERIOR_AL_CORTE");
    expect(await stock(prod)).toBe(8000);
  });

  it("producto que la nube no tiene -> 23503; uuid inválido -> 22P02", async () => {
    const a = await rpc("aplicar_movimientos_inventario", { p_movimientos: [movimiento(randomUUID(), -1)], p_caja_id: "A" });
    expect(a.json().code).toBe("23503");
    const b = await rpc("aplicar_movimientos_inventario", { p_movimientos: [movimiento("zzz", -1)], p_caja_id: "A" });
    expect(b.json().code).toBe("22P02");
  });

  it("parámetros mal tipados o de más se rechazan antes de llegar a la función", async () => {
    expect((await rpc("aplicar_movimientos_inventario", { p_movimientos: "no es lista" })).statusCode).toBe(400);
    expect((await rpc("aplicar_movimientos_inventario", { p_movimientos: [], otro: 1 })).statusCode).toBe(400);
    expect((await rpc("inicializar_inventario_global", { p_caja_id: "A", p_corte_en: "ayer", p_existencias: [] })).statusCode).toBe(400);
  });

  it("p_caja_id llega a la función: el llenado del servidor queda a nombre de esa caja", async () => {
    const p = producto();
    await upsert("productos", [p]);
    const m = movimiento(p.id, -3000); // existencia 0: la función tiene que llenar
    const r = await rpc("aplicar_movimientos_inventario", { p_movimientos: [m], p_caja_id: "CAJA-Z" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()[0]).toMatchObject({ estado: "APLICADO", llenado_mil: 3000, stock_mil: 0 });
    const llenado = await q<{ caja_id: string; origen: string }>(
      "SELECT caja_id, origen FROM movimientos_inventario WHERE movimiento_origen_id = $1",
      [m.id],
    );
    expect(llenado).toEqual([{ caja_id: "CAJA-Z", origen: "SERVIDOR" }]);
  });

  describe("concurrencia con conexiones reales", () => {
    it("el MISMO movimiento enviado a la vez muchas veces se aplica una sola vez", async () => {
      const antes = await stock(prod);
      const m = movimiento(prod, -1000);
      const respuestas = await Promise.all(
        Array.from({ length: 12 }, () => rpc("aplicar_movimientos_inventario", { p_movimientos: [m], p_caja_id: "A" })),
      );
      for (const r of respuestas) expect(r.statusCode, r.body).toBe(200);
      const estados = respuestas.map((r) => r.json()[0].estado).sort();
      expect(estados.filter((e) => e === "APLICADO")).toHaveLength(1);
      expect(estados.filter((e) => e === "YA_APLICADO")).toHaveLength(11);
      expect(await stock(prod)).toBe(antes - 1000);
      expect(await q("SELECT 1 FROM movimientos_inventario WHERE id = $1", [m.id])).toHaveLength(1);
    });

    it("movimientos distintos al mismo producto: ninguno se pierde y la existencia nunca baja de cero", async () => {
      const p = producto();
      await upsert("productos", [p]);
      // Esta existencia entra como movimiento del servidor para que cuadre con el kardex.
      await q("SELECT set_config('pos.inventario','on',false)");
      const m0 = movimiento(p.id, 5000, { tipo: "COMPRA" });
      await rpc("aplicar_movimientos_inventario", { p_movimientos: [m0], p_caja_id: "A" });
      expect(await stock(p.id)).toBe(5000);

      // 20 ventas de 1 pieza desde "cajas" distintas, con 5 en existencia.
      const ventas = Array.from({ length: 20 }, () => movimiento(p.id, -1000));
      const rs = await Promise.all(
        ventas.map((m, i) => rpc("aplicar_movimientos_inventario", { p_movimientos: [m], p_caja_id: `C${i % 4}` })),
      );
      for (const r of rs) expect(r.statusCode, r.body).toBe(200);
      expect(rs.every((r) => r.json()[0].estado === "APLICADO")).toBe(true);
      expect(await stock(p.id)).toBe(0);

      // El kardex cuadra con la existencia: la suma de todo lo aplicado es lo que hay.
      const { suma } = (await q<{ suma: string }>(
        "SELECT COALESCE(sum(cantidad_mil),0) suma FROM movimientos_inventario WHERE producto_id = $1",
        [p.id],
      ))[0]!;
      expect(Number(suma)).toBe(0);
      expect(await q("SELECT 1 FROM v_inventario_descuadres WHERE id = $1", [p.id])).toHaveLength(0);
    });

    it("lotes que tocan los mismos productos en distinto orden no se interbloquean", async () => {
      const ps = [producto(), producto(), producto()];
      await upsert("productos", ps);
      await rpc("aplicar_movimientos_inventario", {
        p_movimientos: ps.map((p) => movimiento(p.id, 100_000, { tipo: "COMPRA" })),
        p_caja_id: "A",
      });
      const lote = (orden: number[]) => orden.map((i) => movimiento(ps[i]!.id, -1000));
      const rs = await Promise.all([
        ...Array.from({ length: 8 }, () => rpc("aplicar_movimientos_inventario", { p_movimientos: lote([0, 1, 2]), p_caja_id: "A" })),
        ...Array.from({ length: 8 }, () => rpc("aplicar_movimientos_inventario", { p_movimientos: lote([2, 1, 0]), p_caja_id: "B" })),
      ]);
      for (const r of rs) expect(r.statusCode, r.body).toBe(200);
      for (const p of ps) expect(await stock(p.id)).toBe(100_000 - 16 * 1000);
    });
  });
});

describe("config_nube", () => {
  it("la clave sembrada se lee; una inexistente da 404", async () => {
    const r = await app.inject({ method: "GET", url: "/config/correo_publico_general", headers: auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ clave: "correo_publico_general", valor: "" });
    const no = await app.inject({ method: "GET", url: "/config/no_existe", headers: auth() });
    expect(no.statusCode).toBe(404);
  });

  it("PUT guarda y actualiza (upsert)", async () => {
    const put = (valor: string) =>
      app.inject({ method: "PUT", url: "/config/correo_publico_general", headers: auth(), payload: { valor } });
    expect((await put("a@b.com")).json().valor).toBe("a@b.com");
    expect((await put("c@d.com")).json().valor).toBe("c@d.com");
    const r = await app.inject({ method: "GET", url: "/config/correo_publico_general", headers: auth() });
    expect(r.json().valor).toBe("c@d.com");
    expect(await q("SELECT 1 FROM config_nube WHERE clave = 'correo_publico_general'")).toHaveLength(1);
  });

  it("claves con caracteres raros se rechazan", async () => {
    for (const clave of ["A", "x-y", "x%20y", "x'y"]) {
      const r = await app.inject({ method: "GET", url: `/config/${clave}`, headers: auth() });
      expect(r.statusCode, clave).toBe(400);
    }
  });
});
