import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Almacen, claveDeFirmas, firmarUrl, verificarFirma } from "../src/almacen.js";
import { construirApp } from "../src/app.js";
import { hashPassword } from "../src/auth.js";
import { migrar } from "../src/migrar.js";
import { baseLimpia, CARPETA_MIGRACIONES } from "./ayudas.js";

const SECRETO = "s".repeat(40);
const MB = 1024 * 1024; // literal a propósito: no depender de las constantes que se prueban
const SECRETO_EN_DISCO = "CONTENIDO-SECRETO-FUERA-DEL-BUCKET";

let base: Awaited<ReturnType<typeof baseLimpia>>;
let app: ReturnType<typeof construirApp>;
let raiz: string;
let token: string;

beforeAll(async () => {
  base = await baseLimpia("pos_test_almacen");
  await migrar(base.pool, CARPETA_MIGRACIONES);
  raiz = await mkdtemp(path.join(tmpdir(), "almacen-test-"));
  app = construirApp({ pool: base.pool, jwtSecret: SECRETO, almacenDir: raiz });
  await app.ready();
  await base.pool.query("INSERT INTO terminales (email, password_hash) VALUES ($1, $2)", [
    "caja@ferreteria.local",
    await hashPassword("x-contraseña-1"),
  ]);
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "caja@ferreteria.local", password: "x-contraseña-1" },
  });
  token = r.json().access_token;

  // Un archivo que NO debe poder alcanzarse: junto a las carpetas de los buckets y un nivel más arriba.
  await writeFile(path.join(raiz, "secreto.txt"), SECRETO_EN_DISCO);
  await writeFile(path.join(raiz, "..", "secreto-arriba.txt"), SECRETO_EN_DISCO).catch(() => undefined);
  await mkdir(path.join(raiz, "app-updates"), { recursive: true });
  await writeFile(path.join(raiz, "app-updates", "latest.json"), JSON.stringify({ version: "9.9.9" }));
  await writeFile(path.join(raiz, "app-updates", "instalador_1.0.0_x64-setup.exe"), Buffer.alloc(3 * 1024 * 1024, 7));
});

afterAll(async () => {
  await app.close();
  await base.cerrar();
  await rm(raiz, { recursive: true, force: true });
  await rm(path.join(raiz, "..", "secreto-arriba.txt"), { force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });
const uuid = () => randomUUID();
const rutaXml = (u = uuid()) => `2026/09/${u}.xml`;
const rutaPdf = (u = uuid()) => `2026/09/${u}.pdf`;
const XML = '<?xml version="1.0"?><cfdi:Comprobante Total="116.00"/>';
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 1)]);

const subir = (bucket: string, ruta: string, cuerpo: string | Buffer, tipo: string, headers = auth()) =>
  app.inject({ method: "PUT", url: `/storage/${bucket}/${ruta}`, headers: { ...headers, "content-type": tipo }, payload: cuerpo });
const bajar = (bucket: string, ruta: string, headers = auth()) =>
  app.inject({ method: "GET", url: `/storage/${bucket}/${ruta}`, headers });
const firmar = (bucket: string, cuerpo: object) =>
  app.inject({ method: "POST", url: `/storage/${bucket}/firmar`, headers: auth(), payload: cuerpo });

