/**
 * Da de alta (o actualiza la contraseña de) la TERMINAL de la app en Supabase
 * Auth, con las mismas credenciales que ya usa la app (TERMINAL_EMAIL /
 * TERMINAL_PASSWORD), y comprueba que puede iniciar sesión con la llave pública.
 *
 *   npm run supabase:terminal
 *
 * Usa la llave secreta del proyecto (SUPABASE_SECRET_KEY): solo desde esta
 * máquina, nunca dentro de la app. No imprime llaves ni contraseñas.
 */

const base = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const secreta = process.env.SUPABASE_SECRET_KEY ?? "";
const publica = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const email = process.env.TERMINAL_EMAIL ?? "";
const password = process.env.TERMINAL_PASSWORD ?? "";
if (![base, secreta, publica, email, password].every(Boolean)) {
  console.error("Faltan SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY, TERMINAL_EMAIL o TERMINAL_PASSWORD en .env.");
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(base)) {
  console.error("SUPABASE_URL no tiene la forma https://<proyecto>.supabase.co");
  process.exit(1);
}

const admin = (ruta: string, init: RequestInit = {}) =>
  fetch(`${base}/auth/v1/admin${ruta}`, {
    ...init,
    headers: { apikey: secreta, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20_000),
  });

// Crear; si ya existe, se busca y se le pone la contraseña.
let r = await admin("/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
if (r.status === 201 || r.status === 200) {
  console.log(`Terminal creada: ${email}`);
} else if (r.status === 422) {
  const lista = (await (await admin("/users?per_page=200")).json()) as { users?: { id: string; email: string }[] };
  const existente = lista.users?.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!existente) {
    console.error(`No se pudo crear ni encontrar a ${email}: HTTP ${r.status}`);
    process.exit(1);
  }
  r = await admin(`/users/${existente.id}`, { method: "PUT", body: JSON.stringify({ password, email_confirm: true }) });
  if (!r.ok) {
    console.error(`No se pudo actualizar la contraseña: HTTP ${r.status}`);
    process.exit(1);
  }
  console.log(`La terminal ya existía: contraseña actualizada (${email})`);
} else {
  console.error(`No se pudo crear la terminal: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  process.exit(1);
}

// Lo que hará la app: entrar con la llave PÚBLICA.
const login = await fetch(`${base}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: publica, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
  signal: AbortSignal.timeout(20_000),
});
const sesion = (await login.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
if (login.ok && sesion.access_token) {
  console.log("Inicio de sesión con la llave pública: OK (la app podrá conectarse sola).");
} else {
  console.error(`Inicio de sesión con la llave pública FALLÓ: HTTP ${login.status} ${sesion.error_description ?? ""}`);
  process.exitCode = 1;
}
