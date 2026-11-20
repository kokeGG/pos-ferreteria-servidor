/**
 * Timbrado de CFDI: facturar una venta o una factura global, cancelar y
 * reenviar el correo.
 *
 * Portado de `supabase/functions/timbrar/index.ts` del POS (Edge Function de
 * Deno). La lógica fiscal y los mensajes se conservan tal cual; lo que cambió
 * es el entorno (Deno/Supabase -> Node/pg):
 *
 *   - `Response` -> `Resultado` (estado HTTP + cuerpo), que la ruta envía.
 *   - `sb.from(...)`  -> `Repositorio` (SQL sobre `pg`, ver repositorio.ts).
 *   - `sb.storage`    -> `Almacen` (carpeta en disco, ver ../almacen.ts).
 *   - `Deno.env`      -> `Entorno` inyectado.
 *
 * Es IDEMPOTENTE. Si ya está timbrada devuelve el timbre existente sin volver
 * a llamar al PAC: un timbre cuesta dinero, y un reintento por timeout de red
 * no puede facturar dos veces lo mismo. (La ruta, además, serializa las
 * llamadas sobre el mismo id: ver `rutas.ts`.)
 */

import { type Almacen } from "../almacen.js";
import {
  conceptoResumen,
  conceptosPorNota,
  pesos,
  verificarTotales,
  type DetalleVenta,
  type EntradaCfdi,
  type NotaDeGlobal,
} from "./cfdi.ts";
import { type Entorno, requerir } from "./entorno.ts";
import { enviarFactura, hayCorreoConfigurado, type CrearTransporte } from "./mailer.ts";
import { obtenerPac, PacNoConfigurado, type MotivoCancelacion, type PAC, type Timbre } from "./pac.ts";
import type { Fila, Repositorio } from "./repositorio.ts";

export interface Resultado {
  estado: number;
  cuerpo: Record<string, unknown>;
}

const r = (estado: number, cuerpo: Record<string, unknown>): Resultado => ({ estado, cuerpo });
const ok = (cuerpo: Record<string, unknown>) => r(200, cuerpo);

export interface DepsTimbrado {
  repo: Repositorio;
  almacen: Almacen;
  env: Entorno;
  /** PAC a usar; por omisión el que diga `PAC_PROVEEDOR`. */
  obtenerPac?: () => PAC;
  /** Transporte de correo; por omisión el SMTP de Gmail. */
  crearTransporte?: CrearTransporte;
}

