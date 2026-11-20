/**
 * Envío del CFDI por correo, vía SMTP de Gmail.
 *
 * El PAC no manda el correo: Factura.com lo puede hacer (`EnviarCorreo`),
 * pero se le pasa `false` a propósito — como el PDF y el XML ya están en
 * memoria justo después de timbrar, mandarlos nosotros mismos da control
 * total sobre la plantilla y el remitente, y no depende de la plantilla de
 * correo que tenga configurada la cuenta del PAC.
 *
 * Portado de la Edge Function (Deno): mismo `nodemailer` 6.9.16, pero el
 * entorno se inyecta y el transporte se puede sustituir (pruebas).
 *
 * Gmail por SMTP necesita una "contraseña de aplicación" (no la contraseña
 * normal de la cuenta): Cuenta de Google → Seguridad → Verificación en dos
 * pasos → Contraseñas de aplicaciones. Límite de envío de Gmail: ~500
 * correos/día, que sobra para una ferretería de un local.
 *
 * Variables (.env): GMAIL_USER, GMAIL_APP_PASSWORD y, opcionales,
 * CORREO_REMITENTE_NOMBRE (el nombre que ve el cliente; si falta, el fiscal) y
 * CORREO_RESPONDER_A (a dónde llegan las respuestas, si no es el mismo Gmail).
 *
 * Outlook/Hotmail/Microsoft 365 NO sirven como remitente aquí: Microsoft ya no
 * acepta SMTP con contraseña ni contraseña de aplicación (sólo OAuth). Con un
 * buzón de Outlook, se envía desde un Gmail dedicado y CORREO_RESPONDER_A apunta
 * al Outlook.
 */

import nodemailer from "nodemailer";
import { type Entorno, requerir } from "./entorno.ts";

/** Lo mínimo que se usa de un transporte de nodemailer; las pruebas ponen uno propio. */
export type Transporte = Pick<nodemailer.Transporter, "sendMail">;
export type CrearTransporte = (usuario: string, clave: string) => Transporte;

const transporteGmail: CrearTransporte = (usuario, clave) =>
  nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: usuario, pass: clave } });

export interface FacturaParaEnviar {
  destinatario: string;
  nombreCliente: string;
  folio: string;
  totalTexto: string;
  uuid: string;
  xml: string;
  pdf: Uint8Array;
}

/** `true` si hay credenciales de Gmail configuradas. */
export function hayCorreoConfigurado(env: Entorno): boolean {
  return Boolean(env.GMAIL_USER && env.GMAIL_APP_PASSWORD);
}

/**
 * Manda el CFDI (PDF + XML adjuntos) al correo del cliente.
 *
 * No atrapa errores: quien llama decide qué hacer si falla (en `index.ts`,
 * se guarda en `ventas.error_correo` sin tumbar el timbrado, que ya es
 * definitivo para entonces).
 */
export async function enviarFactura(
  f: FacturaParaEnviar,
  env: Entorno,
  crearTransporte: CrearTransporte = transporteGmail,
): Promise<void> {
  const usuario = requerir(env, "GMAIL_USER");
  const clave = requerir(env, "GMAIL_APP_PASSWORD");
  // El nombre que ve el cliente en el correo ("Ferretería La Base"), que no
  // tiene por qué ser el nombre fiscal del emisor: una persona física factura
  // con su nombre, pero el negocio se conoce por otro. Sin el secreto, el
  // nombre fiscal, como antes.
  const nombreEmisor =
    env.CORREO_REMITENTE_NOMBRE ?? env.CFDI_EMISOR_NOMBRE ?? "Ferretería";

  const transportador = crearTransporte(usuario, clave);

  // Si el negocio contesta desde otro buzón (p.ej. su Outlook, que ya no
  // permite enviar por SMTP con contraseña), las respuestas del cliente van
  // ahí y no a la cuenta de Gmail que sólo envía.
  const responderA = env.CORREO_RESPONDER_A || undefined;

  await transportador.sendMail({
    from: `${nombreEmisor} <${usuario}>`,
    replyTo: responderA,
    to: f.destinatario,
    subject: `Factura ${f.folio} — ${nombreEmisor}`,
    html: `
      <p>Hola${f.nombreCliente ? ` ${f.nombreCliente}` : ""},</p>
      <p>Adjunto tu factura <strong>${f.folio}</strong> por <strong>${f.totalTexto}</strong>.</p>
      <p style="color:#666;font-size:.85em">Folio fiscal (UUID): ${f.uuid}</p>
      <p>Gracias por tu compra.</p>
    `,
    attachments: [
      { filename: `${f.folio}.pdf`, content: Buffer.from(f.pdf), contentType: "application/pdf" },
      {
        filename: `${f.folio}.xml`,
        content: Buffer.from(f.xml, "utf8"),
        contentType: "application/xml",
      },
    ],
  });
}
