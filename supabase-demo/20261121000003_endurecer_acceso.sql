-- Endurecimiento de acceso para el proyecto de Supabase de la DEMO.
--
-- Supabase da al rol `anon` (el de la llave PÚBLICA, la que viaja dentro de la
-- app) permisos amplios por omisión sobre todo lo que se crea en `public`.
-- Midiendo las migraciones heredadas contra esos permisos se vio que:
--
--   * Las vistas v_ventas, v_ventas_por_dia, v_margen_productos,
--     v_pendientes_global y v_inventario_descuadres corren con los permisos de
--     su dueño y SE SALTAN la seguridad por fila: con la llave pública se leían
--     todas las ventas con nombre y RFC del cliente, aunque la tabla `ventas`
--     estuviera protegida.
--   * aplicar_movimientos_inventario e inicializar_inventario_global
--     (SECURITY DEFINER) eran ejecutables con la llave pública: cualquiera
--     podía mover la existencia.
--
-- La app entra siempre autenticada (rol `authenticated`) y la función de
-- timbrado usa la llave secreta (service_role): `anon` no necesita nada.

-- Las vistas respetan los permisos y la seguridad por fila de QUIEN consulta.
ALTER VIEW v_ventas                SET (security_invoker = true);
ALTER VIEW v_ventas_por_dia        SET (security_invoker = true);
ALTER VIEW v_margen_productos      SET (security_invoker = true);
ALTER VIEW v_pendientes_global     SET (security_invoker = true);
ALTER VIEW v_inventario_descuadres SET (security_invoker = true);

-- `anon` no toca nada de `public`...
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- Postgres da EXECUTE a PUBLIC (todos los roles, también `anon`) en toda función
-- nueva: se quita, y quedan solo los permisos explícitos (authenticated y
-- service_role). Los disparadores no se ven afectados: se ejecutan por el
-- mecanismo de triggers, no por una llamada del usuario.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- ...ni en lo que se cree después (otra migración, otro desarrollador).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- La tabla del aplicador de migraciones (src/migrar.ts) no es de nadie más.
DO $$
BEGIN
    IF to_regclass('public._migraciones') IS NOT NULL THEN
        ALTER TABLE public._migraciones ENABLE ROW LEVEL SECURITY;
    END IF;
END $$;
