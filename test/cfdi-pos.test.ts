import { describe, expect, it } from "vitest";
import {
  calcularConcepto,
  cantidad,
  construirCfdi,
  pesos,
  tasa,
  totalesDerivados,
  verificarTotales,
  type DetalleVenta,
  type EntradaCfdi,
} from "../src/timbrar/cfdi.ts";
import { calcularRenglon } from "./pos/iva.ts";

/**
 * El módulo de CFDI vive en supabase/functions/ porque corre en Deno, pero es
 * puro y se prueba desde aquí: la aritmética fiscal es justo lo que no puede
 * quedarse sin pruebas por estar del otro lado de una frontera de despliegue.
 */

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
    fecha: "2026-09-23T14:05:01",
    formaPago: "01",
    metodoPago: "PUE",
    totalCent: detalles.reduce((s, d) => s + d.total_cent, 0),
  },
  emisor: {
    rfc: "AAA010101AAA",
    nombre: "FERRETERIA DE PRUEBA",
    regimenFiscal: "601",
    codigoPostal: "44100",
  },
  receptor: {
    rfc: "XAXX010101000",
    nombre: "PUBLICO EN GENERAL",
    domicilioFiscal: "44100",
    regimenFiscal: "616",
    usoCfdi: "G03",
  },
  detalles,
});

// ------------------------------------------------------------- formatos ---

describe("formatos del Anexo 20", () => {
  it("escribe centavos sin pasar por coma flotante", () => {
    expect(pesos(0)).toBe("0.00");
    expect(pesos(5)).toBe("0.05");
    expect(pesos(1293)).toBe("12.93");
    expect(pesos(123456789)).toBe("1234567.89");
  });

  it("escribe cantidades con hasta 3 decimales y sin relleno", () => {
    expect(cantidad(1000)).toBe("1");
    expect(cantidad(2500)).toBe("2.5");
    expect(cantidad(1250)).toBe("1.25");
    expect(cantidad(1)).toBe("0.001");
  });

  it("escribe la tasa con los 6 decimales que exige el SAT", () => {
    expect(tasa(160_000)).toBe("0.160000");
    expect(tasa(80_000)).toBe("0.080000");
    expect(tasa(0)).toBe("0.000000");
  });
});

// ------------------------------------------------------------- conceptos ---

describe("conversión de renglón a concepto", () => {
  it("pasa el precio de mostrador con IVA a base sin IVA", () => {
    const c = calcularConcepto(renglon({ precio_unit_cent: 1500 }));

    expect(c.importeBaseCent).toBe(1293);
    expect(c.ivaCent).toBe(207);
    expect(c.baseTrasladoCent).toBe(1293);
    expect(c.valorUnitario).toBe("12.930000");
    // Lo que el cliente pagó, intacto.
    expect(c.baseTrasladoCent + c.ivaCent).toBe(1500);
  });

  it("convierte el descuento a base para que Importe - Descuento = Base", () => {
    const d = renglon({ precio_unit_cent: 10_000, descuento_cent: 1_000 });
    const c = calcularConcepto(d);

    expect(c.importeBaseCent - c.descuentoBaseCent).toBe(c.baseTrasladoCent);
    expect(c.baseTrasladoCent).toBe(d.importe_cent);
    expect(c.baseTrasladoCent + c.ivaCent).toBe(d.total_cent);
  });

  it("no desglosa tasa en un producto exento", () => {
    const xml = construirCfdi(
      entrada([renglon({ tipo_factor: "Exento", tasa_iva_ppm: 0 })]),
    );

    expect(xml).toContain('TipoFactor="Exento"');
    expect(xml).not.toContain("TasaOCuota");
  });
});

// --------------------------------------------------------------- totales ---

describe("totales del comprobante", () => {
  it("cuadra Total = SubTotal - Descuento + Traslados", () => {
    const e = entrada([
      renglon({ precio_unit_cent: 1500 }),
      renglon({ precio_unit_cent: 3399, cantidad_mil: 2000 }),
      renglon({ precio_unit_cent: 79, cantidad_mil: 7000 }),
    ]);

    const t = totalesDerivados(e.detalles);
    expect(t.subtotalCent - t.descuentoCent + t.trasladosCent).toBe(t.totalCent);
    expect(t.totalCent).toBe(e.venta.totalCent);
    expect(verificarTotales(e)).toEqual([]);
  });

  it("cuadra también con descuentos de por medio", () => {
    const e = entrada([
      renglon({ precio_unit_cent: 4999, descuento_cent: 500 }),
      renglon({ precio_unit_cent: 1250, cantidad_mil: 3000, descuento_cent: 137 }),
    ]);

    expect(verificarTotales(e)).toEqual([]);
  });

  it("cuadra sobre 5,000 tickets aleatorios, que es la prueba que importa", () => {
    // El método ingenuo —IVA como porcentaje del subtotal, redondeado al
    // final— descuadra en el 14.1% de los tickets y el PAC lo rechaza. Ver
    // db/README.md §3. Esta prueba fija ese 0%.
    let semilla = 20260923;
    const aleatorio = () => {
      semilla = (semilla * 1103515245 + 12345) % 2147483648;
      return semilla / 2147483648;
    };

    for (let t = 0; t < 5000; t++) {
      const n = 1 + Math.floor(aleatorio() * 8);
      const detalles = Array.from({ length: n }, () =>
        renglon({
          precio_unit_cent: 1 + Math.floor(aleatorio() * 200_000),
          cantidad_mil: 1000 * (1 + Math.floor(aleatorio() * 10)),
        }),
      );
      expect(verificarTotales(entrada(detalles))).toEqual([]);
    }
  });

  it("delata el descuadre en vez de gastar un timbre", () => {
    const e = entrada([renglon({ precio_unit_cent: 1500 })]);
    e.venta.totalCent = 1499; // alguien tocó el total a mano

    const problemas = verificarTotales(e);
    expect(problemas).toHaveLength(1);
    expect(problemas[0]).toContain("14.99");
  });
});

// ------------------------------------------------------------------- xml ---

describe("XML", () => {
  it("trae los atributos obligatorios del CFDI 4.0", () => {
    const xml = construirCfdi(entrada([renglon()]));

    expect(xml).toContain('Version="4.0"');
    expect(xml).toContain('TipoDeComprobante="I"');
    expect(xml).toContain('Exportacion="01"');
    expect(xml).toContain('Moneda="MXN"');
    expect(xml).toContain('LugarExpedicion="44100"');
    expect(xml).toContain('Fecha="2026-09-23T14:05:01"');
    // La fecha del SAT es local y sin zona: una Z aquí es rechazo directo.
    expect(xml).not.toContain("Z\"");
  });

  it("escapa lo que rompería el XML", () => {
    const xml = construirCfdi(
      entrada([renglon({ descripcion: 'TUBO 1/2" & CODO <PVC>' })]),
    );

    expect(xml).toContain("TUBO 1/2&quot; &amp; CODO &lt;PVC&gt;");
  });

  it("agrupa los traslados por tasa, no renglón por renglón", () => {
    const xml = construirCfdi(
      entrada([
        renglon({ precio_unit_cent: 1500 }),
        renglon({ precio_unit_cent: 2500 }),
      ]),
    );

    const impuestos = xml.slice(xml.indexOf("<cfdi:Impuestos T"));
    expect(impuestos.match(/<cfdi:Traslado /g)).toHaveLength(1);
    expect(impuestos).toContain('TotalImpuestosTrasladados="5.52"');
  });
});