describe("ida y vuelta", () => {
  it("un XML sube, baja idéntico y con su tipo", async () => {
    const ruta = rutaXml();
    const s = await subir("cfdi-xml", ruta, XML, "application/xml");
    expect(s.statusCode, s.body).toBe(201);
    const b = await bajar("cfdi-xml", ruta);
    expect(b.statusCode).toBe(200);
    expect(b.body).toBe(XML);
    expect(b.headers["content-type"]).toContain("application/xml");
    expect(b.headers["cache-control"]).toBe("private, no-store");
    expect(existsSync(path.join(raiz, "cfdi-xml", ...ruta.split("/")))).toBe(true);
  });

  it("un PDF sube y baja byte por byte (también con charset en el tipo de un XML)", async () => {
    const ruta = rutaPdf();
    expect((await subir("cfdi-pdf", ruta, PDF, "application/pdf")).statusCode).toBe(201);
    const b = await bajar("cfdi-pdf", ruta);
    expect(Buffer.compare(b.rawPayload, PDF)).toBe(0);
    expect(b.headers["content-type"]).toContain("application/pdf");
    expect((await subir("cfdi-xml", rutaXml(), XML, "text/xml; charset=utf-8")).statusCode).toBe(201);
  });

  it("el acuse de cancelación vive junto al XML con la misma convención", async () => {
    const u = uuid();
    expect((await subir("cfdi-xml", `2026/09/${u}-cancelacion.xml`, XML, "application/xml")).statusCode).toBe(201);
  });

  it("un archivo inexistente es 404", async () => {
    expect((await bajar("cfdi-xml", rutaXml())).statusCode).toBe(404);
  });

  it("no se sobrescribe por HTTP (la caja solo tenía permiso de INSERT)", async () => {
    const ruta = rutaXml();
    expect((await subir("cfdi-xml", ruta, XML, "application/xml")).statusCode).toBe(201);
    const otra = await subir("cfdi-xml", ruta, "<otro/>", "application/xml");
    expect(otra.statusCode).toBe(409);
    expect((await bajar("cfdi-xml", ruta)).body).toBe(XML);
  });

  it("no hay forma de borrar un CFDI", async () => {
    const ruta = rutaXml();
    await subir("cfdi-xml", ruta, XML, "application/xml");
    const d = await app.inject({ method: "DELETE", url: `/storage/cfdi-xml/${ruta}`, headers: auth() });
    expect(d.statusCode).toBe(404);
    expect((await bajar("cfdi-xml", ruta)).statusCode).toBe(200);
  });

  it("subidas simultáneas a la misma ruta: gana una, las demás 409, sin temporales", async () => {
    const ruta = rutaXml();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => subir("cfdi-xml", ruta, `<a n="${i}"/>`, "application/xml")));
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(9);
    const dentro = await readdir(path.join(raiz, "cfdi-xml", "2026", "09"));
    expect(dentro.filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });
});

describe("límites de tamaño y de tipo", () => {
  it("un XML de más de 1 MB es 413 y no queda nada", async () => {
    const ruta = rutaXml();
    const r = await subir("cfdi-xml", ruta, Buffer.alloc(MB + 1, 0x20), "application/xml");
    expect(r.statusCode).toBe(413);
    expect((await bajar("cfdi-xml", ruta)).statusCode).toBe(404);
  });

  it("un XML de exactamente 1 MB entra", async () => {
    expect((await subir("cfdi-xml", rutaXml(), Buffer.alloc(MB, 0x20), "application/xml")).statusCode).toBe(201);
  });

  it("un PDF de exactamente 10 MB entra", async () => {
    const r = await subir("cfdi-pdf", rutaPdf(), Buffer.alloc((10 * MB), 1), "application/pdf");
    expect(r.statusCode, r.body).toBe(201);
  });

  it("un PDF de más de 10 MB es 413", async () => {
    const r = await subir("cfdi-pdf", rutaPdf(), Buffer.alloc((10 * MB) + 1, 1), "application/pdf");
    expect(r.statusCode).toBe(413);
  });

  it("el tipo debe ser el del bucket: PDF en el de XML y XML en el de PDF dan 415", async () => {
    expect((await subir("cfdi-xml", rutaXml(), PDF, "application/pdf")).statusCode).toBe(415);
    expect((await subir("cfdi-pdf", rutaPdf(), XML, "application/xml")).statusCode).toBe(415);
    expect((await subir("cfdi-xml", rutaXml(), "x", "image/png")).statusCode).toBe(415);
  });

  it("un cuerpo JSON (no binario) o vacío se rechaza", async () => {
    const json = await app.inject({
      method: "PUT",
      url: `/storage/cfdi-xml/${rutaXml()}`,
      headers: { ...auth(), "content-type": "application/json" },
      payload: { a: 1 },
    });
    expect(json.statusCode).toBe(415);
    expect((await subir("cfdi-xml", rutaXml(), "", "application/xml")).statusCode).toBe(400);
  });
});

