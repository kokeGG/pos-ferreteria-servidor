-- Permisos que SÍ necesita la app, explícitos.
--
-- Los proyectos nuevos de Supabase ya no dan permisos automáticos al rol
-- `authenticated` (la terminal de la app) ni a `service_role` (la función de
-- timbrado) sobre lo que se crea por SQL en `public`. Las migraciones
-- heredadas lo daban por hecho, y sin esto la app recibe "permission denied"
-- en todas las tablas. La seguridad por fila (RLS) sigue mandando: estos
-- permisos solo dejan que las políticas se evalúen.
--
-- `anon` (la llave pública) NO recibe nada: ver 20261121000003.

GRANT USAGE ON SCHEMA public TO authenticated, service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- Funciones: la terminal solo ejecuta las dos de inventario (ya concedidas en
-- 20261024010000); la función de timbrado (service_role) puede con todas.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- Lo que se cree después (otra migración), igual.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;

-- La tabla del aplicador de migraciones no es de la app.
DO $$
BEGIN
    IF to_regclass('public._migraciones') IS NOT NULL THEN
        REVOKE ALL ON public._migraciones FROM authenticated, service_role;
    END IF;
END $$;
