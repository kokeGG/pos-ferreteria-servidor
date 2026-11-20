-- Ajustes compartidos en la nube, editables desde la app (Ctrl+F9) sin tocar
-- secretos de las Edge Functions ni volver a desplegar nada. Es el equivalente
-- en la nube de la tabla `config` local de SQLite, pero esa es la identidad
-- física de CADA caja (caja_id...) y nunca se sincroniza; esta es al revés,
-- compartida entre todas las cajas, por eso vive sólo aquí y se lee/escribe
-- directo contra Supabase desde Conexion.tsx, sin pasar por sync_queue.
--
-- Primer valor: el correo con el que se da de alta ante el PAC al receptor
-- genérico de la factura global ("PUBLICO EN GENERAL" / XAXX010101000) — ver
-- supabase/functions/timbrar/index.ts. No se le manda nada a este correo; el
-- PAC sólo lo exige para registrar ese receptor la primera vez que se timbra.
CREATE TABLE config_nube (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE config_nube ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_config_nube_authenticated ON config_nube
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO config_nube (clave, valor) VALUES ('correo_publico_general', '');
