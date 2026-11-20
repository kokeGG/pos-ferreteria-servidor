# Plan de migración: de Supabase a Node.js + PostgreSQL (rama demo)

Documento de trabajo del proyecto `pos-ferreteria-servidor`. Dice qué es este
proyecto, por qué existe, qué ya está hecho y qué falta, fase por fase.

Última actualización: 2026-11-01. Fases 1 a 6 terminadas; la 7 pendiente.

---

## 1. Contexto y objetivo

El POS (`pos-ferreteria`, Tauri + React) trabaja **offline-first**: cada caja
vende sobre su SQLite local y sincroniza con una réplica en la nube. Hoy esa
nube es Supabase y **`main` ya es producción**: usa Factura.com real, y las
llaves y la URL de la API viven como secretos del proyecto de Supabase, no en
git.

Se necesita un entorno **demo** para operar con el **sandbox** de Factura.com
sin tocar producción. El plan gratuito de Supabase no permite un segundo
proyecto, así que la nube de la demo será este servidor propio.

**Decisiones tomadas**

| Tema | Decisión | Por qué |
|---|---|---|
| Alcance | Solo la rama `demo/pruebas` del POS | `main` y las ventas reales no se tocan; si la demo funciona se decide después si producción migra |
| Dónde corre | La PC del desarrollador (Docker + Node) | Gratis; la demo la opera una sola persona |
| Proyecto | Repositorio aparte (este), no dentro del POS | Pedido explícito; el backend tiene su propio ciclo |
| Ubicación en disco | `C:\Users\keko_\pos-ferreteria-servidor`, fuera de OneDrive | Evita sincronizar `node_modules` y los datos de Postgres |
| Estrategia de cliente | Reemplazar `src/lib/supabase.ts` por un cliente propio con las mismas funciones que usa el POS | `sync.ts` y `facturacion.ts` casi no cambian |
| Migraciones | Copia exacta de `supabase/migrations`, sin editar | Se pueden comparar archivo a archivo con producción |

**Lo que NO es esto:** no es una migración de producción, no migra datos
reales, no toca las cajas instaladas ni el actualizador de producción.

---

## 2. Arquitectura destino

```
  Caja (Tauri)                       Servidor (este proyecto)            Externos
 ┌──────────────┐   HTTP + JWT     ┌────────────────────────┐
 │ SQLite local │ ───────────────► │ Fastify (Node 24)      │ ──────► Factura.com (sandbox)
 │ sync_queue   │                  │  /auth  /sync  /rpc    │ ──────► Gmail (SMTP)
 │ cliente nube │ ◄─────────────── │  /storage  /timbrar    │
 └──────────────┘                  │  /actualizaciones      │
                                   └───────────┬────────────┘
                                               │ pg
                                   ┌───────────▼────────────┐
                                   │ PostgreSQL 17 (Docker) │   archivos: ./almacen/
                                   └────────────────────────┘
```

Qué reemplaza a qué:

| Supabase | Aquí |
|---|---|
| Auth (usuario único por terminal) | `terminales` + `sesiones`, JWT + refresh con rotación (hecho) |
| PostgREST (`.from().select/upsert`) | Endpoints de sincronización con lista blanca de tablas (hecho, fase 3) |
| `.rpc()` | `POST /rpc/:nombre` con lista blanca (hecho, fase 3) |
| RLS | El servidor autoriza; se conecta como dueño de las tablas. RLS queda activada en el esquema pero no interviene |
| Storage (`cfdi-xml`, `cfdi-pdf`, `app-updates`) | Carpetas en disco + URLs firmadas (hecho, fase 4) |
| Edge Function `timbrar` (Deno) | Ruta Node `POST /timbrar` (hecho, fase 5) |
| Realtime | No se usa. El bloque de la migración está protegido con `IF EXISTS` y no hace nada aquí |

---

## 3. Estado por fase

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Postgres en Docker + servidor + migraciones | ✅ Terminada |
| 2 | Autenticación de terminales | ✅ Terminada |
| 3 | API de sincronización y `rpc` | ✅ Terminada |
| 4 | Almacenamiento (XML/PDF) y hosting del actualizador | ✅ Terminada |
| 5 | `timbrar` portado a Node, contra el sandbox | ✅ Terminada y verificada contra el sandbox real |
| 6 | Cliente en el POS (`demo/pruebas`) | ✅ Terminada (falta abrir la app de escritorio) |
| 7 | Pruebas de punta a punta y puesta en marcha de la demo | ⏳ Pendiente |

