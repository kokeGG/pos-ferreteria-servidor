-- Ver db/sqlite/014_cotizacion_convertida.sql para el porqué.

ALTER TABLE cotizaciones ADD COLUMN convertida_en_venta_id UUID REFERENCES ventas(id);
