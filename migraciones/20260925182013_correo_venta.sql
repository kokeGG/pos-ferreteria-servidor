-- Rastro del envío del CFDI por correo. Ver db/sqlite/005_correo_venta.sql
-- para la explicación completa; misma columna en los dos esquemas.

ALTER TABLE ventas ADD COLUMN correo_enviado_en TIMESTAMPTZ;
ALTER TABLE ventas ADD COLUMN error_correo TEXT;
