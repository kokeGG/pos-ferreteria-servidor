import { describe, expect, it } from "vitest";
import { construirCuerpoFacturaCom } from "../src/timbrar/facturacom-cuerpo.ts";
import { extraerMensaje, mensajeAmigable } from "../src/timbrar/facturacom-mensajes.ts";
import {
  conceptosPorNota,
  construirCfdi,
  verificarTotales,
  type DetalleVenta,
  type EntradaCfdi,
} from "../src/timbrar/cfdi.ts";
import { calcularRenglon } from "./pos/iva.ts";

/**
 * Prueba la traducción de venta -> JSON de Factura.com.
 *
 * Los nombres de campo y las reglas exactas (Serie numérico, Receptor sólo
 * como UID, InformacionGlobal con "Año" acentuado, PDF/XML como archivo
 * directo) están verificados contra su API real de sandbox el 2026-09-28,
 * con timbres reales tanto individuales como globales — ver la bitácora de
 * esa sesión y los comentarios en facturacom.ts.
 */

const RECEPTOR_UID = "6abaa517ec5d0"; // público en general, del sandbox real
const SERIE_ID = 5506239; // SerieID de tipo "factura", del sandbox real

const renglon = (campos: Partial<DetalleVenta> = {}): DetalleVenta => {
  const cantidad_mil = campos.cantidad_mil ?? 1000;
  const precio_unit_cent = campos.precio_unit_cent ?? 1500;
  const tasa_iva_ppm = campos.tasa_iva_ppm ?? 160_000;
  const descuento_cent = campos.descuento_cent ?? 0;

  const imp = calcularRenglon({
    cantidadMil: cantidad_mil,
    precioUnitCent: precio_unit_cent,
    descuentoCent: descuento_cent,
    tasaIvaPpm: tasa_iva_ppm,
    precioIncluyeIva: true,
  });

  return {
    clave_prod_serv: "27111500",
    clave_unidad: "H87",
    unidad_medida: "PIEZA",
    descripcion: "MARTILLO",
    cantidad_mil,
    precio_unit_cent,
    descuento_cent,
    importe_cent: imp.importeCent,
    iva_cent: imp.ivaCent,
    total_cent: imp.totalCent,
    objeto_imp: "02",
    tipo_factor: "Tasa",
    tasa_iva_ppm,
    ...campos,
  };
};

const entrada = (detalles: DetalleVenta[]): EntradaCfdi => ({
  venta: {
    serie: "A",
    folio: "123",
    fecha: "2026-09-28T12:00:00",
    formaPago: "03",
    metodoPago: "PUE",
    totalCent: detalles.reduce((s, d) => s + d.total_cent, 0),
  },
  emisor: {
    rfc: "HERJ990828ML5",
    nombre: "JORGE ROBERTO HERNANDEZ",
    regimenFiscal: "626",
    codigoPostal: "42501",
  },
  receptor: {
    rfc: "XAXX010101000",
    nombre: "PUBLICO EN GENERAL",
    domicilioFiscal: "42501",
    regimenFiscal: "616",
    usoCfdi: "S01",
  },
  detalles,
});

describe("cuerpo de Factura.com: encabezado", () => {
  it("trae los campos obligatorios verificados contra la API real", () => {
    const c = construirCuerpoFacturaCom(entrada([renglon()]), RECEPTOR_UID, SERIE_ID);

    expect(c.TipoDocumento).toBe("factura");
    expect(c.FormaPago).toBe("03");
    expect(c.MetodoPago).toBe("PUE");
    expect(c.Moneda).toBe("MXN");
    expect(c.UsoCFDI).toBe("S01");
    // El Serie es el SerieID numérico, no una letra — sin él la API real
    // rechaza con "El campo serie es requerido".
    expect(c.Serie).toBe(5506239);
    // El correo lo manda esta app (mailer.ts), no Factura.com.
    expect(c.EnviarCorreo).toBe(false);
  });

  it("el Receptor es sólo el UID resuelto, nunca los datos del cliente", () => {
    const c = construirCuerpoFacturaCom(entrada([renglon()]), RECEPTOR_UID, SERIE_ID);
    expect(c.Receptor).toEqual({ UID: "6abaa517ec5d0" });
  });
});