El orden importa: 3 y 4 son independientes entre sí (la 3 ya está); 5 depende de 3 y 4 (lee y
escribe ventas y guarda archivos); 6 depende de 3, 4 y 5; 7 cierra.

---

## 4. Fases terminadas

### Fase 1: Postgres y servidor

- `docker-compose.yml`: Postgres 17 en `127.0.0.1:5433`, volumen `pgdata`, con
  chequeo de salud. Solo escucha en la propia PC.
- `migraciones/`: 25 de las 27 migraciones de producción, copiadas **sin
  editar**. Se omitieron `20260923030046_storage_cfdi.sql` y
  `20261019230000_storage_actualizaciones.sql` porque crean buckets de
  `storage.*`, que no existe aquí (los reemplaza la fase 4).
- `00000000000000_base.sql`: crea los roles `anon`, `authenticated` y
  `service_role`, que las migraciones heredadas nombran en `CREATE POLICY` y
  `GRANT`. No autorizan nada; solo permiten que apliquen sin editarse.
- `src/migrar.ts`: aplicador con las mismas reglas que el de la caja: orden por
  nombre, una transacción por migración, huella SHA-256, rechazo si una
  migración ya aplicada cambió, CRLF y LF dan la misma huella.
- Resultado verificado: 27 migraciones aplicadas en limpio, 6,619 productos y
  8,078 clientes cargados.

### Fase 2: autenticación

- Migración `20261101000001_terminales.sql`: tablas `terminales` y `sesiones`.
- Contraseña con scrypt y sal; refresh token aleatorio de 32 bytes del que solo
  se guarda el SHA-256.
- Rutas: `GET /salud`, `POST /auth/login`, `POST /auth/refresh`,
  `POST /auth/logout`, `GET /auth/yo`. El decorador `app.autenticar` es el
  `preHandler` que protegerá todas las rutas de las fases siguientes.
- Access token 1 h; refresh 90 días con rotación (el usado queda revocado en el
  mismo `UPDATE` que lo valida, así dos usos simultáneos no pueden ganar los
  dos). Desactivar una terminal corta sus tokens al instante.
- Correo inexistente y contraseña mala dan el mismo error y tardan lo mismo.
- Esquemas de entrada estrictos: un campo de más responde 400.
- `npm run terminal:crear` da de alta o cambia la contraseña de una terminal
  (la contraseña va por variable de entorno, no por argumento).
- `npm run humo` recorre el flujo completo por HTTP contra la base real.

**Verificación:** 34 pruebas; 24 de 24 mutaciones detectadas (ver sección 8).

**Todavía no hecho en esta fase (decisión consciente):** no hay límite de
intentos de login ni sesión anónima (`signInAnonymously`). La app demo usa
credenciales de terminal, así que la sesión anónima no hace falta. El límite de
intentos es poco relevante mientras el servidor solo escuche en `127.0.0.1`;
sería obligatorio antes de exponerlo a una red.

### Fase 3: API de sincronización y `rpc`

Todo en `src/sync.ts` (`registrarSincronizacion`), detrás de `app.autenticar`.
Se autentica **antes** de validar el cuerpo: un cuerpo inválido sin token es
401, no 400.

**Contrato** (lo que el cliente de la fase 6 debe llamar):

| Ruta | Cuerpo → respuesta | Sustituye a |
|---|---|---|
| `POST /sync/:tabla/consultar` | `{ columnas?, filtros?, despues?, orden?, limite? }` → `{ filas }` | `.from().select()` con `eq/gt/gte/lt/lte/in`, `order`, `limit` y `.or()` |
| `POST /sync/:tabla/upsert` | `{ filas: [...] }` (1 a 500, en una transacción) → `{ guardadas }` | `.upsert(fila, { onConflict })` |
| `POST /rpc/aplicar_movimientos_inventario` | `{ p_movimientos, p_caja_id }` → la lista que devuelve la función | `.rpc()` |
| `POST /rpc/inicializar_inventario_global` | `{ p_caja_id, p_corte_en, p_existencias }` → `{ productos, corte_en }` | `.rpc()` |
| `GET` / `PUT /config/:clave` | `{ valor }` → `{ clave, valor, actualizado_en }` | `config_nube` (`maybeSingle` / `upsert`) |

Decisiones que se apartan del plan original:

