/**
 * Variables de entorno de `timbrar`, inyectadas en vez de leídas de `Deno.env`
 * / `process.env` donde se usan: las pruebas arman su propio entorno sin
 * tocar el del proceso.
 */

export type Entorno = Readonly<Record<string, string | undefined>>;

export function requerir(env: Entorno, nombre: string): string {
  const v = env[nombre];
  if (!v) throw new Error(`falta la variable de entorno ${nombre}`);
  return v;
}
