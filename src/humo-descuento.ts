/**
 * Recorrido REAL contra el sandbox de Factura.com para ventas CON DESCUENTO.
 *
 * Timbra ventas con descuento y revisa el XML que devolvió el PAC: que el
 * concepto lleve `Descuento`, que `Importe - Descuento` sea la base del IVA, y
 * que el `Total` del comprobante sea exactamente lo que cobró la caja. Al
 * terminar cancela lo timbrado (en el sandbox, sin costo).
 *
 * Corre en una base TEMPORAL y una carpeta temporal, que borra al terminar.
 * Solo sale de esta máquina lo que va al sandbox (el servidor se niega a
 * arrancar con otra URL). No imprime llaves ni contraseñas.
 *
 *   npm run humo:descuento
 *
 * HUMO_CORREO=<dirección>  correo del cliente de prueba. Por omisión
 * `pruebas@ejemplo.com`: este recorrido NO manda correos a nadie.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { construirApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { leerConfig } from "./config.js";
import { migrar } from "./migrar.js";

const NOMBRE_BASE = "pos_humo_descuento";
const CARPETA_MIGRACIONES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migraciones");

const config = leerConfig();
if (process.env.PAC_PROVEEDOR !== "facturacom") {
  console.error("Falta PAC_PROVEEDOR=facturacom en .env: no hay a quién timbrar.");
  process.exit(1);
}

const urlDe = (base: string) => {
  const u = new URL(config.databaseUrl);
  u.pathname = `/${base}`;
  return u.toString();
};

/** Atributos de la primera etiqueta `<nombre …>` del XML. */
function atributos(xml: string, etiqueta: string): Record<string, string> {
  const m = new RegExp(`<${etiqueta}\\s([^>]*?)/?>`).exec(xml);
  const r: Record<string, string> = {};
  if (m) for (const a of m[1]!.matchAll(/([A-Za-z:]+)="([^"]*)"/g)) r[a[1]!] = a[2]!;
  return r;
}
const centavos = (s: string | undefined) => Math.round(Number(s ?? "0") * 100);

let fallos = 0;
function reportar(ok: boolean, nombre: string, detalle = ""): void {
  console.log(`${ok ? "OK   " : "FALLA"} ${nombre}${detalle ? `\n       ${detalle}` : ""}`);
  if (!ok) fallos++;
}

interface Renglon {
  descripcion: string;
  cantidadMil: number;
  /** Precio de mostrador, IVA incluido. */
  precioCent: number;
  descuentoCent: number;
  /** Lo que ya calculó la caja (base sin IVA tras el descuento, IVA y total). */
  baseCent: number;
  ivaCent: number;
  totalCent: number;
}

