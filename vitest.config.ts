import { defineConfig } from "vitest/config";

// Las pruebas leen TEST_DATABASE_URL del mismo `.env` que usa el servidor.
try {
  process.loadEnvFile(".env");
} catch {
  // Sin .env: se espera que el entorno ya traiga las variables (CI).
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Cada archivo crea su propia base, pero los roles de Postgres son globales
    // al servidor; en serie evitamos carreras al crearlos.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
