import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { leerConfig } from "../src/config.js";
import { requerir } from "../src/timbrar/entorno.ts";
import { ConfiguracionInsegura, PacNoConfigurado, verificarSandbox } from "../src/timbrar/guarda.ts";
import { obtenerPac } from "../src/timbrar/pac.ts";

const carpeta = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "timbrar");

describe("módulos fiscales: copia exacta de los del POS", () => {
  // SHA-256 de supabase/functions/timbrar/*.ts del POS (rama demo/pruebas) al portarlos. Si
  // alguno cambia, cambió la lógica fiscal: hay que revisarlo contra el POS a propósito, no
  // por accidente. Sus pruebas (cfdi-pos.test.ts, facturacom-pos.test.ts) vienen del POS.
  //
  // facturacom-cuerpo.ts cambió a propósito el 2026-11-19: ahora manda `Descuento` en cada
  // concepto que lo tiene (sin él, el sandbox timbraba $98.62 en vez de los $90.00 cobrados).
  // El mismo cambio está en el POS (supabase/functions/timbrar/facturacom-cuerpo.ts).
  const HUELLAS: Record<string, string> = {
    "cfdi.ts": "cf655ebe73eeec181485b368231a2cba2d0a0475dc6cc47ffeac7778a880e005",
    "facturacom-cuerpo.ts": "d2f6233aaa9c256bb398cff5503d1a80f86c719582ab6e7c48d9917ec5910e73",
    "facturacom-mensajes.ts": "bc3d06286762dda84693fe4f1db081fccfde7740e8f99710cd0957f917fb8f1d",
  };
  for (const [archivo, esperada] of Object.entries(HUELLAS)) {
    it(`${archivo} no ha cambiado`, async () => {
      const bytes = await readFile(path.join(carpeta, archivo));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(esperada);
    });
  }
});

describe("verificarSandbox", () => {
  it("acepta el sandbox de Factura.com y devuelve la URL sin barra final", () => {
    expect(verificarSandbox("https://sandbox.factura.com/api")).toBe("https://sandbox.factura.com/api");
    expect(verificarSandbox("https://sandbox.factura.com/api/")).toBe("https://sandbox.factura.com/api");
    expect(verificarSandbox("https://SANDBOX.factura.com/api")).toBe("https://SANDBOX.factura.com/api");
  });

  it("acepta una dirección de esta misma máquina (el Factura.com simulado de las pruebas)", () => {
    for (const url of ["http://127.0.0.1:4010", "http://localhost:4010/api", "https://127.0.0.1:4010", "http://[::1]:4010"]) {
      expect(() => verificarSandbox(url), url).not.toThrow();
    }
  });

  it("rechaza producción, la ausencia de URL y cualquier cosa que solo PAREZCA sandbox", () => {
    const malas: (string | undefined)[] = [
      undefined,
      "",
      "https://api.factura.com",
      "https://api.factura.com/api",
      "https://factura.com/api",
      "http://sandbox.factura.com/api", // sin TLS
      "https://sandbox.factura.com.evil.com/api",
      "https://evil.com/sandbox.factura.com",
      "https://api.factura.com/sandbox",
      "https://api.factura.com/?host=sandbox.factura.com",
      "https://api.factura.com#sandbox.factura.com",
      "https://sandbox.factura.com@api.factura.com/api",
      "https://sandbox.factura.com:pass@api.factura.com/api",
      "https://usuario@sandbox.factura.com/api",
      "https://xsandbox.factura.com/api",
      "https://sandbox-factura.com/api",
      "https://sandbox.factura.com.mx/api",
      "ftp://127.0.0.1",
      "sandbox.factura.com",
      "no es una url",
      "https://127.0.0.1.evil.com",
      "https://localhost.evil.com",
    ];
    for (const url of malas) {
      expect(() => verificarSandbox(url), String(url)).toThrow(ConfiguracionInsegura);
    }
  });

  it("el error es un PacNoConfigurado (la ruta lo responde 501) y explica qué corregir", () => {
    try {
      verificarSandbox("https://api.factura.com");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PacNoConfigurado);
      expect((e as Error).message).toContain("DEMOSTRACIÓN");
      expect((e as Error).message).toContain("https://sandbox.factura.com/api");
      expect((e as Error).message).toContain("api.factura.com");
    }
  });
});

describe("el servidor se niega a arrancar con un PAC que no es el sandbox", () => {
  const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "j".repeat(32) };

  it("leerConfig falla con PAC_PROVEEDOR=facturacom y URL de producción o ausente", () => {
    expect(() => leerConfig({ ...base, PAC_PROVEEDOR: "facturacom", FACTURACOM_BASE_URL: "https://api.factura.com" })).toThrow(/sandbox/);
    expect(() => leerConfig({ ...base, PAC_PROVEEDOR: "facturacom" })).toThrow(/FACTURACOM_BASE_URL/);
  });

  it("arranca con el sandbox, o sin PAC (entonces /timbrar responde 501)", () => {
    expect(() => leerConfig({ ...base, PAC_PROVEEDOR: "facturacom", FACTURACOM_BASE_URL: "https://sandbox.factura.com/api" })).not.toThrow();
    expect(() => leerConfig(base)).not.toThrow();
  });
});

describe("el adaptador también se protege solo (defensa en profundidad)", () => {
  it("un PacFacturaCom con la URL de producción no hace NINGUNA llamada de red", async () => {
    const espia = vi.spyOn(globalThis, "fetch");
    const pac = obtenerPac({ PAC_PROVEEDOR: "facturacom", FACTURACOM_BASE_URL: "https://api.factura.com", FACTURACOM_API_KEY: "k", FACTURACOM_SECRET_KEY: "s" });
    const entrada = { venta: {}, emisor: {}, receptor: { rfc: "AAA010101AAA", nombre: "X", domicilioFiscal: "1", regimenFiscal: "601", usoCfdi: "G03", email: "a@b.c" }, detalles: [] };
    await expect(pac.timbrar(entrada as never)).rejects.toBeInstanceOf(ConfiguracionInsegura);
    await expect(pac.cancelar("uuid", "02")).rejects.toBeInstanceOf(ConfiguracionInsegura);
    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();
  });

  it("obtenerPac sin PAC_PROVEEDOR o con otro valor lanza PacNoConfigurado", () => {
    expect(() => obtenerPac({})).toThrow(PacNoConfigurado);
    expect(() => obtenerPac({ PAC_PROVEEDOR: "facturama" })).toThrow(PacNoConfigurado);
  });
});

describe("requerir", () => {
  it("falla con el nombre de la variable cuando falta o está vacía", () => {
    expect(() => requerir({}, "X")).toThrow("falta la variable de entorno X");
    expect(() => requerir({ X: "" }, "X")).toThrow("falta la variable de entorno X");
    expect(requerir({ X: "v" }, "X")).toBe("v");
  });
});
