-- Espejo de db/sqlite/018_auditoria_productos.sql (ver README.md → "Seguridad en Productos").

ALTER TABLE productos ADD COLUMN usuario_registro_id UUID REFERENCES usuarios(id);
ALTER TABLE productos ADD COLUMN usuario_modifico_id UUID REFERENCES usuarios(id);