- **La consulta es `POST`, no `GET`.** El filtro `in` de las hijas lleva hasta
  200 UUID y el cursor tiene varios campos; en la URL sería frágil. Sigue
  siendo solo lectura.
- **Cursor estructurado.** `despues: { col, valor, llave_valor? }` equivale a
  `col > valor OR (col = valor AND llave > llave_valor)` y fija el orden
  `(col, llave)`. Sin `llave_valor` es solo `col > valor` (primer lote). No se
  combina con `orden` (400). La llave de cada tabla sale de `TABLAS` (`id`, o
  `codigo` en `producto_codigos`).
- **Fechas con microsegundos** (`2026-11-01T10:00:00.123456+00:00`), igual que
  PostgREST, y `bigint` como número. Pasar por `Date` truncaría a milisegundos
  y la fila del borde del cursor volvería a salir en cada página.
- **Una fila con solo la llave se rechaza** (400): ninguna tabla lo permite por
  los NOT NULL. El POS siempre sube la fila completa (`SELECT *`).
- **Solo lectura:** `movimientos_inventario` (sube únicamente por la RPC, para
  no saltarse el cálculo de la existencia global) e `inventario_global`. Un
  upsert ahí responde 403.
- **`recibido_en` no es escribible** (lo pone el servidor; es el cursor del
  historial). La existencia (`stock_mil`, `stock_version`) que mande la caja se
  acepta pero la ignora el trigger de la migración, como en producción.

**Lista blanca.** Tablas fijas en `TABLAS`; columnas leídas de
`information_schema` (no de la entrada); todo nombre va entre comillas solo
después de comprobarse contra esas listas; los valores siempre son parámetros.
Tabla desconocida: 404. Columna u operador desconocido: 400.

**Errores.** El cuerpo es `{ code, message }` con el SQLSTATE original.
`23505` → 409; `42501` → 403; clases 22 y 23 y `P0001` → 400; clases 40, 08,
53, 57 y conexión caída → **503** (transitorio); el resto → 500 con mensaje
genérico (el detalle solo va al registro del servidor). Se probó que los cinco
códigos que `sync.ts` del POS trata como definitivos (`23505 23514 23502 22P02
42501`) llegan intactos y con 4xx.

**Verificación:** 56 pruebas nuevas (`test/sync.test.ts`), 90 en total.
Incluyen: el catálogo sembrado de 6,619 filas con casi la misma marca,
paginado sin saltar ni repetir; filas con el mismo microsegundo con páginas de
1; concurrencia con conexiones reales (12 envíos simultáneos del mismo
movimiento se aplican una vez; 20 ventas simultáneas al mismo producto nunca
bajan la existencia de cero y el kardex cuadra; lotes con distinto orden no se
interbloquean); y ataques de inyección por nombre de tabla, columna y valor.
Pasada de mutaciones: 34 de 35 detectados; el que sobrevive es equivalente (el
patrón del nombre de columna es una segunda capa y la lista blanca ya lo
bloquea). `npm run humo` recorre el catálogo real completo (6,619 de 6,619) por
HTTP.

**Todavía no verificado:** el cliente real del POS contra este servidor (es la
fase 6). El criterio "las pruebas de `sync` del POS pasan contra este
servidor" queda para entonces.

### Fase 4: almacenamiento y actualizador

Código en `src/almacen.ts` (la clase `Almacen`, que también usa `timbrar` sin
pasar por HTTP) y `src/almacen-rutas.ts`. Carpeta `almacen/<bucket>/…`
(`ALMACEN_DIR` en `.env`, por omisión `./almacen`, ya ignorada por git).

| Bucket | Visibilidad | Límite | Tipos | Ruta |
|---|---|---|---|---|
| `cfdi-xml` | privado | 1 MB | `application/xml`, `text/xml` | `<anio>/<mes>/<uuid_sat>.xml` y `…-cancelacion.xml` (acuse) |
| `cfdi-pdf` | privado | 10 MB | `application/pdf` | `<anio>/<mes>/<uuid_sat>.pdf` |
| `app-updates` | **público** | 100 MB | cualquiera | `latest.json` + instaladores (hasta 3 carpetas) |

