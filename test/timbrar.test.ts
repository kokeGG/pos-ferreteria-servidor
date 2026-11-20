import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { construirApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { migrar } from "../src/migrar.js";
import { fechaSat, interpretar } from "../src/timbrar/servicio.ts";
import { baseLimpia, CARPETA_MIGRACIONES } from "./ayudas.js";
import { iniciarFacturaCom, LLAVE, SECRETO as SECRETO_PAC } from "./factura-com-simulada.js";
import { calcularRenglon } from "./pos/iva.ts";

const SECRETO = "s".repeat(40);

let base: Awaited<ReturnType<typeof baseLimpia>>;
let sim: Awaited<ReturnType<typeof iniciarFacturaCom>>;
let raiz: string;
let token: string;
let app: FastifyInstance;

/** Correos "enviados" por el transporte de prueba. */
const correos: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const correo = { falla: false };

const entornoBase = () => ({
  PAC_PROVEEDOR: "facturacom",
  FACTURACOM_BASE_URL: sim.url,
  FACTURACOM_API_KEY: LLAVE,
  FACTURACOM_SECRET_KEY: SECRETO_PAC,
  CFDI_EMISOR_RFC: "AAA010101AAA",
  CFDI_EMISOR_NOMBRE: "FERRETERIA DE PRUEBA",
  CFDI_EMISOR_REGIMEN: "601",
  CFDI_EMISOR_CP: "44100",
  GMAIL_USER: "negocio@gmail.com",
  GMAIL_APP_PASSWORD: "clave-de-aplicacion",
});

const transportePrueba = () => ({
  sendMail: async (opciones: unknown) => {
    if (correo.falla) throw new Error("SMTP caído");
    correos.push(opciones);
    return {};
  },
});

async function nuevaApp(entorno: Record<string, string | undefined>) {
  const a = construirApp({
    pool: base.pool,
    jwtSecret: SECRETO,
    almacenDir: raiz,
    entorno,
    timbrar: { crearTransporte: transportePrueba },
  });
  await a.ready();
  return a;
}

beforeAll(async () => {
  base = await baseLimpia("pos_test_timbrar");
  await migrar(base.pool, CARPETA_MIGRACIONES);
  sim = await iniciarFacturaCom();
  raiz = await mkdtemp(path.join(tmpdir(), "timbrar-test-"));
  app = await nuevaApp(entornoBase());
  await base.pool.query("INSERT INTO terminales (email, password_hash) VALUES ($1, $2)", [
    "caja@ferreteria.local",
    await hashPassword("x-contraseña-1"),
  ]);
  token = (
    await app.inject({ method: "POST", url: "/auth/login", payload: { email: "caja@ferreteria.local", password: "x-contraseña-1" } })
  ).json().access_token;
});

afterAll(async () => {
  await app.close();
  await sim.cerrar();
  await base.cerrar();
  await rm(raiz, { recursive: true, force: true });
});

beforeEach(() => {
  sim.reiniciar();
  correos.length = 0;
  correo.falla = false;
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const q = <T = any>(sql: string, params: unknown[] = []) => base.pool.query(sql, params).then((r) => r.rows as T[]); // eslint-disable-line @typescript-eslint/no-explicit-any

async function crearCliente(extra: Record<string, unknown> = {}) {
  const c = {
    id: randomUUID(),
    rfc: "XAXX010101000".replace("XAXX010101000", `AAA${Math.floor(Math.random() * 900000 + 100000)}AB1`),
    razon_social: "CLIENTE DE PRUEBA SA",
    codigo_postal: "64000",
    regimen_fiscal: "601",
    email: "cliente@ejemplo.com",
    ...extra,
  };
  await q(
    "INSERT INTO clientes (id, rfc, razon_social, codigo_postal, regimen_fiscal, email) VALUES ($1,$2,$3,$4,$5,$6)",
    [c.id, c.rfc, c.razon_social, c.codigo_postal, c.regimen_fiscal, c.email],
  );
  return c;
}

let folio = 1000;

/** Renglón con los importes que calcula la caja (mismo cálculo que el POS). */
function renglon(i: number, cantidad_mil = 2000, precio_unit_cent = 1500) {
  const imp = calcularRenglon({ cantidadMil: cantidad_mil, precioUnitCent: precio_unit_cent, descuentoCent: 0, tasaIvaPpm: 160_000, precioIncluyeIva: true });
  return { renglon: i, cantidad_mil, precio_unit_cent, importe_cent: imp.importeCent, iva_cent: imp.ivaCent, total_cent: imp.totalCent };
}

async function crearVenta(opciones: { cliente?: string | null; caja?: string; sinDetalles?: boolean; descuadrar?: number; estado?: string; creadoEn?: string; globalId?: string | null; requiere?: boolean } = {}) {
  const id = randomUUID();
  const caja = opciones.caja ?? "T";
  const rs = opciones.sinDetalles ? [] : [renglon(1), renglon(2, 1000, 999)];
  const sub = rs.reduce((s, r) => s + r.importe_cent, 0);
  const iva = rs.reduce((s, r) => s + r.iva_cent, 0);
  const total = rs.reduce((s, r) => s + r.total_cent, 0) + (opciones.descuadrar ?? 0);
  const requiere = opciones.requiere ?? (opciones.cliente !== null && opciones.globalId === undefined);
  const nFolio = ++folio;
  await q(
    `INSERT INTO ventas (id, caja_id, folio_local, cliente_id, subtotal_cent, impuestos_cent, total_cent,
                         requiere_factura, estado_factura, estado, creado_en, factura_global_id, uso_cfdi)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'G03')`,
    [id, caja, nFolio, opciones.cliente ?? null, sub, iva, total, requiere, requiere ? "PENDIENTE" : "NO_REQUERIDA",
     opciones.estado ?? "COMPLETADA", opciones.creadoEn ?? "2026-09-23T14:05:01Z", opciones.globalId ?? null],
  );
  const productoId = (await q("SELECT id FROM productos LIMIT 1"))[0].id;
  for (const r of rs) {
    await q(
      `INSERT INTO venta_detalles (id, venta_id, producto_id, renglon, clave_interna, descripcion, clave_prod_serv, clave_unidad,
                                   unidad_medida, objeto_imp, tipo_factor, tasa_iva_ppm, cantidad_mil, precio_unit_cent,
                                   importe_cent, iva_cent, total_cent)
       VALUES ($1,$2,$3,$4,'X','MARTILLO','27111500','H87','PIEZA','02','Tasa',160000,$5,$6,$7,$8,$9)`,
      [randomUUID(), id, productoId, r.renglon, r.cantidad_mil, r.precio_unit_cent, r.importe_cent, r.iva_cent, r.total_cent],
    );
  }
  if (total > 0) await q("INSERT INTO venta_pagos (id, venta_id, forma_pago, monto_cent) VALUES ($1,$2,'01',$3)", [randomUUID(), id, total]);
  return { id, caja, folio: nFolio, total, sub, iva };
}

async function crearGlobal(opciones: { meses?: string; anio?: number; notas?: number; numVentas?: number } = {}) {
  const id = randomUUID();
  const n = opciones.notas ?? 3;
  const meses = opciones.meses ?? "09";
  const anio = opciones.anio ?? 2026;
  await q(
    `INSERT INTO facturas_globales (id, periodicidad, meses, anio, periodo_inicio, periodo_fin, subtotal_cent, impuestos_cent,
                                    total_cent, num_ventas, estado)
     VALUES ($1,'04',$2,$3,'2026-09-01T06:00:00Z','2026-09-30T06:00:00Z',0,0,0,$4,'PENDIENTE')`,
    [id, meses, anio, opciones.numVentas ?? n],
  );
  let total = 0;
  for (let i = 0; i < n; i++) total += (await crearVenta({ cliente: null, globalId: id, caja: "G", requiere: false })).total;
  const [{ sub, iva }] = await q("SELECT COALESCE(sum(subtotal_cent),0)::int sub, COALESCE(sum(impuestos_cent),0)::int iva FROM ventas WHERE factura_global_id = $1", [id]);
  await q("UPDATE facturas_globales SET subtotal_cent=$2, impuestos_cent=$3, total_cent=$4 WHERE id=$1", [id, sub, iva, total]);
  return { id, total, n };
}

const auth = () => ({ authorization: `Bearer ${token}` });
const llamar = (cuerpo: unknown, a = app, headers: Record<string, string> = auth()) =>
  a.inject({ method: "POST", url: "/timbrar", headers, payload: cuerpo as object });
const timbrar = (venta_id: string, a = app) => llamar({ venta_id }, a);
const venta = async (id: string) => (await q("SELECT * FROM ventas WHERE id = $1", [id]))[0];
const global = async (id: string) => (await q("SELECT * FROM facturas_globales WHERE id = $1", [id]))[0];
const enAlmacen = (bucket: string, ruta: string) => existsSync(path.join(raiz, bucket, ...ruta.split("/")));

// ---------------------------------------------------------------------------

describe("timbrar una venta", () => {
  it("timbra, guarda XML y PDF, anota la venta y manda el correo", async () => {
    const cliente = await crearCliente();
    const v = await crearVenta({ cliente: cliente.id });
    const r = await timbrar(v.id);
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json();
    expect(c.uuid).toMatch(/^[0-9A-F-]{36}$/);
    expect(c.url_xml).toBe(`2026/09/${c.uuid}.xml`);
    expect(c.url_pdf).toBe(`2026/09/${c.uuid}.pdf`);
    expect(c.correo_enviado).toBe(true);
    expect(c.error_correo).toBeNull();
    expect(c.xml).toContain(c.uuid);
    expect(Buffer.from(c.pdf_base64, "base64").subarray(0, 8).toString()).toBe("%PDF-1.4");

    // En el almacén, con el mismo contenido que se devolvió.
    expect(await readFile(path.join(raiz, "cfdi-xml", "2026", "09", `${c.uuid}.xml`), "utf8")).toBe(c.xml);
    expect(enAlmacen("cfdi-pdf", c.url_pdf)).toBe(true);

    // En la venta.
    const fila = await venta(v.id);
    expect(fila).toMatchObject({ uuid_sat: c.uuid, estado_factura: "TIMBRADA", url_xml: c.url_xml, url_pdf: c.url_pdf, error_timbrado: null });
    expect(fila.timbrada_en).not.toBeNull();
    expect(fila.correo_enviado_en).not.toBeNull();

    // Lo que se le pidió al PAC: receptor dado de alta una vez, la serie, el total.
    expect(sim.creaciones()).toHaveLength(1);
    const cuerpo = sim.creaciones()[0]!.cuerpo;
    expect(cuerpo).toMatchObject({ Serie: 7, UsoCFDI: "G03", FormaPago: "01", MetodoPago: "PUE", Moneda: "MXN", EnviarCorreo: false });
    expect(cuerpo.Receptor.UID).toBe(sim.clientes.get(cliente.rfc));
    expect(cuerpo.Conceptos).toHaveLength(2);
    expect(cuerpo.InformacionGlobal).toBeUndefined();
    expect(sim.llamadas.filter((l) => l.ruta === "/v1/clients/create")).toHaveLength(1);
    // Las credenciales viajan en las cabeceras del PAC.
    expect(sim.creaciones()[0]!.cabeceras["f-api-key"]).toBe(LLAVE);

    // El correo: al cliente, con PDF y XML adjuntos como Buffer.
    expect(correos).toHaveLength(1);
    expect(correos[0]).toMatchObject({ to: cliente.email, from: expect.stringContaining("negocio@gmail.com") });
    expect(correos[0].subject).toContain(`${String(v.folio).padStart(6, "0")}-T`);
    expect(correos[0].attachments.map((a: any) => a.filename)).toEqual([`${String(v.folio).padStart(6, "0")}-T.pdf`, `${String(v.folio).padStart(6, "0")}-T.xml`]); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const a of correos[0].attachments) expect(Buffer.isBuffer(a.content)).toBe(true);
  });

  it("es idempotente: la segunda vez devuelve el mismo timbre sin tocar al PAC", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const primera = (await timbrar(v.id)).json();
    const segunda = await timbrar(v.id);
    expect(segunda.statusCode).toBe(200);
    expect(segunda.json()).toMatchObject({ ya_timbrada: true, uuid: primera.uuid, url_xml: primera.url_xml, url_pdf: primera.url_pdf, xml: primera.xml });
    expect(segunda.json().pdf_base64).toBe(primera.pdf_base64);
    expect(sim.creaciones()).toHaveLength(1);
    expect(correos).toHaveLength(1);
  });

  it("peticiones simultáneas de la MISMA venta: un solo timbre", async () => {
    sim.comportamiento.demoraCrearMs = 250;
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const rs = await Promise.all(Array.from({ length: 15 }, () => timbrar(v.id)));
    for (const r of rs) expect(r.statusCode, r.body).toBe(200);
    expect(sim.creaciones()).toHaveLength(1);
    const uuids = new Set(rs.map((r) => r.json().uuid));
    expect(uuids.size).toBe(1);
    expect(rs.filter((r) => !r.json().ya_timbrada)).toHaveLength(1);
    expect(correos).toHaveLength(1);
  });

  it("ventas DISTINTAS a la vez no se bloquean entre sí", async () => {
    sim.comportamiento.demoraCrearMs = 300;
    const cliente = await crearCliente();
    const vs = await Promise.all([1, 2, 3, 4].map(() => crearVenta({ cliente: cliente.id })));
    const t0 = Date.now();
    const rs = await Promise.all(vs.map((v) => timbrar(v.id)));
    const ms = Date.now() - t0;
    for (const r of rs) expect(r.statusCode, r.body).toBe(200);
    expect(sim.creaciones()).toHaveLength(4);
    expect(new Set(rs.map((r) => r.json().uuid)).size).toBe(4);
    expect(ms).toBeLessThan(300 * 4); // en paralelo, no una tras otra
  });

  it("un fallo no deja el candado puesto: la misma venta se puede reintentar", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    sim.comportamiento.crear = "rechazo200";
    expect((await timbrar(v.id)).statusCode).toBe(502);
    sim.comportamiento.crear = "ok";
    expect((await timbrar(v.id)).statusCode).toBe(200);
  });

  it("RFC genérico: se timbra como público en general, con InformacionGlobal y el correo de Ctrl+F9", async () => {
    await q("UPDATE config_nube SET valor = 'publico@negocio.com' WHERE clave = 'correo_publico_general'");
    const mostrador = await crearCliente({ rfc: "XAXX010101000", razon_social: "VENTA MOSTRADOR PUBLICO EN GENERAL", email: null, regimen_fiscal: "616" });
    const v = await crearVenta({ cliente: mostrador.id });
    const r = await timbrar(v.id);
    expect(r.statusCode, r.body).toBe(200);
    const cuerpo = sim.creaciones()[0]!.cuerpo;
    expect(cuerpo.UsoCFDI).toBe("S01");
    expect(cuerpo.Conceptos).toHaveLength(1);
    expect(cuerpo.Conceptos[0]).toMatchObject({ ClaveProdServ: "01010101", ClaveUnidad: "ACT" });
    expect(cuerpo.InformacionGlobal).toMatchObject({ Periodicidad: "01", Meses: "09", Año: "2026" });
    // El receptor se registró con el nombre genérico, el CP del emisor y el correo de config_nube.
    const alta = sim.llamadas.find((l) => l.ruta === "/v1/clients/create")!;
    expect(alta.cuerpo).toMatchObject({ rfc: "XAXX010101000", razons: "PUBLICO EN GENERAL", codpos: "44100", regimen: "616", email: "publico@negocio.com" });
    expect(correos[0].to).toBe("publico@negocio.com");
  });

  it("sin correo en config_nube, el receptor genérico usa el GMAIL_USER del negocio", async () => {
    await q("UPDATE config_nube SET valor = '' WHERE clave = 'correo_publico_general'");
    const mostrador = await crearCliente({ rfc: "XAXX010101000", email: null, regimen_fiscal: "616" });
    expect((await timbrar((await crearVenta({ cliente: mostrador.id })).id)).statusCode).toBe(200);
    expect(sim.llamadas.find((l) => l.ruta === "/v1/clients/create")!.cuerpo.email).toBe("negocio@gmail.com");
  });

  it("con varias formas de pago se usa la del monto mayor", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    await q("DELETE FROM venta_pagos WHERE venta_id = $1", [v.id]);
    await q("INSERT INTO venta_pagos (id, venta_id, forma_pago, monto_cent) VALUES ($1,$2,'01',100), ($3,$2,'04',$4), ($5,$2,'03',50)", [randomUUID(), v.id, randomUUID(), v.total - 150, randomUUID()]);
    expect((await timbrar(v.id)).statusCode).toBe(200);
    expect(sim.creaciones()[0]!.cuerpo.FormaPago).toBe("04");
  });

  it("RFC genérico con varias formas de pago: también la del monto mayor", async () => {
    const mostrador = await crearCliente({ rfc: "XAXX010101000", email: "m@x.com", regimen_fiscal: "616" });
    const v = await crearVenta({ cliente: mostrador.id });
    await q("DELETE FROM venta_pagos WHERE venta_id = $1", [v.id]);
    await q("INSERT INTO venta_pagos (id, venta_id, forma_pago, monto_cent) VALUES ($1,$2,'01',100), ($3,$2,'04',$4)", [randomUUID(), v.id, randomUUID(), v.total - 100]);
    expect((await timbrar(v.id)).statusCode).toBe(200);
    expect(sim.creaciones()[0]!.cuerpo.FormaPago).toBe("04");
  });

  it("un reintento que devuelve el MISMO uuid sobrescribe el XML (el PAC es idempotente)", async () => {
    sim.comportamiento.uuidFijo = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const primera = await timbrar(v.id);
    expect(primera.statusCode, primera.body).toBe(200);
    // La caja no se enteró (o el UPDATE falló): la venta sigue sin timbrar y reintenta.
    await q("UPDATE ventas SET uuid_sat = NULL, estado_factura = 'PENDIENTE' WHERE id = $1", [v.id]);
    const segunda = await timbrar(v.id);
    expect(segunda.statusCode, segunda.body).toBe(200);
    expect(segunda.json().uuid).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    expect(sim.creaciones()).toHaveLength(2);
  });

  it("la fecha de la carpeta es la de la venta (UTC), no la de hoy", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id, creadoEn: "2025-01-31T23:30:00Z" });
    expect((await timbrar(v.id)).json().url_xml).toMatch(/^2025\/01\//);
  });
});

