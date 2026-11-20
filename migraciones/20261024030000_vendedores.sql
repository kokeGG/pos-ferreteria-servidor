-- Vendedores: clave de usuario y vendedor de cada venta/cotización.
-- Espejo de db/sqlite/017_vendedores.sql (ver README.md → "Vendedores").

ALTER TABLE usuarios ADD COLUMN clave TEXT;
CREATE UNIQUE INDEX ux_usuarios_clave ON usuarios (clave) WHERE clave IS NOT NULL;

ALTER TABLE ventas ADD COLUMN vendedor_id UUID REFERENCES usuarios(id);
ALTER TABLE cotizaciones ADD COLUMN vendedor_id UUID REFERENCES usuarios(id);
CREATE INDEX ix_ventas_vendedor ON ventas (vendedor_id);

-- Los usuarios que ya existían reciben clave 1, 2, 3… en el orden en que se
-- dieron de alta. Se hace aquí (y no en cada caja) para que todas las cajas
-- reciban LA MISMA clave por el pull: el UPDATE mueve `actualizado_en`.
UPDATE usuarios u
   SET clave = n.clave
  FROM (SELECT id, (row_number() OVER (ORDER BY creado_en, id))::text AS clave
          FROM usuarios WHERE clave IS NULL) n
 WHERE u.id = n.id;
