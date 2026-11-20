/**
 * Armado del CFDI 4.0 a partir de una venta.
 *
 * Módulo PURO a propósito: no toca Deno, red ni base. Así el mismo código que
 * corre en la Edge Function se prueba con vitest desde el repo
 * (src/lib/cfdi.test.ts), que es donde vive la verificación numérica del IVA.
 *
 * Todo entra en centavos enteros y sale como cadena con 2 decimales. La
 * conversión a decimal ocurre UNA sola vez, aquí, en el último momento: es la
 * única frontera donde el SAT obliga a escribir un decimal. Ver db/README.md.
 */

export const PPM = 1_000_000;

/** IVA en el catálogo de impuestos del SAT (c_Impuesto). */
const IMPUESTO_IVA = "002";

export interface DetalleVenta {
  clave_prod_serv: string;
  clave_unidad: string;
  /** "PIEZA", "KILO"... — texto libre para el `Unit` humano, no un catálogo SAT. */
  unidad_medida: string;
  descripcion: string;
  cantidad_mil: number;
  precio_unit_cent: number;
  descuento_cent: number;
  importe_cent: number; // base gravable YA con el descuento aplicado
  iva_cent: number;
  total_cent: number;
  objeto_imp: string;
  tipo_factor: string;
  tasa_iva_ppm: number;
  /**
   * NoIdentificacion del concepto. En la factura global es el folio de la
   * nota de venta que representa (C-000001), como pide la guía de llenado
   * del SAT; en una factura normal no se usa.
   */
  no_identificacion?: string;
}

export interface DatosEmisor {
  rfc: string;
  nombre: string;
  regimenFiscal: string;
  codigoPostal: string;
}

export interface DatosReceptor {
  rfc: string;
  nombre: string;
  domicilioFiscal: string;
  regimenFiscal: string;
  usoCfdi: string;
  /**
   * Lo usa el PAC (Factura.com): su API exige un receptor pre-registrado, y
   * para darlo de alta la primera vez que se le factura pide su correo. Va
   * opcional aquí, no en `DatosReceptor` en general, porque es un requisito
   * de ESTE PAC, no del CFDI: un adaptador futuro podría no necesitarlo.
   */
  email?: string;
}

export interface DatosVenta {
  serie: string;
  folio: string;
  /** Fecha LOCAL del emisor, sin zona. El SAT no acepta `Z` ni desfase. */
  fecha: string;
  formaPago: string;
  metodoPago: string;
  /**
   * Lo que la caja cobró de verdad. Es el ÚNICO total que se toma de la venta:
   * SubTotal, Descuento y Traslados se derivan de los conceptos.
   *
   * No es lo mismo que `ventas.subtotal_cent`, y confundirlos es un rechazo
   * seguro: el POS guarda el subtotal YA con el descuento restado, mientras
   * que el `SubTotal` del CFDI es la suma de los conceptos ANTES de descuento.
   * Derivarlo aquí hace imposible mezclar las dos definiciones.
   */
  totalCent: number;
}

/** Centavos enteros -> cadena decimal con 2 posiciones, sin coma flotante. */
export function pesos(cent: number): string {
  const signo = cent < 0 ? "-" : "";
  const n = Math.abs(cent);
  return `${signo}${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
}

/** Milésimas enteras -> cantidad con hasta 3 decimales, sin ceros de relleno. */
export function cantidad(mil: number): string {
  const entero = Math.floor(mil / 1000);
  const frac = String(mil % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac === "" ? String(entero) : `${entero}.${frac}`;
}

/** Tasa en ppm -> la forma que exige el Anexo 20: 160000 -> "0.160000". */
export function tasa(ppm: number): string {
  return (ppm / PPM).toFixed(6);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function atributos(pares: Record<string, string | undefined>): string {
  return Object.entries(pares)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}="${xmlEscape(v as string)}"`)
    .join(" ");
}

export interface ConceptoCalculado {
  /** Base antes de descuento. Es el `Importe` del concepto. */
  importeBaseCent: number;
  /** Descuento expresado en base, sin IVA. */
  descuentoBaseCent: number;
  /** Base del traslado: importe - descuento. */
  baseTrasladoCent: number;
  ivaCent: number;
  /** Valor unitario sin IVA, a 6 decimales. */
  valorUnitario: string;
}

