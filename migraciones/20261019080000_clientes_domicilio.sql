-- Ver db/sqlite/010_clientes_domicilio.sql: domicilio estructurado del
-- cliente, para cargar el catálogo heredado de FoxPro.

ALTER TABLE clientes ADD COLUMN domicilio  TEXT;
ALTER TABLE clientes ADD COLUMN numero_ext TEXT;
ALTER TABLE clientes ADD COLUMN numero_int TEXT;
ALTER TABLE clientes ADD COLUMN colonia    TEXT;
ALTER TABLE clientes ADD COLUMN municipio  TEXT;
ALTER TABLE clientes ADD COLUMN ciudad     TEXT;
ALTER TABLE clientes ADD COLUMN estado     TEXT;