| Ruta | Qué hace |
|---|---|
| `PUT /storage/:bucket/*` | Sube (autenticado). No sobrescribe: un archivo existente da 409, como el permiso de solo INSERT de la migración original. Sin ruta de borrado: un CFDI no se elimina. |
| `GET /storage/:bucket/*` | Baja (autenticado), `cache-control: private, no-store`. |
| `POST /storage/:bucket/firmar` | `{ ruta, expira_en? }` → `{ url, expira_en }`. 300 s por omisión (lo que usa el POS), máximo 3600. La URL es absoluta (`/firmado/…`) porque el POS se la pasa al navegador del sistema; se arma con el `Host` de la petición. 404 si el archivo no existe. |
| `GET /firmado/:bucket/*?exp&sig` | Baja con la URL firmada, **sin token**. HMAC-SHA-256 sobre bucket, ruta y vencimiento, con una clave derivada de `JWT_SECRET` (no la misma). Vencida, alterada o de otro archivo: el mismo 403. |
| `GET /actualizaciones/*` | Público y **solo lectura** (`latest.json` e instaladores, en flujo). No existe ningún otro método para esa ruta: PUT/POST/DELETE dan 404. La escritura es solo local: el desarrollador copia los archivos a `almacen/app-updates/`. |

`app-updates` no se alcanza por `/storage` (404), ni los CFDI por
`/actualizaciones`.

**Rutas.** Se validan contra la convención del bucket (regex cerrada) y, aparte,
contra nombres de dispositivo de Windows (`NUL`, `CON`…), puntos finales,
flujos alternos (`:`), ocultos (`.x`), barras invertidas y bytes nulos. Después
se comprueba que lo resuelto sigue dentro del bucket, **con enlaces simbólicos
y *junctions* resueltos** (`realpath`), y las carpetas se crean una por una
rechazando cualquier enlace: `mkdir -p` a través de un enlace habría creado
carpetas fuera del bucket antes de poder detectarlo. Las dos fallas reales que
encontraron las pruebas fueron justo esas dos.

**Verificación:** 35 pruebas (`test/almacen.test.ts`): ida y vuelta de XML y PDF
byte por byte; exactamente en el límite entra y un byte más es 413; tipo
equivocado 415; 10 subidas simultáneas a la misma ruta (gana una, sin
temporales); 24 rutas de ataque con un archivo secreto real fuera del bucket;
firma válida, vencida, con la vigencia alargada, de otro archivo y de otro
bucket; el endpoint público no deja escribir con ningún método. Pasada de
mutaciones: 31 de 31 (2 son capas redundantes y sobreviven a propósito:
la comprobación `startsWith` repite a la regex, y el chequeo de cuerpo binario
lo cubre antes el de tipo MIME). `npm run humo` comprueba lo básico contra la
instalación real sin escribir nada.

**Pendiente de la caja:** servir `latest.json` real e instaladores firmados de
la demo (fase 6 decide si hay actualizador).

---

### Fase 5: `timbrar` en Node

Código en `src/timbrar/`. Ruta: **`POST /timbrar`** (autenticada), con los
mismos cuerpos y las mismas respuestas `{ error }` que la Edge Function, así
que el POS solo cambia de dónde llama (fase 6).

| Archivo | Qué es |
|---|---|
| `cfdi.ts`, `facturacom-cuerpo.ts`, `facturacom-mensajes.ts` | **Copia exacta** (mismo SHA-256, comprobado por una prueba) de la lógica fiscal del POS. `.gitattributes` evita que git les cambie los saltos de línea. |
| `facturacom.ts`, `mailer.ts`, `pac.ts` | Portados con solo lo necesario: entorno inyectado en vez de `Deno.env`, `nodemailer` normal, tiempo límite de 90 s al PAC, guarda de sandbox, adjuntos como `Buffer` (en Node un `Uint8Array` no es un adjunto válido). |
| `guarda.ts` | La guarda de sandbox (abajo). |
| `repositorio.ts` | Las ~35 consultas `sb.from()` reescritas como SQL sobre `pg`, tras una interfaz `Repositorio`. Columnas escribibles por tabla fijas en código. |
| `servicio.ts` | Port de `index.ts`: la lógica y los mensajes, sin `Response` ni Supabase. |
| `rutas.ts` | La ruta y el candado por id. |

