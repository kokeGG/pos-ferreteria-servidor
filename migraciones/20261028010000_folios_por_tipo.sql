-- Notas de venta y facturas con numeración separada. Espejo de
-- db/sqlite/019_folios_por_tipo.sql (ver README.md → "Folios").
--
-- Nota de venta: C-000001…   Factura: 000001-C…   Cada serie de cada letra
-- empieza en 1; el folio es único por (letra, tipo, número).

ALTER TABLE ventas DROP CONSTRAINT ux_ventas_folio;
ALTER TABLE ventas ADD CONSTRAINT ux_ventas_folio UNIQUE (caja_id, requiere_factura, folio_local);

-- Las notas que ya existen se renumeran desde 1 por letra, en el orden en que
-- se hicieron (las facturas NO se tocan: ya están timbradas y conservan su
-- número). El folio con que se imprimió el ticket queda en `folio_anterior`,
-- así se sigue encontrando por él en el historial. Las cajas reciben el cambio
-- por el pull (folio_local y folio_anterior están en CAMPOS_ACTUALIZABLES).
--
-- En dos pasos (primero negativo) para que ninguna fila choque con otra que
-- todavía no se ha movido: la restricción única se revisa renglón por renglón.
WITH n AS (
    SELECT id, row_number() OVER (PARTITION BY caja_id ORDER BY folio_local) AS nuevo
      FROM ventas
     WHERE requiere_factura = false
)
UPDATE ventas v
   SET folio_anterior = COALESCE(v.folio_anterior, v.caja_id || '-' || lpad(v.folio_local::text, 6, '0')),
       folio_local = -n.nuevo
  FROM n
 WHERE v.id = n.id AND v.folio_local <> n.nuevo;

UPDATE ventas SET folio_local = -folio_local WHERE folio_local < 0;

CREATE OR REPLACE VIEW v_ventas AS
SELECT
    v.id,
    CASE WHEN v.requiere_factura
         THEN lpad(v.folio_local::text, 6, '0') || '-' || v.caja_id
         ELSE v.caja_id || '-' || lpad(v.folio_local::text, 6, '0')
    END AS folio,
    v.creado_en,
    COALESCE(c.razon_social, 'PUBLICO EN GENERAL')        AS cliente,
    c.rfc,
    (v.subtotal_cent  / 100.0)::numeric(14,2) AS subtotal,
    (v.descuento_cent / 100.0)::numeric(14,2) AS descuento,
    (v.impuestos_cent / 100.0)::numeric(14,2) AS iva,
    (v.total_cent     / 100.0)::numeric(14,2) AS total,
    v.estado,
    v.estado_factura,
    v.uuid_sat
FROM ventas v
LEFT JOIN clientes c ON c.id = v.cliente_id;
