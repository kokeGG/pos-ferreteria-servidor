# Supabase de la demo: cómo se montó y cómo repetirlo

Proyecto: el de la demo (`zawiurctwqkowpixkyee`). **No es el de producción.** La
carpeta `supabase/` del repo del POS está enlazada por la CLI al proyecto de
producción: en cualquier comando de la CLI pasa SIEMPRE `--project-ref` con el
de la demo.

## Variables en `.env` de ESTE repo (el del servidor; nunca en el del POS)

`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
`SUPABASE_DB_URL` (Connect → **Session pooler**, puerto 5432).

## 1. Base de datos (esquema, catálogo y clientes)

```
npm run supabase:aplicar
```

Arma 26 migraciones del POS (sin las 2 de productos de La Base) + el catálogo
nuevo + 2 migraciones de este directorio, las aplica (solo agrega, re-ejecutable)
y verifica que la llave pública (`anon`) no vea ni ejecute nada.

- `20261121000003_endurecer_acceso.sql`: cierra lo que `anon` leía por las vistas
  y las funciones de inventario ejecutables con la llave pública.
- `20261121000004_permisos_de_la_app.sql`: los proyectos nuevos de Supabase ya no
  dan permisos automáticos a `authenticated`/`service_role`; sin esto la app recibe
  "permission denied".

## 2. Terminal de la app (Supabase Auth)

```
npm run supabase:terminal
```

Crea (o actualiza la contraseña de) `TERMINAL_EMAIL` y comprueba que entra con la
llave pública.

## 3. Función de facturación (en el repo del POS, rama `dh-demo-supabase`)

```
npx supabase functions deploy timbrar --project-ref zawiurctwqkowpixkyee
npx supabase secrets set --env-file <archivo> --project-ref zawiurctwqkowpixkyee
```

Secretos: `PAC_PROVEEDOR`, `FACTURACOM_API_KEY`, `FACTURACOM_SECRET_KEY`,
`FACTURACOM_BASE_URL` (**sandbox**), `CFDI_EMISOR_*`, `GMAIL_*` y `SB_SECRET_KEY`
(la llave secreta del proyecto; los nombres que empiezan con `SUPABASE_` están
reservados). La CLI pide confirmación explícita (`--yes`) al correr desde un agente.

La función de esta rama difiere de la de producción en dos cosas: se **niega a
timbrar** si la URL del PAC no es `https://sandbox.factura.com` (la original caía a
producción si faltaba el secreto) y **exige una sesión de usuario real** (`verify_jwt`
deja pasar también la llave pública, que viaja dentro de la app).

## Prueba de punta a punta (solo lectura) desde el POS

```
POS_SUPABASE=1 npx vitest run src/lib/nube-supabase.test.ts
```
