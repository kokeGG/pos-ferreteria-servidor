-- GENERADO por tools/generar-migracion.sh — no editar a mano.
-- Fuente: db/postgres/001_schema.sql

-- ============================================================================
-- POS Ferretería — Esquema nube (PostgreSQL / Supabase)  v2
-- ============================================================================
-- DECISIÓN CLAVE: el dinero se guarda en BIGINT CENTAVOS también aquí, no en
-- NUMERIC(12,2). Motivo: el worker de sincronización empuja la fila local tal
-- cual, sin convertir ni un solo campo. Cada conversión en el camino es un
-- lugar donde se pierde un centavo. Para leer en pesos están las vistas del
-- final, que es donde un humano consulta.
--
-- Diferencias intencionales contra SQLite (las únicas):
--   TEXT uuid       -> UUID
--   TEXT ISO-8601   -> TIMESTAMPTZ
--   INTEGER 0/1     -> BOOLEAN
-- El worker mapea esos tres tipos y nada más.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE rol_usuario      AS ENUM ('CAJERO','ADMIN');
CREATE TYPE objeto_impuesto  AS ENUM ('01','02','03');
CREATE TYPE tipo_factor_imp  AS ENUM ('Tasa','Cuota','Exento');
CREATE TYPE estado_venta     AS ENUM ('COMPLETADA','CANCELADA');
CREATE TYPE metodo_pago_sat  AS ENUM ('PUE','PPD');
CREATE TYPE estado_factura_t AS ENUM ('NO_REQUERIDA','PENDIENTE','TIMBRADA',
                                      'ERROR','CANCELADA','EN_GLOBAL');
CREATE TYPE estado_global_t  AS ENUM ('BORRADOR','PENDIENTE','TIMBRADA',
                                      'ERROR','CANCELADA');
CREATE TYPE estado_turno     AS ENUM ('ABIERTO','CERRADO');
CREATE TYPE tipo_movimiento  AS ENUM ('INICIAL','VENTA','COMPRA','AJUSTE',
                                      'MERMA','CANCELACION');

-- ---------------------------------------------------------------------------
-- Función compartida para actualizado_en
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_actualizado_en()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Si el cliente mandó explícitamente un actualizado_en (viene del push
    -- local y queremos conservar la hora real del hecho), se respeta.
    IF NEW.actualizado_en IS NOT DISTINCT FROM OLD.actualizado_en THEN
        NEW.actualizado_en := now();
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------------