describe("cuerpo de Factura.com: conceptos", () => {
  it("arma el concepto con los nombres de campo exactos de la API", () => {
    const c = construirCuerpoFacturaCom(
      entrada([renglon({ descripcion: "MARTILLO", cantidad_mil: 2000, precio_unit_cent: 1500 })]),
      RECEPTOR_UID,
      SERIE_ID,
    );
    const item = c.Conceptos[0]!;

    expect(item.ClaveProdServ).toBe("27111500");
    expect(item.ClaveUnidad).toBe("H87");
    expect(item.Unidad).toBe("PIEZA");
    expect(item.Descripcion).toBe("MARTILLO");
    expect(item.Cantidad).toBe(2);
    expect(item.ObjetoImp).toBe("02");
  });

  it("Importe del traslado + Base = lo que el cliente pagó por ese renglón", () => {
    const d = renglon({ precio_unit_cent: 1500, cantidad_mil: 1000 });
    const c = construirCuerpoFacturaCom(entrada([d]), RECEPTOR_UID, SERIE_ID);
    const traslado = c.Conceptos[0]!.Impuestos!.Traslados[0]!;

    expect(traslado.Base + traslado.Importe!).toBeCloseTo(15.0, 2);
    expect(traslado.Impuesto).toBe("002");
    expect(traslado.TipoFactor).toBe("Tasa");
    expect(traslado.TasaOCuota).toBe("0.160000");
  });

  it("omite el nodo Impuestos cuando ObjetoImp es 01 (no objeto de impuesto)", () => {
    const c = construirCuerpoFacturaCom(entrada([renglon({ objeto_imp: "01" })]), RECEPTOR_UID, SERIE_ID);
    expect(c.Conceptos[0]!.Impuestos).toBeUndefined();
  });

  it("un renglón Exento no manda TasaOCuota ni Importe en el traslado", () => {
    const c = construirCuerpoFacturaCom(
      entrada([renglon({ tipo_factor: "Exento", tasa_iva_ppm: 0 })]),
      RECEPTOR_UID,
      SERIE_ID,
    );
    const traslado = c.Conceptos[0]!.Impuestos!.Traslados[0]!;
    expect(traslado.TipoFactor).toBe("Exento");
    expect(traslado.TasaOCuota).toBeUndefined();
    expect(traslado.Importe).toBeUndefined();
  });

  it("varios renglones producen el mismo número de Conceptos, en orden", () => {
    const c = construirCuerpoFacturaCom(
      entrada([renglon({ descripcion: "A" }), renglon({ descripcion: "B" }), renglon({ descripcion: "C" })]),
      RECEPTOR_UID,
      SERIE_ID,
    );
    expect(c.Conceptos).toHaveLength(3);
    expect(c.Conceptos.map((i) => i.Descripcion)).toEqual(["A", "B", "C"]);
  });
});

describe("cuerpo de Factura.com: descuento", () => {
  const conceptoDe = (d: DetalleVenta) => construirCuerpoFacturaCom(entrada([d]), RECEPTOR_UID, SERIE_ID).Conceptos[0]!;
  const cent = (pesos: number) => Math.round(pesos * 100);

  it("un renglón con descuento manda Descuento en base (sin IVA), en pesos", () => {
    // 2 piezas a $50.00 con IVA y $10.00 de descuento: 100.00 - 10.00 = 90.00,
    // que son 77.59 de base + 12.41 de IVA. Verificado contra el sandbox
    // (2026-11-19): con este campo el XML timbrado trae Total 90.00.
    const c = conceptoDe(renglon({ cantidad_mil: 2000, precio_unit_cent: 5000, descuento_cent: 1000 }));
    expect(c.Descuento).toBe(8.62);
    expect(c.Impuestos!.Traslados[0]!.Base).toBe(77.59);
  });

  it("Importe - Descuento = Base del IVA, en varios casos (si no, el PAC timbra un total distinto del cobrado)", () => {
    for (const [precio, cantidadMil, descuento] of [
      [5000, 2000, 1000],
      [4999, 1000, 500],
      [1250, 3000, 137],
      [3333, 2500, 999],
    ] as const) {
      const c = conceptoDe(renglon({ precio_unit_cent: precio, cantidad_mil: cantidadMil, descuento_cent: descuento }));
      const importe = cent(c.ValorUnitario * c.Cantidad);
      expect(importe - cent(c.Descuento!), `precio ${precio} x ${cantidadMil / 1000} con ${descuento} de descuento`).toBe(
        cent(c.Impuestos!.Traslados[0]!.Base),
      );
    }
  });

  it("sin descuento no manda el campo Descuento (ni en 0)", () => {
    expect("Descuento" in conceptoDe(renglon())).toBe(false);
  });

  it("un renglón Exento manda el descuento tal cual: no hay IVA que quitarle", () => {
    const c = conceptoDe(renglon({ tipo_factor: "Exento", tasa_iva_ppm: 0, precio_unit_cent: 1000, descuento_cent: 100 }));
    expect(c.Descuento).toBe(1);
    expect(cent(c.ValorUnitario * c.Cantidad) - cent(c.Descuento!)).toBe(cent(c.Impuestos!.Traslados[0]!.Base));
  });

  it("con varios renglones, solo el que tiene descuento lo manda", () => {
    const { Conceptos } = construirCuerpoFacturaCom(
      entrada([renglon({ descuento_cent: 0 }), renglon({ precio_unit_cent: 5000, descuento_cent: 1000 })]),
      RECEPTOR_UID,
      SERIE_ID,
    );
    expect(Conceptos.map((c) => c.Descuento)).toEqual([undefined, 8.62]);
  });
});

