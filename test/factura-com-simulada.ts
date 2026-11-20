/**
 * Factura.com simulado: un servidor HTTP local con las rutas que usa
 * `facturacom.ts` y la forma de respuesta verificada contra su sandbox real
 * (incluido que un rechazo puede llegar con HTTP 200 y `response: "error"`).
 *
 * Sirve para probar errores, cancelaciones y reintentos SIN gastar timbres.
 * Lo que NO puede probar es que el sandbox real acepte el comprobante: eso
 * solo lo hace un recorrido con las llaves reales.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const LLAVE = "llave-de-prueba";
export const SECRETO = "secreto-de-prueba";

export interface Llamada {
  metodo: string;
  ruta: string;
  cuerpo: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cabeceras: IncomingMessage["headers"];
}

export interface Comportamiento {
  /** `POST /v4/cfdi40/create` */
  crear: "ok" | "rechazo200" | "http500" | "sin-json" | "uuid-invalido";
  /** `POST /v4/cfdi40/{uid}/cancel` */
  cancelar: "ok" | "sin-acuse" | "rechazo200" | "http500";
  /** Espera antes de responder al crear (para provocar peticiones simultáneas). */
  demoraCrearMs: number;
  /** El PDF no se puede descargar (HTTP 500). */
  sinPdf: boolean;
  /** Siempre devuelve este UUID al timbrar (un reintento del PAC devuelve el mismo). */
  uuidFijo: string | null;
}

export async function iniciarFacturaCom() {
  const llamadas: Llamada[] = [];
  const comportamiento: Comportamiento = { crear: "ok", cancelar: "ok", demoraCrearMs: 0, sinPdf: false, uuidFijo: null };
  const clientes = new Map<string, string>(); // rfc -> UID
  const timbres = new Map<string, { uuid: string; xml: string }>(); // uid -> timbre
  const canceladas = new Set<string>();

  const server: Server = createServer(async (req, res) => {
    const trozos: Buffer[] = [];
    for await (const t of req) trozos.push(t as Buffer);
    const bruto = Buffer.concat(trozos).toString("utf8");
    let cuerpo: any = undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      cuerpo = bruto ? JSON.parse(bruto) : undefined;
    } catch {
      cuerpo = bruto;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const metodo = req.method ?? "GET";
    llamadas.push({ metodo, ruta: url.pathname, cuerpo, cabeceras: req.headers });

    const json = (estado: number, datos: unknown) => {
      res.writeHead(estado, { "content-type": "application/json" });
      res.end(JSON.stringify(datos));
    };

    if (req.headers["f-api-key"] !== LLAVE || req.headers["f-secret-key"] !== SECRETO) {
      return json(401, { response: "error", status: "error", message: "Credenciales inválidas" });
    }

    let m: RegExpMatchArray | null;
    if (metodo === "GET" && (m = url.pathname.match(/^\/v1\/clients\/rfc\/(.+)$/))) {
      const uid = clientes.get(decodeURIComponent(m[1]!));
      return uid ? json(200, { status: "success", Data: { UID: uid } }) : json(200, { status: "error", message: "No existe" });
    }
    if (metodo === "POST" && url.pathname === "/v1/clients/create") {
      const uid = `cli-${randomUUID().slice(0, 8)}`;
      clientes.set(cuerpo.rfc, uid);
      return json(200, { status: "success", Data: { UID: uid } });
    }
    if (metodo === "GET" && url.pathname === "/v4/series") {
      return json(200, { status: "success", data: [{ SerieID: 7, SerieType: "factura" }] });
    }
    if (metodo === "POST" && url.pathname === "/v4/cfdi40/create") {
      if (comportamiento.demoraCrearMs) await new Promise((r) => setTimeout(r, comportamiento.demoraCrearMs));
      switch (comportamiento.crear) {
        case "rechazo200":
          return json(200, { response: "error", message: "CFDI40145 - El RFC del receptor no es válido" });
        case "http500":
          res.writeHead(500, { "content-type": "text/plain" });
          return res.end("Internal Server Error");
        case "sin-json":
          res.writeHead(200, { "content-type": "text/html" });
          return res.end("<html>mantenimiento</html>");
        default: {
          const uuid = comportamiento.crear === "uuid-invalido" ? "no-es-un-uuid" : (comportamiento.uuidFijo ?? randomUUID().toUpperCase());
          const uid = `inv-${randomUUID().slice(0, 8)}`;
          timbres.set(uid, { uuid, xml: `<cfdi:Comprobante Serie="${cuerpo.Serie}"><tfd:TimbreFiscalDigital UUID="${uuid}"/></cfdi:Comprobante>` });
          return json(200, { response: "success", message: "Factura creada", UUID: uuid, invoice_uid: uid });
        }
      }
    }
    if (metodo === "GET" && (m = url.pathname.match(/^\/v4\/cfdi40\/([^/]+)\/(xml|pdf)$/))) {
      const t = timbres.get(m[1]!);
      if (!t) return json(404, { response: "error" });
      if (m[2] === "xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(t.xml);
      }
      if (comportamiento.sinPdf) {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(t.uuid), Buffer.alloc(512, 3)]));
    }
    if (metodo === "GET" && (m = url.pathname.match(/^\/v4\/cfdi\/uuid\/(.+)$/))) {
      const uuid = decodeURIComponent(m[1]!);
      for (const [uid, t] of timbres) if (t.uuid === uuid) return json(200, { Data: { UID: uid } });
      return json(404, { response: "error" });
    }
    if (metodo === "POST" && (m = url.pathname.match(/^\/v4\/cfdi40\/([^/]+)\/cancel$/))) {
      const uid = decodeURIComponent(m[1]!);
      switch (comportamiento.cancelar) {
        case "rechazo200":
          return json(200, { response: "error", message: "No se puede cancelar: el receptor debe aceptar la cancelación" });
        case "http500":
          res.writeHead(500);
          return res.end("boom");
        case "sin-acuse":
          canceladas.add(uid);
          return json(200, { response: "success", message: "Cancelación en proceso" });
        default:
          canceladas.add(uid);
          return json(200, { response: "success", message: "Cancelado", respuestaapi: { response: "success", acuse: `<Acuse uid="${uid}"/>` } });
      }
    }
    return json(404, { response: "error", message: `ruta no simulada: ${metodo} ${url.pathname}` });
  });

  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    llamadas,
    comportamiento,
    clientes,
    timbres,
    canceladas,
    /** Cuántas veces se pidió timbrar. */
    creaciones: () => llamadas.filter((l) => l.metodo === "POST" && l.ruta === "/v4/cfdi40/create"),
    cancelaciones: () => llamadas.filter((l) => l.metodo === "POST" && /\/cancel$/.test(l.ruta)),
    reiniciar() {
      llamadas.length = 0;
      clientes.clear();
      timbres.clear();
      canceladas.clear();
      Object.assign(comportamiento, { crear: "ok", cancelar: "ok", demoraCrearMs: 0, sinPdf: false, uuidFijo: null });
    },
    cerrar: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