/**
 * Convierte un renglón del POS a los importes que pide el CFDI.
 *
 * El POS guarda el precio de mostrador CON IVA y el descuento aplicado sobre
 * ese precio; el SAT quiere todo en base sin IVA. La conversión del descuento
 * usa la misma tasa del renglón, así que `Importe - Descuento` vuelve a dar
 * exactamente la base que el POS ya había calculado, y el comprobante cuadra
 * por construcción:
 *
 *     Total = SubTotal - Descuento + Traslados
 *           = (base + descBase) - descBase + iva
 *           = base + iva                              <- el total cobrado
 *
 * Por eso no se recalcula nada a partir de porcentajes: se respeta lo que la
 * caja ya cobró, que es el número que el cliente tiene en la mano.
 */
export function calcularConcepto(d: DetalleVenta): ConceptoCalculado {
  const exento = d.tipo_factor === "Exento" || d.tasa_iva_ppm === 0;

  const descuentoBaseCent = exento
    ? d.descuento_cent
    : Math.round((d.descuento_cent * PPM) / (PPM + d.tasa_iva_ppm));

  const importeBaseCent = d.importe_cent + descuentoBaseCent;

  // ValorUnitario a 6 decimales (el máximo del Anexo 20). El PAC valida
  // Importe ~= Cantidad x ValorUnitario con tolerancia; derivarlo de la base
  // ya redondeada mantiene el error por debajo de medio centavo.
  const unidades = d.cantidad_mil / 1000;
  const valorUnitario = (importeBaseCent / 100 / unidades).toFixed(6);

  return {
    importeBaseCent,
    descuentoBaseCent,
    baseTrasladoCent: d.importe_cent,
    ivaCent: d.iva_cent,
    valorUnitario,
  };
}

function concepto(d: DetalleVenta): string {
  const c = calcularConcepto(d);
  const exento = d.tipo_factor === "Exento" || d.tasa_iva_ppm === 0;

  const cabecera = atributos({
    ClaveProdServ: d.clave_prod_serv,
    NoIdentificacion: d.no_identificacion,
    Cantidad: cantidad(d.cantidad_mil),
    ClaveUnidad: d.clave_unidad,
    Descripcion: d.descripcion,
    ValorUnitario: c.valorUnitario,
    Importe: pesos(c.importeBaseCent),
    Descuento: c.descuentoBaseCent > 0 ? pesos(c.descuentoBaseCent) : undefined,
    ObjetoImp: d.objeto_imp,
  });

  // ObjetoImp "01" = no objeto de impuesto: no lleva nodo de impuestos.
  if (d.objeto_imp === "01") {
    return `      <cfdi:Concepto ${cabecera}/>`;
  }

  const traslado = atributos({
    Base: pesos(c.baseTrasladoCent),
    Impuesto: IMPUESTO_IVA,
    TipoFactor: exento ? "Exento" : d.tipo_factor,
    // Un traslado exento NO lleva TasaOCuota ni Importe.
    TasaOCuota: exento ? undefined : tasa(d.tasa_iva_ppm),
    Importe: exento ? undefined : pesos(c.ivaCent),
  });

  return `      <cfdi:Concepto ${cabecera}>
        <cfdi:Impuestos>
          <cfdi:Traslados>
            <cfdi:Traslado ${traslado}/>
          </cfdi:Traslados>
        </cfdi:Impuestos>
      </cfdi:Concepto>`;
}

/**
 * Agrupa los traslados del comprobante.
 *
 * El SAT los quiere sumados por (Impuesto, TipoFactor, TasaOCuota), no renglón
 * por renglón. Sumar los importes YA redondeados de cada concepto —en vez de
 * aplicar la tasa al total— es lo que hace que el nodo de Impuestos cuadre con
 * la suma de los conceptos. Ver db/README.md §3.
 */