describe("buckets", () => {
  it("un bucket inexistente es 404, en subida, bajada y firma", async () => {
    expect((await subir("otro", rutaXml(), XML, "application/xml")).statusCode).toBe(404);
    expect((await bajar("otro", rutaXml())).statusCode).toBe(404);
    expect((await firmar("otro", { ruta: rutaXml() })).statusCode).toBe(404);
  });

  it("nombres de bucket como propiedades de Object no existen", async () => {
    for (const b of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect((await bajar(b, rutaXml())).statusCode, b).toBe(404);
    }
  });

  it("app-updates no se toca por /storage: ni subir, ni bajar, ni firmar", async () => {
    expect((await subir("app-updates", "latest.json", "{}", "application/json")).statusCode).toBe(404);
    expect((await bajar("app-updates", "latest.json")).statusCode).toBe(404);
    expect((await firmar("app-updates", { ruta: "latest.json" })).statusCode).toBe(404);
    expect(JSON.parse(await readFile(path.join(raiz, "app-updates", "latest.json"), "utf8"))).toEqual({ version: "9.9.9" });
  });
});

describe("autenticación", () => {
  it("/storage exige token, y una terminal desactivada pierde el acceso", async () => {
    const ruta = rutaXml();
    expect((await subir("cfdi-xml", ruta, XML, "application/xml", {} as never)).statusCode).toBe(401);
    expect((await bajar("cfdi-xml", ruta, {} as never)).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/storage/cfdi-xml/firmar", payload: { ruta } })).statusCode).toBe(401);
    // Se autentica antes de validar: cuerpo inválido sin token también es 401.
    expect((await app.inject({ method: "POST", url: "/storage/cfdi-xml/firmar", payload: { x: 1 } })).statusCode).toBe(401);
    await base.pool.query("UPDATE terminales SET activa = false");
    expect((await bajar("cfdi-xml", ruta)).statusCode).toBe(401);
    await base.pool.query("UPDATE terminales SET activa = true");
  });
});

describe("rutas: traversal y convención", () => {
  const ataques = [
    "../secreto.txt",
    "..%2fsecreto.txt",
    "%2e%2e%2fsecreto.txt",
    "%2e%2e/%2e%2e/secreto.txt",
    "2026/09/../../../secreto.txt",
    "..\\secreto.txt",
    "..%5csecreto.txt",
    "%2fsecreto.txt",
    "/secreto.txt",
    "C:/Windows/win.ini",
    "C%3A%5CWindows%5Cwin.ini",
    "2026/09/%00.xml",
    "secreto.txt",
    "2026/09/secreto.xml",
    "2026/13/" + "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12) + ".xml",
    "2026/9/" + uuid() + ".xml",
    "26/09/" + uuid() + ".xml",
    "2026/09/" + uuid() + ".xml.exe",
    "2026/09/" + uuid() + ".xml:stream",
    "2026/09/" + uuid() + ".pdf", // convención de PDF en el bucket de XML
    "2026/09/" + uuid() + "/" + uuid() + ".xml",
    "2026/09//" + uuid() + ".xml",
    "2026/09/" + uuid() + "-cancelacion.pdf",
  ];

  it("ninguna ruta fuera de la convención llega al disco, en lectura ni escritura", async () => {
    for (const ruta of ataques) {
      const g = await bajar("cfdi-xml", ruta);
      expect(g.statusCode, `GET ${ruta}`).not.toBe(200);
      expect(g.body, `GET ${ruta}`).not.toContain(SECRETO_EN_DISCO);
      const p = await subir("cfdi-xml", ruta, XML, "application/xml");
      expect([400, 404], `PUT ${ruta}`).toContain(p.statusCode);
    }
    // Nada se escribió fuera de la convención.
    expect(existsSync(path.join(raiz, "..", "2026"))).toBe(false);
    expect(existsSync(path.join(raiz, "secreto.xml"))).toBe(false);
    expect(await readFile(path.join(raiz, "secreto.txt"), "utf8")).toBe(SECRETO_EN_DISCO);
  });

  it("resolver() rechaza lo mismo directamente (no depende de la capa HTTP)", () => {
    const a = new Almacen(raiz);
    for (const ruta of ["../secreto.txt", "/etc/passwd", "a/../../b", "..", ".", "", "2026/09/x.xml", rutaXml() + " ", " " + rutaXml(), rutaXml() + "\n"]) {
      expect(() => a.resolver("cfdi-xml", ruta), ruta).toThrow();
    }
    expect(a.resolver("cfdi-xml", rutaXml()).startsWith(path.join(raiz, "cfdi-xml") + path.sep)).toBe(true);
  });

  it("en app-updates: nombres de dispositivo de Windows, ocultos, flujos, vacíos y demasiado hondos", () => {
    const a = new Almacen(raiz);
    const malas = [
      "NUL", "nul.txt", "CON", "aux.json", "com1", "LPT9.exe", "a/nul", ".hidden", "a/.hidden", "..", "a/../b", "a//b",
      "a\\b", "a:b", "a.txt:stream", "fin.", "con espacio", "a/b/c/d/e", "-guion", "", "/abs", "a/", "%00", "a\u0000b",
    ];
    for (const m of malas) expect(() => a.resolver("app-updates", m), JSON.stringify(m)).toThrow();
    for (const buena of ["latest.json", "v1.2.3/setup_1.2.3_x64.exe", "setup_1.0.0+build.5.exe.sig"]) {
      expect(() => a.resolver("app-updates", buena), buena).not.toThrow();
    }
  });

  it("un enlace simbólico fuera del bucket no se sirve", async () => {
    // En Windows crear symlinks exige privilegios: si no se puede, no hay nada que probar.
    const carpeta = path.join(raiz, "app-updates");
    const enlace = path.join(carpeta, "fuga.txt");
    const ok = await import("node:fs/promises").then((fs) => fs.symlink(path.join(raiz, "secreto.txt"), enlace).then(() => true, () => false));
    if (!ok) return;
    const r = await app.inject({ method: "GET", url: "/actualizaciones/fuga.txt" });
    expect(r.body).not.toContain(SECRETO_EN_DISCO);
    expect(r.statusCode).toBe(404);
  });
});

describe("enlaces simbólicos", () => {
  it("no se escribe a través de una carpeta enlazada hacia fuera del bucket", async () => {
    const { symlink, mkdir: mk } = await import("node:fs/promises");
    const fuera = path.join(raiz, "fuera");
    await mk(fuera, { recursive: true });
    const ok = await symlink(fuera, path.join(raiz, "cfdi-xml", "2031"), "junction").then(() => true, () => false);
    if (!ok) return;
    const r = await subir("cfdi-xml", `2031/09/${uuid()}.xml`, XML, "application/xml");
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readdir(fuera).catch(() => [])).toEqual([]);
    await rm(path.join(raiz, "fuera", "09"), { recursive: true, force: true });
  });
});

