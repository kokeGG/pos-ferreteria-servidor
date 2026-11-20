import pg from "pg";
import { construirApp } from "./app.js";
import { leerConfig } from "./config.js";

const config = leerConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const app = construirApp({ pool, jwtSecret: config.jwtSecret, almacenDir: config.almacenDir, entorno: process.env, logger: true });

app.addHook("onClose", async () => {
  await pool.end();
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
