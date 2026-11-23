/**
 * API de sincronización (fase 3): sustituye a PostgREST y a `.rpc()`.
 *
 * Reemplaza a RLS con una LISTA BLANCA: solo las tablas de `TABLAS`, solo sus
 * columnas reales (leídas de `information_schema`, no de la entrada), y los
 * nombres siempre entre comillas tras pasar por esas listas. Los valores van
 * siempre como parámetros. Ningún nombre de tabla o columna llega al SQL tal
 * como lo mandó el cliente sin haber sido comparado antes contra ellas.
 *
 * Errores: se conserva el SQLSTATE original en `{ code, message }`. La caja
 * decide con `code` si un rechazo es definitivo (se descarta de su cola) o
 * transitorio (se reintenta), así que un código mal puesto es o una venta que
 * se reintenta para siempre o una que se pierde.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg from "pg";
import type { Pool } from "pg";

interface Tabla {
  /** Llave primaria; también el desempate del cursor y el `ON CONFLICT`. */
  llave: string;
  /** `false`: solo lectura (la escribe el servidor, p. ej. por una función). */
  escribible: boolean;
}

/** Tablas que la caja puede leer y, si `escribible`, subir con upsert. */
export const TABLAS: Readonly<Record<string, Tabla>> = {
  usuarios: { llave: "id", escribible: true },
  clientes: { llave: "id", escribible: true },
  productos: { llave: "id", escribible: true },
  producto_codigos: { llave: "codigo", escribible: true },
  producto_precios: { llave: "id", escribible: true },
  turnos: { llave: "id", escribible: true },
  facturas_globales: { llave: "id", escribible: true },
  ventas: { llave: "id", escribible: true },
  venta_detalles: { llave: "id", escribible: true },
  venta_pagos: { llave: "id", escribible: true },
  cotizaciones: { llave: "id", escribible: true },
  cotizacion_detalles: { llave: "id", escribible: true },
  // Cobranza: cuentas por cobrar (ventas a crédito) y sus abonos. Las reglas de saldo viven en la app.
  cuentas_por_cobrar: { llave: "id", escribible: true },
  abonos: { llave: "id", escribible: true },
  // Los movimientos suben solo por `aplicar_movimientos_inventario`: un upsert
  // directo se saltaría el cálculo de la existencia global.
  movimientos_inventario: { llave: "id", escribible: false },
  inventario_global: { llave: "id", escribible: false },
};

/** Columnas que escribe el servidor (trigger/DEFAULT) y la caja no puede fijar. */
const NO_ESCRIBIBLES = new Set(["recibido_en"]);

const MAX_FILAS_UPSERT = 500;
const MAX_LIMITE = 1000;
const LIMITE_POR_OMISION = 500;
const MAX_VALORES_IN = 500;

type Primitivo = string | number | boolean | null;

// ---------------------------------------------------------------------------
// Tipos de salida: lo que PostgREST entregaba a la caja
// ---------------------------------------------------------------------------

const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_TIMESTAMPTZ = 1184;

const TIMESTAMPTZ = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/;

/**
 * `timestamptz` como texto ISO CON microsegundos ("…123456+00:00"), como lo
 * daba PostgREST. Pasar por `Date` los truncaría a milisegundos, y el cursor
 * `(actualizado_en, id)` de la caja compara contra el valor exacto de la
 * fila: con la marca truncada, la fila del borde volvería a salir en cada
 * página.
 */
export function aIsoConMicros(texto: string): string {
  const m = TIMESTAMPTZ.exec(texto);
  if (!m) return texto; // 'infinity' u otro formato: tal cual.
  const [, fecha, hora, hh, mm = "00"] = m;
  if (hh === "+00" && mm === "00") return `${fecha}T${hora}+00:00`;
  // Otra zona (la base no está en UTC): se normaliza a UTC, a milisegundos.
  return new Date(`${fecha}T${hora}${hh}:${mm}`).toISOString();
}

/** int8 y numeric como número JSON (PostgREST igual); el dinero es entero en centavos. */
export const TIPOS = {
  getTypeParser(oid: number, formato?: "text" | "binary") {
    if (oid === OID_INT8 || oid === OID_NUMERIC) return (v: string) => Number(v);
    if (oid === OID_TIMESTAMPTZ) return aIsoConMicros;
    return pg.types.getTypeParser(oid, formato as "text");
  },
};

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

interface ErrorHttp {
  estado: number;
  cuerpo: { code: string; message: string; detail?: string };
}

function esErrorDePostgres(e: unknown): e is Error & { code: string; detail?: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    /^[0-9A-Z]{5}$/.test((e as { code: string }).code) &&
    "severity" in e
  );
}