describe("URLs firmadas", () => {
  const clave = claveDeFirmas(SECRETO);

  async function firmada(ruta: string, cuerpo: object = {}) {
    const r = await firmar("cfdi-xml", { ruta, ...cuerpo });
    expect(r.statusCode, r.body).toBe(200);
    const u = new URL(r.json().url);
    return { r, url: u, relativa: u.pathname + u.search };
  }

  it("la URL firmada baja el archivo SIN token y vence a los 300 s por omisión", async () => {
    const ruta = rutaXml();
    await subir("cfdi-xml", ruta, XML, "application/xml");
    const { r, relativa, url } = await firmada(ruta);
    expect(r.json().expira_en).toBe(300);
    const exp = Number(url.searchParams.get("exp"));
    expect(exp - Date.now() / 1000).toBeGreaterThan(295);
    expect(exp - Date.now() / 1000).toBeLessThanOrEqual(300);
    expect(url.pathname).toBe(`/firmado/cfdi-xml/${ruta}`);
    const g = await app.inject({ method: "GET", url: relativa });
    expect(g.statusCode).toBe(200);
    expect(g.body).toBe(XML);
  });

  it("una URL firmada vencida da 403", async () => {
    const ruta = rutaXml();
    await subir("cfdi-xml", ruta, XML, "application/xml");
    const { exp, sig } = firmarUrl(clave, "cfdi-xml", ruta, 300, Date.now() - 301_000);
    const g = await app.inject({ method: "GET", url: `/firmado/cfdi-xml/${ruta}?exp=${exp}&sig=${sig}` });
    expect(g.statusCode).toBe(403);
  });

  it("alterar la firma, el vencimiento, la ruta o el bucket da 403", async () => {
    const a = rutaXml();
    const b = rutaXml();
    await subir("cfdi-xml", a, XML, "application/xml");
    await subir("cfdi-xml", b, "<otro/>", "application/xml");
    const { url } = await firmada(a);
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    const mal = [
      `/firmado/cfdi-xml/${a}?exp=${exp}&sig=${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`,
      `/firmado/cfdi-xml/${a}?exp=${Number(exp) + 3600}&sig=${sig}`, // vigencia alargada
      `/firmado/cfdi-xml/${b}?exp=${exp}&sig=${sig}`, // firma de otro archivo
      `/firmado/cfdi-pdf/${a.replace(".xml", ".pdf")}?exp=${exp}&sig=${sig}`, // otro bucket
      `/firmado/cfdi-xml/${a}?exp=${exp}&sig=`,
      `/firmado/cfdi-xml/${a}?exp=${exp}&sig=${"x".repeat(43)}`,
    ];
    for (const u of mal) {
      const g = await app.inject({ method: "GET", url: u });
      expect([400, 403], u).toContain(g.statusCode);
      expect(g.body).not.toBe(XML);
    }
    expect((await app.inject({ method: "GET", url: `/firmado/cfdi-xml/${a}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/firmado/cfdi-xml/${a}?exp=abc&sig=x` })).statusCode).toBe(400);
  });

  it("una firma válida no abre rutas fuera de la convención (traversal con firma correcta)", async () => {
    const ruta = "../secreto.txt";
    const { exp, sig } = firmarUrl(clave, "cfdi-xml", ruta, 300);
    const g = await app.inject({ method: "GET", url: `/firmado/cfdi-xml/..%2fsecreto.txt?exp=${exp}&sig=${sig}` });
    expect(g.body).not.toContain(SECRETO_EN_DISCO);
    expect(g.statusCode).not.toBe(200);
  });

  it("firmar un archivo inexistente es 404; vigencias fuera de rango 400", async () => {
    expect((await firmar("cfdi-xml", { ruta: rutaXml() })).statusCode).toBe(404);
    expect((await firmar("cfdi-xml", { ruta: "../secreto.txt" })).statusCode).toBe(400);
    const ruta = rutaXml();
    await subir("cfdi-xml", ruta, XML, "application/xml");
    expect((await firmar("cfdi-xml", { ruta, expira_en: 3601 })).statusCode).toBe(400);
    expect((await firmar("cfdi-xml", { ruta, expira_en: 0 })).statusCode).toBe(400);
    expect((await firmar("cfdi-xml", { ruta, extra: 1 })).statusCode).toBe(400);
    expect((await firmar("cfdi-xml", { ruta, expira_en: 60 })).json().expira_en).toBe(60);
  });

  it("verificarFirma: vence justo en el límite y es sensible a cada campo", () => {
    const ahora = 1_800_000_000_000;
    const { exp, sig } = firmarUrl(clave, "cfdi-xml", "r", 300, ahora);
    expect(verificarFirma(clave, "cfdi-xml", "r", exp, sig, ahora + 299_000)).toBe(true);
    expect(verificarFirma(clave, "cfdi-xml", "r", exp, sig, ahora + 301_000)).toBe(false);
    expect(verificarFirma(clave, "cfdi-pdf", "r", exp, sig, ahora)).toBe(false);
    expect(verificarFirma(clave, "cfdi-xml", "s", exp, sig, ahora)).toBe(false);
    expect(verificarFirma(clave, "cfdi-xml", "r", exp + 1, sig, ahora)).toBe(false);
    expect(verificarFirma(claveDeFirmas("otro-secreto-distinto-de-40-caracteres!!"), "cfdi-xml", "r", exp, sig, ahora)).toBe(false);
    expect(verificarFirma(clave, "cfdi-xml", "r", Number.NaN, sig, ahora)).toBe(false);
  });

  it("la clave de firmas no es el secreto de los JWT", () => {
    expect(claveDeFirmas(SECRETO).toString()).not.toContain(SECRETO);
    expect(claveDeFirmas(SECRETO).equals(Buffer.from(SECRETO))).toBe(false);
  });
});

