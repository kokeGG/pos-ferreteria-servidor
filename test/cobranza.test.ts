import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { construirApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { migrar } from "../src/migrar.js";
import { baseLimpia, CARPETA_MIGRACIONES } from "./ayudas.js";

/**
 * Cobranza en el servidor: las cuentas por cobrar y sus abonos suben por la
 * API de sincronización de siempre. El servidor NO impone las reglas de saldo
 * (viven en la app; ver 20261121000002_cobranza.sql): aquí se prueba que las
 * tablas existen, que el orden de las llaves foráneas se respeta, y que los
 * errores llegan a la caja con el código que decide si reintenta o descarta.
 */

const SECRETO = "s".repeat(40);

let base: Awaited<ReturnType<typeof baseLimpia>>;
let app: ReturnType<typeof construirApp>;
let token: string;

beforeAll(async () => {
  base = await baseLimpia("pos_test_cobranza");
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
}, 60_000);

afterAll(async () => {
  await app.close();
  await base.cerrar();
});

const auth = () => ({ authorization: `Bearer ${token}` });
const upsert = (tabla: string, filas: object[]) =>
  app.inject({ method: "POST", url: `/sync/${tabla}/upsert`, headers: auth(), payload: { filas } });
const consultar = (tabla: string, cuerpo: object = {}) =>
  app.inject({ method: "POST", url: `/sync/${tabla}/consultar`, headers: auth(), payload: cuerpo });
const q = <T = unknown>(sql: string, params: unknown[] = []) => base.pool.query(sql, params).then((r) => r.rows as T[]);

let folio = 7000;
/** Un cliente y una venta a crédito ya en la nube (como los dejaría su propia subida). */
async function ventaConCliente() {
  const clienteId = randomUUID();
  const ventaId = randomUUID();
  await q(
    "INSERT INTO clientes (id, rfc, razon_social, codigo_postal, regimen_fiscal, uso_cfdi) VALUES ($1, $2, 'CLIENTE A CREDITO', '42501', '601', 'G03')",
    [clienteId, `XYZ010101${String(++folio).slice(-3)}`],
  );
  await q(
    `INSERT INTO ventas (id, caja_id, folio_local, cliente_id, subtotal_cent, impuestos_cent, total_cent, metodo_pago)
     VALUES ($1, 'A', $2, $3, 43103, 6897, 50000, 'PPD')`,
    [ventaId, ++folio, clienteId],
  );
  return { clienteId, ventaId };
}

const cuenta = (ventaId: string, clienteId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  venta_id: ventaId,
  cliente_id: clienteId,
  total_cent: 50_000,
  estado: "ABIERTA",
  liquidada_en: null,
  creado_en: "2026-11-21T15:00:00.000Z",
  actualizado_en: "2026-11-21T15:00:00.000Z",
  ...extra,
});

const abono = (cuentaId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  cuenta_id: cuentaId,
  tipo: "ABONO",
  monto_cent: 10_000,
  forma_pago: "01",
  referencia: null,
  usuario_id: null,
  turno_id: null,
  caja_id: "A",
  creado_en: "2026-11-21T16:00:00.000Z",
  ...extra,
});