/**
 * SQLSTATE -> HTTP. 4xx es un rechazo del dato (no se arregla reintentando);
 * 5xx/503 es transitorio. La caja mira `code`, no el estado, pero el estado
 * tiene que ser coherente para quien lea los registros.
 */
export function aErrorHttp(e: unknown): ErrorHttp {
  if (esErrorDePostgres(e)) {
    const { code } = e;
    const cuerpo = { code, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
    if (code === "23505") return { estado: 409, cuerpo };
    if (code === "42501") return { estado: 403, cuerpo };
    if (code.startsWith("22") || code.startsWith("23") || code === "P0001") return { estado: 400, cuerpo };
    // Interbloqueo, serialización, sin conexiones, apagado: vale reintentar.
    if (code.startsWith("40") || code.startsWith("08") || code.startsWith("53") || code.startsWith("57")) {
      return { estado: 503, cuerpo };
    }
    // Lo demás (sintaxis, columna inexistente…) es un error nuestro: no se
    // detalla al cliente.
    return { estado: 500, cuerpo: { code, message: "Error interno del servidor" } };
  }
  const errno = (e as { code?: string } | null)?.code;
  if (errno === "ECONNREFUSED" || errno === "ECONNRESET" || errno === "ETIMEDOUT") {
    return { estado: 503, cuerpo: { code: "08006", message: "Base de datos no disponible" } };
  }
  return { estado: 500, cuerpo: { code: "XX000", message: "Error interno del servidor" } };
}

class PeticionInvalida extends Error {
  constructor(
    mensaje: string,
    readonly estado = 400,
  ) {
    super(mensaje);
  }
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

const comillas = (identificador: string) => `"${identificador}"`;

const primitivo = { type: ["string", "number", "boolean", "null"] } as const;
const nombreSql = { type: "string", pattern: "^[a-z_][a-z0-9_]{0,62}$" } as const;

const cuerpoConsulta = {
  type: "object",
  additionalProperties: false,
  properties: {
    columnas: { type: "array", items: nombreSql, minItems: 1, maxItems: 60 },
    filtros: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["col", "op", "valor"],
        additionalProperties: false,
        properties: {
          col: nombreSql,
          op: { enum: ["eq", "gt", "gte", "lt", "lte", "in"] },
          valor: {
            anyOf: [primitivo, { type: "array", items: primitivo, maxItems: MAX_VALORES_IN }],
          },
        },
      },
    },
    // Cursor por llave compuesta: filas con (col, llave) estrictamente
    // posteriores a (valor, llave_valor). Sin `llave_valor`, solo `col > valor`.
    despues: {
      type: "object",
      required: ["col", "valor"],
      additionalProperties: false,
      properties: {
        col: nombreSql,
        valor: { type: ["string", "number"] },
        llave_valor: { type: ["string", "number"] },
      },
    },
    orden: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["col"],
        additionalProperties: false,
        properties: { col: nombreSql, desc: { type: "boolean" } },
      },
    },
    limite: { type: "integer", minimum: 1, maximum: MAX_LIMITE },
  },
} as const;

interface CuerpoConsulta {
  columnas?: string[];
  filtros?: { col: string; op: "eq" | "gt" | "gte" | "lt" | "lte" | "in"; valor: Primitivo | Primitivo[] }[];
  despues?: { col: string; valor: string | number; llave_valor?: string | number };
  orden?: { col: string; desc?: boolean }[];
  limite?: number;
}

const OPERADOR_SQL = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

const cuerpoUpsert = {
  type: "object",
  required: ["filas"],
  additionalProperties: false,
  properties: {
    filas: {
      type: "array",
      minItems: 1,
      maxItems: MAX_FILAS_UPSERT,
      // Mínimo 2: la llave y algo que guardar (una fila solo con la llave nunca pasa los NOT NULL).
      items: { type: "object", minProperties: 2, maxProperties: 60, additionalProperties: primitivo },
    },
  },
} as const;

const cuerpoMovimientos = {
  type: "object",
  required: ["p_movimientos"],
  additionalProperties: false,
  properties: {
    p_movimientos: { type: "array", maxItems: 500, items: { type: "object" } },
    p_caja_id: { type: ["string", "null"], maxLength: 20 },
  },
} as const;

const cuerpoInicializar = {
  type: "object",
  required: ["p_caja_id", "p_corte_en", "p_existencias"],
  additionalProperties: false,
  properties: {
    p_caja_id: { type: "string", minLength: 1, maxLength: 20 },
    p_corte_en: { type: "string", format: "date-time" },
    p_existencias: { type: "array", maxItems: 50_000, items: { type: "object" } },
  },
} as const;

const paramsTabla = {
  type: "object",
  required: ["tabla"],
  properties: { tabla: { type: "string", maxLength: 64 } },
} as const;

const paramsClave = {
  type: "object",
  required: ["clave"],
  properties: { clave: { type: "string", pattern: "^[a-z0-9_]{1,64}$" } },
} as const;

