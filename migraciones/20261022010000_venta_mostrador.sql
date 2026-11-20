-- Ver db/sqlite/013_venta_mostrador.sql para el porqué. Mismo contenido,
-- sintaxis de Postgres (clientes.id es UUID de verdad aquí).

INSERT INTO clientes (id, numero_cliente, rfc, razon_social, codigo_postal,
                       regimen_fiscal, uso_cfdi)
SELECT '00000000-0000-0000-0000-000000000001'::uuid,
       (SELECT COALESCE(MAX(numero_cliente), 0) + 1 FROM clientes),
       'XAXX010101000', 'VENTA MOSTRADOR PUBLICO EN GENERAL', '39860',
       '616', 'G03'
WHERE NOT EXISTS (
  SELECT 1 FROM clientes
   WHERE rfc = 'XAXX010101000' AND razon_social = 'VENTA MOSTRADOR PUBLICO EN GENERAL'
);