describe("timbrar: lo que NO se debe timbrar", () => {
  it("venta inexistente -> 404 con el mensaje de sincronización; id mal formado -> 400", async () => {
    const r = await timbrar(randomUUID());
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toContain("todavía no llega a la nube");
    expect((await timbrar("no-es-uuid")).statusCode).toBe(400);
    expect((await timbrar("'; DROP TABLE ventas;--")).statusCode).toBe(400);
    expect(sim.llamadas).toHaveLength(0);
  });

  it("venta cancelada, sin cliente o sin renglones -> 409 y el PAC ni se entera", async () => {
    const cliente = await crearCliente();
    const cancelada = await crearVenta({ cliente: cliente.id, estado: "CANCELADA" });
    expect((await timbrar(cancelada.id)).json().error).toBe("la venta está cancelada");
    const sinCliente = await crearVenta({ cliente: null, requiere: false });
    expect((await timbrar(sinCliente.id)).json().error).toBe("una factura nominativa necesita cliente");
    const sinRenglones = await crearVenta({ cliente: cliente.id, sinDetalles: true });
    const r = await timbrar(sinRenglones.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("la venta no tiene renglones");
    expect(sim.llamadas).toHaveLength(0);
  });

  it("cliente sin régimen, CP o correo -> 422 con el mensaje para el cajero y la venta queda en ERROR", async () => {
    const incompleto = await crearCliente({ regimen_fiscal: "", codigo_postal: "", email: null, razon_social: "INCOMPLETO SA" });
    const v = await crearVenta({ cliente: incompleto.id });
    const r = await timbrar(v.id);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain('"INCOMPLETO SA"');
    expect(r.json().error).toContain("régimen fiscal y código postal y correo");
    expect(await venta(v.id)).toMatchObject({ estado_factura: "ERROR" });
    expect((await venta(v.id)).error_timbrado).toContain("le falta");
    expect(sim.llamadas).toHaveLength(0);
  });

  it("un comprobante que no cuadra con lo cobrado -> 422 y NO se gasta un timbre", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id, descuadrar: 5 });
    const r = await timbrar(v.id);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("el comprobante no cuadra");
    expect(r.json().detalles[0]).toContain("pero la caja cobró");
    expect(sim.creaciones()).toHaveLength(0);
    expect((await venta(v.id)).estado_factura).toBe("ERROR");
  });
});