/** Fecha local del emisor en el formato del SAT: sin zona y sin milisegundos. */
export function fechaSat(iso: string, zona = "America/Mexico_City"): string {
  const partes = new Intl.DateTimeFormat("sv-SE", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  // "sv-SE" da "2026-09-23 14:05:01"; el SAT quiere la T.
  return partes.replace(" ", "T");
}

const aBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** RFC genéricos del SAT: nacional y extranjero. */
const RFC_GENERICOS = new Set(["XAXX010101000", "XEXX010101000"]);

/** c_Meses -> mes calendario para elegir la carpeta año/mes del almacén. */
const MES_DE_CLAVE: Record<string, number> = {
  "01": 1, "02": 2, "03": 3, "04": 4, "05": 5, "06": 6,
  "07": 7, "08": 8, "09": 9, "10": 10, "11": 11, "12": 12,
  "13": 2, "14": 4, "15": 6, "16": 8, "17": 10, "18": 12,
};

const MOTIVOS: readonly MotivoCancelacion[] = ["02", "03"];

const carpetaDe = (iso: string) => {
  const f = new Date(iso);
  return `${f.getUTCFullYear()}/${String(f.getUTCMonth() + 1).padStart(2, "0")}`;
};

const mensajeDe = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function crearServicioTimbrado(deps: DepsTimbrado) {
  const { repo, almacen, env } = deps;
  const pac = deps.obtenerPac ?? (() => obtenerPac(env));

  /**
   * XML y PDF de una factura que YA estaba timbrada, leídos del almacén, para
   * que la app pueda dejar su copia en Documentos aunque el timbrado original
   * haya terminado sin que la app se enterara (p.ej. se cortó la red justo
   * después de que el PAC respondió). Best-effort: si no están, la respuesta
   * sigue siendo válida, sólo sin archivos.
   */
  async function archivosGuardados(rutaXml: string | null, rutaPdf: string | null) {
    const leer = async (bucket: string, ruta: string | null) => {
      if (!ruta) return null;
      try {
        return await almacen.leer(bucket, ruta);
      } catch {
        return null;
      }
    };
    const [xml, pdf] = await Promise.all([leer("cfdi-xml", rutaXml), leer("cfdi-pdf", rutaPdf)]);
    return { xml: xml ? xml.toString("utf8") : null, pdf_base64: pdf ? pdf.toString("base64") : null };
  }

  const emisor = () => ({
    rfc: requerir(env, "CFDI_EMISOR_RFC"),
    nombre: requerir(env, "CFDI_EMISOR_NOMBRE"),
    regimenFiscal: requerir(env, "CFDI_EMISOR_REGIMEN"),
    codigoPostal: requerir(env, "CFDI_EMISOR_CP"),
  });

  /**
   * Correo con el que se da de alta ante el PAC al receptor genérico de la
   * factura global ("PUBLICO EN GENERAL" / XAXX010101000). Editable desde la
   * app en Ctrl+F9 (`config_nube`); si todavía no se ha puesto, cae al correo
   * del negocio que ya manda las facturas por si acaso. No se le envía nada a
   * esta dirección por esto.
   */
  async function correoPublicoGeneral(): Promise<string | undefined> {
    return (await repo.correoPublicoGeneral()) || env.GMAIL_USER || undefined;
  }

  /** Marca el error en la tabla que toque; si ni eso se puede, no hay más que hacer. */
  const marcador = (tabla: "ventas" | "facturas_globales", id: string) => async (mensaje: string) => {
    const campos =
      tabla === "ventas"
        ? { estado_factura: "ERROR", error_timbrado: mensaje.slice(0, 1000) }
        : { estado: "ERROR", error_timbrado: mensaje.slice(0, 1000) };
    await repo.actualizar(tabla, id, campos).catch(() => undefined);
  };

  /**
   * PAC + almacén, compartido entre venta individual y factura global. Deja el
   * XML y el PDF guardados y devuelve las rutas; quien llama decide en qué
   * tabla escribir el resultado.
   *
   * Si falla, llama a `marcarError` (distinta tabla según el caso) y devuelve
   * el `Resultado` que hay que regresar tal cual — para no duplicar el manejo
   * de error en cada rama.
   */
  async function timbrarYGuardar(
    entrada: EntradaCfdi,
    fechaVenta: string,
    marcarError: (mensaje: string) => Promise<void>,
  ): Promise<{ timbre: Timbre; rutaXml: string; rutaPdf: string | null } | Resultado> {
    const descuadres = verificarTotales(entrada);
    if (descuadres.length > 0) {
      await marcarError(descuadres.join(" | "));
      return r(422, { error: "el comprobante no cuadra", detalles: descuadres });
    }

    let timbre: Timbre;
    try {
      timbre = await pac().timbrar(entrada);
    } catch (e) {
      const msg = mensajeDe(e);
      await marcarError(msg);
      return r(e instanceof PacNoConfigurado ? 501 : 502, { error: msg });
    }

    // Particionado por año/mes: los periodos son como el contador y el SAT
    // piden las cosas. El nombre es el UUID fiscal, único ante el SAT sea
    // cual sea el origen (venta o global).
    const carpeta = carpetaDe(fechaVenta);
    const rutaXml = `${carpeta}/${timbre.uuid}.xml`;

    // Se sobrescribe: un reintento del PAC devuelve el mismo UUID.
    try {
      await almacen.guardar("cfdi-xml", rutaXml, Buffer.from(timbre.xmlTimbrado, "utf8"), "application/xml", {
        sobrescribir: true,
      });
    } catch (e) {
      // El XML timbrado es el comprobante fiscal. Si no se pudo guardar, NO se
      // marca como timbrada aunque el PAC ya haya respondido: se prefiere
      // reintentar (el PAC devuelve el mismo UUID) a perder el archivo.
      await marcarError(`timbrado ok pero falló guardar el XML: ${mensajeDe(e)}`);
      return r(500, { error: "no se pudo guardar el XML", uuid: timbre.uuid });
    }

    let rutaPdf: string | null = null;
    if (timbre.pdf) {
      rutaPdf = `${carpeta}/${timbre.uuid}.pdf`;
      try {
        await almacen.guardar("cfdi-pdf", rutaPdf, Buffer.from(timbre.pdf), "application/pdf", { sobrescribir: true });
      } catch {
        // El PDF es sólo la representación impresa: se puede regenerar. Que
        // falle no invalida la factura, así que no se detiene el flujo.
        rutaPdf = null;
      }
    }

    return { timbre, rutaXml, rutaPdf };
  }

  // -------------------------------------------------------------------------
  // Venta individual
  // -------------------------------------------------------------------------

  async function timbrarVenta(ventaId: string): Promise<Resultado> {
    const marcarError = marcador("ventas", ventaId);
    const venta = await repo.ventaConCliente(ventaId);

    // La app es push-only hacia `ventas` (ver sync.ts): una venta recién hecha
    // tarda en subir lo que tarde el worker de sincronización (`Ctrl+F9` la
    // fuerza). "No encontrada" casi siempre es eso, no un id inventado — se lo
    // dice así al cajero en vez de un 404 seco que no explica nada.
    if (!venta) {
      return r(404, {
        error:
          "Esta venta todavía no llega a la nube. Espera a que termine de sincronizar (o fuerza la sincronización con Ctrl+F9) e intenta timbrar otra vez.",
      });
    }

    if (venta.uuid_sat) {
      return ok({
        ya_timbrada: true,
        uuid: venta.uuid_sat,
        url_xml: venta.url_xml,
        url_pdf: venta.url_pdf,
        ...(await archivosGuardados(venta.url_xml, venta.url_pdf)),
      });
    }
    if (venta.estado === "CANCELADA") return r(409, { error: "la venta está cancelada" });
    if (!venta.cliente_id) return r(409, { error: "una factura nominativa necesita cliente" });

    const detalles = await repo.detalles(ventaId);
    if (!detalles.length) return r(409, { error: "la venta no tiene renglones" });

    const pagos = await repo.pagos(ventaId);
    const cliente = venta.clientes as Fila;

    // RFC genérico (p.ej. el cliente "VENTA MOSTRADOR PUBLICO EN GENERAL"): el
    // SAT no acepta una factura nominativa a XAXX010101000. Se timbra como una
    // factura a público en general de esta sola venta — receptor "PUBLICO EN
    // GENERAL", régimen 616, uso S01, CP del emisor, InformacionGlobal diaria
    // con el mes y año de la venta y un solo concepto 01010101/ACT con sus
    // totales —, igual que la global, que ya timbra así. Va al correo del
    // cliente, o al de público en general (Ctrl+F9) si no tiene.
    if (RFC_GENERICOS.has((cliente.rfc ?? "").toUpperCase())) {
      const fecha = fechaSat(venta.creado_en);
      const correo = cliente.email || (await correoPublicoGeneral());
      const entradaGenerica: EntradaCfdi = {
        venta: {
          serie: venta.caja_id,
          folio: String(venta.folio_local),
          fecha,
          formaPago: pagos[0]?.forma_pago ?? "01",
          metodoPago: venta.metodo_pago ?? "PUE",
          totalCent: venta.total_cent,
        },
        emisor: emisor(),
        receptor: {
          rfc: "XAXX010101000",
          nombre: "PUBLICO EN GENERAL",
          domicilioFiscal: requerir(env, "CFDI_EMISOR_CP"),
          regimenFiscal: "616",
          usoCfdi: "S01",
          email: correo,
        },
        detalles: [conceptoResumen(venta.subtotal_cent, venta.impuestos_cent, venta.total_cent)],
        global: { periodicidad: "01", meses: fecha.slice(5, 7), anio: Number(fecha.slice(0, 4)) },
      };
      return terminarTimbradoDeVenta(ventaId, venta, entradaGenerica, marcarError, {
        email: correo,
        razon_social: cliente.razon_social,
      });
    }

    // El catálogo heredado de FoxPro trajo varios miles de clientes sin
    // régimen fiscal ni CP capturados: la pantalla de alta/edición ya exige
    // estos campos, pero no re-validó a los que ya estaban. Sin este chequeo,
    // el PAC rechaza la petición con un mensaje suyo mucho menos claro que
    // "falta este dato del cliente, complétalo en Ctrl+3".
    const faltantes: string[] = [];
    if (!cliente.regimen_fiscal) faltantes.push("régimen fiscal");
    if (!cliente.codigo_postal) faltantes.push("código postal");
    if (!cliente.email) faltantes.push("correo");
    if (faltantes.length > 0) {
      const mensaje =
        `Al cliente "${cliente.razon_social}" (RFC ${cliente.rfc}) le falta ${faltantes.join(" y ")} ` +
        `para poder facturarle. Complétalo en el catálogo de clientes (Ctrl+3) e intenta otra vez.`;
      await marcarError(mensaje);
      return r(422, { error: mensaje });
    }

    const entrada: EntradaCfdi = {
      venta: {
        serie: venta.caja_id,
        folio: String(venta.folio_local),
        fecha: fechaSat(venta.creado_en),
        // Con varias formas de pago, el SAT pide la del monto mayor.
        formaPago: pagos[0]?.forma_pago ?? "01",
        metodoPago: venta.metodo_pago ?? "PUE",
        totalCent: venta.total_cent,
      },
      emisor: emisor(),
      receptor: {
        rfc: cliente.rfc,
        nombre: cliente.razon_social,
        domicilioFiscal: cliente.codigo_postal,
        regimenFiscal: cliente.regimen_fiscal,
        usoCfdi: venta.uso_cfdi ?? cliente.uso_cfdi ?? "G03",
        email: cliente.email,
      },
      detalles: detalles as unknown as DetalleVenta[],
    };

    return terminarTimbradoDeVenta(ventaId, venta, entrada, marcarError, cliente);
  }

  /**
   * Timbra, anota el timbre en la venta y manda el correo. Común a la factura
   * nominativa y a la de público en general (RFC genérico) de una venta.
   */
  async function terminarTimbradoDeVenta(
    ventaId: string,
    venta: Fila,
    entrada: EntradaCfdi,
    marcarError: (mensaje: string) => Promise<void>,
    cliente: { email?: string | null; razon_social?: string | null },
  ): Promise<Resultado> {
    const resultado = await timbrarYGuardar(entrada, venta.creado_en, marcarError);
    if ("estado" in resultado) return resultado;
    const { timbre, rutaXml, rutaPdf } = resultado;

    try {
      await repo.actualizar("ventas", ventaId, {
        uuid_sat: timbre.uuid,
        estado_factura: "TIMBRADA",
        timbrada_en: new Date().toISOString(),
        url_xml: rutaXml,
        url_pdf: rutaPdf,
        error_timbrado: null,
      });
    } catch (e) {
      return r(500, { error: mensajeDe(e), uuid: timbre.uuid });
    }

    // La factura YA está timbrada a estas alturas: nada de lo que pase aquí
    // abajo puede deshacer eso. Un correo que no sale es una segunda cosa que
    // arreglar, no una factura perdida — por eso se guarda en su propia
    // columna (`error_correo`) y no en `error_timbrado`.
    let correoEnviado = false;
    let errorCorreo: string | null = null;

    if (cliente.email && hayCorreoConfigurado(env)) {
      try {
        await enviarFactura(
          {
            destinatario: cliente.email,
            nombreCliente: cliente.razon_social ?? "",
            // Factura: 000001-C (las notas son C-000001; ver src/lib/caja.ts del POS).
            folio: `${String(venta.folio_local).padStart(6, "0")}-${venta.caja_id}`,
            totalTexto: `$${pesos(venta.total_cent)} MXN`,
            uuid: timbre.uuid,
            xml: timbre.xmlTimbrado,
            pdf: timbre.pdf ?? new Uint8Array(),
          },
          env,
          deps.crearTransporte,
        );
        correoEnviado = true;
      } catch (e) {
        errorCorreo = mensajeDe(e);
      }

      await repo
        .actualizar("ventas", ventaId, {
          correo_enviado_en: correoEnviado ? new Date().toISOString() : null,
          error_correo: errorCorreo,
        })
        .catch(() => undefined);
    }

    return ok({
      uuid: timbre.uuid,
      url_xml: rutaXml,
      url_pdf: rutaPdf,
      correo_enviado: correoEnviado,
      error_correo: errorCorreo,
      // La app guarda su propia copia en Documentos. Viajan aquí y no se
      // descargan del almacén desde la app porque timbrar no necesita ese paso.
      xml: timbre.xmlTimbrado,
      pdf_base64: timbre.pdf ? aBase64(timbre.pdf) : null,
    });
  }

  // -------------------------------------------------------------------------
  // Factura global
  // -------------------------------------------------------------------------

  async function timbrarGlobal(globalId: string): Promise<Resultado> {
    const marcarError = marcador("facturas_globales", globalId);
    const global = await repo.global(globalId);
    if (!global) return r(404, { error: "factura global no encontrada" });

    if (global.uuid_sat) {
      return ok({
        ya_timbrada: true,
        uuid: global.uuid_sat,
        url_xml: global.url_xml,
        url_pdf: global.url_pdf,
        ...(await archivosGuardados(global.url_xml, global.url_pdf)),
      });
    }
    if (global.estado === "CANCELADA") return r(409, { error: "la factura global fue deshecha" });
    if (global.num_ventas === 0) return r(409, { error: "la factura global no tiene ventas" });

    // Un concepto por nota, con su folio (C-000001) en NoIdentificacion: ver
    // `conceptosPorNota` en cfdi.ts. Las notas son las que la caja marcó con
    // esta global; tienen que estar TODAS en la nube y sumar lo mismo que la
    // global congeló al generarse, o el CFDI no cuadraría con lo que la
    // pantalla mostró.
    const notas = await repo.notasDeGlobal(globalId);
    const sumaNotas = notas.reduce((s, n) => s + Number(n.total_cent), 0);
    if (notas.length !== global.num_ventas || sumaNotas !== Number(global.total_cent)) {
      const mensaje =
        `La nube todavía no tiene todas las notas de esta factura global (${notas.length} de ` +
        `${global.num_ventas}). Espera a que termine de sincronizar (Ctrl+F9) e intenta timbrar otra vez.`;
      await marcarError(mensaje);
      return r(409, { error: mensaje });
    }
    const detalles = conceptosPorNota(notas as unknown as NotaDeGlobal[]);

    // Se resuelve una sola vez: lo usa el receptor del CFDI (para que el PAC
    // pueda registrarlo) y, más abajo, el envío del PDF/XML por correo.
    const correoReceptor = await correoPublicoGeneral();

    const entrada: EntradaCfdi = {
      venta: {
        serie: "",
        folio: "",
        fecha: fechaSat(new Date().toISOString()),
        // Hoy la caja sólo cobra en efectivo: todas las ventas que entran a la
        // global comparten esa forma de pago.
        formaPago: "01",
        metodoPago: "PUE",
        totalCent: global.total_cent,
      },
      emisor: emisor(),
      receptor: {
        rfc: "XAXX010101000",
        nombre: "PUBLICO EN GENERAL",
        domicilioFiscal: requerir(env, "CFDI_EMISOR_CP"),
        regimenFiscal: "616",
        usoCfdi: "S01",
        email: correoReceptor,
      },
      detalles,
      global: { periodicidad: global.periodicidad, meses: global.meses, anio: global.anio },
    };

    // La fecha de la carpeta es la del periodo, no la de hoy: así los CFDI
    // quedan junto a las ventas que agrupan.
    const fechaCarpeta = new Date(global.anio, (MES_DE_CLAVE[global.meses] ?? 1) - 1, 1).toISOString();

    const resultado = await timbrarYGuardar(entrada, fechaCarpeta, marcarError);
    if ("estado" in resultado) return resultado;
    const { timbre, rutaXml, rutaPdf } = resultado;

    try {
      await repo.actualizar("facturas_globales", globalId, {
        uuid_sat: timbre.uuid,
        estado: "TIMBRADA",
        timbrada_en: new Date().toISOString(),
        url_xml: rutaXml,
        url_pdf: rutaPdf,
        error_timbrado: null,
      });
    } catch (e) {
      return r(500, { error: mensajeDe(e), uuid: timbre.uuid });
    }

    // La global YA está timbrada a estas alturas: igual que con una venta, un
    // correo que no sale no deshace el timbrado, sólo queda anotado en su
    // propia columna. El destinatario es el mismo correo que se usó para
    // registrar al receptor genérico ante el PAC (Ctrl+F9 en la app).
    let correoEnviado = false;
    let errorCorreo: string | null = null;

    if (correoReceptor && hayCorreoConfigurado(env)) {
      try {
        await enviarFactura(
          {
            destinatario: correoReceptor,
            nombreCliente: "PUBLICO EN GENERAL",
            folio: `Global ${global.meses}/${global.anio}`,
            totalTexto: `$${pesos(global.total_cent)} MXN`,
            uuid: timbre.uuid,
            xml: timbre.xmlTimbrado,
            pdf: timbre.pdf ?? new Uint8Array(),
          },
          env,
          deps.crearTransporte,
        );
        correoEnviado = true;
      } catch (e) {
        errorCorreo = mensajeDe(e);
      }

      await repo
        .actualizar("facturas_globales", globalId, {
          correo_enviado_en: correoEnviado ? new Date().toISOString() : null,
          error_correo: errorCorreo,
        })
        .catch(() => undefined);
    }

    return ok({
      uuid: timbre.uuid,
      url_xml: rutaXml,
      url_pdf: rutaPdf,
      correo_enviado: correoEnviado,
      error_correo: errorCorreo,
      xml: timbre.xmlTimbrado,
      pdf_base64: timbre.pdf ? aBase64(timbre.pdf) : null,
    });
  }

  // -------------------------------------------------------------------------
  // Cancelar
  // -------------------------------------------------------------------------

  /** Guarda el acuse junto al XML. Si falla, la cancelación YA ocurrió ante el SAT: se sigue igual. */
  async function guardarAcuse(fechaCarpeta: string, uuid: string, acuse: string | null) {
    if (!acuse) return;
    await almacen
      .guardar("cfdi-xml", `${carpetaDe(fechaCarpeta)}/${uuid}-cancelacion.xml`, Buffer.from(acuse, "utf8"), "application/xml", {
        sobrescribir: true,
      })
      .catch(() => undefined);
  }

  /**
   * Cancela ante el SAT el CFDI de una venta y marca la venta cancelada.
   * Idempotente como el timbrado: si ya estaba cancelada responde
   * `ya_cancelada` sin volver a llamar al PAC (la caja pudo no recibir la
   * respuesta la primera vez y reintenta).
   *
   * Devuelve el acuse del SAT para que la caja lo guarde junto a la factura.
   * La devolución de la mercancía la hace la caja (movimientos CANCELACION de
   * su kardex, que suben por la RPC de inventario), no esta función.
   */
  async function cancelarFacturaDeVenta(
    ventaId: string,
    motivo: MotivoCancelacion,
    motivoTexto: string,
  ): Promise<Resultado> {
    const venta = await repo.ventaParaCancelar(ventaId);
    if (!venta) {
      return r(404, { error: "Esta venta todavía no llega a la nube. Espera a que sincronice (Ctrl+F9) e intenta otra vez." });
    }
    if (venta.estado_factura === "CANCELADA") return ok({ ya_cancelada: true, uuid: venta.uuid_sat, acuse: null });
    if (!venta.uuid_sat || venta.estado_factura !== "TIMBRADA") {
      return r(409, { error: "La venta no tiene una factura timbrada que cancelar." });
    }

    let cancelacion;
    try {
      cancelacion = await pac().cancelar(venta.uuid_sat, motivo);
    } catch (e) {
      return r(e instanceof PacNoConfigurado ? 501 : 502, { error: mensajeDe(e) });
    }

    await guardarAcuse(venta.creado_en, venta.uuid_sat, cancelacion.acuse);

    try {
      await repo.actualizar("ventas", ventaId, {
        estado: "CANCELADA",
        estado_factura: "CANCELADA",
        cancelada_en: new Date().toISOString(),
        motivo_cancelacion: `SAT ${motivo}: ${motivoTexto}`.slice(0, 500),
        error_timbrado: null,
      });
    } catch (e) {
      // Cancelada ante el SAT pero no anotada: se dice así para que se
      // reintente (el PAC responderá que ya estaba cancelada).
      return r(500, { error: `cancelada ante el SAT, pero no se pudo anotar: ${mensajeDe(e)}`, cancelada_sat: true });
    }

    return ok({ uuid: venta.uuid_sat, acuse: cancelacion.acuse, mensaje: cancelacion.mensaje });
  }

  /**
   * Cancela ante el SAT una factura global timbrada y la marca CANCELADA.
   * Mismo contrato que `cancelarFacturaDeVenta`: idempotente, devuelve el
   * acuse. Liberar sus ventas (que vuelvan a quedar pendientes para otra
   * global) lo hace la caja, en el mismo lote en que anota la cancelación.
   */
  async function cancelarFacturaGlobal(globalId: string, motivo: MotivoCancelacion): Promise<Resultado> {
    const global = await repo.globalParaCancelar(globalId);
    if (!global) {
      return r(404, { error: "Esta factura global todavía no llega a la nube. Espera a que sincronice e intenta otra vez." });
    }
    if (global.estado === "CANCELADA" && global.uuid_sat) return ok({ ya_cancelada: true, uuid: global.uuid_sat, acuse: null });
    if (!global.uuid_sat || global.estado !== "TIMBRADA") {
      return r(409, { error: "La factura global no está timbrada: no hay nada que cancelar ante el SAT." });
    }

    let cancelacion;
    try {
      cancelacion = await pac().cancelar(global.uuid_sat, motivo);
    } catch (e) {
      return r(e instanceof PacNoConfigurado ? 501 : 502, { error: mensajeDe(e) });
    }

    await guardarAcuse(global.periodo_inicio, global.uuid_sat, cancelacion.acuse);

    try {
      await repo.actualizar("facturas_globales", globalId, { estado: "CANCELADA", error_timbrado: null });
    } catch (e) {
      return r(500, { error: `cancelada ante el SAT, pero no se pudo anotar: ${mensajeDe(e)}`, cancelada_sat: true });
    }

    return ok({ uuid: global.uuid_sat, acuse: cancelacion.acuse, mensaje: cancelacion.mensaje });
  }

  // -------------------------------------------------------------------------
  // Reenviar el correo de una factura ya timbrada
  // -------------------------------------------------------------------------

  /**
   * Vuelve a mandar el PDF/XML de una factura timbrada, leídos del almacén —
   * no se toca el PAC ni el timbre. Es para cuando el correo del timbrado
   * falló (`error_correo`) o el cliente dice que no le llegó. Anota el
   * resultado en `correo_enviado_en`/`error_correo` igual que el timbrado.
   */
  async function reenviarCorreo(ids: { venta_id?: string; factura_global_id?: string }): Promise<Resultado> {
    if (!hayCorreoConfigurado(env)) {
      return r(501, { error: "El envío de correo no está configurado en la nube (GMAIL_USER / GMAIL_APP_PASSWORD)." });
    }

    const tabla = ids.factura_global_id ? "facturas_globales" : "ventas";
    const id = (ids.factura_global_id ?? ids.venta_id)!;
    let destinatario: string | undefined;
    let nombreCliente: string;
    let folio: string;
    let totalCent: number;
    let uuid: string;
    let rutaXml: string | null;
    let rutaPdf: string | null;

    if (tabla === "ventas") {
      const venta = await repo.ventaConCliente(id);
      if (!venta) return r(404, { error: "Esta venta todavía no llega a la nube. Espera a que sincronice (Ctrl+F9)." });
      if (!venta.uuid_sat || venta.estado_factura !== "TIMBRADA") {
        return r(409, { error: "La venta no tiene una factura timbrada vigente." });
      }
      const cliente = (venta.clientes ?? {}) as Fila;
      // Igual que al timbrar: con RFC genérico y sin correo del cliente, va al
      // de público en general (Ctrl+F9).
      destinatario =
        cliente.email ||
        (RFC_GENERICOS.has((cliente.rfc ?? "").toUpperCase()) ? await correoPublicoGeneral() : undefined);
      nombreCliente = cliente.razon_social ?? "";
      folio = `${String(venta.folio_local).padStart(6, "0")}-${venta.caja_id}`;
      totalCent = venta.total_cent;
      uuid = venta.uuid_sat;
      rutaXml = venta.url_xml;
      rutaPdf = venta.url_pdf;
    } else {
      const global = await repo.global(id);
      if (!global) return r(404, { error: "Esta factura global todavía no llega a la nube." });
      if (!global.uuid_sat || global.estado !== "TIMBRADA") return r(409, { error: "La factura global no está timbrada." });
      destinatario = await correoPublicoGeneral();
      nombreCliente = "PUBLICO EN GENERAL";
      folio = `Global ${global.meses}/${global.anio}`;
      totalCent = global.total_cent;
      uuid = global.uuid_sat;
      rutaXml = global.url_xml;
      rutaPdf = global.url_pdf;
    }

    if (!destinatario) {
      return r(422, { error: "No hay a qué correo mandarla: captura el correo del cliente (Ctrl+3) e intenta otra vez." });
    }

    const leer = async (bucket: string, ruta: string | null) => (ruta ? almacen.leer(bucket, ruta).catch(() => null) : null);
    const [xml, pdf] = await Promise.all([leer("cfdi-xml", rutaXml), leer("cfdi-pdf", rutaPdf)]);
    if (!xml) return r(404, { error: "No se encontró el XML de la factura en la nube." });

    let errorCorreo: string | null = null;
    try {
      await enviarFactura(
        {
          destinatario,
          nombreCliente,
          folio,
          totalTexto: `$${pesos(totalCent)} MXN`,
          uuid,
          xml: xml.toString("utf8"),
          pdf: pdf ?? new Uint8Array(),
        },
        env,
        deps.crearTransporte,
      );
    } catch (e) {
      errorCorreo = mensajeDe(e);
    }

    const correoEnviadoEn = errorCorreo ? null : new Date().toISOString();
    await repo.actualizar(tabla, id, { correo_enviado_en: correoEnviadoEn, error_correo: errorCorreo }).catch(() => undefined);

    return ok({
      correo_enviado: errorCorreo === null,
      correo_enviado_en: correoEnviadoEn,
      error_correo: errorCorreo,
      destinatario,
    });
  }

  return { timbrarVenta, timbrarGlobal, cancelarFacturaDeVenta, cancelarFacturaGlobal, reenviarCorreo };
}

export type ServicioTimbrado = ReturnType<typeof crearServicioTimbrado>;

// ---------------------------------------------------------------------------
// Despacho: los tres cuerpos con que el POS invoca `timbrar`
// ---------------------------------------------------------------------------

export interface CuerpoTimbrar {
  venta_id?: unknown;
  factura_global_id?: unknown;
  cancelar?: { venta_id?: unknown; factura_global_id?: unknown; motivo?: unknown; motivo_texto?: unknown };
  reenviar_correo?: { venta_id?: unknown; factura_global_id?: unknown };
}

const texto = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Qué operación pide el cuerpo, y sobre qué id. Mismo orden de precedencia que la función original. */
export type Operacion =
  | { tipo: "reenviar"; ids: { venta_id?: string; factura_global_id?: string }; id: string }
  | { tipo: "cancelar-global"; id: string; motivo: MotivoCancelacion }
  | { tipo: "cancelar-venta"; id: string; motivo: MotivoCancelacion; motivoTexto: string }
  | { tipo: "timbrar-venta"; id: string }
  | { tipo: "timbrar-global"; id: string }
  | { tipo: "invalida"; resultado: Resultado };

export function interpretar(cuerpo: CuerpoTimbrar): Operacion {
  const re = cuerpo.reenviar_correo;
  if (re && texto(re.factura_global_id)) {
    return { tipo: "reenviar", ids: { factura_global_id: re.factura_global_id }, id: re.factura_global_id };
  }
  if (re && texto(re.venta_id)) return { tipo: "reenviar", ids: { venta_id: re.venta_id }, id: re.venta_id };

  const c = cuerpo.cancelar;
  if (c && !MOTIVOS.includes(c.motivo as MotivoCancelacion)) {
    return { tipo: "invalida", resultado: r(400, { error: "motivo de cancelación inválido (se aceptan 02 y 03)" }) };
  }
  if (c && texto(c.factura_global_id)) {
    return { tipo: "cancelar-global", id: c.factura_global_id, motivo: c.motivo as MotivoCancelacion };
  }
  if (c && texto(c.venta_id)) {
    return {
      tipo: "cancelar-venta",
      id: c.venta_id,
      motivo: c.motivo as MotivoCancelacion,
      motivoTexto: typeof c.motivo_texto === "string" ? c.motivo_texto : "",
    };
  }

  if (texto(cuerpo.venta_id)) return { tipo: "timbrar-venta", id: cuerpo.venta_id };
  if (texto(cuerpo.factura_global_id)) return { tipo: "timbrar-global", id: cuerpo.factura_global_id };
  return { tipo: "invalida", resultado: r(400, { error: "falta venta_id o factura_global_id" }) };
}

export function ejecutar(servicio: ServicioTimbrado, op: Exclude<Operacion, { tipo: "invalida" }>): Promise<Resultado> {
  switch (op.tipo) {
    case "reenviar":
      return servicio.reenviarCorreo(op.ids);
    case "cancelar-global":
      return servicio.cancelarFacturaGlobal(op.id, op.motivo);
    case "cancelar-venta":
      return servicio.cancelarFacturaDeVenta(op.id, op.motivo, op.motivoTexto);
    case "timbrar-venta":
      return servicio.timbrarVenta(op.id);
    case "timbrar-global":
      return servicio.timbrarGlobal(op.id);
  }
}
