-- Quita índices de la nube que ninguna consulta usa, para ahorrar espacio en el
-- plan gratis de Supabase (tope de 500 MB de base de datos).
--
-- Criterio: lo que el CÓDIGO consulta, no las estadísticas de uso (con pocos
-- tickets, esas estadísticas no distinguen un índice inútil de uno útil aún
-- sin estrenar). Lo que consulta la nube:
--
--   * Edge Function `timbrar`: ventas por id (PK), venta_detalles por venta_id
--     (unique venta_id+renglon), venta_pagos por venta_id (ix_venta_pagos_venta),
--     facturas_globales por id (PK), clientes por join (PK).
--   * Worker de sincronización, pull: SÓLO catálogos (productos,
--     producto_codigos, producto_precios, clientes), por (actualizado_en, llave).
--   * Vistas de reporte: ix_ventas_creado_en para los rangos de fecha.
--
-- Se quedan todas las llaves primarias y restricciones UNIQUE (folio único,
-- UUID del SAT único, clave de producto única): protegen la integridad, no son
-- opcionales. Un índice sólo es un atajo: quitarlo no toca ningún dato, y se
-- recrea con CREATE INDEX en segundos.

-- Duplicado exacto de la restricción unique (venta_id, renglon).
DROP INDEX IF EXISTS ix_venta_detalles_venta;

-- Nadie busca por nombre en la nube: eso se hace en la caja, sobre SQLite.
-- Era el más grande (~0.5 MB, tanto como la tabla de productos misma).
DROP INDEX IF EXISTS ix_productos_nombre;

-- El pull sólo trae catálogos. Estas tablas son push-only: nadie las consulta
-- por `actualizado_en`, sólo se escribía en el índice en cada UPDATE.
DROP INDEX IF EXISTS ix_ventas_actualizado;
DROP INDEX IF EXISTS ix_turnos_actualizado;
DROP INDEX IF EXISTS ix_facturas_globales_actualizado;