const admin = new pg.Pool({ connectionString: urlDe("postgres"), max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_BASE} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${NOMBRE_BASE}`);
const pool = new pg.Pool({ connectionString: urlDe(NOMBRE_BASE) });
const almacenDir = await mkdtemp(path.join(tmpdir(), "humo-descuento-"));
const timbradas: string[] = [];

try {
  console.log("Preparando base temporal (migraciones)…");
  await migrar(pool, CARPETA_MIGRACIONES);
  const password = randomBytes(12).toString("hex");
  await pool.query("INSERT INTO terminales (email, password_hash) VALUES ('humo@local', $1)", [await hashPassword(password)]);

  // Sin Gmail: este recorrido no manda correos.
  const entorno = { ...process.env, GMAIL_USER: "", GMAIL_APP_PASSWORD: "" };
  const app = construirApp({ pool, jwtSecret: config.jwtSecret, almacenDir, entorno });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "humo@local", password } });
  const auth = { authorization: `Bearer ${login.json().access_token}` };
  const timbrar = (cuerpo: object) => app.inject({ method: "POST", url: "/timbrar", headers: auth, payload: cuerpo });

  // Receptor de pruebas del SAT: razón social y CP deben ser exactamente estos.
  const clienteId = randomUUID();
  await pool.query(
    "INSERT INTO clientes (id, rfc, razon_social, codigo_postal, regimen_fiscal, uso_cfdi, email) VALUES ($1,'EKU9003173C9','ESCUELA KEMPER URGATE','42501','601','G03',$2)",
    [clienteId, process.env.HUMO_CORREO || "pruebas@ejemplo.com"],
  );
  const productoId = (await pool.query("SELECT id FROM productos LIMIT 1")).rows[0].id;
  let folio = Math.floor(Date.now() / 1000) % 1_000_000_000;

  async function crearVenta(renglones: Renglon[]): Promise<{ id: string; subtotal: number; iva: number; descuento: number; total: number }> {
    const id = randomUUID();
    const subtotal = renglones.reduce((s, r) => s + r.baseCent, 0);
    const iva = renglones.reduce((s, r) => s + r.ivaCent, 0);
    const descuento = renglones.reduce((s, r) => s + r.descuentoCent, 0);
    const total = renglones.reduce((s, r) => s + r.totalCent, 0);
    await pool.query(
      `INSERT INTO ventas (id, caja_id, folio_local, cliente_id, subtotal_cent, descuento_cent, impuestos_cent, total_cent,
                           requiere_factura, estado_factura, uso_cfdi)
       VALUES ($1,'H',$2,$3,$4,$5,$6,$7,TRUE,'PENDIENTE','G03')`,
      [id, ++folio, clienteId, subtotal, descuento, iva, total],
    );
    let n = 0;
    for (const r of renglones) {
      await pool.query(
        `INSERT INTO venta_detalles (id, venta_id, producto_id, renglon, clave_interna, descripcion, clave_prod_serv, clave_unidad,
                                     unidad_medida, objeto_imp, tipo_factor, tasa_iva_ppm, cantidad_mil, precio_unit_cent,
                                     descuento_cent, importe_cent, iva_cent, total_cent)
         VALUES ($1,$2,$3,$4,'HUMO',$5,'01010101','H87','PIEZA','02','Tasa',160000,$6,$7,$8,$9,$10,$11)`,
        [randomUUID(), id, productoId, ++n, r.descripcion, r.cantidadMil, r.precioCent, r.descuentoCent, r.baseCent, r.ivaCent, r.totalCent],
      );
    }
    await pool.query("INSERT INTO venta_pagos (id, venta_id, forma_pago, monto_cent) VALUES ($1,$2,'01',$3)", [randomUUID(), id, total]);
    return { id, subtotal, iva, descuento, total };
  }

  const casos: { nombre: string; renglones: Renglon[] }[] = [
    {
      nombre: "un renglón: 2 piezas a $50.00 con $10.00 de descuento",
      // bruto 100.00 - 10.00 = 90.00 con IVA -> base 77.59 + IVA 12.41
      renglones: [{ descripcion: "MARTILLO CON DESCUENTO", cantidadMil: 2000, precioCent: 5000, descuentoCent: 1000, baseCent: 7759, ivaCent: 1241, totalCent: 9000 }],
    },
    {
      nombre: "dos renglones: uno con descuento y otro sin él",
      renglones: [
        { descripcion: "MARTILLO CON DESCUENTO", cantidadMil: 2000, precioCent: 5000, descuentoCent: 1000, baseCent: 7759, ivaCent: 1241, totalCent: 9000 },
        { descripcion: "CLAVOS SIN DESCUENTO", cantidadMil: 1000, precioCent: 2320, descuentoCent: 0, baseCent: 2000, ivaCent: 320, totalCent: 2320 },
      ],
    },
  ];

  for (const caso of casos) {
    console.log(`\n${caso.nombre}`);
    const v = await crearVenta(caso.renglones);
    const r = await timbrar({ venta_id: v.id });
    const cuerpo = r.json();
    if (r.statusCode !== 200) {
      reportar(false, "el PAC aceptó y timbró la factura", `HTTP ${r.statusCode}: ${cuerpo.error ?? JSON.stringify(cuerpo)}`);
      continue;
    }
    timbradas.push(v.id);
    reportar(true, "el PAC aceptó y timbró la factura", `UUID ${cuerpo.uuid}`);

    const xml = String(cuerpo.xml);
    const comp = atributos(xml, "cfdi:Comprobante");
    const conceptos = [...xml.matchAll(/<cfdi:Concepto\s([^>]*?)>/g)].map((m) => {
      const a: Record<string, string> = {};
      for (const x of m[1]!.matchAll(/([A-Za-z:]+)="([^"]*)"/g)) a[x[1]!] = x[2]!;
      return a;
    });
    const traslados = [...xml.matchAll(/<cfdi:Traslado\s([^>]*?)\/>/g)].map((m) => {
      const a: Record<string, string> = {};
      for (const x of m[1]!.matchAll(/([A-Za-z:]+)="([^"]*)"/g)) a[x[1]!] = x[2]!;
      return a;
    });
    console.log(`       XML: SubTotal=${comp.SubTotal} Descuento=${comp.Descuento ?? "(no lleva)"} Total=${comp.Total}`);
    conceptos.forEach((c, i) => console.log(`       Concepto ${i + 1}: Importe=${c.Importe} Descuento=${c.Descuento ?? "(no lleva)"} | Traslado Base=${traslados[i]?.Base} Importe=${traslados[i]?.Importe}`));

    reportar(centavos(comp.Total) === v.total, `el Total de la factura es lo que cobró la caja (${(v.total / 100).toFixed(2)})`, `factura: ${comp.Total}`);
    reportar(centavos(comp.Descuento) > 0, "el comprobante indica el Descuento");
    // El IVA del comprobante es el resumen `TotalImpuestosTrasladados` (los
    // `<cfdi:Traslado>` salen dos veces: en cada concepto y en el resumen).
    const ivaDelComprobante = centavos(/TotalImpuestosTrasladados="([^"]*)"/.exec(xml)?.[1]);
    reportar(
      centavos(comp.SubTotal) - centavos(comp.Descuento) + ivaDelComprobante === centavos(comp.Total),
      "SubTotal - Descuento + IVA = Total",
      `${comp.SubTotal} - ${comp.Descuento} + ${(ivaDelComprobante / 100).toFixed(2)} vs ${comp.Total}`,
    );
    const conDesc = caso.renglones.map((x, i) => ({ x, c: conceptos[i], t: traslados[i] }));
    for (const { x, c, t } of conDesc) {
      if (x.descuentoCent > 0) {
        reportar(centavos(c?.Descuento) > 0, `el concepto «${x.descripcion}» indica su Descuento`);
        reportar(centavos(c?.Importe) - centavos(c?.Descuento) === centavos(t?.Base), "Importe - Descuento = Base del IVA", `${c?.Importe} - ${c?.Descuento} vs ${t?.Base}`);
      } else {
        reportar(c?.Descuento === undefined, `el concepto «${x.descripcion}» (sin descuento) no lleva Descuento`);
      }
    }
  }

  // Limpieza en el sandbox.
  for (const id of timbradas) await timbrar({ cancelar: { venta_id: id, motivo: "02", motivo_texto: "Prueba de descuento" } });
  await app.close();
} catch (e) {
  fallos++;
  console.error("\nEl recorrido se detuvo:", e instanceof Error ? e.message : e);
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_BASE} WITH (FORCE)`).catch(() => undefined);
  await rm(almacenDir, { recursive: true, force: true });
  await admin.end();
}

console.log(fallos === 0 ? "\nTodo bien." : `\n${fallos} verificación(es) con falla.`);
process.exitCode = fallos === 0 ? 0 : 1;
