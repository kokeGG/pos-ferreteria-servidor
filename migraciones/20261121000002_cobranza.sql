-- Cobranza: cuentas por cobrar y abonos. Ver db/sqlite/020_cobranza.sql para el
-- diseño completo (el saldo se calcula, no se guarda; las reglas de abono y de
-- cancelación viven en la app). Mismo esquema, tipos de Postgres.
--
-- Sin triggers que impongan esas reglas, a propósito: el pull de las cajas
-- inserta las filas tal como llegan y dos cajas que abonan a la vez a la misma
-- cuenta pueden dejar el saldo en negativo; una regla aquí abortaría el lote.

CREATE TABLE cuentas_por_cobrar (
    id             UUID PRIMARY KEY,
    venta_id       UUID NOT NULL UNIQUE REFERENCES ventas(id),
    cliente_id     UUID NOT NULL REFERENCES clientes(id),
    total_cent     BIGINT NOT NULL CHECK (total_cent > 0),
    estado         TEXT NOT NULL DEFAULT 'ABIERTA'
                   CHECK (estado IN ('ABIERTA','LIQUIDADA','CANCELADA')),
    liquidada_en   TIMESTAMPTZ,
    creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_cuentas_cliente ON cuentas_por_cobrar (cliente_id);
CREATE INDEX ix_cuentas_estado  ON cuentas_por_cobrar (estado, creado_en);

CREATE TRIGGER tg_cuentas_por_cobrar_touch BEFORE UPDATE ON cuentas_por_cobrar
    FOR EACH ROW EXECUTE FUNCTION touch_actualizado_en();

-- Una cuenta cambia después de creada (se liquida, se cancela): cada UPDATE la
-- pone otra vez al frente del cursor `recibido_en`, para que las demás cajas la
-- vuelvan a ver (ver 20261017154050_recibido_en_en_update.sql).
CREATE TRIGGER tg_cuentas_por_cobrar_recibido_touch BEFORE UPDATE ON cuentas_por_cobrar
    FOR EACH ROW EXECUTE FUNCTION touch_recibido_en();

CREATE TABLE abonos (
    id          UUID PRIMARY KEY,
    cuenta_id   UUID NOT NULL REFERENCES cuentas_por_cobrar(id),
    tipo        TEXT NOT NULL DEFAULT 'ABONO' CHECK (tipo IN ('ANTICIPO','ABONO')),
    monto_cent  BIGINT NOT NULL CHECK (monto_cent > 0),
    forma_pago  TEXT NOT NULL,
    referencia  TEXT,
    usuario_id  UUID REFERENCES usuarios(id),
    turno_id    UUID REFERENCES turnos(id),
    caja_id     TEXT NOT NULL,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    recibido_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_abonos_cuenta ON abonos (cuenta_id);
CREATE INDEX ix_abonos_fecha  ON abonos (creado_en);

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['cuentas_por_cobrar','abonos']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
            'pol_' || t || '_authenticated', t);
    END LOOP;
END $$;