**Guarda de sandbox** (la razón de ser del proyecto). Tres capas: (1)
`leerConfig` no deja arrancar el servidor si `PAC_PROVEEDOR=facturacom` y la
URL no es la del sandbox; (2) el adaptador del PAC la revisa en cada llamada
y se niega *antes* de abrir una conexión (si falta `FACTURACOM_BASE_URL` ya no
cae a producción como hacía la función original); (3) `/timbrar` responde 501
con el motivo. Es más estricta que "contiene `sandbox`": acepta solo
`https://sandbox.factura.com` (o una dirección de esta misma máquina, para el
Factura.com simulado de las pruebas). Se rechazan 22 variantes que solo
*parecen* sandbox (`sandbox.factura.com.evil.com`, `api.factura.com/sandbox`,
usuario en la URL, `http`, etc.).

**Idempotencia y concurrencia.** Con la lectura "¿ya está timbrada?" y luego la
llamada al PAC, dos peticiones simultáneas a la misma venta (doble clic, o un
reintento de la caja mientras la primera espera al PAC) llamaban las dos al PAC
y gastaban dos timbres. Se agregó un candado en memoria por id (timbrar,
cancelar y reenviar): la segunda espera y recibe `ya_timbrada`. Se descartó un
candado de Postgres porque cada petición en espera retendría una conexión del
pool y, con diez o más al mismo id, quien tiene el candado se quedaría sin
conexión. Vale mientras el servidor sea **un solo proceso**.

**Variables (`.env`, nunca en git ni en el chat):** `PAC_PROVEEDOR=facturacom`,
`FACTURACOM_API_KEY`, `FACTURACOM_SECRET_KEY`,
`FACTURACOM_BASE_URL=https://sandbox.factura.com/api`, `CFDI_EMISOR_RFC`,
`CFDI_EMISOR_NOMBRE`, `CFDI_EMISOR_REGIMEN`, `CFDI_EMISOR_CP`, y opcionales
`GMAIL_USER`, `GMAIL_APP_PASSWORD`, `CORREO_REMITENTE_NOMBRE`,
`CORREO_RESPONDER_A`. Sin las del PAC, `/timbrar` responde 501.

**También se hizo aquí:** CORS (`Access-Control-Allow-Origin: *`, preflight
`OPTIONS` con 204). El webview del POS es otro origen y sin esto el
`POST` con `Authorization` nunca sale (la Edge Function lo tenía). Es seguro
porque la autenticación es por cabecera, no por cookies. Aplica a **todas** las
rutas, no solo a `/timbrar`.

**Diferencias deliberadas con la función de Deno:**
- Un error de base de datos o una variable de entorno faltante dan 500 con su
  mensaje; antes un error de lectura se disfrazaba de "todavía no llega a la
  nube" (404).
- Las notas de una global se ordenan por letra y folio (antes, sin orden; el
  CFDI ya las reordenaba, así que el resultado es el mismo).
- Un `id` que no es UUID da 400 en vez de un error de Postgres.

**Verificación:** 46 pruebas (`test/timbrar.test.ts`) contra Postgres real, el
almacén en disco y un **Factura.com simulado** (`test/factura-com-simulada.ts`,
un servidor HTTP local con modos de falla), más 12 de la guarda y la integridad
(`test/timbrar-guarda.test.ts`) y las 30 del POS portadas (`cfdi-pos`,
`facturacom-pos`). Cubren: facturar, idempotencia, 15 peticiones simultáneas a
la misma venta (un solo timbre), ventas distintas en paralelo, rechazo del PAC
con HTTP 200, HTTP 500 y respuesta que no es JSON, credenciales malas, XML que
no se puede guardar (no queda como timbrada), correo que falla (la factura
sigue timbrada) y reenvío, factura global (carpeta del periodo, bimestres,
notas faltantes o de más), cancelación (acuse, idempotente, 8 simultáneas, PAC
que rechaza deja la venta timbrada), RFC genérico, y la guarda. Pasada de
mutaciones: 48 de 48 detectados (reglas de qué se puede timbrar, idempotencia,
candado, cancelación, global, correo, almacén y cada regla de la guarda). Dos
las encontró la propia pasada y se agregaron: la forma de pago de la rama de
RFC genérico y el reintento con el mismo UUID.

**Recorrido real contra el sandbox (2026-11-19, `npm run humo:timbrar`): 12 de 12.**
Con las llaves y el emisor del `.env`, en una base y una carpeta temporales
(se borran al terminar, así no quedan ventas de prueba en la base de la demo):
factura nominativa (UUID real, XML y PDF guardados, correo enviado), repetir la
petición no vuelve a timbrar, reenvío del correo, cancelación con acuse (y
repetirla no llama al PAC), factura a público en general, y factura global de 2
notas con su cancelación. Con esto quedan confirmadas las rutas de cancelación,
que el código original marcaba como "según su documentación, sin llamada real".
Lo que sigue sin probarse contra el sandbox: un rechazo real del PAC (solo se
probó con el simulado) y la cancelación de una factura que el receptor deba
aceptar.