describe("cuerpo de Factura.com: factura global", () => {
  it("sin `global`, no manda InformacionGlobal", () => {
    const c = construirCuerpoFacturaCom(entrada([renglon()]), RECEPTOR_UID, SERIE_ID);
    expect(c.InformacionGlobal).toBeUndefined();
  });

  it("con `global`, arma el nodo con los nombres de campo verificados contra la API real", () => {
    const e = entrada([renglon()]);
    e.global = { periodicidad: "01", meses: "09", anio: 2026 };

    const c = construirCuerpoFacturaCom(e, RECEPTOR_UID, SERIE_ID);

    // Periodicidad/Meses/Año (con eñe): confirmado con un timbre real de
    // sandbox (2026-09-28) — UUID 8d1dbd0a-c819-4a70-9043-40420fd484bf.
    expect(c.InformacionGlobal).toEqual({ Periodicidad: "01", Meses: "09", Año: "2026" });
  });
});

describe("factura global: un renglón por nota con su folio", () => {
  // Como las guarda la caja: precio con IVA incluido, base e IVA ya separados.
  const notas = [
    { caja_id: "C", folio_local: 2, subtotal_cent: 8621, impuestos_cent: 1379, total_cent: 10000 },
    { caja_id: "C", folio_local: 1, subtotal_cent: 4310, impuestos_cent: 690, total_cent: 5000 },
    { caja_id: "C", folio_local: 3, subtotal_cent: 44, impuestos_cent: 7, total_cent: 51 },
  ];

  it("un concepto por nota, en orden de folio, con el folio en NoIdentificacion", () => {
    const d = conceptosPorNota(notas);
    expect(d.map((x) => x.no_identificacion)).toEqual(["C-000001", "C-000002", "C-000003"]);
    expect(d.every((x) => x.clave_prod_serv === "01010101" && x.clave_unidad === "ACT" && x.cantidad_mil === 1000)).toBe(true);
    expect(d.map((x) => x.descripcion)).toEqual(["Venta", "Venta", "Venta"]);
    expect(d.map((x) => [x.importe_cent, x.iva_cent])).toEqual([[4310, 690], [8621, 1379], [44, 7]]);
  });

  it("los conceptos suman exactamente el total de las notas: el comprobante cuadra", () => {
    const e = entrada(conceptosPorNota(notas));
    e.global = { periodicidad: "01", meses: "10", anio: 2026 };
    expect(e.venta.totalCent).toBe(15051);
    expect(verificarTotales(e)).toEqual([]);
  });

  it("el cuerpo de Factura.com y el XML llevan NoIdentificacion; un renglón normal no", () => {
    const c = construirCuerpoFacturaCom(entrada(conceptosPorNota(notas)), RECEPTOR_UID, SERIE_ID);
    expect(c.Conceptos.map((x) => x.NoIdentificacion)).toEqual(["C-000001", "C-000002", "C-000003"]);
    expect(construirCfdi(entrada(conceptosPorNota(notas)))).toContain('NoIdentificacion="C-000001"');

    const normal = construirCuerpoFacturaCom(entrada([renglon()]), RECEPTOR_UID, SERIE_ID);
    expect("NoIdentificacion" in normal.Conceptos[0]!).toBe(false);
  });
});

describe("mensaje de rechazo de Factura.com, legible para el cajero", () => {
  it("extrae el texto de {message: '...'}, no '[object Object]'", () => {
    expect(extraerMensaje({ message: "CFDI40145 - El campo Nombre del receptor..." }))
      .toBe("CFDI40145 - El campo Nombre del receptor...");
  });

  it("también acepta el mensaje como cadena plana", () => {
    expect(extraerMensaje("El campo serie es requerido")).toBe("El campo serie es requerido");
  });

  it("sin mensaje usable, devuelve undefined (cae al texto crudo de la respuesta)", () => {
    expect(extraerMensaje(undefined)).toBeUndefined();
    expect(extraerMensaje("")).toBeUndefined();
    expect(extraerMensaje({})).toBeUndefined();
  });

  it("un código conocido (CFDI40145) agrega la explicación en español de qué corregir", () => {
    const m = mensajeAmigable("CFDI40145 - El campo Nombre del receptor, debe pertenecer al RFC.");
    expect(m).toContain("CFDI40145");
    expect(m).toContain("Corrige la razón social en Clientes");
  });

  it("un código sin explicación conocida se deja tal cual, sin inventar nada", () => {
    expect(mensajeAmigable("CFDI99999 - algo que todavía no hemos visto")).toBe(
      "CFDI99999 - algo que todavía no hemos visto",
    );
  });
});
