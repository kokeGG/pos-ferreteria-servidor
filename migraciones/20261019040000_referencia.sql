-- Ver db/sqlite/008_referencia.sql: referencia libre de la cotización.
-- `ventas` ya tiene su equivalente en `venta_pagos.referencia`.

ALTER TABLE cotizaciones ADD COLUMN referencia TEXT;
