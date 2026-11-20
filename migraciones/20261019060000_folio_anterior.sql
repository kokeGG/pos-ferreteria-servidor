-- Ver db/sqlite/009_folio_anterior.sql: folio con el que se imprimió una
-- venta antes de reasignarle uno nuevo por choque de folios entre cajas.
--
-- Debe aplicarse (supabase db push) ANTES de instalar la versión de la app
-- que trae esta columna: el worker sube todas las columnas locales, y sin
-- ésta en la nube el UPSERT de ventas fallaría.

ALTER TABLE ventas ADD COLUMN folio_anterior TEXT;