**Puntos abiertos que vienen de la función original** (se conservaron; son de
lógica fiscal y no se tocaron):
1. Si el PAC **timbra** pero la descarga del PDF falla, el adaptador lanza, la
   venta queda en `ERROR` y el CFDI ya existe en el PAC. Un reintento crearía
   otro (el comentario original asume que el PAC devuelve el mismo UUID; no
   está comprobado).
2. Una cancelación con respuesta `success` pero sin acuse (receptor que debe
   aceptarla) se anota como CANCELADA de inmediato, sin esperar la aceptación.
3. La carpeta de una global usa `new Date(anio, mes, 1)` en hora local del
   servidor; en una PC con otra zona horaria podría caer en el mes vecino.

**Listo cuando:** facturar, cancelar y reenviar correo funcionan contra el
sandbox y producen los mismos resultados que la función de Deno. **Hecho.**

### Fase 6: cliente en el POS (rama `demo/pruebas`)

Se hizo en el repo del POS, solo en esa rama (sin commit todavía: los cambios
están en el árbol de trabajo para revisarlos). `main` no se tocó.

**Cliente.** `src/lib/nube-cliente.ts` (`ClienteNube`) reemplaza a
supabase-js con la MISMA forma de lo que usan `sync.ts`, `facturacion.ts` y las
pantallas, así que esos archivos casi no cambiaron (solo un tipo importado y
`removeChannel?.()`). `src/lib/supabase.ts` conserva el nombre y las 9 funciones
exportadas. La dependencia `@supabase/supabase-js` se quitó.

| supabase-js | Servidor |
|---|---|
| `from(t).select().eq/gt/gte/lt/lte/in/order/limit/maybeSingle` | `POST /sync/:t/consultar` |
| `.or("A.gt.X,and(A.eq.X,K.gt.Y)")` (cursor compuesto) | `despues: { col, valor, llave_valor }`. Es la única forma de `.or` que se admite; cualquier otra da error sin mandar nada |
| `from(t).upsert(fila, { onConflict })` | `POST /sync/:t/upsert` (la llave la fija el servidor) |
| `rpc(nombre, args)` | `POST /rpc/:nombre` |
| `storage.from(b).download / createSignedUrl` | `GET /storage/…` y `POST /storage/:b/firmar` (`{ url }` → `{ signedUrl }`) |
| `functions.invoke("timbrar")` | `POST /timbrar`; un error HTTP trae la respuesta en `error.context`, así `mensajeDeError` sigue funcionando |
| `config_nube` | `GET/PUT /config/:clave` |

**Sesión.** Access token de 1 h y refresh rotatorio en `localStorage`. Se
renueva antes de vencer, y ante un 401 renueva una vez y reintenta. Un solo
refresh a la vez (el token rota y no admite dos usos): 8 peticiones con el
token vencido gastan uno. Si el refresh ya no sirve y la app trae las
credenciales de la terminal, **vuelve a entrar sola**; un fallo de red conserva
la sesión. Los errores conservan el SQLSTATE en `error.code` (el cajero no
ve nada, pero `sync.ts` decide con él si descarta o reintenta); un fallo de
red no lleva `code`, así que siempre se reintenta.

**Configuración.** `.env` del POS: `VITE_API_URL=http://127.0.0.1:3000` y la
terminal (`VITE_TERMINAL_*`, copiada sin imprimirse desde el `.env` del
servidor). **El `.env` está versionado en el POS**, así que la contraseña de
la terminal de la demo quedará en el repo si se hace commit (igual que ya pasaba
con la de producción en `main`). Tauri: `identifier`
`mx.ferreteria.pos.demo` (base SQLite propia: no comparte datos con la app de
producción), `productName` y título de ventana con "DEMO", CSP con
`http://127.0.0.1:3000` en lugar de supabase.co, `createUpdaterArtifacts`
apagado, y el actualizador apunta a `/actualizaciones` del servidor (vacío, con
`dangerousInsecureTransportProtocol`: **sin actualizador en la demo**, que era
la opción más simple de la pregunta abierta 3). Rotulado "DEMO": insignia fija
(`InsigniaDemo`), título, y nombre y pie del ticket por omisión.