CREATE TABLE usuarios (
    id             UUID PRIMARY KEY,
    nombre         TEXT NOT NULL,
    pin_hash       TEXT NOT NULL,
    rol            rol_usuario NOT NULL DEFAULT 'CAJERO',
    activo         BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER tg_usuarios_touch BEFORE UPDATE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

-- ---------------------------------------------------------------------------
-- Productos
-- ---------------------------------------------------------------------------

CREATE TABLE productos (
    id                 UUID PRIMARY KEY,
    clave_interna      TEXT NOT NULL UNIQUE,
    nombre             TEXT NOT NULL,

    precio_venta_cent  BIGINT NOT NULL CHECK (precio_venta_cent >= 0),
    costo_cent         BIGINT NOT NULL DEFAULT 0 CHECK (costo_cent >= 0),
    stock_mil          BIGINT NOT NULL DEFAULT 0 CHECK (stock_mil >= 0),
    stock_minimo_mil   BIGINT NOT NULL DEFAULT 0,
    unidad_medida      TEXT NOT NULL DEFAULT 'PIEZA',

    -- Campos fiscales CFDI 4.0
    clave_prod_serv    TEXT NOT NULL,
    clave_unidad       TEXT NOT NULL,
    objeto_imp         objeto_impuesto NOT NULL DEFAULT '02',
    tipo_factor        tipo_factor_imp NOT NULL DEFAULT 'Tasa',
    tasa_iva_ppm       INTEGER NOT NULL DEFAULT 160000 CHECK (tasa_iva_ppm >= 0),

    precio_incluye_iva BOOLEAN NOT NULL DEFAULT TRUE,
    permite_decimales  BOOLEAN NOT NULL DEFAULT FALSE,

    activo             BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_productos_exento
        CHECK (tipo_factor <> 'Exento' OR tasa_iva_ppm = 0)
);

CREATE INDEX ix_productos_nombre      ON productos (nombre);
CREATE INDEX ix_productos_actualizado ON productos (actualizado_en);

CREATE TRIGGER tg_productos_touch BEFORE UPDATE ON productos
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

CREATE TABLE producto_codigos (
    codigo         TEXT PRIMARY KEY,
    producto_id    UUID NOT NULL REFERENCES productos(id),
    activo         BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_producto_codigos_producto    ON producto_codigos (producto_id);
CREATE INDEX ix_producto_codigos_actualizado ON producto_codigos (actualizado_en);

CREATE TRIGGER tg_producto_codigos_touch BEFORE UPDATE ON producto_codigos
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

CREATE TABLE producto_precios (
    id               UUID PRIMARY KEY,
    producto_id      UUID NOT NULL REFERENCES productos(id),
    cantidad_min_mil BIGINT NOT NULL CHECK (cantidad_min_mil > 0),
    precio_cent      BIGINT NOT NULL CHECK (precio_cent >= 0),
    activo           BOOLEAN NOT NULL DEFAULT TRUE,
    actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (producto_id, cantidad_min_mil)
);

CREATE INDEX ix_producto_precios_actualizado ON producto_precios (actualizado_en);

CREATE TRIGGER tg_producto_precios_touch BEFORE UPDATE ON producto_precios
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

-- ---------------------------------------------------------------------------
-- Clientes
-- ---------------------------------------------------------------------------

CREATE TABLE clientes (
    id             UUID PRIMARY KEY,
    rfc            TEXT NOT NULL DEFAULT 'XAXX010101000',
    razon_social   TEXT NOT NULL,
    codigo_postal  TEXT NOT NULL,
    regimen_fiscal TEXT NOT NULL,
    uso_cfdi       TEXT NOT NULL DEFAULT 'G03',
    email          TEXT,
    telefono       TEXT,
    activo         BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_clientes_rfc         ON clientes (rfc);
CREATE INDEX ix_clientes_actualizado ON clientes (actualizado_en);

CREATE TRIGGER tg_clientes_touch BEFORE UPDATE ON clientes
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

-- ---------------------------------------------------------------------------
-- Turnos
-- ---------------------------------------------------------------------------

CREATE TABLE turnos (
    id                     UUID PRIMARY KEY,
    usuario_id             UUID NOT NULL REFERENCES usuarios(id),
    abierto_en             TIMESTAMPTZ NOT NULL DEFAULT now(),
    cerrado_en             TIMESTAMPTZ,
    fondo_inicial_cent     BIGINT NOT NULL DEFAULT 0,
    efectivo_contado_cent  BIGINT,
    efectivo_esperado_cent BIGINT,
    diferencia_cent        BIGINT,
    estado                 estado_turno NOT NULL DEFAULT 'ABIERTO',
    notas                  TEXT,
    actualizado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_turnos_actualizado ON turnos (actualizado_en);

CREATE TRIGGER tg_turnos_touch BEFORE UPDATE ON turnos
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

-- ---------------------------------------------------------------------------
-- Factura global
-- ---------------------------------------------------------------------------

CREATE TABLE facturas_globales (
    id             UUID PRIMARY KEY,
    periodicidad   TEXT NOT NULL CHECK (periodicidad IN ('01','02','03','04','05')),
    meses          TEXT NOT NULL,
    anio           INTEGER NOT NULL,
    periodo_inicio TIMESTAMPTZ NOT NULL,
    periodo_fin    TIMESTAMPTZ NOT NULL,
    subtotal_cent  BIGINT NOT NULL DEFAULT 0,
    impuestos_cent BIGINT NOT NULL DEFAULT 0,
    total_cent     BIGINT NOT NULL DEFAULT 0,
    num_ventas     INTEGER NOT NULL DEFAULT 0,
    estado         estado_global_t NOT NULL DEFAULT 'BORRADOR',
    uuid_sat       TEXT UNIQUE,
    timbrada_en    TIMESTAMPTZ,
    url_pdf        TEXT,
    url_xml        TEXT,
    error_timbrado TEXT,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (periodo_fin > periodo_inicio)
);

CREATE INDEX ix_facturas_globales_periodo     ON facturas_globales (anio, meses);
CREATE INDEX ix_facturas_globales_actualizado ON facturas_globales (actualizado_en);

CREATE TRIGGER tg_facturas_globales_touch BEFORE UPDATE ON facturas_globales
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

-- ---------------------------------------------------------------------------
-- Ventas
-- ---------------------------------------------------------------------------

CREATE TABLE ventas (
    id                 UUID PRIMARY KEY,
    caja_id            TEXT NOT NULL,
    folio_local        INTEGER NOT NULL,

    turno_id           UUID REFERENCES turnos(id),
    usuario_id         UUID REFERENCES usuarios(id),
    cliente_id         UUID REFERENCES clientes(id),

    subtotal_cent      BIGINT NOT NULL CHECK (subtotal_cent >= 0),
    descuento_cent     BIGINT NOT NULL DEFAULT 0 CHECK (descuento_cent >= 0),
    impuestos_cent     BIGINT NOT NULL DEFAULT 0 CHECK (impuestos_cent >= 0),
    total_cent         BIGINT NOT NULL CHECK (total_cent >= 0),
    recibido_cent      BIGINT NOT NULL DEFAULT 0,
    cambio_cent        BIGINT NOT NULL DEFAULT 0,

    estado             estado_venta NOT NULL DEFAULT 'COMPLETADA',
    cancelada_en       TIMESTAMPTZ,
    motivo_cancelacion TEXT,

    metodo_pago        metodo_pago_sat NOT NULL DEFAULT 'PUE',
    uso_cfdi           TEXT NOT NULL DEFAULT 'S01',
    requiere_factura   BOOLEAN NOT NULL DEFAULT FALSE,
    estado_factura     estado_factura_t NOT NULL DEFAULT 'NO_REQUERIDA',
    factura_global_id  UUID REFERENCES facturas_globales(id),
    uuid_sat           TEXT UNIQUE,
    serie_folio_sat    TEXT,
    timbrada_en        TIMESTAMPTZ,
    url_pdf            TEXT,
    url_xml            TEXT,
    error_timbrado     TEXT,

    creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_ventas_folio UNIQUE (caja_id, folio_local),
    CONSTRAINT ck_ventas_factura_receptor
        CHECK (requiere_factura = FALSE OR cliente_id IS NOT NULL)
);

CREATE INDEX ix_ventas_creado_en   ON ventas (creado_en);
CREATE INDEX ix_ventas_turno       ON ventas (turno_id);
CREATE INDEX ix_ventas_cliente     ON ventas (cliente_id);
CREATE INDEX ix_ventas_actualizado ON ventas (actualizado_en);
CREATE INDEX ix_ventas_por_timbrar ON ventas (creado_en)
    WHERE estado_factura IN ('PENDIENTE','ERROR');

CREATE TRIGGER tg_ventas_touch BEFORE UPDATE ON ventas
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

CREATE TABLE venta_detalles (
    id               UUID PRIMARY KEY,
    venta_id         UUID NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id      UUID NOT NULL REFERENCES productos(id),
    renglon          INTEGER NOT NULL,

    -- snapshot al momento de la venta
    clave_interna    TEXT NOT NULL,
    descripcion      TEXT NOT NULL,
    clave_prod_serv  TEXT NOT NULL,
    clave_unidad     TEXT NOT NULL,
    unidad_medida    TEXT NOT NULL,
    objeto_imp       objeto_impuesto NOT NULL,
    tipo_factor      tipo_factor_imp NOT NULL,
    tasa_iva_ppm     INTEGER NOT NULL,

    cantidad_mil     BIGINT NOT NULL CHECK (cantidad_mil > 0),
    precio_unit_cent BIGINT NOT NULL CHECK (precio_unit_cent >= 0),
    descuento_cent   BIGINT NOT NULL DEFAULT 0 CHECK (descuento_cent >= 0),
    importe_cent     BIGINT NOT NULL CHECK (importe_cent >= 0),
    iva_cent         BIGINT NOT NULL DEFAULT 0 CHECK (iva_cent >= 0),
    total_cent       BIGINT NOT NULL CHECK (total_cent >= 0),
    costo_cent       BIGINT NOT NULL DEFAULT 0,
    recibido_en      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (venta_id, renglon)
);

CREATE INDEX ix_venta_detalles_venta    ON venta_detalles (venta_id);
CREATE INDEX ix_venta_detalles_producto ON venta_detalles (producto_id);

CREATE TABLE venta_pagos (
    id          UUID PRIMARY KEY,
    venta_id    UUID NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    forma_pago  TEXT NOT NULL,
    monto_cent  BIGINT NOT NULL CHECK (monto_cent > 0),
    referencia  TEXT,
    recibido_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_venta_pagos_venta ON venta_pagos (venta_id);

-- ---------------------------------------------------------------------------
-- Inventario
-- ---------------------------------------------------------------------------

CREATE TABLE movimientos_inventario (
    id              UUID PRIMARY KEY,
    producto_id     UUID NOT NULL REFERENCES productos(id),
    tipo            tipo_movimiento NOT NULL,
    cantidad_mil    BIGINT NOT NULL CHECK (cantidad_mil <> 0),
    costo_unit_cent BIGINT NOT NULL DEFAULT 0,
    saldo_mil       BIGINT NOT NULL CHECK (saldo_mil >= 0),
    referencia_tipo TEXT,
    referencia_id   UUID,
    usuario_id      UUID REFERENCES usuarios(id),
    notas           TEXT,
    creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_movinv_producto   ON movimientos_inventario (producto_id, creado_en);
CREATE INDEX ix_movinv_referencia ON movimientos_inventario (referencia_tipo, referencia_id);

-- El kardex también es inmutable en la nube. Pero el worker reintenta pushes,
-- así que un UPSERT que reenvía una fila IDÉNTICA debe ser un no-op silencioso
-- (idempotencia), no un error que atore la cola. Sólo se rechaza un cambio real.
CREATE OR REPLACE FUNCTION movinv_inmutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'movimientos_inventario es append-only (id=%): use un AJUSTE', OLD.id;
    END IF;
    RETURN NULL;   -- fila idéntica: se omite el UPDATE sin error
END;
$$;

CREATE TRIGGER tg_movinv_no_update BEFORE UPDATE ON movimientos_inventario
    FOR EACH ROW EXECUTE FUNCTION movinv_inmutable();

CREATE OR REPLACE FUNCTION movinv_no_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'movimientos_inventario es append-only: no se borra';
END;
$$;

CREATE TRIGGER tg_movinv_no_delete BEFORE DELETE ON movimientos_inventario
    FOR EACH ROW EXECUTE FUNCTION movinv_no_delete();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- Un solo local, una caja: la terminal se autentica como un único usuario de
-- Supabase y necesita acceso total. Las Edge Functions usan service_role, que
-- pasa por encima de RLS.
--
-- RLS queda ACTIVADO igualmente: sin políticas, la anon key no lee nada. Si
-- mañana hay varias sucursales, aquí se agrega el filtro por sucursal_id en
-- vez de tener que activar RLS sobre datos ya expuestos.

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['usuarios','productos','producto_codigos',
        'producto_precios','clientes','turnos','ventas','venta_detalles',
        'venta_pagos','movimientos_inventario','facturas_globales']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            'pol_' || t || '_authenticated', t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Vistas de reporte (en pesos, para consultar desde el panel de Supabase)
-- ---------------------------------------------------------------------------

CREATE VIEW v_ventas AS
SELECT
    v.id,
    v.caja_id || '-' || lpad(v.folio_local::text, 6, '0') AS folio,
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

CREATE VIEW v_ventas_por_dia AS
SELECT
    date_trunc('day', v.creado_en AT TIME ZONE 'America/Mexico_City') AS dia,
    count(*)                                   AS num_tickets,
    (sum(v.total_cent) / 100.0)::numeric(14,2) AS total_vendido,
    (sum(v.impuestos_cent) / 100.0)::numeric(14,2) AS iva_trasladado
FROM ventas v
WHERE v.estado = 'COMPLETADA'
GROUP BY 1
ORDER BY 1 DESC;

CREATE VIEW v_margen_productos AS
SELECT
    d.producto_id,
    d.clave_interna,
    d.descripcion,
    (sum(d.cantidad_mil) / 1000.0)::numeric(14,3) AS unidades_vendidas,
    (sum(d.importe_cent) / 100.0)::numeric(14,2)  AS venta_neta,
    (sum(d.costo_cent * d.cantidad_mil / 1000) / 100.0)::numeric(14,2) AS costo_total,
    ((sum(d.importe_cent) - sum(d.costo_cent * d.cantidad_mil / 1000)) / 100.0)::numeric(14,2) AS margen
FROM venta_detalles d
JOIN ventas v ON v.id = d.venta_id AND v.estado = 'COMPLETADA'
GROUP BY d.producto_id, d.clave_interna, d.descripcion;

-- Ventas a público en general pendientes de entrar a una factura global.
CREATE VIEW v_pendientes_global AS
SELECT v.*
FROM ventas v
WHERE v.estado = 'COMPLETADA'
  AND v.estado_factura = 'NO_REQUERIDA'
  AND v.factura_global_id IS NULL;
