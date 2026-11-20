-- Roles que las migraciones heredadas de Supabase mencionan
-- (`CREATE POLICY ... TO authenticated`, `GRANT EXECUTE ... TO authenticated`).
--
-- Aquí NO se usan para autorizar: el servidor Node es el único que habla con
-- la base, conectado como dueño de las tablas (que se salta RLS), y decide
-- quién puede qué antes de tocar SQL. Existen solo para que las migraciones
-- de producción apliquen sin editarse y se puedan comparar una a una.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN;
    END IF;
END $$;
