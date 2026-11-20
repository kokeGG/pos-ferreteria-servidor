-- Credenciales de las cajas (reemplaza a Supabase Auth).
--
-- La caja se autentica como UNA terminal, no como el cajero en turno: quién
-- vendió vive en `ventas.usuario_id`. Aquí solo se guarda la identidad de la
-- máquina, con su contraseña como hash scrypt (nunca en claro).

CREATE TABLE terminales (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    activa        BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El correo no distingue mayúsculas: "Caja-A@x" y "caja-a@x" son la misma.
CREATE UNIQUE INDEX terminales_email_uq ON terminales (lower(email));

-- Un refresh token por sesión abierta. Solo se guarda su SHA-256: si se
-- filtra la base no se pueden reconstruir los tokens. Cada uso lo rota.
CREATE TABLE sesiones (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    terminal_id UUID NOT NULL REFERENCES terminales (id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    expira_en   TIMESTAMPTZ NOT NULL,
    revocada_en TIMESTAMPTZ,
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sesiones_terminal_idx ON sesiones (terminal_id);