describe("timbrar: fallas del PAC y del almacén", () => {
  it("rechazo con HTTP 200 (response:error) -> 502 con el motivo legible, nada guardado, y se puede reintentar", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    sim.comportamiento.crear = "rechazo200";
    const r = await timbrar(v.id);
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toContain("Factura.com rechazó el comprobante");
    expect(r.json().error).toContain("CFDI40145");
    expect(await venta(v.id)).toMatchObject({ estado_factura: "ERROR", uuid_sat: null, url_xml: null });
    expect((await venta(v.id)).error_timbrado).toContain("CFDI40145");
    expect(correos).toHaveLength(0);

    sim.comportamiento.crear = "ok";
    const bien = await timbrar(v.id);
    expect(bien.statusCode).toBe(200);
    expect(await venta(v.id)).toMatchObject({ estado_factura: "TIMBRADA", error_timbrado: null });
  });

  it("HTTP 500 o respuesta que no es JSON -> 502", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    for (const modo of ["http500", "sin-json"] as const) {
      sim.comportamiento.crear = modo;
      const r = await timbrar(v.id);
      expect(r.statusCode, modo).toBe(502);
      expect(r.json().error).toContain("Factura.com");
    }
    expect((await venta(v.id)).uuid_sat).toBeNull();
  });

  it("credenciales equivocadas -> el PAC contesta 401 y la venta no se marca timbrada", async () => {
    const mala = await nuevaApp({ ...entornoBase(), FACTURACOM_API_KEY: "otra" });
    const t = (await mala.inject({ method: "POST", url: "/auth/login", payload: { email: "caja@ferreteria.local", password: "x-contraseña-1" } })).json().access_token;
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const r = await mala.inject({ method: "POST", url: "/timbrar", headers: { authorization: `Bearer ${t}` }, payload: { venta_id: v.id } });
    expect(r.statusCode).toBe(502);
    expect((await venta(v.id)).uuid_sat).toBeNull();
    await mala.close();
  });

  it("el PAC timbró pero el XML no se puede guardar -> 500, NO queda como timbrada y se avisa el uuid", async () => {
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    sim.comportamiento.crear = "uuid-invalido"; // el nombre de archivo no cumple la convención: el almacén lo rechaza
    const r = await timbrar(v.id);
    expect(r.statusCode).toBe(500);
    expect(r.json()).toMatchObject({ error: "no se pudo guardar el XML", uuid: "no-es-un-uuid" });
    expect(await venta(v.id)).toMatchObject({ estado_factura: "ERROR", uuid_sat: null });
    expect((await venta(v.id)).error_timbrado).toContain("timbrado ok pero falló guardar el XML");
  });

  it("si el PAC timbra pero no deja descargar el PDF, el adaptador falla (igual que la función original) y no se marca timbrada", async () => {
    sim.comportamiento.sinPdf = true;
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const r = await timbrar(v.id);
    // facturacom.ts descarga XML y PDF juntos: sin PDF el adaptador falla (comportamiento original).
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toContain("no se pudo descargar el pdf");
    expect((await venta(v.id)).uuid_sat).toBeNull();
  });

  it("PAC sin configurar -> 501 con el mensaje, sin llamadas de red", async () => {
    const sinPac = await nuevaApp({ ...entornoBase(), PAC_PROVEEDOR: undefined });
    const espia = vi.spyOn(globalThis, "fetch");
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const r = await timbrar(v.id, sinPac);
    expect(r.statusCode).toBe(501);
    expect(r.json().error).toContain("PAC_PROVEEDOR");
    expect(espia).not.toHaveBeenCalled();
    await sinPac.close();
  });

  it("GUARDA DE SANDBOX: con la URL de producción (o sin URL) el servidor NO llama al PAC", async () => {
    const espia = vi.spyOn(globalThis, "fetch");
    for (const url of ["https://api.factura.com", "https://api.factura.com/api", undefined, "https://sandbox.factura.com.evil.com/api", "https://evil.com/sandbox.factura.com"]) {
      const insegura = await nuevaApp({ ...entornoBase(), FACTURACOM_BASE_URL: url });
      const v = await crearVenta({ cliente: (await crearCliente()).id });
      const r = await timbrar(v.id, insegura);
      expect(r.statusCode, String(url)).toBe(501);
      expect(r.json().error).toContain("sandbox");
      expect((await venta(v.id)).uuid_sat).toBeNull();
      await insegura.close();
    }
    expect(espia).not.toHaveBeenCalled();
  });

  it("falta una variable del emisor -> 500 con el nombre de la variable y el PAC no se toca", async () => {
    const sinRfc = await nuevaApp({ ...entornoBase(), CFDI_EMISOR_RFC: undefined });
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const r = await timbrar(v.id, sinRfc);
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toBe("falta la variable de entorno CFDI_EMISOR_RFC");
    expect(sim.creaciones()).toHaveLength(0);
    await sinRfc.close();
  });
});

