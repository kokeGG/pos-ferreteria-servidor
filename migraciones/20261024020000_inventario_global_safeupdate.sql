-- Corrige `inicializar_inventario_global` para Supabase.
--
-- Supabase carga `pg_safeupdate` en las conexiones de la API: rechaza todo
-- UPDATE/DELETE sin WHERE ("UPDATE requires a WHERE clause"), también dentro
-- de una función SECURITY DEFINER. La versión de 20261024010000 terminaba con
-- `UPDATE inventario_global SET productos = v_n` (tabla de una sola fila, sin
-- WHERE) y el corte inicial fallaba completo — sin dejar nada a medias: la
-- transacción entera se deshacía.
--
-- Única diferencia contra la versión anterior: el `WHERE id` del final. La
-- prueba "ninguna función de inventario hace UPDATE/DELETE sin WHERE"
-- (src/lib/inventario-global.test.ts) evita que vuelva a pasar.

CREATE OR REPLACE FUNCTION inicializar_inventario_global(
    p_caja_id     TEXT,
    p_corte_en    TIMESTAMPTZ,
    p_existencias JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    e         JSONB;
    v_prod    UUID;
    v_nuevo   BIGINT;
    v_actual  BIGINT;
    v_n       INTEGER := 0;
    v_previo  inventario_global%ROWTYPE;
BEGIN
    INSERT INTO inventario_global (corte_en, caja_id, productos)
    VALUES (p_corte_en, p_caja_id, 0)
    ON CONFLICT (id) DO NOTHING;
    IF NOT FOUND THEN
        SELECT * INTO v_previo FROM inventario_global;
        RAISE EXCEPTION 'el inventario global ya se inicializó el % desde la caja %',
            v_previo.corte_en, v_previo.caja_id
            USING ERRCODE = '23505';
    END IF;

    PERFORM set_config('pos.inventario', 'on', true);

    FOR e IN
        SELECT value FROM jsonb_array_elements(p_existencias) ORDER BY value->>'producto_id'
    LOOP
        v_prod  := (e->>'producto_id')::uuid;
        v_nuevo := (e->>'stock_mil')::bigint;
        IF v_nuevo < 0 THEN
            RAISE EXCEPTION 'existencia negativa para %', v_prod USING ERRCODE = '23514';
        END IF;

        SELECT stock_mil INTO v_actual FROM productos WHERE id = v_prod FOR UPDATE;
        CONTINUE WHEN NOT FOUND;   -- producto que la nube todavía no tiene

        UPDATE productos
           SET stock_mil = v_nuevo, stock_version = nextval('inventario_version_seq')
         WHERE id = v_prod;

        IF v_nuevo <> v_actual THEN
            INSERT INTO movimientos_inventario
                (id, producto_id, tipo, cantidad_mil, saldo_mil, referencia_tipo, notas,
                 creado_en, origen, caja_id, aplicado_en, resultado)
            VALUES
                (gen_random_uuid(), v_prod, 'AJUSTE', v_nuevo - v_actual, v_nuevo, 'CORTE',
                 'Corte inicial del inventario global', p_corte_en, 'SERVIDOR', p_caja_id,
                 clock_timestamp(), 'APLICADO');
        END IF;
        v_n := v_n + 1;
    END LOOP;

    UPDATE inventario_global SET productos = v_n WHERE id;
    RETURN jsonb_build_object('productos', v_n, 'corte_en', p_corte_en);
END;
$$;