describe("/actualizaciones (público, solo lectura)", () => {
  it("sirve latest.json sin token, con su tipo", async () => {
    const r = await app.inject({ method: "GET", url: "/actualizaciones/latest.json" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.json()).toEqual({ version: "9.9.9" });
  });

  it("sirve un instalador completo con su tamaño", async () => {
    const r = await app.inject({ method: "GET", url: "/actualizaciones/instalador_1.0.0_x64-setup.exe" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-length"]).toBe(String(3 * 1024 * 1024));
    expect(r.rawPayload.length).toBe(3 * 1024 * 1024);
    expect(r.headers["content-type"]).toContain("application/octet-stream");
  });

  it("no deja escribir: PUT, POST, DELETE y PATCH dan 404 y no cambian nada", async () => {
    for (const method of ["PUT", "POST", "DELETE", "PATCH"] as const) {
      const r = await app.inject({
        method,
        url: "/actualizaciones/latest.json",
        headers: method === "DELETE" ? auth() : { ...auth(), "content-type": "application/json" },
        payload: method === "DELETE" ? undefined : '{"version":"0.0.1-malicioso"}',
      });
      expect(r.statusCode, method).toBe(404);
    }
    const nuevo = await app.inject({ method: "PUT", url: "/actualizaciones/nuevo.json", headers: auth(), payload: "{}" });
    expect(nuevo.statusCode).toBe(404);
    expect(existsSync(path.join(raiz, "app-updates", "nuevo.json"))).toBe(false);
    expect(JSON.parse(await readFile(path.join(raiz, "app-updates", "latest.json"), "utf8"))).toEqual({ version: "9.9.9" });
  });

  it("archivo inexistente o carpeta es 404; traversal y nombres raros no llegan al disco", async () => {
    expect((await app.inject({ method: "GET", url: "/actualizaciones/no-existe.json" })).statusCode).toBe(404);
    for (const ruta of ["..%2fsecreto.txt", "%2e%2e%2fsecreto.txt", "../secreto.txt", "..%5csecreto.txt", "nul", "a:b", ".env", "%00"]) {
      const r = await app.inject({ method: "GET", url: `/actualizaciones/${ruta}` });
      expect(r.statusCode, ruta).not.toBe(200);
      expect(r.body, ruta).not.toContain(SECRETO_EN_DISCO);
    }
    // Los CFDI no se alcanzan por aquí aunque se conozca la ruta.
    const ruta = rutaXml();
    await subir("cfdi-xml", ruta, XML, "application/xml");
    expect((await app.inject({ method: "GET", url: `/actualizaciones/${ruta}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/actualizaciones/..%2fcfdi-xml%2f${ruta.replace(/\//g, "%2f")}` })).statusCode).not.toBe(200);
  });
});

describe("Almacen.guardar (lo que usará timbrar)", () => {
  it("sobrescribir reemplaza (un reintento del PAC devuelve el mismo UUID) y no deja temporales", async () => {
    const a = new Almacen(raiz);
    const ruta = rutaXml();
    await a.guardar("cfdi-xml", ruta, Buffer.from("<v1/>"), "application/xml");
    await expect(a.guardar("cfdi-xml", ruta, Buffer.from("<v2/>"), "application/xml")).rejects.toMatchObject({ estado: 409 });
    await a.guardar("cfdi-xml", ruta, Buffer.from("<v2/>"), "application/xml", { sobrescribir: true });
    expect((await a.leer("cfdi-xml", ruta))?.toString()).toBe("<v2/>");
    const dentro = await readdir(path.join(raiz, "cfdi-xml", "2026", "09"));
    expect(dentro.filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });

  it("también valida tipo, tamaño y ruta cuando se usa directo", async () => {
    const a = new Almacen(raiz);
    await expect(a.guardar("cfdi-xml", rutaXml(), Buffer.from("x"), "application/pdf")).rejects.toMatchObject({ estado: 415 });
    await expect(a.guardar("cfdi-xml", rutaXml(), Buffer.alloc(2_000_000), "application/xml")).rejects.toMatchObject({ estado: 413 });
    await expect(a.guardar("cfdi-xml", "../x.xml", Buffer.from("x"), "application/xml")).rejects.toMatchObject({ estado: 400 });
    await expect(a.guardar("nada", rutaXml(), Buffer.from("x"), "application/xml")).rejects.toMatchObject({ estado: 404 });
  });
});
