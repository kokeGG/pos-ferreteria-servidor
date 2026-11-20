-- Ver db/sqlite/015_correo_factura_global.sql para la explicación completa;
-- misma columna en los dos esquemas.

ALTER TABLE facturas_globales ADD COLUMN correo_enviado_en TIMESTAMPTZ;
ALTER TABLE facturas_globales ADD COLUMN error_correo TEXT;
