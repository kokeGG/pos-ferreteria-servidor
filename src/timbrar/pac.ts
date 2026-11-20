/**
 * Frontera con el PAC.
 *
 * Portado de `supabase/functions/timbrar/pac.ts` del POS. Cambios respecto al
 * original: `obtenerPac` recibe el entorno (no `Deno.env`), los mensajes
 * hablan de `.env` y se agrega la GUARDA DE SANDBOX (`verificarSandbox`).
 *
 * Se decidió Factura.com (ver `facturacom.ts`), pero la interfaz sigue
 * separada a propósito: cambiar de PAC es algo que pasa de verdad y no debe
 * obligar a tocar el cálculo fiscal.
 */

import type { EntradaCfdi } from "./cfdi.ts";
import type { Entorno } from "./entorno.ts";
import { PacFacturaCom } from "./facturacom.ts";
import { PacNoConfigurado } from "./guarda.ts";

export { ConfiguracionInsegura, PacNoConfigurado, verificarSandbox } from "./guarda.ts";

export interface Timbre {
  /** Folio fiscal que asigna el SAT. */
  uuid: string;
  /** XML ya timbrado, con el TimbreFiscalDigital incrustado. */
  xmlTimbrado: string;
  /** Representación impresa, si el PAC la genera. Muchos no. */
  pdf?: Uint8Array;
  /** Serie y folio del SAT, cuando el PAC los devuelve por separado. */
  serieFolio?: string;
}

export interface PAC {
  readonly nombre: string;
  /**
   * Arma (si hace falta), sella y timbra.
   *
   * El CSD no pasa por este servidor ni por `EntradaCfdi`: cada PAC lo
   * resguarda de su lado.
   */
  timbrar(entrada: EntradaCfdi): Promise<Timbre>;

  /**
   * Cancela ante el SAT el CFDI con ese UUID. `motivo` es el c_Motivo del
   * SAT ("02" errores sin relación, "03" no se llevó a cabo la operación).
   * Lanza si el PAC lo rechaza, con su mensaje tal cual.
   */
  cancelar(uuid: string, motivo: MotivoCancelacion): Promise<Cancelacion>;
}

/**
 * Motivos que la app ofrece. Fuera a propósito: "01" (exige emitir antes la
 * factura que sustituye y relacionarla) y "04" (nominativa que se incluyó en
 * una global): ninguno de los dos es un flujo que exista hoy en la caja.
 */
export type MotivoCancelacion = "02" | "03";

export interface Cancelacion {
  /** Acuse de cancelación del SAT (XML), si el PAC lo devuelve. */
  acuse: string | null;
  /** Mensaje del PAC, para la bitácora. */
  mensaje: string;
}

/**
 * Devuelve el adaptador según `PAC_PROVEEDOR`.
 *
 * Falla de forma explícita y ruidosa si no está puesta: un `timbrar` que
 * silenciosamente no timbra sería mucho peor que un error claro, porque la
 * venta quedaría marcada como facturada sin haberlo estado.
 */
export function obtenerPac(env: Entorno): PAC {
  switch (env.PAC_PROVEEDOR ?? "") {
    case "facturacom":
      return new PacFacturaCom(env);
    default:
      throw new PacNoConfigurado();
  }
}
