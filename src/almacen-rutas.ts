/**
 * Rutas HTTP del almacenamiento (fase 4).
 *
 *   PUT  /storage/:bucket/*           sube (autenticado; no sobrescribe)
 *   GET  /storage/:bucket/*           baja (autenticado)
 *   POST /storage/:bucket/firmar      URL firmada de vigencia corta
 *   GET  /firmado/:bucket/*?exp&sig   baja con la URL firmada (sin token)
 *   GET  /actualizaciones/*           público, solo lectura (latest.json e instaladores)
 *
 * Los cfdi son privados; `app-updates` solo se sirve por `/actualizaciones` y
 * no se puede escribir por HTTP: el desarrollador copia los archivos a la
 * carpeta a mano.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type Almacen,
  BUCKETS,
  claveDeFirmas,
  ErrorAlmacen,
  esBucket,
  firmarUrl,
  MAX_SEGUNDOS_FIRMA,
  SEGUNDOS_FIRMA,
  tipoDe,
  verificarFirma,
} from "./almacen.js";

const MAYOR_SUBIDA = Math.max(...Object.values(BUCKETS).filter((b) => !b.publico).map((b) => b.maxBytes));

/** Buckets que se pueden tocar por `/storage` (los privados). */
const esPrivado = (bucket: string) => esBucket(bucket) && !BUCKETS[bucket].publico;

const paramsBucket = {
  type: "object",
  required: ["bucket", "*"],
  properties: { bucket: { type: "string", maxLength: 64 }, "*": { type: "string", maxLength: 512 } },
} as const;

export function registrarAlmacen(app: FastifyInstance, almacen: Almacen, jwtSecret: string): void {
  const clave = claveDeFirmas(jwtSecret);

  // Cuerpos binarios tal cual (Fastify solo entiende JSON y texto de fábrica).
  app.addContentTypeParser(["application/xml", "text/xml", "application/pdf"], { parseAs: "buffer" }, (_req, cuerpo, hecho) =>
    hecho(null, cuerpo),
  );

  function responder(reply: FastifyReply, e: unknown) {
    if (e instanceof ErrorAlmacen) return reply.code(e.estado).send({ code: "ALMACEN", message: e.message });
    throw e;
  }

  /** Un bucket que no es privado no existe para `/storage`: ni 403 que confirme que está. */
  const noEsPrivado = (reply: FastifyReply, bucket: string) =>
    esPrivado(bucket) ? null : reply.code(404).send({ code: "ALMACEN", message: `Bucket inexistente: ${bucket}` });

  app.put<{ Params: { bucket: string; "*": string }; Body: unknown }>(
    "/storage/:bucket/*",
    { onRequest: app.autenticar, bodyLimit: MAYOR_SUBIDA, schema: { params: paramsBucket } },
    async (req, reply) => {
      const { bucket, "*": ruta } = req.params;
      const rechazo = noEsPrivado(reply, bucket);
      if (rechazo) return rechazo;
      if (!Buffer.isBuffer(req.body)) {
        return reply.code(415).send({ code: "ALMACEN", message: "Se esperaba un cuerpo binario con su Content-Type" });
      }
      try {
        await almacen.guardar(bucket, ruta, req.body, req.headers["content-type"] ?? "");
      } catch (e) {
        return responder(reply, e);
      }
      return reply.code(201).send({ bucket, ruta });
    },
  );

  app.get<{ Params: { bucket: string; "*": string } }>(
    "/storage/:bucket/*",
    { onRequest: app.autenticar, schema: { params: paramsBucket } },
    async (req, reply) => {
      const { bucket, "*": ruta } = req.params;
      const rechazo = noEsPrivado(reply, bucket);
      if (rechazo) return rechazo;
      try {
        const datos = await almacen.leer(bucket, ruta);
        if (!datos) return reply.code(404).send({ code: "ALMACEN", message: "No existe ese archivo" });
        return reply.header("cache-control", "private, no-store").type(tipoDe(ruta)).send(datos);
      } catch (e) {
        return responder(reply, e);
      }
    },
  );

  app.post<{ Params: { bucket: string }; Body: { ruta: string; expira_en?: number } }>(
    "/storage/:bucket/firmar",
    {
      onRequest: app.autenticar,
      schema: {
        params: { type: "object", required: ["bucket"], properties: { bucket: { type: "string", maxLength: 64 } } },
        body: {
          type: "object",
          required: ["ruta"],
          additionalProperties: false,
          properties: {
            ruta: { type: "string", minLength: 1, maxLength: 512 },
            expira_en: { type: "integer", minimum: 1, maximum: MAX_SEGUNDOS_FIRMA },
          },
        },
      },
    },
    async (req, reply) => {
      const { bucket } = req.params;
      const { ruta, expira_en = SEGUNDOS_FIRMA } = req.body;
      const rechazo = noEsPrivado(reply, bucket);
      if (rechazo) return rechazo;
      try {
        if (!(await almacen.existe(bucket, ruta))) {
          return reply.code(404).send({ code: "ALMACEN", message: "No existe ese archivo" });
        }
      } catch (e) {
        return responder(reply, e);
      }
      const { exp, sig } = firmarUrl(clave, bucket, ruta, expira_en);
      const consulta = new URLSearchParams({ exp: String(exp), sig });
      const url = `${req.protocol}://${req.headers.host}/firmado/${bucket}/${ruta}?${consulta}`;
      return { url, expira_en };
    },
  );

  app.get<{ Params: { bucket: string; "*": string }; Querystring: { exp: number; sig: string } }>(
    "/firmado/:bucket/*",
    {
      schema: {
        params: paramsBucket,
        querystring: {
          type: "object",
          required: ["exp", "sig"],
          additionalProperties: false,
          properties: { exp: { type: "integer" }, sig: { type: "string", maxLength: 128 } },
        },
      },
    },
    async (req, reply) => {
      const { bucket, "*": ruta } = req.params;
      const rechazo = noEsPrivado(reply, bucket);
      if (rechazo) return rechazo;
      // La firma se comprueba ANTES de tocar el disco, y el mismo error para
      // vencida, alterada o de otra ruta: no se distingue cuál fue.
      if (!verificarFirma(clave, bucket, ruta, req.query.exp, req.query.sig)) {
        return reply.code(403).send({ code: "ALMACEN", message: "Enlace inválido o vencido" });
      }
      try {
        const datos = await almacen.leer(bucket, ruta);
        if (!datos) return reply.code(404).send({ code: "ALMACEN", message: "No existe ese archivo" });
        return reply.header("cache-control", "private, no-store").type(tipoDe(ruta)).send(datos);
      } catch (e) {
        return responder(reply, e);
      }
    },
  );

  // Público y de solo lectura: no se registra ningún otro método, así que un
  // PUT/POST/DELETE aquí da 404 sin que ningún código de escritura exista.
  app.get<{ Params: { "*": string } }>(
    "/actualizaciones/*",
    { schema: { params: { type: "object", required: ["*"], properties: { "*": { type: "string", maxLength: 512 } } } } },
    async (req, reply) => {
      try {
        const archivo = await almacen.abrir("app-updates", req.params["*"]);
        if (!archivo) return reply.code(404).send({ code: "ALMACEN", message: "No existe ese archivo" });
        return reply.header("content-length", archivo.bytes).type(tipoDe(req.params["*"])).send(archivo.flujo);
      } catch (e) {
        return responder(reply, e);
      }
    },
  );
}
