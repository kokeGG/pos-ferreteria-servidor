-- Inventario global compartido entre todas las cajas.
--
-- Antes: cada caja subía `productos.stock_mil` como un número absoluto y el
-- último en escribir ganaba; los movimientos VENTA ni siquiera subían, y en
-- la nube nada aplicaba los demás movimientos a la existencia. Una caja con
-- datos viejos (o una PC de desarrollo) pisaba la existencia de las demás.
--
-- Ahora la existencia global SÓLO la mueve `aplicar_movimientos_inventario`,
-- a partir de los movimientos del kardex que mandan las cajas, de uno en uno,
-- con el producto bloqueado y sin aplicar nunca dos veces el mismo
-- movimiento. Ver db/README.md → "Inventario global".
--
-- Compatible con cajas que sigan con la versión anterior: lo que manden de
-- `stock_mil` se ignora (trigger de abajo) y sus movimientos, que antes
-- subían con UPSERT, quedan en su cola sin perderse hasta que se actualicen.

-- ---------------------------------------------------------------------------
-- 1. Corte inicial
-- ---------------------------------------------------------------------------
-- Una sola fila. Mientras no exista, la RPC no aplica nada (responde un error
-- temporal y los movimientos esperan en la cola de cada caja). El corte toma
-- la existencia de UNA caja como punto de partida: no se suman las copias de
-- varias cajas, que pueden ser las mismas piezas físicas contadas dos veces.

