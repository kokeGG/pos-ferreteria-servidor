-- El worker (src/lib/sync.ts) recupera el historial de ventas usando
-- `recibido_en` como cursor: "cuándo llegó esta fila a la nube". Hasta ahora
-- sólo se ponía al crear la fila (DEFAULT now()) y nunca se tocaba después.
--
-- Eso dejaba un bug real: si una caja ya se había traído una venta (p.ej. al
-- recuperar su historial) y DESPUÉS esa venta se timbraba o se cancelaba en
-- otra caja, la primera se quedaba para siempre con la versión vieja —
-- "Factura por timbrar" aunque ya estuviera timbrada, con el riesgo de que
-- alguien la timbrara otra vez y generara un CFDI duplicado.
--
-- `ventas` y `facturas_globales` son las únicas tablas de historial que
-- cambian después de creadas (timbrado, cancelación). Con este trigger,
-- cualquier UPDATE las vuelve a poner "al frente" del cursor, y
-- `jalarHistorial()` (ya actualizado para actualizar, no sólo insertar, en
-- esas dos tablas) las vuelve a traer con su estado real.
CREATE OR REPLACE FUNCTION touch_recibido_en()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.recibido_en := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_ventas_recibido_touch BEFORE UPDATE ON ventas
    FOR EACH ROW EXECUTE FUNCTION touch_recibido_en();

CREATE TRIGGER tg_facturas_globales_recibido_touch BEFORE UPDATE ON facturas_globales
    FOR EACH ROW EXECUTE FUNCTION touch_recibido_en();