describe("cobranza por la API de sincronización", () => {
  it("sube una cuenta, su anticipo y un abono; las cifras quedan como números y todo se puede leer", async () => {
    const { ventaId, clienteId } = await ventaConCliente();
    const c = cuenta(ventaId, clienteId);
    expect((await upsert("cuentas_por_cobrar", [c])).statusCode).toBe(200);
    expect((await upsert("abonos", [abono(c.id, { tipo: "ANTICIPO", monto_cent: 15_000 }), abono(c.id)])).statusCode).toBe(200);

    const r = await consultar("cuentas_por_cobrar", { filtros: [{ col: "id", op: "eq", valor: c.id }] });
    expect(r.statusCode).toBe(200);
    expect(r.json().filas).toHaveLength(1);
    expect(r.json().filas[0]).toMatchObject({ id: c.id, venta_id: ventaId, total_cent: 50_000, estado: "ABIERTA" });

    const a = await consultar("abonos", { filtros: [{ col: "cuenta_id", op: "eq", valor: c.id }], orden: [{ col: "creado_en" }] });
    expect(a.json().filas.map((f: { tipo: string; monto_cent: number }) => [f.tipo, f.monto_cent])).toEqual([
      ["ANTICIPO", 15_000],
      ["ABONO", 10_000],
    ]);
  });

  it("subir lo mismo dos veces no duplica nada", async () => {
    const { ventaId, clienteId } = await ventaConCliente();
    const c = cuenta(ventaId, clienteId);
    const ab = abono(c.id);
    for (let i = 0; i < 2; i++) {
      expect((await upsert("cuentas_por_cobrar", [c])).statusCode).toBe(200);
      expect((await upsert("abonos", [ab])).statusCode).toBe(200);
    }
    expect(await q("SELECT id FROM cuentas_por_cobrar WHERE id = $1", [c.id])).toHaveLength(1);
    expect(await q("SELECT id FROM abonos WHERE cuenta_id = $1", [c.id])).toHaveLength(1);
  });

  it("liquidar o cancelar la cuenta actualiza su estado Y la pone otra vez al frente del cursor `recibido_en`", async () => {
    const { ventaId, clienteId } = await ventaConCliente();
    const c = cuenta(ventaId, clienteId);
    await upsert("cuentas_por_cobrar", [c]);
    const [antes] = await q<{ recibido_en: Date }>("SELECT recibido_en FROM cuentas_por_cobrar WHERE id = $1", [c.id]);

    await new Promise((r) => setTimeout(r, 15));
    expect((await upsert("cuentas_por_cobrar", [{ ...c, estado: "LIQUIDADA", liquidada_en: "2026-11-22T10:00:00.000Z" }])).statusCode).toBe(200);

    const [despues] = await q<{ estado: string; liquidada_en: Date | null; recibido_en: Date }>(
      "SELECT estado, liquidada_en, recibido_en FROM cuentas_por_cobrar WHERE id = $1",
      [c.id],
    );
    expect(despues!.estado).toBe("LIQUIDADA");
    expect(despues!.liquidada_en).not.toBeNull();
    // Sin esto, otra caja que ya había bajado la cuenta no volvería a verla liquidada.
    expect(despues!.recibido_en.getTime()).toBeGreaterThan(antes!.recibido_en.getTime());
  });

  describe("errores: el código que le dice a la caja si reintenta o descarta", () => {
    it("una cuenta cuya venta todavía no llegó -> 23503 (llave foránea): la caja reintenta, no descarta", async () => {
      const { clienteId } = await ventaConCliente();
      const r = await upsert("cuentas_por_cobrar", [cuenta(randomUUID(), clienteId)]);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("23503");
    });

    it("un abono de una cuenta que no existe -> 23503", async () => {
      const r = await upsert("abonos", [abono(randomUUID())]);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("23503");
    });

    it("un abono de $0 o negativo -> 23514 (CHECK): rechazo definitivo", async () => {
      const { ventaId, clienteId } = await ventaConCliente();
      const c = cuenta(ventaId, clienteId);
      await upsert("cuentas_por_cobrar", [c]);
      for (const monto of [0, -100]) {
        const r = await upsert("abonos", [abono(c.id, { monto_cent: monto })]);
        expect(r.json().code, String(monto)).toBe("23514");
      }
    });

    it("un tipo de abono inventado o un estado de cuenta inventado -> 23514", async () => {
      const { ventaId, clienteId } = await ventaConCliente();
      const c = cuenta(ventaId, clienteId);
      expect((await upsert("cuentas_por_cobrar", [{ ...c, estado: "PAGADA" }])).json().code).toBe("23514");
      await upsert("cuentas_por_cobrar", [c]);
      expect((await upsert("abonos", [abono(c.id, { tipo: "REGALO" })])).json().code).toBe("23514");
    });

    it("una segunda cuenta para la MISMA venta -> 23505 (única): una venta abre a lo más una cuenta", async () => {
      const { ventaId, clienteId } = await ventaConCliente();
      await upsert("cuentas_por_cobrar", [cuenta(ventaId, clienteId)]);
      const r = await upsert("cuentas_por_cobrar", [cuenta(ventaId, clienteId)]); // otro id, misma venta
      expect(r.statusCode).toBe(409);
      expect(r.json().code).toBe("23505");
    });
  });

  it("el servidor NO impone el saldo (dos cajas pueden cobrar de más a la vez): lo guarda y la app lo muestra", async () => {
    const { ventaId, clienteId } = await ventaConCliente();
    const c = cuenta(ventaId, clienteId, { total_cent: 10_000 });
    await upsert("cuentas_por_cobrar", [c]);
    expect((await upsert("abonos", [abono(c.id, { monto_cent: 8_000 }), abono(c.id, { monto_cent: 8_000 })])).statusCode).toBe(200);
    const [r] = await q<{ pagado: number }>("SELECT SUM(monto_cent)::int AS pagado FROM abonos WHERE cuenta_id = $1", [c.id]);
    expect(r!.pagado).toBe(16_000); // más que los $100.00 de la cuenta: se ve, no se esconde
  });

  it("sin token no se escribe nada", async () => {
    const r = await app.inject({ method: "POST", url: "/sync/abonos/upsert", payload: { filas: [abono(randomUUID())] } });
    expect(r.statusCode).toBe(401);
  });
});