**Sin Realtime.** `sync.ts` ya lo trataba como opcional; otra caja que vende
se refleja en el siguiente ciclo de 30 s.

**Verificación.**
- `nube-cliente.test.ts` (37 pruebas, con un `fetch` falso): traducción de cada
  llamada, el cursor con microsegundos, SQLSTATE, sesión (refresh único,
  re-entrada, red caída). Pasada de mutaciones: **27 de 27**.
- Pruebas existentes del POS: `sync.test.ts`, `inventario-cajas.test.ts`,
  `facturacion.test.ts` siguen en verde (476 de 477; la que falla,
  `nucleo.test.ts › el descuento nunca pasa del importe del renglón`, **ya falla
  en el commit anterior** sin estos cambios: viene del commit "descuento").
  `tsc --noEmit` y `npm run build` pasan.
- **De punta a punta, con el código real de la app** (`nube-servidor.test.ts`,
  14 pruebas, `npm run humo:pos` desde este repo): levanta un servidor y una
  base desechables en el puerto 3000 y corre cajas SQLite reales contra él.
  Pull de **14,697 filas en 2.3 s** y el segundo pull baja 0; subir de regreso
  el "eco" del catálogo (cada fila bajada se encola una vez): 14,697 filas en
  **71 s** (74 pasadas, un POST por fila) sin errores; vender en A, sincronizar,
  y B recupera la venta y la existencia; **dos cajas vendiendo el mismo producto
  a la vez** con conexiones reales (la existencia global cuadra y nunca baja de
  cero); una caja con la misma letra y folio recibe `23505` y su cola lo marca
  como rechazo definitivo; corte inicial una sola vez; y, contra el sandbox
  real, **timbrar, bajar XML, abrir el PDF por la URL firmada sin sesión,
  timbrar otra vez (no gasta otro timbre) y cancelar**, todo por
  `timbrarVenta`/`cancelarFacturaDeVenta` del POS.

**No verificado:** abrir la app de escritorio (`npm run app`): hace falta Rust
y una ventana; ni el CSP de Tauri ni el origen del webview (`http://tauri.localhost`)
contra el servidor se probaron con el webview real. Lo que sí se probó es el
preflight CORS del servidor. La subida del "eco" (71 s) es el comportamiento
de la app; si molesta, se puede subir por lotes con `/sync/:t/upsert` (acepta
hasta 500 filas), que el cliente hoy no aprovecha.

**Listo cuando:** `tsc`, `npm test` y `npm run build` pasan, y una caja con la
rama demo sincroniza contra este servidor. **Hecho** (salvo la app de
escritorio, que solo se puede revisar abriéndola).

---

## 5. Fases pendientes (7)

### Fase 7: pruebas de punta a punta y puesta en marcha

1. Recorrido manual en una caja: login automático → venta → ticket →
   sincronización (Ctrl+F9 sin pendientes) → facturar contra el sandbox →
   descargar XML/PDF → cancelar → factura global → inventario global.
2. Resiliencia offline-first: apagar el servidor, vender, volver a encenderlo y
   comprobar que la cola vacía sin duplicar ni perder ventas.
3. Reinicio del servidor y de Docker con sesiones abiertas.
4. Respaldo y restauración de la base demo (`pg_dump`) y de `almacen/`.
5. Arranque cómodo en Windows: script o acceso directo que levante Docker, el
   servidor y abra la app; que `npm start` quede como servicio o tarea
   programada si se quiere que arranque con la PC.
6. Documentar la operación en el README del POS (rama demo): cómo arrancar,
   cómo crear una terminal, cómo limpiar los datos de prueba, cómo volver a
   producción.

**Listo cuando:** puedes operar la demo tú solo de principio a fin sin tocar la
nube de producción.

---

## 6. Riesgos y puntos abiertos

