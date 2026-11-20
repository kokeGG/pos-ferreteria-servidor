/**
 * Almacenamiento en disco (fase 4): sustituye a Supabase Storage.
 *
 * Carpeta `almacen/<bucket>/<ruta>`. Los nombres de bucket y de ruta NUNCA se
 * usan tal como llegan: cada ruta se valida contra la convención del bucket
 * (o, en `app-updates`, contra un alfabeto cerrado) y el archivo resuelto se
 * comprueba dentro de la carpeta del bucket antes de tocarlo. Es la defensa
 * contra `../../.env`, rutas absolutas, nombres de dispositivo de Windows
 * (`NUL`, `CON`), flujos alternos (`a.txt:x`) y separadores raros.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DefBucket {
  /** `true`: se lee sin autenticar (`/actualizaciones`). */
  publico: boolean;
  /** Tope de tamaño en bytes, el mismo que tenía el bucket en Supabase. */
  maxBytes: number;
  /** Tipos MIME aceptados al subir; `null` = cualquiera. */
  tipos: readonly string[] | null;
  /** Convención de la ruta relativa (sin barra inicial). */
  ruta: RegExp;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `<anio>/<mes>/<uuid_sat>` (+ `-cancelacion` para el acuse, solo en XML). */
const CARPETA = "[0-9]{4}/(?:0[1-9]|1[0-2])";