CREATE TABLE inventario_global (
    id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    -- Reloj de la caja que hizo el corte: con ese mismo reloj se fechan sus
    -- movimientos, así que se comparan sin desfase.
    corte_en            TIMESTAMPTZ NOT NULL,
    caja_id             TEXT NOT NULL,
    productos           INTEGER NOT NULL,
    registrado_en       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE inventario_global ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_inventario_global_leer ON inventario_global
    FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- 2. Existencia protegida y versionada
-- ---------------------------------------------------------------------------

CREATE SEQUENCE inventario_version_seq;

-- Sube en cada cambio de existencia. Las cajas sólo aceptan una existencia
-- con versión mayor a la que ya tienen: un evento atrasado o una respuesta
-- vieja nunca regresan un valor anterior.
ALTER TABLE productos ADD COLUMN stock_version BIGINT NOT NULL DEFAULT 0;
CREATE INDEX ix_productos_stock_version ON productos (stock_version);

-- `pos.inventario = 'on'` sólo lo pone, dentro de su propia transacción, una
-- de las funciones de abajo. Cualquier otro INSERT/UPDATE (el UPSERT de
-- catálogo de una caja, nueva o vieja) no puede mover la existencia.
CREATE OR REPLACE FUNCTION productos_stock_protegido()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('pos.inventario', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- Un producto nuevo entra en 0: su existencia inicial llega como
        -- movimiento INICIAL por la RPC, igual que en la caja.
        NEW.stock_mil := 0;
        NEW.stock_version := 0;
    ELSE
        NEW.stock_mil := OLD.stock_mil;
        NEW.stock_version := OLD.stock_version;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_productos_stock_protegido BEFORE INSERT OR UPDATE ON productos
    FOR EACH ROW EXECUTE FUNCTION productos_stock_protegido();

-- ---------------------------------------------------------------------------
-- 3. Kardex de la nube: lo que pidió la caja y lo que se aplicó
-- ---------------------------------------------------------------------------

ALTER TABLE movimientos_inventario
    -- CAJA: lo mandó una caja. SERVIDOR: lo generó la nube (llenado al
    -- sincronizar, corte inicial).
    ADD COLUMN origen               TEXT NOT NULL DEFAULT 'CAJA'
                                    CHECK (origen IN ('CAJA','SERVIDOR')),
    ADD COLUMN caja_id              TEXT,
    -- Lo que registró la caja. `cantidad_mil`/`saldo_mil` son lo que de
    -- verdad se aplicó a la existencia global; si difieren, aquí se ve por qué.
    ADD COLUMN cantidad_local_mil   BIGINT,
    ADD COLUMN saldo_local_mil      BIGINT,
    -- Llenado del servidor: el movimiento VENTA que lo hizo necesario.
    ADD COLUMN movimiento_origen_id UUID
                                    REFERENCES movimientos_inventario(id)
                                    DEFERRABLE INITIALLY DEFERRED,
    ADD COLUMN aplicado_en          TIMESTAMPTZ,
    -- NULL en filas anteriores a esta migración (subidas con UPSERT).
    ADD COLUMN resultado            TEXT
                                    CHECK (resultado IN ('APLICADO','ANTERIOR_AL_CORTE'));

-- Un movimiento de caja puede quedar sin efecto (un llenado que ya no hacía
-- falta, uno anterior al corte), y se guarda igual para auditar: entonces
-- `cantidad_mil` es 0 pero `cantidad_local_mil` no.
ALTER TABLE movimientos_inventario DROP CONSTRAINT movimientos_inventario_cantidad_mil_check;
ALTER TABLE movimientos_inventario ADD CONSTRAINT ck_movinv_cantidad
    CHECK (cantidad_mil <> 0 OR COALESCE(cantidad_local_mil, 0) <> 0);

-- A lo más UN llenado del servidor por movimiento: un reintento no puede
-- crear otro aunque la función tuviera un error.
CREATE UNIQUE INDEX ux_movinv_llenado_servidor
    ON movimientos_inventario (movimiento_origen_id)
    WHERE origen = 'SERVIDOR' AND movimiento_origen_id IS NOT NULL;

CREATE INDEX ix_movinv_aplicado ON movimientos_inventario (producto_id, aplicado_en);

-- Las cajas ya no escriben el kardex de la nube directo: sólo por la RPC.
DROP POLICY pol_movimientos_inventario_authenticated ON movimientos_inventario;
CREATE POLICY pol_movimientos_inventario_leer ON movimientos_inventario
    FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- 4. Aplicar movimientos
-- ---------------------------------------------------------------------------
--
-- Recibe un arreglo JSON de movimientos tal como los guardó la caja:
--   { id, producto_id, tipo, cantidad_mil, saldo_mil, costo_unit_cent,
--     referencia_tipo, referencia_id, usuario_id, notas, creado_en }
-- y devuelve, por movimiento:
--   { id, producto_id, estado, aplicado_mil, llenado_mil, stock_mil, stock_version }
-- con estado APLICADO | YA_APLICADO | ANTERIOR_AL_CORTE.
--
-- Todo el arreglo es UNA transacción: o se confirma completo o nada.
--
-- Orden: por producto_id y, dentro del mismo producto, en el orden en que
-- vienen (el de la cola de la caja). Distintos productos no dependen entre
-- sí; bloquearlos siempre en el mismo orden evita que dos cajas que
-- sincronizan a la vez se bloqueen mutuamente. Entre cajas, gana el orden en
-- que cada una obtiene el bloqueo del producto (orden de llegada).
--
-- Reglas (ver db/README.md → "Inventario global"):
--   VENTA                si no alcanza, LLENADO del servidor por el faltante
--                        exacto (el mismo ajuste que hace la caja con
--                        DialogoStock) y luego se descuenta. Nunca negativo.
--   AJUSTE 'LLENADO'     la existencia queda en AL MENOS lo que declaró el
--                        cajero (`saldo_mil` de la caja): sólo se aplica lo
--                        que falte, no el delta calculado sobre una
--                        existencia local que pudo estar vieja.
--   INICIAL, COMPRA, CANCELACION, AJUSTE > 0   se suman.
--   MERMA, AJUSTE < 0    se restan hasta donde haya.

CREATE OR REPLACE FUNCTION aplicar_movimientos_inventario(
    p_movimientos JSONB,
    p_caja_id     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_corte       TIMESTAMPTZ;
    m             JSONB;
    v_id          UUID;
    v_producto    UUID;
    v_tipo        tipo_movimiento;
    v_cantidad    BIGINT;
    v_saldo_local BIGINT;
    v_ref_tipo    TEXT;
    v_ref_id      UUID;
    v_usuario     UUID;
    v_creado      TIMESTAMPTZ;
    v_costo       BIGINT;
    v_notas       TEXT;
    v_stock       BIGINT;
    v_version     BIGINT;
    v_aplicado    BIGINT;
    v_llenado     BIGINT;
    v_estado      TEXT;
    v_previo      movimientos_inventario%ROWTYPE;
    v_salida      JSONB := '[]'::jsonb;
BEGIN
    SELECT corte_en INTO v_corte FROM inventario_global;
    IF v_corte IS NULL THEN
        RAISE EXCEPTION 'inventario global sin inicializar: falta hacer el corte inicial desde la caja principal (Ctrl+F9)'
            USING ERRCODE = 'P0001';
    END IF;

    PERFORM set_config('pos.inventario', 'on', true);

    FOR m IN
        SELECT e.value
          FROM jsonb_array_elements(p_movimientos) WITH ORDINALITY AS e(value, n)
         ORDER BY e.value->>'producto_id', e.n
    LOOP
        v_id          := (m->>'id')::uuid;
        v_producto    := (m->>'producto_id')::uuid;
        v_tipo        := (m->>'tipo')::tipo_movimiento;
        v_cantidad    := (m->>'cantidad_mil')::bigint;
        v_saldo_local := (m->>'saldo_mil')::bigint;
        v_ref_tipo    := m->>'referencia_tipo';
        v_ref_id      := NULLIF(m->>'referencia_id', '')::uuid;
        v_usuario     := NULLIF(m->>'usuario_id', '')::uuid;
        v_creado      := COALESCE((m->>'creado_en')::timestamptz, now());
        v_costo       := COALESCE((m->>'costo_unit_cent')::bigint, 0);
        v_notas       := m->>'notas';
        v_llenado     := 0;

        -- El bloqueo va ANTES de revisar si ya se aplicó: dos reintentos del
        -- mismo movimiento que llegan a la vez se forman uno detrás del otro.
        SELECT stock_mil INTO v_stock FROM productos WHERE id = v_producto FOR UPDATE;
        IF NOT FOUND THEN
            -- Igual que una llave foránea: suele llegar sola cuando sube el producto.
            RAISE EXCEPTION 'el producto % todavía no está en la nube', v_producto
                USING ERRCODE = '23503';
        END IF;

        SELECT * INTO v_previo FROM movimientos_inventario WHERE id = v_id;
        IF FOUND THEN
            -- Ya procesado (la respuesta anterior se perdió, o la caja lo
            -- reintenta): se devuelve lo que se aplicó entonces, sin tocar nada.
            SELECT stock_version INTO v_version FROM productos WHERE id = v_producto;
            v_salida := v_salida || jsonb_build_object(
                'id', v_id,
                'producto_id', v_producto,
                'estado', 'YA_APLICADO',
                'aplicado_mil', v_previo.cantidad_mil,
                'llenado_mil', COALESCE((
                    SELECT cantidad_mil FROM movimientos_inventario
                     WHERE movimiento_origen_id = v_id AND origen = 'SERVIDOR'), 0),
                'stock_mil', v_stock,
                'stock_version', v_version);
            CONTINUE;
        END IF;

        IF v_creado <= v_corte THEN
            -- Ya está contado en la existencia del corte: se guarda para
            -- auditar, sin efecto.
            v_aplicado := 0;
            v_estado := 'ANTERIOR_AL_CORTE';
        ELSE
            v_estado := 'APLICADO';
            IF v_tipo = 'VENTA' THEN
                IF v_stock < -v_cantidad THEN
                    v_llenado := -v_cantidad - v_stock;
                    v_stock := v_stock + v_llenado;
                    INSERT INTO movimientos_inventario
                        (id, producto_id, tipo, cantidad_mil, costo_unit_cent, saldo_mil,
                         referencia_tipo, referencia_id, usuario_id, notas, creado_en,
                         origen, caja_id, movimiento_origen_id, aplicado_en, resultado)
                    VALUES
                        (gen_random_uuid(), v_producto, 'AJUSTE', v_llenado, v_costo, v_stock,
                         'LLENADO', v_ref_id, v_usuario,
                         'Llenado al sincronizar: la existencia global no alcanzaba para esta venta',
                         v_creado, 'SERVIDOR', p_caja_id, v_id, clock_timestamp(), 'APLICADO');
                END IF;
                v_aplicado := v_cantidad;
            ELSIF v_tipo = 'AJUSTE' AND v_ref_tipo = 'LLENADO' THEN
                v_aplicado := GREATEST(0, v_saldo_local - v_stock);
            ELSIF v_cantidad < 0 THEN
                v_aplicado := -LEAST(-v_cantidad, v_stock);
            ELSE
                v_aplicado := v_cantidad;
            END IF;
            v_stock := v_stock + v_aplicado;
        END IF;

        INSERT INTO movimientos_inventario
            (id, producto_id, tipo, cantidad_mil, costo_unit_cent, saldo_mil,
             referencia_tipo, referencia_id, usuario_id, notas, creado_en,
             origen, caja_id, cantidad_local_mil, saldo_local_mil, aplicado_en, resultado)
        VALUES
            (v_id, v_producto, v_tipo, v_aplicado, v_costo, v_stock,
             v_ref_tipo, v_ref_id, v_usuario, v_notas, v_creado,
             'CAJA', p_caja_id, v_cantidad, v_saldo_local, clock_timestamp(), v_estado);

        IF v_aplicado <> 0 OR v_llenado <> 0 THEN
            v_version := nextval('inventario_version_seq');
            UPDATE productos SET stock_mil = v_stock, stock_version = v_version
             WHERE id = v_producto;
        ELSE
            SELECT stock_version INTO v_version FROM productos WHERE id = v_producto;
        END IF;

        v_salida := v_salida || jsonb_build_object(
            'id', v_id,
            'producto_id', v_producto,
            'estado', v_estado,
            'aplicado_mil', v_aplicado,
            'llenado_mil', v_llenado,
            'stock_mil', v_stock,
            'stock_version', v_version);
    END LOOP;

    RETURN v_salida;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Corte inicial
-- ---------------------------------------------------------------------------
--
-- `p_existencias`: [{ producto_id, stock_mil }] tal como los tiene la caja
-- principal en el momento `p_corte_en` (su reloj). Se puede hacer UNA vez.
-- Cada diferencia contra lo que tenía la nube queda en el kardex como
-- AJUSTE 'CORTE'. Productos de la nube que la caja no mandó no se tocan.

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

    UPDATE inventario_global SET productos = v_n;
    RETURN jsonb_build_object('productos', v_n, 'corte_en', p_corte_en);
END;
$$;

REVOKE ALL ON FUNCTION aplicar_movimientos_inventario(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION inicializar_inventario_global(TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aplicar_movimientos_inventario(JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION inicializar_inventario_global(TEXT, TIMESTAMPTZ, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Auditoría y avisos
-- ---------------------------------------------------------------------------

-- Productos cuya existencia no coincide con el saldo de su último movimiento
-- aplicado. Debe estar vacía; si no, algo movió la existencia por fuera de la
-- RPC.
CREATE VIEW v_inventario_descuadres AS
SELECT p.id, p.clave_interna, p.stock_mil, u.saldo_mil AS saldo_kardex
  FROM productos p
  JOIN LATERAL (
        SELECT saldo_mil FROM movimientos_inventario m
         WHERE m.producto_id = p.id AND m.aplicado_en IS NOT NULL
         ORDER BY m.aplicado_en DESC
         LIMIT 1) u ON TRUE
 WHERE p.stock_mil <> u.saldo_mil;

-- Realtime avisa a las cajas conectadas que algo cambió en `productos`; la
-- caja vuelve a leer la existencia por `stock_version`, no se fía del evento.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE productos;
    END IF;
END $$;
