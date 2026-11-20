/**
 * GUARDA DE SANDBOX y errores de configuración del PAC.
 *
 * Aparte de `pac.ts` para que `facturacom.ts` pueda usarla sin un ciclo de
 * importaciones (`pac.ts` importa `facturacom.ts`).
 */

export class PacNoConfigurado extends Error {
  constructor(mensaje?: string) {
    super(
      mensaje ??
        "PAC_PROVEEDOR no está puesto (o no vale 'facturacom') en el .env del " +
          "servidor. El CFDI se arma y se valida correctamente, pero nadie lo " +
          "timbra. Ver PLAN.md, fase 5: PAC_PROVEEDOR=facturacom " +
          "FACTURACOM_API_KEY=... FACTURACOM_SECRET_KEY=... " +
          "FACTURACOM_BASE_URL=https://sandbox.factura.com/api",
    );
    this.name = "PacNoConfigurado";
  }
}

/** La URL del PAC no es la del sandbox: se rechaza (ver `verificarSandbox`). */
export class ConfiguracionInsegura extends PacNoConfigurado {
  constructor(motivo: string) {
    super(
      `Este servidor es de DEMOSTRACIÓN y solo timbra contra el sandbox de Factura.com. ${motivo} ` +
        "Corrige FACTURACOM_BASE_URL en el .env (https://sandbox.factura.com/api).",
    );
    this.name = "ConfiguracionInsegura";
  }
}

const ANFITRIONES_LOCALES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Devuelve la URL base del PAC solo si es el sandbox de Factura.com (o una
 * dirección de esta misma máquina, que es lo que usan las pruebas con un
 * Factura.com simulado y no puede facturar nada real). Falta, es producción
 * (`api.factura.com`), no se puede interpretar, o "sandbox" solo aparece en
 * otra parte de la URL (`https://api.factura.com/sandbox`,
 * `https://sandbox.factura.com.evil.com`): se rechaza.
 *
 * Sin esta guarda, un `.env` copiado de producción timbraría facturas reales
 * desde la demo, que es el riesgo que originó todo este proyecto.
 */
export function verificarSandbox(baseUrl: string | undefined): string {
  if (!baseUrl) {
    // Por omisión la API de Factura.com es producción: aquí no hay omisión.
    throw new ConfiguracionInsegura("FACTURACOM_BASE_URL no está puesta (por omisión sería producción).");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfiguracionInsegura("FACTURACOM_BASE_URL no es una URL válida.");
  }
  if (url.username || url.password) {
    throw new ConfiguracionInsegura("FACTURACOM_BASE_URL no debe llevar usuario ni contraseña.");
  }
  const esSandbox = url.protocol === "https:" && url.hostname === "sandbox.factura.com";
  const esLocal = (url.protocol === "http:" || url.protocol === "https:") && ANFITRIONES_LOCALES.has(url.hostname);
  if (!esSandbox && !esLocal) {
    throw new ConfiguracionInsegura(`FACTURACOM_BASE_URL apunta a "${url.host}", que no es el sandbox.`);
  }
  return baseUrl.replace(/\/+$/, "");
}
