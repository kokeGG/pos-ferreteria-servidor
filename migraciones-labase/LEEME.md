# Migraciones del catálogo de PRODUCTOS de Ferretería La Base

Estas dos migraciones (la siembra de los 6,619 productos de La Base y su
actualización posterior) **no se aplican** en la versión DH, que usa su propio
catálogo de productos: `migraciones/20261121000001_catalogo_dh.sql`, generado
desde un Excel con `tools/importar_catalogo_excel.py` del repo del POS.

Los CLIENTES sí se conservan (siguen en `migraciones/`): la versión DH usa los
mismos clientes y todo lo demás; solo cambia el catálogo de productos.

Se dejaron aquí, sin editar, para poder compararlas con la rama de La Base. El
aplicador (`src/migrar.ts`) solo lee `migraciones/`. Ojo: la base `pos_demo`
(La Base) ya las tiene aplicadas; esta rama se usa con `pos_dhdemo`.
