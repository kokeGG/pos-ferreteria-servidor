import { describe, expect, it } from "vitest";
import { leerConfig } from "../src/config.js";

const bueno = { DATABASE_URL: "postgres://x", JWT_SECRET: "j".repeat(32) };

describe("leerConfig", () => {
  it("lee valores válidos y aplica defaults", () => {
    expect(leerConfig(bueno)).toEqual({
      databaseUrl: "postgres://x",
      jwtSecret: "j".repeat(32),
      port: 3000,
      host: "127.0.0.1",
      almacenDir: "almacen",
    });
  });

  it("falla sin DATABASE_URL", () => {
    expect(() => leerConfig({ JWT_SECRET: bueno.JWT_SECRET })).toThrow(/DATABASE_URL/);
  });

  it("falla con un JWT_SECRET corto o ausente", () => {
    expect(() => leerConfig({ DATABASE_URL: "x", JWT_SECRET: "corto" })).toThrow(/JWT_SECRET/);
    expect(() => leerConfig({ DATABASE_URL: "x" })).toThrow(/JWT_SECRET/);
  });

  it("falla con un puerto inválido", () => {
    expect(() => leerConfig({ ...bueno, PORT: "abc" })).toThrow(/PORT/);
    expect(() => leerConfig({ ...bueno, PORT: "70000" })).toThrow(/PORT/);
  });
});