describe("correo", () => {
  it("si el correo falla, la factura sigue timbrada y el error queda en su propia columna", async () => {
    correo.falla = true;
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const r = await timbrar(v.id);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ correo_enviado: false, error_correo: "SMTP caído" });
    expect(await venta(v.id)).toMatchObject({ estado_factura: "TIMBRADA", error_correo: "SMTP caído", correo_enviado_en: null, error_timbrado: null });
  });

  it("sin credenciales de Gmail no se manda nada ni se marca error", async () => {
    const sinCorreo = await nuevaApp({ ...entornoBase(), GMAIL_USER: undefined, GMAIL_APP_PASSWORD: undefined });
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const r = await timbrar(v.id, sinCorreo);
    expect(r.json()).toMatchObject({ correo_enviado: false, error_correo: null });
    expect(correos).toHaveLength(0);
    await sinCorreo.close();
  });

  it("reenviar_correo: lee XML y PDF del almacén, no toca al PAC y anota el resultado", async () => {
    correo.falla = true;
    const cliente = await crearCliente();
    const v = await crearVenta({ cliente: cliente.id });
    await timbrar(v.id);
    correo.falla = false;
    sim.reiniciar();

    const r = await llamar({ reenviar_correo: { venta_id: v.id } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ correo_enviado: true, error_correo: null, destinatario: cliente.email });
    expect(sim.llamadas).toHaveLength(0);
    expect(correos).toHaveLength(1);
    expect(correos[0].attachments).toHaveLength(2);
    expect(await venta(v.id)).toMatchObject({ error_correo: null });
    expect((await venta(v.id)).correo_enviado_en).not.toBeNull();

    // Si vuelve a fallar queda anotado.
    correo.falla = true;
    const mal = await llamar({ reenviar_correo: { venta_id: v.id } });
    expect(mal.json()).toMatchObject({ correo_enviado: false, error_correo: "SMTP caído" });
    expect(await venta(v.id)).toMatchObject({ error_correo: "SMTP caído", correo_enviado_en: null });
  });

  it("reenviar: venta sin timbrar 409, inexistente 404, sin correo configurado 501, sin destinatario 422, sin XML 404", async () => {
    const cliente = await crearCliente({ email: null });
    const pendiente = await crearVenta({ cliente: cliente.id });
    expect((await llamar({ reenviar_correo: { venta_id: pendiente.id } })).statusCode).toBe(409);
    expect((await llamar({ reenviar_correo: { venta_id: randomUUID() } })).statusCode).toBe(404);

    const sinCorreo = await nuevaApp({ ...entornoBase(), GMAIL_USER: undefined, GMAIL_APP_PASSWORD: undefined });
    expect((await llamar({ reenviar_correo: { venta_id: pendiente.id } }, sinCorreo)).statusCode).toBe(501);
    await sinCorreo.close();

    // Timbrada pero el cliente no tiene correo (se le quitó después).
    const conCorreo = await crearCliente();
    const v = await crearVenta({ cliente: conCorreo.id });
    await timbrar(v.id);
    await q("UPDATE clientes SET email = NULL WHERE id = $1", [conCorreo.id]);
    const r = await llamar({ reenviar_correo: { venta_id: v.id } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toContain("No hay a qué correo mandarla");

    // El XML desapareció del almacén.
    await q("UPDATE clientes SET email = 'otra@x.com' WHERE id = $1", [conCorreo.id]);
    await q("UPDATE ventas SET url_xml = '2026/09/00000000-0000-0000-0000-000000000000.xml' WHERE id = $1", [v.id]);
    const sinXml = await llamar({ reenviar_correo: { venta_id: v.id } });
    expect(sinXml.statusCode).toBe(404);
    expect(sinXml.json().error).toContain("No se encontró el XML");
  });
});

