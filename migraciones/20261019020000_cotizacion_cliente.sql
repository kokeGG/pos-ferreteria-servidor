-- Ver db/sqlite/007_cotizacion_cliente.sql: el cliente de cotización pasa de
-- texto libre a referencia real a `clientes`. NULL = público en general.

ALTER TABLE cotizaciones ADD COLUMN cliente_id UUID REFERENCES clientes(id);

ALTER TABLE cotizaciones DROP COLUMN cliente_nombre;
ALTER TABLE cotizaciones DROP COLUMN cliente_telefono;

CREATE INDEX ix_cotizaciones_cliente ON cotizaciones (cliente_id);
