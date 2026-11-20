/**
 * Contraseñas y tokens de las terminales.
 *
 * Contraseña: scrypt con sal propia (viene en Node, sin dependencias nativas).
 * Refresh token: 32 bytes aleatorios; en la base solo vive su SHA-256.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const LARGO_CLAVE = 64;

function derivar(password: string, sal: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, sal, LARGO_CLAVE, (e, clave) => (e ? reject(e) : resolve(clave))),
  );
}

/** `scrypt$<sal hex>$<clave hex>` */
export async function hashPassword(password: string): Promise<string> {
  const sal = randomBytes(16);
  const clave = await derivar(password, sal);
  return `scrypt$${sal.toString("hex")}$${clave.toString("hex")}`;
}

export async function verificarPassword(password: string, guardado: string): Promise<boolean> {
  const [alg, salHex, claveHex] = guardado.split("$");
  if (alg !== "scrypt" || !salHex || !claveHex) return false;
  const esperada = Buffer.from(claveHex, "hex");
  const obtenida = await derivar(password, Buffer.from(salHex, "hex"));
  return esperada.length === obtenida.length && timingSafeEqual(esperada, obtenida);
}

/**
 * Hash de relleno para cuando el correo no existe: así tardar lo mismo en
 * "no existe" que en "contraseña mala" y no revelar qué correos son válidos.
 */
export const HASH_DE_RELLENO = await hashPassword(randomBytes(16).toString("hex"));

export function nuevoRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