export function registrarSincronizacion(app: FastifyInstance, pool: Pool): void {
  // Columnas reales de cada tabla, leídas una vez de la base.
  let columnasCache: Promise<Map<string, ReadonlySet<string>>> | null = null;
  const columnas = (): Promise<Map<string, ReadonlySet<string>>> => {
    columnasCache ??= pool
      .query<{ t: string; c: string }>(
        `SELECT table_name AS t, column_name AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [Object.keys(TABLAS)],
      )
      .then(({ rows }) => {
        const m = new Map<string, Set<string>>();
        for (const { t, c } of rows) (m.get(t) ?? m.set(t, new Set()).get(t)!).add(c);
        return m;
      })
      .catch((e) => {
        columnasCache = null; // que un fallo no quede guardado para siempre
        throw e;
      });
    return columnasCache;
  };

  /** Tabla de la lista blanca y sus columnas, o 404. `hasOwn`: "constructor" no es una tabla. */
  async function tablaDe(nombre: string, paraEscribir = false) {
    if (!Object.hasOwn(TABLAS, nombre)) throw new PeticionInvalida(`Tabla no permitida: ${nombre}`, 404);
    const def = TABLAS[nombre]!;
    if (paraEscribir && !def.escribible) throw new PeticionInvalida(`La tabla ${nombre} es de solo lectura`, 403);
    const cols = (await columnas()).get(nombre);
    if (!cols) throw new Error(`La tabla ${nombre} no existe en la base (¿faltan migraciones?)`);
    return { def, cols };
  }

  const columnaValida = (cols: ReadonlySet<string>, col: string, tabla: string) => {
    if (!cols.has(col)) throw new PeticionInvalida(`Columna no permitida en ${tabla}: ${col}`);
    return comillas(col);
  };

  /** Envuelve una ruta: errores de Postgres a `{ code, message }` con su SQLSTATE. */
  function ruta<T extends FastifyRequest>(fn: (req: T, reply: FastifyReply) => Promise<unknown>) {
    return async (req: T, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (e) {
        if (e instanceof PeticionInvalida) {
          return reply.code(e.estado).send({ code: "PETICION_INVALIDA", message: e.message });
        }
        const { estado, cuerpo } = aErrorHttp(e);
        if (estado >= 500) req.log.error(e);
        return reply.code(estado).send(cuerpo);
      }
    };
  }

  // -- Lectura -------------------------------------------------------------

  app.post<{ Params: { tabla: string }; Body: CuerpoConsulta }>(
    "/sync/:tabla/consultar",
    { onRequest: app.autenticar, schema: { params: paramsTabla, body: cuerpoConsulta } },
    ruta(async (req) => {
      const { def, cols } = await tablaDe(req.params.tabla);
      const { filtros = [], despues, orden, limite = LIMITE_POR_OMISION } = req.body;
      const tabla = req.params.tabla;
      if (despues && orden) throw new PeticionInvalida("`despues` fija su propio orden: no se combina con `orden`");

      const lista = req.body.columnas
        ? req.body.columnas.map((c) => columnaValida(cols, c, tabla)).join(", ")
        : "*";

      const params: unknown[] = [];
      const donde: string[] = [];
      const param = (v: unknown) => `$${params.push(v)}`;

      for (const f of filtros) {
        const col = columnaValida(cols, f.col, tabla);
        if (f.op === "in") {
          if (!Array.isArray(f.valor)) throw new PeticionInvalida("`in` exige una lista");
          donde.push(`${col} = ANY(${param(f.valor)})`);
        } else {
          if (Array.isArray(f.valor)) throw new PeticionInvalida(`\`${f.op}\` exige un solo valor`);
          donde.push(f.valor === null && f.op === "eq" ? `${col} IS NULL` : `${col} ${OPERADOR_SQL[f.op]} ${param(f.valor)}`);
        }
      }

      let ordenSql: string;
      if (despues) {
        const col = columnaValida(cols, despues.col, tabla);
        const llave = comillas(def.llave);
        const v = param(despues.valor);
        donde.push(
          despues.llave_valor === undefined
            ? `${col} > ${v}`
            : `(${col} > ${v} OR (${col} = ${v} AND ${llave} > ${param(despues.llave_valor)}))`,
        );
        ordenSql = `${col}, ${llave}`;
      } else if (orden) {
        ordenSql = orden.map((o) => `${columnaValida(cols, o.col, tabla)}${o.desc ? " DESC" : ""}`).join(", ");
      } else {
        ordenSql = comillas(def.llave);
      }

      const sql =
        `SELECT ${lista} FROM ${comillas(tabla)}` +
        (donde.length ? ` WHERE ${donde.join(" AND ")}` : "") +
        ` ORDER BY ${ordenSql} LIMIT ${limite}`;
      const { rows } = await pool.query({ text: sql, values: params, types: TIPOS });
      return { filas: rows };
    }),
  );

  // -- Escritura -----------------------------------------------------------

  app.post<{ Params: { tabla: string }; Body: { filas: Record<string, Primitivo>[] } }>(
    "/sync/:tabla/upsert",
    { onRequest: app.autenticar, schema: { params: paramsTabla, body: cuerpoUpsert } },
    ruta(async (req) => {
      const tabla = req.params.tabla;
      const { def, cols } = await tablaDe(tabla, true);

      // Se valida todo ANTES de abrir la transacción.
      const sentencias = req.body.filas.map((fila) => {
        const nombres = Object.keys(fila);
        for (const c of nombres) {
          if (NO_ESCRIBIBLES.has(c)) throw new PeticionInvalida(`Columna no escribible en ${tabla}: ${c}`);
          columnaValida(cols, c, tabla);
        }
        if (!(def.llave in fila) || fila[def.llave] === null) {
          throw new PeticionInvalida(`Falta la llave ${def.llave} en una fila de ${tabla}`);
        }
        const valores = nombres.map((c) => fila[c]);
        // Hay al menos una columna además de la llave (minProperties: 2).
        const actualizables = nombres.filter((c) => c !== def.llave);
        const alConflicto = `DO UPDATE SET ${actualizables.map((c) => `${comillas(c)} = EXCLUDED.${comillas(c)}`).join(", ")}`;
        return {
          text:
            `INSERT INTO ${comillas(tabla)} (${nombres.map(comillas).join(", ")}) ` +
            `VALUES (${nombres.map((_, i) => `$${i + 1}`).join(", ")}) ` +
            `ON CONFLICT (${comillas(def.llave)}) ${alConflicto}`,
          values: valores,
        };
      });

      // Un lote entra completo o no entra.
      const cliente = await pool.connect();
      try {
        await cliente.query("BEGIN");
        for (const s of sentencias) await cliente.query(s);
        await cliente.query("COMMIT");
      } catch (e) {
        await cliente.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        cliente.release();
      }
      return { guardadas: sentencias.length };
    }),
  );

  // -- RPC: solo las dos funciones de inventario ---------------------------

  app.post<{ Body: { p_movimientos: unknown[]; p_caja_id?: string | null } }>(
    "/rpc/aplicar_movimientos_inventario",
    { onRequest: app.autenticar, schema: { body: cuerpoMovimientos } },
    ruta(async (req) => {
      const { rows } = await pool.query({
        text: "SELECT aplicar_movimientos_inventario($1::jsonb, $2::text) AS r",
        values: [JSON.stringify(req.body.p_movimientos), req.body.p_caja_id ?? null],
        types: TIPOS,
      });
      return rows[0].r;
    }),
  );

  app.post<{ Body: { p_caja_id: string; p_corte_en: string; p_existencias: unknown[] } }>(
    "/rpc/inicializar_inventario_global",
    { onRequest: app.autenticar, schema: { body: cuerpoInicializar } },
    ruta(async (req) => {
      const { rows } = await pool.query({
        text: "SELECT inicializar_inventario_global($1::text, $2::timestamptz, $3::jsonb) AS r",
        values: [req.body.p_caja_id, req.body.p_corte_en, JSON.stringify(req.body.p_existencias)],
        types: TIPOS,
      });
      return rows[0].r;
    }),
  );

  // -- config_nube (clave/valor compartido entre cajas) --------------------

  app.get<{ Params: { clave: string } }>(
    "/config/:clave",
    { onRequest: app.autenticar, schema: { params: paramsClave } },
    ruta(async (req, reply) => {
      const { rows } = await pool.query({
        text: "SELECT clave, valor, actualizado_en FROM config_nube WHERE clave = $1",
        values: [req.params.clave],
        types: TIPOS,
      });
      if (rows.length === 0) return reply.code(404).send({ code: "NO_ENCONTRADO", message: "No existe esa clave" });
      return rows[0];
    }),
  );

  app.put<{ Params: { clave: string }; Body: { valor: string } }>(
    "/config/:clave",
    {
      onRequest: app.autenticar,
      schema: {
        params: paramsClave,
        body: {
          type: "object",
          required: ["valor"],
          additionalProperties: false,
          properties: { valor: { type: "string", maxLength: 2000 } },
        },
      },
    },
    ruta(async (req) => {
      const { rows } = await pool.query({
        text: `INSERT INTO config_nube (clave, valor, actualizado_en) VALUES ($1, $2, now())
               ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now()
               RETURNING clave, valor, actualizado_en`,
        values: [req.params.clave, req.body.valor],
        types: TIPOS,
      });
      return rows[0];
    }),
  );
}