function impuestosComprobante(detalles: DetalleVenta[]): string {
  const grupos = new Map<string, { base: number; iva: number; ppm: number }>();
  let totalTrasladado = 0;

  for (const d of detalles) {
    if (d.objeto_imp === "01") continue;
    const exento = d.tipo_factor === "Exento" || d.tasa_iva_ppm === 0;
    const c = calcularConcepto(d);
    const llave = exento ? "Exento" : `Tasa|${d.tasa_iva_ppm}`;

    const g = grupos.get(llave) ?? { base: 0, iva: 0, ppm: d.tasa_iva_ppm };
    g.base += c.baseTrasladoCent;
    g.iva += exento ? 0 : c.ivaCent;
    grupos.set(llave, g);
    if (!exento) totalTrasladado += c.ivaCent;
  }

  if (grupos.size === 0) return "";

  const filas = [...grupos.entries()]
    .map(([llave, g]) => {
      const exento = llave === "Exento";
      return `        <cfdi:Traslado ${atributos({
        Base: pesos(g.base),
        Impuesto: IMPUESTO_IVA,
        TipoFactor: exento ? "Exento" : "Tasa",
        TasaOCuota: exento ? undefined : tasa(g.ppm),
        Importe: exento ? undefined : pesos(g.iva),
      })}/>`;
    })
    .join("\n");

  const attrTotal =
    totalTrasladado > 0
      ? ` TotalImpuestosTrasladados="${pesos(totalTrasladado)}"`
      : "";

  return `      <cfdi:Impuestos${attrTotal}>
        <cfdi:Traslados>
${filas}
        </cfdi:Traslados>
      </cfdi:Impuestos>`;
}

/**
 * Presente sólo cuando el receptor es "público en general"
 * (`XAXX010101000`): el CFDI 4.0 exige este nodo en ese caso, con el periodo
 * que agrupa. Nombres de campo verificados contra la API real de Factura.com
 * (2026-09-28): `Periodicidad`/`Meses`/`Año` — ver facturacom-cuerpo.ts.
 */
export interface InformacionGlobal {
  /** c_Periodicidad del SAT: '01' diario ... '05' bimestral. */
  periodicidad: string;
  /** c_Meses: '01'..'12', o '13'..'18' para los bimestres. */
  meses: string;
  anio: number;
}

export interface EntradaCfdi {
  venta: DatosVenta;
  emisor: DatosEmisor;
  receptor: DatosReceptor;
  detalles: DetalleVenta[];
  /** Sólo para la factura global (ventas a público en general del periodo). */
  global?: InformacionGlobal;
  /** Certificado (.cer) en base64 y su número. Si el PAC sella, van vacíos. */
  noCertificado?: string;
  certificado?: string;
}

/**
 * Arma el XML del CFDI 4.0 SIN sellar.
 *
 * El sello y el certificado los pone quien tenga la llave privada: o esta
 * función recibe el certificado y el PAC sella, o el PAC hace las dos cosas.
 * El CSD nunca pasa por aquí.
 */
