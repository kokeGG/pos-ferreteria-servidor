# POS Ferretería — servidor (demo)

Backend en Node.js + PostgreSQL que reemplaza a Supabase para la rama
`demo/pruebas` del POS (`../OneDrive/Documentos/pos-ferreteria`). Producción
(`main`) sigue en Supabase y no depende de este proyecto.

## Arranque

```
npm install
cp .env.example .env        # llena POSTGRES_PASSWORD y JWT_SECRET (ver comentarios)
npm run db:up               # Postgres 17 en Docker, 127.0.0.1:5433
npm run migrar              # aplica migraciones/ en orden
TERMINAL_EMAIL=caja-a@ferreteria.local TERMINAL_PASSWORD=<12+ caracteres> npm run terminal:crear
npm run dev                 # http://127.0.0.1:3000
```

`npm run humo` recorre login → refresh → logout contra la base real y se apaga
solo. `npm test` corre las pruebas (necesita Postgres arriba; crea y borra sus
propias bases `pos_test_*`).

## Qué hay (fases 1 a 5)

| Ruta | Para qué |
|---|---|
| `GET /salud` | ¿Responde el servidor y la base? |
| `POST /auth/login` | Correo + contraseña de la terminal → `access_token` (1 h) y `refresh_token` (90 días) |
| `POST /auth/refresh` | Cambia un refresh token por una sesión nueva; el usado queda revocado |
| `POST /auth/logout` | Revoca un refresh token |
| `GET /auth/yo` | Quién soy (requiere `Authorization: Bearer …`) |
| `POST /sync/:tabla/consultar`, `POST /sync/:tabla/upsert` | Leer (con cursor) y subir filas de las tablas permitidas |
| `POST /rpc/aplicar_movimientos_inventario`, `POST /rpc/inicializar_inventario_global` | Inventario global |
| `GET`/`PUT /config/:clave` | `config_nube` |
| `PUT`/`GET /storage/:bucket/*`, `POST /storage/:bucket/firmar`, `GET /firmado/…` | CFDI (XML/PDF) privados, con URLs firmadas de 300 s |
| `GET /actualizaciones/*` | Público y de solo lectura: `latest.json` e instaladores |
| `POST /timbrar` | Facturar una venta o global, cancelar, reenviar el correo (sandbox de Factura.com) |

**`/timbrar` solo habla con el sandbox.** Con `PAC_PROVEEDOR=facturacom` el
servidor no arranca si `FACTURACOM_BASE_URL` no es `https://sandbox.factura.com/…`
(ver `.env.example`). Pendiente: el cliente en la app (fase 6) y las pruebas de
punta a punta (fase 7).

## Migraciones

`migraciones/` son las de `supabase/migrations` del POS, **copiadas sin editar**,
salvo las dos de `storage.*` (buckets), que el servidor reemplaza con carpetas.
`00000000000000_base.sql` crea los roles `anon`/`authenticated`/`service_role`
que esas migraciones nombran; aquí no autorizan nada, el servidor decide.

Una migración aplicada no se edita (el aplicador guarda su huella y se niega a
seguir si cambió): un cambio es siempre un archivo nuevo.

Cuando se agregue una migración nueva en el POS para producción, cópiala aquí
con el mismo nombre.

## Seguridad

- La contraseña de cada terminal es un hash scrypt con sal; el refresh token
  solo existe en claro en la caja (en la base va su SHA-256).
- Desactivar una terminal (`UPDATE terminales SET activa = false`) la corta de
  inmediato, aunque su token no haya vencido.
- Postgres solo escucha en 127.0.0.1. `.env` no se sube a git.

## Plan completo

Ver [PLAN.md](PLAN.md): contexto, decisiones, estado y las fases 6 y 7 pendientes.
