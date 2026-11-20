/**
 * Mensajes de rechazo de Factura.com, en una forma legible para el cajero.
 *
 * Módulo PURO a propósito (sin `Deno`, sin red): así se prueba con vitest
 * desde el repo (src/lib/facturacom.test.ts), igual que facturacom-cuerpo.ts.
 *
 * El campo `message` de Factura.com no siempre es texto: en un rechazo real
 * (verificado 2026-10-28) llega como `{"message":"CFDI40145 - ...", ...}`, no
 * como cadena — tratarlo siempre como `string` lo perdía, y el error que veía
 * el cajero era 1000 caracteres de JSON + el XML completo, no el motivo real
 * del rechazo.
 */

export type MensajePac = string | { message?: string; messageDetail?: string } | undefined;

/**
 * Mensajes de Factura.com/SAT de los que ya sabemos, por un caso real, qué
 * significan y cómo se arreglan — para dárselo al cajero en español llano en
 * vez de sólo el código. Lista corta a propósito: sólo se agrega uno aquí
 * cuando se ve ocurrir de verdad, no por anticipado.
 */
const MENSAJES_CONOCIDOS: Record<string, string> = {
  CFDI40145:
    "El nombre del cliente no coincide con el que el SAT tiene registrado para ese RFC. " +
    "Corrige la razón social en Clientes (Ctrl+3) exactamente como aparece en su constancia " +
    "de situación fiscal, y vuelve a facturar.",
};

/** El texto del mensaje, sea que `m` venga como cadena o como `{message: "..."}`. */
export function extraerMensaje(m: MensajePac): string | undefined {
  if (typeof m === "string") return m || undefined;
  if (m && typeof m === "object") return m.message || undefined;
  return undefined;
}

/** Le agrega la explicación conocida (ver `MENSAJES_CONOCIDOS`) si el código la tiene. */
export function mensajeAmigable(bruto: string): string {
  const codigo = bruto.match(/^([A-Z]+\d+)/)?.[1];
  const sugerencia = codigo ? MENSAJES_CONOCIDOS[codigo] : undefined;
  return sugerencia ? `${bruto}\n\n${sugerencia}` : bruto;
}
