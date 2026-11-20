/**
 * Acceso a datos de `timbrar`.
 *
 * Reemplaza las ~35 consultas `sb.from(...)` de la Edge Function original
 * (Supabase/PostgREST) por SQL sobre `pg`. Existe para que la lógica fiscal de
 * `servicio.ts` (que no se debe tocar) quede separada de cómo se leen y
 * escriben las filas, y para poder sustituirlo en pruebas.
 *
 * Los valores salen igual que de PostgREST: `bigint` como número, fechas como
 * texto ISO, y el cliente de una venta embebido como objeto (`clientes`).
 */

import type { Pool } from "pg";
import { TIPOS } from "../sync.js";

/** Una fila tal cual sale de la base: el servicio solo lee las columnas que nombra. */
export type Fila = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type TablaFactura = "ventas" | "facturas_globales";

/** Columnas que `timbrar` puede escribir, por tabla. Cualquier otra es un error de programación. */
const ESCRIBIBLES: Record<TablaFactura, ReadonlySet<string>> = {
  ventas: new Set([
    "estado", "estado_factura", "error_timbrado", "uuid_sat", "timbrada_en", "url_xml", "url_pdf",
    "cancelada_en", "motivo_cancelacion", "correo_enviado_en", "error_correo",
  ]),
  facturas_globales: new Set([
    "estado", "error_timbrado", "uuid_sat", "timbrada_en", "url_xml", "url_pdf",
    "correo_enviado_en", "error_correo",
  ]),
};

export interface Repositorio {
  /** Venta con su cliente embebido (`clientes`, o `null` si no tiene). */
  ventaConCliente(id: string): Promise<Fila | null>;
  /** Campos mínimos de una venta para cancelar su factura. */
  ventaParaCancelar(id: string): Promise<Fila | null>;
  detalles(ventaId: string): Promise<Fila[]>;
  /** Pagos de la venta, el de mayor monto primero. */
  pagos(ventaId: string): Promise<Fila[]>;
  global(id: string): Promise<Fila | null>;
  globalParaCancelar(id: string): Promise<Fila | null>;
  /** Notas COMPLETADAS que la caja marcó con esta global, por folio. */
  notasDeGlobal(globalId: string): Promise<Fila[]>;
  correoPublicoGeneral(): Promise<string | null>;
  actualizar(tabla: TablaFactura, id: string, campos: Record<string, unknown>): Promise<void>;
}

const NOMBRE_COLUMNA = /^[a-z_]+$/;

export function repositorioPg(pool: Pool): Repositorio {
  const filas = async (text: string, values: unknown[]): Promise<Fila[]> =>
    (await pool.query({ text, values, types: TIPOS })).rows;
  const una = async (text: string, values: unknown[]) => (await filas(text, values))[0] ?? null;

  return {
    ventaConCliente: (id) =>
      una(
        `SELECT v.*, to_jsonb(c.*) AS clientes
           FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id
          WHERE v.id = $1`,
        [id],
      ),
    ventaParaCancelar: (id) =>
      una("SELECT id, uuid_sat, estado, estado_factura, creado_en FROM ventas WHERE id = $1", [id]),
    detalles: (ventaId) => filas("SELECT * FROM venta_detalles WHERE venta_id = $1 ORDER BY renglon", [ventaId]),
    pagos: (ventaId) =>
      filas("SELECT forma_pago, monto_cent FROM venta_pagos WHERE venta_id = $1 ORDER BY monto_cent DESC", [ventaId]),
    global: (id) => una("SELECT * FROM facturas_globales WHERE id = $1", [id]),
    globalParaCancelar: (id) =>
      una("SELECT id, uuid_sat, estado, periodo_inicio FROM facturas_globales WHERE id = $1", [id]),
    notasDeGlobal: (globalId) =>
      filas(
        `SELECT caja_id, folio_local, subtotal_cent, impuestos_cent, total_cent
           FROM ventas WHERE factura_global_id = $1 AND estado = 'COMPLETADA'
          ORDER BY caja_id, folio_local`,
        [globalId],
      ),
    correoPublicoGeneral: async () =>
      (await una("SELECT valor FROM config_nube WHERE clave = 'correo_publico_general'", []))?.valor ?? null,
    async actualizar(tabla, id, campos) {
      const nombres = Object.keys(campos);
      for (const n of nombres) {
        if (!NOMBRE_COLUMNA.test(n) || !ESCRIBIBLES[tabla].has(n)) {
          throw new Error(`columna no escribible en ${tabla}: ${n}`);
        }
      }
      if (nombres.length === 0) return;
      await pool.query({
        text: `UPDATE ${tabla} SET ${nombres.map((n, i) => `${n} = $${i + 2}`).join(", ")} WHERE id = $1`,
        values: [id, ...nombres.map((n) => campos[n])],
      });
    },
  };
}