export const BUCKETS = {
  // Los XML y PDF no se borran: la migración original no daba permiso de
  // borrado a propósito (un CFDI timbrado no se elimina). No hay `borrar`.
  "cfdi-xml": {
    publico: false,
    maxBytes: 1_048_576,
    tipos: ["application/xml", "text/xml"],
    ruta: new RegExp(`^${CARPETA}/${UUID}(?:-cancelacion)?\\.xml$`, "i"),
  },
  "cfdi-pdf": {
    publico: false,
    maxBytes: 10_485_760,
    tipos: ["application/pdf"],
    ruta: new RegExp(`^${CARPETA}/${UUID}\\.pdf$`, "i"),
  },
  // Solo lo escribe el desarrollador copiando archivos a la carpeta; el
  // servidor lo sirve de solo lectura y la caja nunca publica.
  "app-updates": {
    publico: true,
    maxBytes: 104_857_600,
    tipos: null,
    ruta: /^(?:[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\/){0,3}[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/,
  },
} as const satisfies Record<string, DefBucket>;

export type NombreBucket = keyof typeof BUCKETS;

export const esBucket = (nombre: string): nombre is NombreBucket => Object.hasOwn(BUCKETS, nombre);

/** Nombres que Windows trata como dispositivo aunque lleven extensión. */
const DISPOSITIVO_WINDOWS = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

export class ErrorAlmacen extends Error {
  constructor(
    readonly estado: 400 | 404 | 409 | 413 | 415,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

const TIPO_POR_EXTENSION: Record<string, string> = {
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".sig": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export const tipoDe = (ruta: string) => TIPO_POR_EXTENSION[path.extname(ruta).toLowerCase()] ?? "application/octet-stream";

export class Almacen {
  readonly raiz: string;

  constructor(raiz: string) {
    this.raiz = path.resolve(raiz);
  }

  /** Valida bucket y ruta y devuelve la ruta absoluta dentro del bucket. */
  resolver(bucket: string, ruta: string): string {
    if (!esBucket(bucket)) throw new ErrorAlmacen(404, `Bucket inexistente: ${bucket}`);
    // Todo lo que no encaje en la convención se rechaza: separadores de
    // Windows, barra inicial, `..`, bytes nulos, `:`, espacios, mayúsculas
    // donde no caben…
    if (!BUCKETS[bucket].ruta.test(ruta)) throw new ErrorAlmacen(400, "Ruta fuera de la convención del bucket");
    for (const segmento of ruta.split("/")) {
      if (DISPOSITIVO_WINDOWS.test(segmento) || segmento.endsWith(".")) {
        throw new ErrorAlmacen(400, "Nombre de archivo no permitido");
      }
    }
    const carpeta = path.join(this.raiz, bucket);
    const destino = path.resolve(carpeta, ...ruta.split("/"));
    // Segunda barrera, independiente de la regex: el resultado sigue dentro.
    if (!destino.startsWith(carpeta + path.sep)) throw new ErrorAlmacen(400, "Ruta fuera del bucket");
    return destino;
  }

  /**
   * `true` si `ruta` (ya existente), con los enlaces simbólicos resueltos,
   * sigue dentro de la carpeta del bucket. La comprobación léxica de
   * `resolver` no ve un enlace que apunte fuera.
   */
  private async dentroDelBucket(bucket: string, ruta: string): Promise<boolean> {
    const real = await realpath(ruta);
    const carpeta = await realpath(path.join(this.raiz, bucket));
    return real.startsWith(carpeta + path.sep);
  }

  /**
   * Crea las carpetas de `ruta` UNA POR UNA y rechaza cualquiera que sea un
   * enlace: `mkdir -p` a través de un enlace crearía carpetas fuera del
   * bucket antes de poder detectarlo.
   */
  private async prepararCarpeta(bucket: string, ruta: string): Promise<void> {
    let actual = path.join(this.raiz, bucket);
    await mkdir(actual, { recursive: true });
    for (const segmento of ruta.split("/").slice(0, -1)) {
      actual = path.join(actual, segmento);
      await mkdir(actual).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
      if ((await lstat(actual)).isSymbolicLink()) throw new ErrorAlmacen(400, "Ruta fuera del bucket");
    }
  }

  /**
   * Guarda un archivo. Sin `sobrescribir`, uno que ya existe da 409 (en
   * Supabase la caja solo tenía permiso de INSERT). `timbrar` sí sobrescribe:
   * un reintento del PAC devuelve el mismo UUID y debe poder volver a guardar.
   * Entra completo o no entra: se escribe a un temporal y se publica de golpe.
   */
  async guardar(
    bucket: string,
    ruta: string,
    datos: Buffer,
    tipo: string,
    opciones: { sobrescribir?: boolean } = {},
  ): Promise<void> {
    const destino = this.resolver(bucket, ruta);
    const def: DefBucket = BUCKETS[bucket as NombreBucket];
    if (def.tipos && !def.tipos.includes(tipo.split(";")[0]!.trim().toLowerCase())) {
      throw new ErrorAlmacen(415, `Tipo no permitido en ${bucket}: ${tipo}`);
    }
    if (datos.length > def.maxBytes) throw new ErrorAlmacen(413, `Excede el límite de ${def.maxBytes} bytes de ${bucket}`);
    if (datos.length === 0) throw new ErrorAlmacen(400, "Archivo vacío");

    await this.prepararCarpeta(bucket, ruta);
    // Empieza con punto: la validación de rutas no deja leerlo ni pedirlo.
    const temporal = path.join(path.dirname(destino), `.tmp-${randomBytes(8).toString("hex")}`);
    await writeFile(temporal, datos);
    try {
      if (opciones.sobrescribir) {
        await rename(temporal, destino);
      } else {
        // `link` falla con EEXIST si ya hay uno: sin carrera entre revisar y escribir.
        await link(temporal, destino).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "EEXIST") throw new ErrorAlmacen(409, "Ya existe un archivo en esa ruta");
          throw e;
        });
        await unlink(temporal);
      }
    } catch (e) {
      await unlink(temporal).catch(() => undefined);
      throw e;
    }
  }

  async leer(bucket: string, ruta: string): Promise<Buffer | null> {
    const destino = this.resolver(bucket, ruta);
    try {
      if (!(await this.dentroDelBucket(bucket, destino))) return null;
      return await readFile(destino);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "EISDIR") return null;
      throw e;
    }
  }

  async existe(bucket: string, ruta: string): Promise<boolean> {
    try {
      const destino = this.resolver(bucket, ruta);
      return (await this.dentroDelBucket(bucket, destino)) && (await stat(destino)).isFile();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }

  /** Para archivos grandes (instaladores): flujo en vez de cargar 100 MB en memoria. */
  async abrir(bucket: string, ruta: string): Promise<{ flujo: ReturnType<typeof createReadStream>; bytes: number } | null> {
    const destino = this.resolver(bucket, ruta);
    try {
      if (!(await this.dentroDelBucket(bucket, destino))) return null;
      const s = await stat(destino);
      if (!s.isFile()) return null;
      return { flujo: createReadStream(destino), bytes: s.size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// URLs firmadas
// ---------------------------------------------------------------------------

/** Vencimiento por omisión: el que usa el POS (`createSignedUrl(ruta, 300)`). */
export const SEGUNDOS_FIRMA = 300;
export const MAX_SEGUNDOS_FIRMA = 3600;

/** Clave propia para firmas, derivada del secreto: no se reutiliza la de los JWT tal cual. */
export const claveDeFirmas = (secreto: string) => createHmac("sha256", secreto).update("almacen-urls-firmadas").digest();

const firma = (clave: Buffer, bucket: string, ruta: string, exp: number) =>
  createHmac("sha256", clave).update(`${bucket}\n${ruta}\n${exp}`).digest("base64url");

export function firmarUrl(clave: Buffer, bucket: string, ruta: string, segundos: number, ahoraMs = Date.now()) {
  const exp = Math.floor(ahoraMs / 1000) + segundos;
  return { exp, sig: firma(clave, bucket, ruta, exp) };
}

/** `true` si la firma corresponde a bucket+ruta+vencimiento y no ha vencido. */
export function verificarFirma(
  clave: Buffer,
  bucket: string,
  ruta: string,
  exp: number,
  sig: string,
  ahoraMs = Date.now(),
): boolean {
  if (!Number.isSafeInteger(exp) || exp * 1000 < ahoraMs) return false;
  // Se comparan los hash de ambas firmas: mismo largo siempre y tiempo constante.
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(sig), h(firma(clave, bucket, ruta, exp)));
}