describe("factura global", () => {
  it("timbra un concepto por nota, guarda en la carpeta del PERIODO y manda el correo de público en general", async () => {
    await q("UPDATE config_nube SET valor = 'publico@negocio.com' WHERE clave = 'correo_publico_general'");
    const g = await crearGlobal({ meses: "09", anio: 2026, notas: 3 });
    const r = await llamar({ factura_global_id: g.id });
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json();
    expect(c.url_xml).toBe(`2026/09/${c.uuid}.xml`);
    expect(enAlmacen("cfdi-xml", c.url_xml)).toBe(true);

    const cuerpo = sim.creaciones()[0]!.cuerpo;
    expect(cuerpo.Conceptos).toHaveLength(3);
    expect(cuerpo.Conceptos.map((x: any) => x.NoIdentificacion)).toEqual(["G-001001".replace("001001", String(await primerFolioGlobal(g.id)).padStart(6, "0")), expect.any(String), expect.any(String)]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cuerpo.InformacionGlobal).toEqual({ Periodicidad: "04", Meses: "09", Año: "2026" });
    expect(cuerpo.UsoCFDI).toBe("S01");

    expect(await global(g.id)).toMatchObject({ estado: "TIMBRADA", uuid_sat: c.uuid, url_xml: c.url_xml, error_timbrado: null });
    expect(correos[0]).toMatchObject({ to: "publico@negocio.com" });
    expect(correos[0].subject).toContain("Global 09/2026");
  });

  it("bimestral (meses 13-18): la carpeta usa el mes calendario del periodo", async () => {
    const g = await crearGlobal({ meses: "15", anio: 2026, notas: 1 }); // 15 = mayo-junio -> junio
    const r = await llamar({ factura_global_id: g.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().url_xml).toMatch(/^2026\/06\//);
  });

  it("idempotente y serializada: peticiones simultáneas dan un solo timbre", async () => {
    sim.comportamiento.demoraCrearMs = 200;
    const g = await crearGlobal({ notas: 2 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => llamar({ factura_global_id: g.id })));
    for (const r of rs) expect(r.statusCode, r.body).toBe(200);
    expect(sim.creaciones()).toHaveLength(1);
    expect(rs.filter((r) => r.json().ya_timbrada)).toHaveLength(5);
  });

  it("si la nube no tiene todas las notas -> 409 con el mensaje de sincronizar y la global queda en ERROR", async () => {
    const g = await crearGlobal({ notas: 2, numVentas: 3 });
    const r = await llamar({ factura_global_id: g.id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("(2 de 3)");
    expect((await global(g.id)).estado).toBe("ERROR");
    expect(sim.llamadas).toHaveLength(0);
  });

  it("si el total de la global no coincide con la suma de sus notas -> 409 y NO se gasta un timbre", async () => {
    const g = await crearGlobal({ notas: 2 });
    await q("UPDATE facturas_globales SET total_cent = total_cent + 100 WHERE id = $1", [g.id]);
    const r = await llamar({ factura_global_id: g.id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain("(2 de 2)");
    expect(sim.llamadas).toHaveLength(0);
  });

  it("una nota CANCELADA colgada de la global no cuenta como nota de la global", async () => {
    const g = await crearGlobal({ notas: 2 });
    await crearVenta({ cliente: null, globalId: g.id, caja: "G", requiere: false, estado: "CANCELADA" });
    const r = await llamar({ factura_global_id: g.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(sim.creaciones()[0]!.cuerpo.Conceptos).toHaveLength(2);
  });

  it("global inexistente 404; sin ventas 409; deshecha 409", async () => {
    expect((await llamar({ factura_global_id: randomUUID() })).json().error).toBe("factura global no encontrada");
    const vacia = await crearGlobal({ notas: 0, numVentas: 0 });
    expect((await llamar({ factura_global_id: vacia.id })).json().error).toBe("la factura global no tiene ventas");
    const deshecha = await crearGlobal({ notas: 1 });
    await q("UPDATE facturas_globales SET estado = 'CANCELADA' WHERE id = $1", [deshecha.id]);
    expect((await llamar({ factura_global_id: deshecha.id })).json().error).toBe("la factura global fue deshecha");
  });

  it("reenviar el correo de una global y cancelarla", async () => {
    const g = await crearGlobal({ notas: 1 });
    await llamar({ factura_global_id: g.id });
    correos.length = 0;
    const re = await llamar({ reenviar_correo: { factura_global_id: g.id } });
    expect(re.json()).toMatchObject({ correo_enviado: true });
    expect(correos).toHaveLength(1);

    const c = await llamar({ cancelar: { factura_global_id: g.id, motivo: "02" } });
    expect(c.statusCode, c.body).toBe(200);
    expect((await global(g.id)).estado).toBe("CANCELADA");
    // Cancelada ya no se reenvía, y cancelar otra vez no toca al PAC.
    expect((await llamar({ reenviar_correo: { factura_global_id: g.id } })).statusCode).toBe(409);
    const otra = await llamar({ cancelar: { factura_global_id: g.id, motivo: "02" } });
    expect(otra.json()).toMatchObject({ ya_cancelada: true, acuse: null });
    expect(sim.cancelaciones()).toHaveLength(1);
    // El acuse junto al XML, con la fecha del periodo.
    expect(enAlmacen("cfdi-xml", `2026/09/${c.json().uuid}-cancelacion.xml`)).toBe(true);
  });
});

async function primerFolioGlobal(globalId: string): Promise<number> {
  return (await q("SELECT min(folio_local)::int AS f FROM ventas WHERE factura_global_id = $1", [globalId]))[0].f;
}

describe("cancelar", () => {
  async function timbrada() {
    const v = await crearVenta({ cliente: (await crearCliente()).id });
    const c = (await timbrar(v.id)).json();
    sim.llamadas.length = 0;
    return { v, uuid: c.uuid as string };
  }

  it("cancela ante el PAC, guarda el acuse y marca la venta cancelada", async () => {
    const { v, uuid } = await timbrada();
    const r = await llamar({ cancelar: { venta_id: v.id, motivo: "02", motivo_texto: "Error en el RFC" } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ uuid, mensaje: "Cancelado" });
    expect(r.json().acuse).toContain("<Acuse");
    expect(sim.cancelaciones()).toHaveLength(1);
    expect(sim.cancelaciones()[0]!.cuerpo).toEqual({ motivo: "02" });
    const fila = await venta(v.id);
    expect(fila).toMatchObject({ estado: "CANCELADA", estado_factura: "CANCELADA", motivo_cancelacion: "SAT 02: Error en el RFC", error_timbrado: null });
    expect(fila.cancelada_en).not.toBeNull();
    expect(await readFile(path.join(raiz, "cfdi-xml", "2026", "09", `${uuid}-cancelacion.xml`), "utf8")).toContain("<Acuse");
  });

  it("es idempotente: cancelar dos veces no vuelve a llamar al PAC", async () => {
    const { v } = await timbrada();
    await llamar({ cancelar: { venta_id: v.id, motivo: "03" } });
    const otra = await llamar({ cancelar: { venta_id: v.id, motivo: "03" } });
    expect(otra.json()).toMatchObject({ ya_cancelada: true, acuse: null });
    expect(sim.cancelaciones()).toHaveLength(1);
  });

  it("cancelaciones simultáneas: una sola llamada al PAC", async () => {
    const { v } = await timbrada();
    const rs = await Promise.all(Array.from({ length: 8 }, () => llamar({ cancelar: { venta_id: v.id, motivo: "02" } })));
    for (const r of rs) expect(r.statusCode, r.body).toBe(200);
    expect(sim.cancelaciones()).toHaveLength(1);
  });

  it("sin acuse (cancelación en proceso): se anota igual, sin archivo de acuse", async () => {
    const { v, uuid } = await timbrada();
    sim.comportamiento.cancelar = "sin-acuse";
    const r = await llamar({ cancelar: { venta_id: v.id, motivo: "02" } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ acuse: null, mensaje: "Cancelación en proceso" });
    expect((await venta(v.id)).estado_factura).toBe("CANCELADA");
    expect(enAlmacen("cfdi-xml", `2026/09/${uuid}-cancelacion.xml`)).toBe(false);
  });

  it("el PAC rechaza (HTTP 200 con response:error o 500) -> 502 y la venta SIGUE timbrada", async () => {
    const { v } = await timbrada();
    for (const modo of ["rechazo200", "http500"] as const) {
      sim.comportamiento.cancelar = modo;
      const r = await llamar({ cancelar: { venta_id: v.id, motivo: "02" } });
      expect(r.statusCode, modo).toBe(502);
      expect(r.json().error).toContain("Factura.com");
      expect(await venta(v.id)).toMatchObject({ estado: "COMPLETADA", estado_factura: "TIMBRADA" });
    }
    // Y después se puede cancelar bien.
    sim.comportamiento.cancelar = "ok";
    expect((await llamar({ cancelar: { venta_id: v.id, motivo: "02" } })).statusCode).toBe(200);
  });

  it("venta sin timbrar 409, inexistente 404; motivo 01/04/ausente -> 400", async () => {
    const pendiente = await crearVenta({ cliente: (await crearCliente()).id });
    expect((await llamar({ cancelar: { venta_id: pendiente.id, motivo: "02" } })).json().error).toBe("La venta no tiene una factura timbrada que cancelar.");
    expect((await llamar({ cancelar: { venta_id: randomUUID(), motivo: "02" } })).statusCode).toBe(404);
    for (const motivo of ["01", "04", "", undefined, 2]) {
      const r = await llamar({ cancelar: { venta_id: pendiente.id, motivo } });
      expect(r.statusCode, String(motivo)).toBe(400);
      expect(r.json().error).toBe("motivo de cancelación inválido (se aceptan 02 y 03)");
    }
    expect(sim.cancelaciones()).toHaveLength(0);
  });
});

describe("el cuerpo de la petición", () => {
  it("interpretar(): mismo orden de precedencia que la función original", () => {
    const v = randomUUID();
    expect(interpretar({ venta_id: v, reenviar_correo: { venta_id: v } }).tipo).toBe("reenviar");
    expect(interpretar({ venta_id: v, cancelar: { venta_id: v, motivo: "02" } }).tipo).toBe("cancelar-venta");
    expect(interpretar({ cancelar: { venta_id: v, factura_global_id: v, motivo: "02" } }).tipo).toBe("cancelar-global");
    expect(interpretar({ reenviar_correo: { venta_id: v, factura_global_id: v } })).toMatchObject({ tipo: "reenviar", ids: { factura_global_id: v } });
    expect(interpretar({ venta_id: v, factura_global_id: v }).tipo).toBe("timbrar-venta");
    expect(interpretar({ factura_global_id: v }).tipo).toBe("timbrar-global");
    for (const malo of [{}, { venta_id: "" }, { venta_id: 5 }, { venta_id: null }, { cancelar: {} }]) {
      expect(interpretar(malo as never).tipo, JSON.stringify(malo)).toBe(malo.hasOwnProperty("cancelar") ? "invalida" : "invalida");
    }
    expect((interpretar({}) as any).resultado).toEqual({ estado: 400, cuerpo: { error: "falta venta_id o factura_global_id" } }); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("sin id -> 400 con el mensaje original; JSON mal formado o vacío -> 400 { error }", async () => {
    expect((await llamar({})).json()).toEqual({ error: "falta venta_id o factura_global_id" });
    const malo = await app.inject({ method: "POST", url: "/timbrar", headers: { ...auth(), "content-type": "application/json" }, payload: "{no es json" });
    expect(malo.statusCode).toBe(400);
    expect(malo.json()).toEqual({ error: "cuerpo inválido" });
    const vacio = await app.inject({ method: "POST", url: "/timbrar", headers: { ...auth(), "content-type": "application/json" }, payload: "" });
    expect(vacio.statusCode).toBe(400);
    expect(Object.keys(vacio.json())).toEqual(["error"]);
  });

  it("exige token (también con un cuerpo inválido) y no acepta otros métodos", async () => {
    expect((await llamar({ venta_id: randomUUID() }, app, {})).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/timbrar", payload: "{no es json", headers: { "content-type": "application/json" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/timbrar", headers: auth() })).statusCode).toBe(404);
    await base.pool.query("UPDATE terminales SET activa = false");
    expect((await timbrar(randomUUID())).statusCode).toBe(401);
    await base.pool.query("UPDATE terminales SET activa = true");
  });

  it("CORS: el preflight del webview recibe 204 con las cabeceras, y hasta un 401 las lleva", async () => {
    const pre = await app.inject({ method: "OPTIONS", url: "/timbrar", headers: { origin: "http://tauri.localhost", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
    expect(pre.headers["access-control-allow-headers"]).toContain("authorization");
    expect(pre.headers["access-control-allow-methods"]).toContain("POST");
    const sinToken = await app.inject({ method: "POST", url: "/timbrar", headers: { origin: "http://tauri.localhost" }, payload: {} });
    expect(sinToken.statusCode).toBe(401);
    expect(sinToken.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("fechaSat", () => {
  it("da la hora local del emisor sin zona y sin milisegundos", () => {
    expect(fechaSat("2026-09-23T20:05:01.123456+00:00")).toBe("2026-09-23T14:05:01");
    expect(fechaSat("2026-01-01T03:00:00Z")).toBe("2025-12-31T21:00:00");
  });
});

describe("integridad", () => {
  it("no queda ningún candado ni conexión colgada tras todas las pruebas", async () => {
    const [{ n }] = await q("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
    expect(n).toBe(0);
  });
});
