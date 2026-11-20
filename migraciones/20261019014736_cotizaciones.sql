-- Cotizaciones: ver db/sqlite/006_cotizaciones.sql para la explicación
-- completa del diseño (folio propio, cliente en texto libre, sin kardex ni
-- pago). Mismo esquema, tipos de Postgres.

CREATE TABLE cotizaciones (
    id               UUID PRIMARY KEY,
    caja_id          TEXT NOT NULL,
    folio_local      INTEGER NOT NULL,

    usuario_id       UUID REFERENCES usuarios(id),

    cliente_nombre   TEXT,
    cliente_telefono TEXT,

    subtotal_cent    BIGINT NOT NULL CHECK (subtotal_cent >= 0),
    descuento_cent   BIGINT NOT NULL DEFAULT 0 CHECK (descuento_cent >= 0),
    impuestos_cent   BIGINT NOT NULL DEFAULT 0 CHECK (impuestos_cent >= 0),
    total_cent       BIGINT NOT NULL CHECK (total_cent >= 0),

    creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_cotizaciones_folio UNIQUE (caja_id, folio_local)
);

CREATE INDEX ix_cotizaciones_creado_en ON cotizaciones (creado_en);

CREATE TRIGGER tg_cotizaciones_touch BEFORE UPDATE ON cotizaciones
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

CREATE TABLE cotizacion_detalles (
    id               UUID PRIMARY KEY,
    cotizacion_id    UUID NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
    producto_id      UUID NOT NULL REFERENCES productos(id),
    renglon          INTEGER NOT NULL,

    clave_interna    TEXT NOT NULL,
    descripcion      TEXT NOT NULL,
    unidad_medida    TEXT NOT NULL,

    cantidad_mil     BIGINT NOT NULL CHECK (cantidad_mil > 0),
    precio_unit_cent BIGINT NOT NULL CHECK (precio_unit_cent >= 0),
    descuento_cent   BIGINT NOT NULL DEFAULT 0 CHECK (descuento_cent >= 0),
    importe_cent     BIGINT NOT NULL CHECK (importe_cent >= 0),
    iva_cent         BIGINT NOT NULL DEFAULT 0 CHECK (iva_cent >= 0),
    total_cent       BIGINT NOT NULL CHECK (total_cent >= 0),
    recibido_en      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (cotizacion_id, renglon)
);

CREATE INDEX ix_cotizacion_detalles_cotizacion ON cotizacion_detalles (cotizacion_id);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['cotizaciones','cotizacion_detalles']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            'pol_' || t || '_authenticated', t);
    END LOOP;
END $$;