export function construirCfdi(e: EntradaCfdi): string {
  const { venta, emisor, receptor, detalles } = e;
  const { subtotalCent, descuentoCent } = totalesDerivados(detalles);

  const comprobante = atributos({
    "xmlns:cfdi": "http://www.sat.gob.mx/cfd/4",
    "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
    "xsi:schemaLocation":
      "http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd",
    Version: "4.0",
    Serie: venta.serie,
    Folio: venta.folio,
    Fecha: venta.fecha,
    NoCertificado: e.noCertificado,
    Certificado: e.certificado,
    FormaPago: venta.formaPago,
    SubTotal: pesos(subtotalCent),
    Descuento: descuentoCent > 0 ? pesos(descuentoCent) : undefined,
    Moneda: "MXN",
    Total: pesos(venta.totalCent),
    TipoDeComprobante: "I",
    Exportacion: "01",
    MetodoPago: venta.metodoPago,
    LugarExpedicion: emisor.codigoPostal,
  });

  const nodoImpuestos = impuestosComprobante(detalles);

  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante ${comprobante}>
      <cfdi:Emisor ${atributos({
        Rfc: emisor.rfc,
        Nombre: emisor.nombre,
        RegimenFiscal: emisor.regimenFiscal,
      })}/>
      <cfdi:Receptor ${atributos({
        Rfc: receptor.rfc,
        Nombre: receptor.nombre,
        DomicilioFiscalReceptor: receptor.domicilioFiscal,
        RegimenFiscalReceptor: receptor.regimenFiscal,
        UsoCFDI: receptor.usoCfdi,
      })}/>
      <cfdi:Conceptos>
${detalles.map(concepto).join("\n")}
      </cfdi:Conceptos>
${nodoImpuestos}
</cfdi:Comprobante>`;
}

export interface TotalesDerivados {
  subtotalCent: number;
  descuentoCent: number;
  trasladosCent: number;
  totalCent: number;
}

/**
 * Los totales del comprobante, derivados de los conceptos.
 *
 * Un solo lugar calcula estos cuatro números, y tanto el XML como la
 * verificación lo usan. Si el `SubTotal` del encabezado y el de los conceptos
 * se calcularan por separado, tarde o temprano divergirían — que es
 * exactamente el rechazo que se quiere evitar.
 */
export function totalesDerivados(detalles: DetalleVenta[]): TotalesDerivados {
  let subtotalCent = 0;
  let descuentoCent = 0;
  let trasladosCent = 0;

  for (const d of detalles) {
    const c = calcularConcepto(d);
    subtotalCent += c.importeBaseCent;
    descuentoCent += c.descuentoBaseCent;
    if (d.objeto_imp !== "01" && d.tipo_factor !== "Exento") {
      trasladosCent += c.ivaCent;
    }
  }

  return {
    subtotalCent,
    descuentoCent,
    trasladosCent,
    totalCent: subtotalCent - descuentoCent + trasladosCent,
  };
}

/**
 * Comprueba la igualdad que el PAC valida a nivel comprobante antes de gastar
 * un timbre. Devuelve la lista de descuadres, vacía si todo cuadra.
 *
 * Existe porque un rechazo del PAC llega como un código opaco y con el timbre
 * ya consumido; verlo aquí cuesta microsegundos y dice exactamente qué número
 * no cuadra.
 */
export function verificarTotales(e: EntradaCfdi): string[] {
  const t = totalesDerivados(e.detalles);
  if (t.totalCent === e.venta.totalCent) return [];

  return [
    `Total: SubTotal ${pesos(t.subtotalCent)} - Descuento ${pesos(t.descuentoCent)} ` +
      `+ Traslados ${pesos(t.trasladosCent)} = ${pesos(t.totalCent)}, ` +
      `pero la caja cobró ${pesos(e.venta.totalCent)}`,
  ];
}

// ---------------------------------------------------------------------------
// Conceptos de un CFDI a público en general (InformacionGlobal)
// ---------------------------------------------------------------------------

/**
 * Un solo concepto que resume la venta: lo usa la factura de UNA venta a un
 * cliente con RFC genérico (ver `timbrarVenta` en index.ts).
 */
export function conceptoResumen(subtotalCent: number, ivaCent: number, totalCent: number): DetalleVenta {
  return {
    clave_prod_serv: "01010101", // "No existe en el catálogo" — estándar para esto
    clave_unidad: "ACT", // Actividad
    unidad_medida: "ACTIVIDAD",
    descripcion: "Venta de bienes y/o prestación de servicios",
    cantidad_mil: 1000,
    precio_unit_cent: totalCent,
    descuento_cent: 0,
    importe_cent: subtotalCent,
    iva_cent: ivaCent,
    total_cent: totalCent,
    objeto_imp: "02",
    tipo_factor: "Tasa",
    tasa_iva_ppm: 160_000,
  };
}

export interface NotaDeGlobal {
  caja_id: string;
  folio_local: number;
  subtotal_cent: number;
  impuestos_cent: number;
  total_cent: number;
}

/**
 * Factura global: UN concepto por nota de venta, con el folio de la nota en
 * NoIdentificacion (C-000001), como pide la guía de llenado del SAT para la
 * factura global — así cada nota del día se ve en el PDF y se encuentra en la
 * global por su folio. Clave 01010101, unidad ACT, cantidad 1 y "Venta"; el
 * importe e IVA son los de esa nota, así que la suma cuadra con los totales
 * que la global congeló al generarse.
 *
 * Ordenadas por letra y folio. Las notas siempre usan el formato LETRA-NÚMERO
 * (las facturas, NÚMERO-LETRA, nunca entran a una global).
 */
export function conceptosPorNota(notas: readonly NotaDeGlobal[]): DetalleVenta[] {
  return [...notas]
    .sort((a, b) => (a.caja_id === b.caja_id ? a.folio_local - b.folio_local : a.caja_id < b.caja_id ? -1 : 1))
    .map((n) => ({
      ...conceptoResumen(n.subtotal_cent, n.impuestos_cent, n.total_cent),
      descripcion: "Venta",
      no_identificacion: `${n.caja_id}-${String(n.folio_local).padStart(6, "0")}`,
    }));
}
