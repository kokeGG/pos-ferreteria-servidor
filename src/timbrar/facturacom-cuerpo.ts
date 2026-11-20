/**
 * Traducción de una venta al JSON que pide `POST /v4/cfdi40/create` de
 * Factura.com.
 *
 * Módulo PURO a propósito: sin `Deno`, sin red. Se prueba con vitest desde el
 * repo (`src/lib/facturacom.test.ts`).
 *
 * Esta API NO recibe al emisor ni al receptor completos en el cuerpo: el
 * emisor sale de la cuenta (ya configurada en su panel), y el receptor es
 * sólo un `UID` de un cliente pre-registrado. Ese UID y el `SerieID` numérico
 * se resuelven aparte, con llamadas de red, en `facturacom.ts` — por eso
 * `construirCuerpoFacturaCom` los recibe ya resueltos en vez de derivarlos de
 * `EntradaCfdi`.
 *
 * Nombres de campo y comportamiento verificados con timbres reales contra su
 * sandbox (2026-09-28): individual y global, con descarga de PDF y XML —
 * no inventados. Ver la bitácora de esa sesión.
 */

import { calcularConcepto, tasa, type DetalleVenta, type EntradaCfdi } from "./cfdi.ts";

export interface ImpuestoFacturaCom {
  Base: number;
  Impuesto: string;
  TipoFactor: string;
  /** Ausente cuando el traslado es Exento — confirmado por analogía con el XML genérico. */
  TasaOCuota?: string;
  Importe?: number;
}

export interface ConceptoFacturaCom {
  ClaveProdServ: string;
  /** El folio de la nota en la factura global (C-000001); ausente si no hay. */
  NoIdentificacion?: string;
  Cantidad: number;
  ClaveUnidad: string;
  Unidad: string;
  ValorUnitario: number;
  Descripcion: string;
  /**
   * Descuento del renglón en base (sin IVA), en pesos. Ausente si no hay.
   * `ValorUnitario x Cantidad` es el Importe ANTES del descuento, así que sin
   * este campo el PAC no sabe que `Importe - Descuento` es la base del IVA y
   * timbra un total distinto del cobrado (sandbox, 2026-11-19: $98.62 en vez
   * de $90.00).
   */
  Descuento?: number;
  ObjetoImp: string;
  /** Ausente cuando ObjetoImp es "01" (no objeto de impuesto). */
  Impuestos?: { Traslados: ImpuestoFacturaCom[] };
}

export interface CuerpoFacturaCom {
  Receptor: { UID: string };
  TipoDocumento: "factura";
  Conceptos: ConceptoFacturaCom[];
  UsoCFDI: string;
  /** El `SerieID` numérico de `GET /v4/series` (tipo "factura"), NO una letra. */
  Serie: number;
  FormaPago: string;
  MetodoPago: string;
  Moneda: string;
  /** Siempre false: el correo lo manda esta app (mailer.ts), no el PAC. */
  EnviarCorreo: boolean;
  /** Sólo en la factura global. Nombres de campo confirmados contra la API real. */
  InformacionGlobal?: {
    Periodicidad: string;
    Meses: string;
    Año: string;
  };
}

/**
 * Un renglón a `Concepto` de Factura.com.
 *
 * Reusa `calcularConcepto()`, el mismo cálculo que usa el XML genérico: no
 * hay un segundo lugar donde la aritmética fiscal pueda divergir.
 */
function aConcepto(d: DetalleVenta): ConceptoFacturaCom {
  const c = calcularConcepto(d);
  const exento = d.tipo_factor === "Exento" || d.tasa_iva_ppm === 0;

  const concepto: ConceptoFacturaCom = {
    ClaveProdServ: d.clave_prod_serv,
    ...(d.no_identificacion ? { NoIdentificacion: d.no_identificacion } : {}),
    Cantidad: d.cantidad_mil / 1000,
    ClaveUnidad: d.clave_unidad,
    Unidad: d.unidad_medida,
    ValorUnitario: Number(c.valorUnitario),
    Descripcion: d.descripcion,
    ...(c.descuentoBaseCent > 0 ? { Descuento: c.descuentoBaseCent / 100 } : {}),
    ObjetoImp: d.objeto_imp,
  };

  // ObjetoImp "01" = no objeto de impuesto: sin nodo de impuestos, igual que
  // en el XML genérico.
  if (d.objeto_imp !== "01") {
    concepto.Impuestos = {
      Traslados: [{
        Base: c.baseTrasladoCent / 100,
        Impuesto: "002",
        TipoFactor: exento ? "Exento" : "Tasa",
        TasaOCuota: exento ? undefined : tasa(d.tasa_iva_ppm),
        Importe: exento ? undefined : c.ivaCent / 100,
      }],
    };
  }

  return concepto;
}

/**
 * Arma el cuerpo de `POST /v4/cfdi40/create`.
 *
 * `receptorUid` y `serieId` los resuelve `facturacom.ts` antes de llamar
 * aquí (consultar/crear el cliente, listar series) — ver el porqué en el
 * comentario de arriba del archivo.
 */
export function construirCuerpoFacturaCom(
  entrada: EntradaCfdi,
  receptorUid: string,
  serieId: number,
): CuerpoFacturaCom {
  const { venta, receptor, detalles, global } = entrada;

  const cuerpo: CuerpoFacturaCom = {
    Receptor: { UID: receptorUid },
    TipoDocumento: "factura",
    Conceptos: detalles.map(aConcepto),
    UsoCFDI: receptor.usoCfdi,
    Serie: serieId,
    FormaPago: venta.formaPago,
    MetodoPago: venta.metodoPago,
    Moneda: "MXN",
    EnviarCorreo: false,
  };

  // Presente sólo para la factura global. Confirmado con un timbre real de
  // sandbox (2026-09-28) con este nodo puesto; no se probó omitirlo con un
  // receptor de público en general, así que no se sabe si ahí también lo
  // exige.
  if (global) {
    cuerpo.InformacionGlobal = {
      Periodicidad: global.periodicidad,
      Meses: global.meses,
      Año: String(global.anio),
    };
  }

  return cuerpo;
}