| Riesgo / duda | Qué hacer |
|---|---|
| Un `.env` con llaves **de producción** copiado a este servidor timbraría facturas reales | Guarda de sandbox en tres capas, probada con 22 URLs engañosas (hecho, fase 5) |
| La demo instalada comparte SQLite con producción si no cambia el `identifier` | Fase 6, punto 3 |
| La demo se "actualiza" con el instalador de producción | Cambiar o quitar el endpoint del actualizador (fase 6) |
| El endpoint genérico de tablas puede ser inyección SQL | Lista blanca estricta + consultas parametrizadas + pruebas de ataque (hecho, fase 3) |
| Rechazos mal clasificados dejan la cola reintentando sin fin | SQLSTATE conservado y 4xx/5xx probados (hecho, fase 3); falta comprobarlo con el cliente real (fase 6) |
| Las dos migraciones de `storage.*` y cualquier migración futura de producción pueden divergir | Copiar cada migración nueva del POS con el mismo nombre; no editar las copiadas |
| El servidor solo funciona con la PC y Docker encendidos | Aceptado para la demo de un solo operador; ver fase 7, punto 5 |
| Sin límite de intentos de login ni HTTPS | Aceptable en `127.0.0.1`; obligatorio antes de abrir el servidor a una red |
| PGlite (pruebas del POS) usa una sola conexión y no prueba concurrencia real | Prueba con conexiones reales (hecho, fase 3) |
| Los datos cargados son los del catálogo y clientes **reales** de la ferretería | Es información del cliente; tratarla como tal si la base se respalda o se comparte |

| Un servidor de un solo proceso: el candado de `/timbrar` es en memoria | Aceptado (un operador, una PC). Con varios procesos habría que pasar a un candado de base de datos |
| CORS `*` en todas las rutas | Seguro porque la autenticación es por cabecera, no cookies; si algún día se expone a una red, restringir a los orígenes de la app |
| Si el PAC timbra y falla la descarga del PDF, la venta queda en ERROR con el CFDI ya emitido | Heredado de la función original; ver "Puntos abiertos" de la fase 5 |

Preguntas abiertas para el dueño:

1. ¿La demo se usará solo desde esta PC, o también desde otra caja de prueba?
   Si es otra máquina, hay que escuchar en la red y pasar a HTTPS (cambia fases
   2, 6 y 7).
2. ¿Quieres que la demo conserve el catálogo y los clientes reales o arrancar
   con datos de ejemplo? (Hoy carga los reales por las migraciones de semilla.)
3. ¿Sin actualizador en la demo, o se monta uno propio con HTTPS?

---

## 7. Cómo trabajar este proyecto

```
npm run db:up        # levanta Postgres
npm run migrar       # aplica migraciones pendientes
npm run dev          # servidor con recarga
npm run humo         # recorrido contra la base real (sin escribir)
npm run humo:timbrar # recorrido real contra el sandbox de Factura.com (base temporal)
npm run humo:pos     # cajas del POS (SQLite) contra un servidor desechable, con facturación en el sandbox
npm test             # pruebas (Postgres arriba)
npm run typecheck
```

Variables (`.env`, copia de `.env.example`; no se sube a git): `POSTGRES_PASSWORD`,
`DATABASE_URL`, `TEST_DATABASE_URL`, `JWT_SECRET`, `PORT`, `HOST`, y para crear
terminales `TERMINAL_EMAIL` / `TERMINAL_PASSWORD`.

Estructura:

```
migraciones/   SQL (copia de producción + base + terminales)
src/           app.ts, auth.ts, sync.ts, almacen.ts, almacen-rutas.ts, config.ts, migrar.ts, servidor.ts, crear-terminal.ts, humo.ts
src/timbrar/   copia fiscal del POS + facturacom, mailer, pac, guarda, repositorio, servicio, rutas
test/          vitest contra Postgres real (bases pos_test_* temporales)
almacen/       archivos subidos (fase 4; ignorado por git)
```

---

## 8. Criterio de calidad para cada fase

1. Escribir las pruebas junto con el código.
2. `npm run typecheck` y `npm test` en verde.
3. **Pasada de mutaciones:** romper a propósito cada regla clave del código
   (script que parchea, corre las pruebas y restaura en `finally`) y comprobar
   que alguna prueba falla. Si un mutante sobrevive, falta una prueba. En las
   fases 1 y 2: 24 de 24 detectados tras corregir 2 supervivientes (el orden de
   las migraciones y la atomicidad entre cambio y registro).
4. Recorrido real (`npm run humo` o equivalente) contra la base de verdad, no
   solo contra las pruebas.
5. Reportar qué se verificó y qué no (por ejemplo, el Factura.com del sandbox
   solo puede probarlo quien tiene las llaves).
6. Secretos solo en `.env`, nunca en el chat, en el repo ni en la salida de
   comandos.
