/**
 * `POST /timbrar` (fase 5): sustituye a la Edge Function de Supabase.
 *
 *     { "venta_id": "<uuid>" }
 *     { "factura_global_id": "<uuid>" }
 *     { "cancelar": { "venta_id" | "factura_global_id", "motivo": "02"|"03", "motivo_texto" } }
 *     { "reenviar_correo": { "venta_id" | "factura_global_id" } }
 *
 * Mismo contrato que la función original: las respuestas de error son
 * `{ error: "<mensaje para el cajero>" }`, que es lo que lee `mensajeDeError`
 * del POS.
 */

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Almacen } from "../almacen.js";
import type { Entorno } from "./entorno.ts";
import type { CrearTransporte } from "./mailer.ts";
import type { PAC } from "./pac.ts";
import { repositorioPg } from "./repositorio.ts";
import { crearServicioTimbrado, ejecutar, interpretar, type CuerpoTimbrar } from "./servicio.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpcionesTimbrar {
  entorno: Entorno;
  /** Sustituir el PAC (pruebas). Por omisión, el de `PAC_PROVEEDOR`. */
  obtenerPac?: () => PAC;
  /** Sustituir el transporte de correo (pruebas). Por omisión, el SMTP de Gmail. */
  crearTransporte?: CrearTransporte;
}

/**
 * Serializa el trabajo sobre un mismo id: una a la vez, en orden de llegada.
 * Dos peticiones simultáneas para la misma venta (doble clic, reintento de la
 * caja mientras la primera sigue esperando al PAC) harían las dos la lectura
 * "¿ya está timbrada?" antes de que ninguna escribiera, y las dos llamarían al
 * PAC: dos timbres, uno de ellos pagado y sin dueño. Con esto la segunda
 * espera y encuentra la venta ya timbrada (`ya_timbrada`), sin tocar al PAC.
 *
 * Es un candado EN MEMORIA, a propósito: un candado de Postgres retendría una
 * conexión del pool por cada petición en espera, y con diez o más al mismo id
 * quien tiene el candado ya no encontraría conexión para trabajar. Vale
 * porque el servidor es un solo proceso (ver PLAN.md); con varios habría que
 * pasar a un candado de base de datos.
 */
const enCurso = new Map<string, Promise<unknown>>();

async function conCandado<T>(id: string, trabajo: () => Promise<T>): Promise<T> {
  const anterior = enCurso.get(id) ?? Promise.resolve();
  // Espera a que termine el anterior sin importar cómo terminó.
  const mio = anterior.then(trabajo, trabajo);
  const cola = mio.catch(() => undefined);
  enCurso.set(id, cola);
  try {
    return await mio;
  } finally {
    // Si nadie se formó detrás, el id ya no necesita entrada.
    if (enCurso.get(id) === cola) enCurso.delete(id);
  }
}

export function registrarTimbrar(app: FastifyInstance, pool: Pool, almacen: Almacen, opciones: OpcionesTimbrar): void {
  const servicio = crearServicioTimbrado({
    repo: repositorioPg(pool),
    almacen,
    env: opciones.entorno,
    obtenerPac: opciones.obtenerPac,
    crearTransporte: opciones.crearTransporte,
  });

  app.post<{ Body: CuerpoTimbrar }>(
    "/timbrar",
    {
      onRequest: app.autenticar,
      schema: { body: { type: "object" } },
      // Los errores de Fastify (JSON mal formado, cuerpo vacío) también como { error }.
      errorHandler: (err, _req, reply) => {
        const estado = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
        if (estado >= 500) app.log.error(err);
        return reply.code(estado).send({ error: estado >= 500 ? "Error interno del servidor" : "cuerpo inválido" });
      },
    },
    async (req, reply) => {
      const op = interpretar(req.body ?? {});
      if (op.tipo === "invalida") return reply.code(op.resultado.estado).send(op.resultado.cuerpo);
      if (!UUID.test(op.id)) return reply.code(400).send({ error: "identificador inválido" });

      try {
        const { estado, cuerpo } = await conCandado(op.id, () => ejecutar(servicio, op));
        return reply.code(estado).send(cuerpo);
      } catch (e) {
        // Lo inesperado (base caída, falta una variable de entorno…): el
        // mensaje llega al cajero igual que en la función original.
        req.log.error(e);
        return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );
}
