/**
 * Configuración del servidor, leída del entorno (`.env`, ver `.env.example`).
 *
 * Falla al arrancar si falta algo esencial: un servidor que "arranca" sin
 * firma de tokens o sin base y luego responde 500 es peor que uno que no abre.
 */

export interface Config {
  databaseUrl: string;
  jwtSecret: string;
  port: number;
  host: string;
  /** Carpeta de archivos subidos (XML/PDF) y del actualizador. */
  almacenDir: string;
}

import { verificarSandbox } from "./timbrar/guarda.js";

export function leerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL ?? "";
  if (databaseUrl === "") throw new Error("Falta DATABASE_URL en .env");

  const jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET debe tener al menos 32 caracteres (openssl rand -hex 32)");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT inválido: ${env.PORT}`);
  }

  // GUARDA DE SANDBOX: si el PAC está activado, su URL tiene que ser la del
  // sandbox. El servidor de la demo NO arranca con una URL de producción (o
  // sin URL, que sería producción por omisión): ver timbrar/guarda.ts.
  if (env.PAC_PROVEEDOR === "facturacom") verificarSandbox(env.FACTURACOM_BASE_URL);

  return { databaseUrl, jwtSecret, port, host: env.HOST ?? "127.0.0.1", almacenDir: env.ALMACEN_DIR || "almacen" };
}
