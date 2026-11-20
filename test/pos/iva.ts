/**
 * Cálculo de IVA en aritmética entera.
 *
 * Ver db/README.md §3 para la justificación completa y los números de la
 * verificación. El resumen:
 *
 *   - El IVA de cada renglón es el RESIDUO (`total - base`), no `base * tasa`.
 *     Se desvía como máximo 0.56 centavos de `Base x Tasa`, dentro de la
 *     tolerancia de ±1 centavo del Anexo 20.
 *   - El total de la venta es la SUMA DE RENGLONES YA REDONDEADOS, nunca un
 *     porcentaje del subtotal. Redondear al final descuadra el comprobante en
 *     el 14.1% de los tickets y el PAC lo rechaza.
 */

export const PPM = 1_000_000;

export interface RenglonFiscal {
  cantidadMil: number;
  precioUnitCent: number;
  descuentoCent: number;
  tasaIvaPpm: number;
  precioIncluyeIva: boolean;
}

export interface ImportesRenglon {
  importeCent: number; // base gravable, sin IVA
  ivaCent: number;
  totalCent: number;
}

/** Importes de un renglón. Todo entero, todo en centavos. */
export function calcularRenglon(r: RenglonFiscal): ImportesRenglon {
  const bruto = Math.round((r.precioUnitCent * r.cantidadMil) / 1000);
  const conDescuento = Math.max(0, bruto - r.descuentoCent);

  if (r.precioIncluyeIva) {
    // El precio de mostrador ya trae IVA: se desglosa hacia atrás.
    const importeCent = Math.round((conDescuento * PPM) / (PPM + r.tasaIvaPpm));
    return {
      importeCent,
      ivaCent: conDescuento - importeCent, // residuo: base + iva == total, siempre
      totalCent: conDescuento,
    };
  }

  const ivaCent = Math.round((conDescuento * r.tasaIvaPpm) / PPM);
  return {
    importeCent: conDescuento,
    ivaCent,
    totalCent: conDescuento + ivaCent,
  };
}

export interface TotalesVenta {
  subtotalCent: number;
  descuentoCent: number;
  impuestosCent: number;
  totalCent: number;
}

/**
 * Totales del comprobante: suma de renglones ya redondeados.
 * Cuadra por construcción — `subtotal + impuestos === total` no puede fallar.
 */
export function calcularTotales(
  renglones: readonly (ImportesRenglon & { descuentoCent: number })[],
): TotalesVenta {
  let subtotalCent = 0;
  let impuestosCent = 0;
  let totalCent = 0;
  let descuentoCent = 0;

  for (const r of renglones) {
    subtotalCent += r.importeCent;
    impuestosCent += r.ivaCent;
    totalCent += r.totalCent;
    descuentoCent += r.descuentoCent;
  }

  return { subtotalCent, descuentoCent, impuestosCent, totalCent };
}
