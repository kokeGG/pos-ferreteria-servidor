/**
 * Recorrido REAL de `/timbrar` contra el sandbox de Factura.com, con las
 * llaves y los datos del emisor del `.env`.
 *
 * Corre en una base TEMPORAL (`pos_humo_timbrar`, con todas las migraciones) y
 * una carpeta temporal de archivos, que se borran al terminar: no deja ventas
 * de prueba en la base de la demo (que las cajas sincronizarían). Lo único que
 * sale de esta máquina son las llamadas al sandbox, que no tienen costo.
 *
 *   npm run humo:timbrar
 *
 * Opcional: HUMO_CORREO=<dirección>  correo del cliente de prueba (por omisión
 *           GMAIL_USER, o uno de ejemplo si no hay Gmail configurado).
 *           HUMO_CONSERVAR=1         no borra la base ni los archivos.
 *
 * No imprime llaves ni contraseñas.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { construirApp } from "./app.js";
import { hashPassword } from "./auth.js";
import { leerConfig } from "./config.js";
import { migrar } from "./migrar.js";

const NOMBRE_BASE = "pos_humo_timbrar";
const CARPETA_MIGRACIONES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migraciones");

// El arranque normal ya exige el sandbox; aquí se exige igual, antes de crear nada.
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

let fallos = 0;
const resumen: string[] = [];
function reportar(ok: boolean, nombre: string, detalle = ""): void {
  console.log(`${ok ? "OK   " : "FALLA"} ${nombre}${detalle ? `\n       ${detalle}` : ""}`);
  if (!ok) fallos++;
  resumen.push(`${ok ? "OK   " : "FALLA"} ${nombre}`);
}

const admin = new pg.Pool({ connectionString: urlDe("postgres"), max: 1 });
await admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_BASE} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${NOMBRE_BASE}`);
const pool = new pg.Pool({ connectionString: urlDe(NOMBRE_BASE) });
const almacenDir = await mkdtemp(path.join(tmpdir(), "humo-timbrar-"));

try {
  console.log("Preparando base temporal (migraciones)…");
  await migrar(pool, CARPETA_MIGRACIONES);

  const password = randomBytes(12).toString("hex");
  await pool.query("INSERT INTO terminales (email, password_hash) VALUES ('humo@local', $1)", [await hashPassword(password)]);

  const app = construirApp({ pool, jwtSecret: config.jwtSecret, almacenDir, entorno: process.env });
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "humo@local", password } });
  const auth = { authorization: `Bearer ${login.json().access_token}` };
  const timbrar = (cuerpo: object) => app.inject({ method: "POST", url: "/timbrar", headers: auth, payload: cuerpo });

  // ---- datos de prueba ------------------------------------------------------
  const correo = process.env.HUMO_CORREO || process.env.GMAIL_USER || "pruebas@ejemplo.com";
  // Receptor de pruebas del SAT: su razón social y CP deben ser exactamente estos.
  const clienteId = randomUUID();
  await pool.query(
    "INSERT INTO clientes (id, rfc, razon_social, codigo_postal, regimen_fiscal, uso_cfdi, email) VALUES ($1,'EKU9003173C9','ESCUELA KEMPER URGATE','42501','601','G03',$2)",
    [clienteId, correo],
  );
  const productoId = (await pool.query("SELECT id FROM productos LIMIT 1")).rows[0].id;
  let folio = Math.floor(Date.now() / 1000) % 1_000_000_000;

  /** Una venta de 1 pieza a $116.00 con IVA incluido: base 100.00 + IVA 16.00. */
  async function crearVenta(opciones: { cliente: string | null; globalId?: string }): Promise<string> {
    const id = randomUUID();
    const nominativa = opciones.cliente !== null;
    await pool.query(
      `INSERT INTO ventas (id, caja_id, folio_local, cliente_id, subtotal_cent, impuestos_cent, total_cent,
                           requiere_factura, estado_factura, uso_cfdi, factura_global_id)
       VALUES ($1,$2,$3,$4,10000,1600,11600,$5,$6,'G03',$7)`,
      [id, nominativa ? "H" : "G", ++folio, opciones.cliente, nominativa, nominativa ? "PENDIENTE" : "NO_REQUERIDA", opciones.globalId ?? null],
    );
    await pool.query(
      `INSERT INTO venta_detalles (id, venta_id, producto_id, renglon, clave_interna, descripcion, clave_prod_serv, clave_unidad,
                                   unidad_medida, objeto_imp, tipo_factor, tasa_iva_ppm, cantidad_mil, precio_unit_cent,
                                   importe_cent, iva_cent, total_cent)
       VALUES ($1,$2,$3,1,'HUMO','ARTICULO DE PRUEBA','01010101','H87','PIEZA','02','Tasa',160000,1000,11600,10000,1600,11600)`,
      [randomUUID(), id, productoId],
    );
    await pool.query("INSERT INTO venta_pagos (id, venta_id, forma_pago, monto_cent) VALUES ($1,$2,'01',11600)", [randomUUID(), id]);
    return id;
  }

  const ahora = new Date();
  const mes = String(ahora.getMonth() + 1).padStart(2, "0");

  // ---- 1. factura de una venta ---------------------------------------------
  console.log("\nFactura nominativa");
  const ventaId = await crearVenta({ cliente: clienteId });
  const f1 = await timbrar({ venta_id: ventaId });
  const c1 = f1.json();
  reportar(f1.statusCode === 200 && !!c1.uuid, "timbrar una venta", f1.statusCode === 200 ? `UUID ${c1.uuid}` : `HTTP ${f1.statusCode}: ${c1.error}`);
  if (f1.statusCode === 200) {
    reportar(existsSync(path.join(almacenDir, "cfdi-xml", ...String(c1.url_xml).split("/"))), "el XML quedó guardado", c1.url_xml);
    reportar(!!c1.url_pdf && existsSync(path.join(almacenDir, "cfdi-pdf", ...String(c1.url_pdf).split("/"))), "el PDF quedó guardado", c1.url_pdf ?? "sin PDF");
    reportar(typeof c1.xml === "string" && c1.xml.includes(c1.uuid), "el XML devuelto trae el UUID timbrado");
    console.log(`       correo: ${c1.correo_enviado ? `enviado a ${correo}` : `no enviado${c1.error_correo ? ` (${c1.error_correo})` : " (sin Gmail configurado)"}`}`);

    const f2 = await timbrar({ venta_id: ventaId });
    reportar(f2.statusCode === 200 && f2.json().ya_timbrada === true && f2.json().uuid === c1.uuid, "repetir la petición no vuelve a timbrar (idempotente)");

    // ---- 2. reenviar correo --------------------------------------------------
    const re = await timbrar({ reenviar_correo: { venta_id: ventaId } });
    if (re.statusCode === 501) console.log("       (reenviar correo omitido: Gmail no está configurado)");
    else reportar(re.statusCode === 200 && re.json().correo_enviado === true, "reenviar el correo", re.statusCode === 200 ? `a ${re.json().destinatario}` : `HTTP ${re.statusCode}: ${re.json().error ?? re.json().error_correo}`);

    // ---- 3. cancelar ---------------------------------------------------------
    const ca = await timbrar({ cancelar: { venta_id: ventaId, motivo: "02", motivo_texto: "Prueba del recorrido real" } });
    const cc = ca.json();
    reportar(ca.statusCode === 200, "cancelar la factura", ca.statusCode === 200 ? `${cc.mensaje}${cc.acuse ? " (con acuse)" : " (sin acuse)"}` : `HTTP ${ca.statusCode}: ${cc.error}`);
    if (ca.statusCode === 200) {
      const fila = (await pool.query("SELECT estado, estado_factura FROM ventas WHERE id = $1", [ventaId])).rows[0];
      reportar(fila.estado === "CANCELADA" && fila.estado_factura === "CANCELADA", "la venta quedó cancelada en la base");
      const otra = await timbrar({ cancelar: { venta_id: ventaId, motivo: "02" } });
      reportar(otra.json().ya_cancelada === true, "cancelar otra vez no llama al PAC (idempotente)");
    }
  }

  // ---- 4. público en general (RFC genérico) --------------------------------
  console.log("\nVenta a público en general");
  const mostrador = randomUUID();
  await pool.query(
    "INSERT INTO clientes (id, rfc, razon_social, codigo_postal, regimen_fiscal, uso_cfdi, email) VALUES ($1,'XAXX010101000','VENTA MOSTRADOR PUBLICO EN GENERAL',$2,'616','S01',$3)",
    [mostrador, process.env.CFDI_EMISOR_CP, correo],
  );
  const vm = await timbrar({ venta_id: await crearVenta({ cliente: mostrador }) });
  reportar(vm.statusCode === 200, "timbrar a público en general", vm.statusCode === 200 ? `UUID ${vm.json().uuid}` : `HTTP ${vm.statusCode}: ${vm.json().error}`);

  // ---- 5. factura global ----------------------------------------------------
  console.log("\nFactura global");
  const globalId = randomUUID();
  await pool.query(
    `INSERT INTO facturas_globales (id, periodicidad, meses, anio, periodo_inicio, periodo_fin, subtotal_cent, impuestos_cent, total_cent, num_ventas, estado)
     VALUES ($1,'04',$2,$3,date_trunc('month', now()), now(), 20000, 3200, 23200, 2, 'PENDIENTE')`,
    [globalId, mes, ahora.getFullYear()],
  );
  await crearVenta({ cliente: null, globalId });
  await crearVenta({ cliente: null, globalId });
  const g = await timbrar({ factura_global_id: globalId });
  reportar(g.statusCode === 200, "timbrar la factura global (2 notas)", g.statusCode === 200 ? `UUID ${g.json().uuid}` : `HTTP ${g.statusCode}: ${g.json().error}`);
  if (g.statusCode === 200) {
    const gc = await timbrar({ cancelar: { factura_global_id: globalId, motivo: "02" } });
    reportar(gc.statusCode === 200, "cancelar la factura global", gc.statusCode === 200 ? gc.json().mensaje : `HTTP ${gc.statusCode}: ${gc.json().error}`);
  }

  await app.close();
} catch (e) {
  fallos++;
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

console.log(`\n${resumen.filter((l) => l.startsWith("OK")).length} bien, ${fallos} con falla.`);
process.exitCode = fallos === 0 ? 0 : 1;
