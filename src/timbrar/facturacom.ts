/**
 * Adaptador de Factura.com: la parte que habla con la red.
 *
 * El armado del cuerpo es puro y vive en `facturacom-cuerpo.ts`. Aquí están
 * las llamadas HTTP: resolver el receptor (su API exige un cliente
 * pre-registrado: no se le puede mandar el receptor completo en la misma
 * llamada), resolver la serie, crear el CFDI y descargar PDF/XML.
 *
 * Verificado con llamadas reales contra su sandbox (2026-09-28), no
 * adivinado:
 *   - GET  /v1/clients/rfc/{rfc}      -> {status:"success", Data:{UID,...}}
 *   - POST /v1/clients/create         -> da de alta un receptor nuevo
 *   - GET  /v4/series                 -> {status, data:[{SerieID, SerieType,...}]}
 *   - POST /v4/cfdi40/create          -> timbra en la misma llamada (síncrono)
 *   - GET  /v4/cfdi40/{uid}/pdf       -> PDF, bytes directos (NO json/base64)
 *   - GET  /v4/cfdi40/{uid}/xml       -> XML, texto directo (NO json/base64)
 *
 * Para cancelar, sólo según su documentación (todavía SIN llamada real):
 *   - GET  /v4/cfdi/uuid/{uuid}       -> el CFDI, con su UID
 *   - POST /v4/cfdi40/{uid}/cancel    -> {response, message, respuestaapi:{acuse}}
 *
 * Una particularidad real de esta API: un rechazo (p.ej. "El campo serie es
 * requerido") puede llegar con HTTP 200 y `{"response":"error", "message":...}`
 * en el cuerpo — el status HTTP solo no basta para saber si timbró.
 *
 * `F-PLUGIN` no es un secreto de esta cuenta: es un valor fijo, documentado
 * por Factura.com igual para cualquiera que use su API directa (no a través
 * de un plugin de su marketplace).
 */

import type { DatosReceptor, EntradaCfdi } from "./cfdi.ts";
import { construirCuerpoFacturaCom } from "./facturacom-cuerpo.ts";
import { extraerMensaje, mensajeAmigable, type MensajePac } from "./facturacom-mensajes.ts";
import { type Entorno, requerir } from "./entorno.ts";
import { verificarSandbox } from "./guarda.ts";
import type { Cancelacion, MotivoCancelacion, PAC, Timbre } from "./pac.ts";

/** Un PAC que no contesta no puede dejar la petición colgada para siempre. */
const TIMEOUT_PAC_MS = 90_000;

const F_PLUGIN = "9d4095c8f7ed5785cb14c0e3b033eeb8252416ed";

interface RespuestaCliente {
  status?: string;
  Data?: { UID?: string };
  UID?: string;
  message?: MensajePac;
}

interface RespuestaSeries {
  status?: string;
  data?: { SerieID: number; SerieType: string }[];
}

interface RespuestaCrearCfdi {
  response?: string;
  message?: MensajePac;
  UUID?: string;
  invoice_uid?: string;
  uid?: string;
}

export class PacFacturaCom implements PAC {
  readonly nombre = "Factura.com";

  constructor(private readonly env: Entorno) {}

  private base(): string {
    // GUARDA DE SANDBOX: solo https://sandbox.factura.com/api (o una dirección
    // de esta máquina, para pruebas). Sin FACTURACOM_BASE_URL NO se cae a
    // producción como hacía la función original: se rechaza. Ver guarda.ts.
    return verificarSandbox(this.env.FACTURACOM_BASE_URL);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "F-PLUGIN": F_PLUGIN,
      "F-Api-Key": requerir(this.env, "FACTURACOM_API_KEY"),
      "F-Secret-Key": requerir(this.env, "FACTURACOM_SECRET_KEY"),
    };
  }

  private async pedir(ruta: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(this.base() + ruta, {
        ...init,
        headers: { ...this.headers(), ...init.headers },
        signal: AbortSignal.timeout(TIMEOUT_PAC_MS),
      });
    } catch (e) {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new Error(`Factura.com no respondió en ${TIMEOUT_PAC_MS / 1000} s (${ruta})`);
      }
      throw e;
    }
  }

  /**
   * Busca el receptor por RFC y, si no existe, lo da de alta. A propósito NO
   * distingue por qué falló la búsqueda (RFC no encontrado vs. otro error):
   * si de verdad ya existiera, "crear" lo diría con su propio mensaje, que
   * llega tal cual al que factura — no hay forma de fallar en silencio.
   */
  private async resolverReceptorUid(r: DatosReceptor): Promise<string> {
    const consulta = await this.pedir(`/v1/clients/rfc/${encodeURIComponent(r.rfc)}`);
    const encontrado = (await consulta.json().catch(() => ({}))) as RespuestaCliente;
    const uidExistente = encontrado.Data?.UID ?? encontrado.UID;
    if (encontrado.status === "success" && uidExistente) return uidExistente;

    if (!r.email) {
      throw new Error(
        `Factura.com necesita el correo de "${r.nombre}" (RFC ${r.rfc}) para darlo de alta ` +
          "como receptor antes de poder facturarle. Agrégaselo al cliente y vuelve a intentar.",
      );
    }

    const creado = await this.pedir("/v1/clients/create", {
      method: "POST",
      body: JSON.stringify({
        rfc: r.rfc,
        razons: r.nombre,
        codpos: r.domicilioFiscal,
        email: r.email,
        regimen: r.regimenFiscal,
        pais: "MEX",
      }),
    });
    const textoCreado = await creado.text();
    let datos: RespuestaCliente;
    try {
      datos = JSON.parse(textoCreado);
    } catch {
      datos = {};
    }
    const uid = datos.Data?.UID ?? datos.UID;
    if (!uid) {
      const bruto = extraerMensaje(datos.message);
      throw new Error(
        bruto
          ? `Factura.com no pudo dar de alta al receptor ${r.rfc}: ${mensajeAmigable(bruto)}`
          : `Factura.com no pudo dar de alta al receptor ${r.rfc}: ${textoCreado.slice(0, 1000)}`,
      );
    }
    return uid;
  }

  /**
   * El `Serie` que pide `/v4/cfdi40/create` es el `SerieID` numérico, no una
   * letra — confirmado con la API real: sin él, rechaza con "El campo serie
   * es requerido". Se resuelve en cada timbrado en vez de fijarlo en un
   * secreto: así no hay un ID por entorno (sandbox/producción) que configurar
   * ni desincronizar.
   */
  private async serieFactura(): Promise<number> {
    const r = await this.pedir("/v4/series");
    const cuerpo = (await r.json().catch(() => ({}))) as RespuestaSeries;
    const serie = cuerpo.data?.find((s) => s.SerieType === "factura");
    if (!serie) {
      throw new Error("Factura.com: no encontré una serie de tipo 'factura' activa en la cuenta.");
    }
    return serie.SerieID;
  }

  private async archivo(tipo: "pdf" | "xml", uid: string): Promise<Uint8Array> {
    const r = await this.pedir(`/v4/cfdi40/${uid}/${tipo}`);
    if (!r.ok) {
      throw new Error(`Factura.com: no se pudo descargar el ${tipo} (HTTP ${r.status})`);
    }
    // El archivo viaja directo en el cuerpo de la respuesta, no envuelto en
    // JSON con base64.
    return new Uint8Array(await r.arrayBuffer());
  }

  async timbrar(entrada: EntradaCfdi): Promise<Timbre> {
    const [receptorUid, serieId] = await Promise.all([
      this.resolverReceptorUid(entrada.receptor),
      this.serieFactura(),
    ]);

    const cuerpo = construirCuerpoFacturaCom(entrada, receptorUid, serieId);

    const r = await this.pedir("/v4/cfdi40/create", {
      method: "POST",
      body: JSON.stringify(cuerpo),
    });

    // Un rechazo puede llegar con HTTP 200: hay que leer el cuerpo para
    // saberlo, no basta `r.ok`. Se lee como texto una sola vez y se parsea
    // después, para poder mostrar la respuesta cruda si no fuera JSON.
    const texto = await r.text();
    let creado: RespuestaCrearCfdi;
    try {
      creado = JSON.parse(texto);
    } catch {
      throw new Error(`Factura.com: respuesta inesperada (HTTP ${r.status}): ${texto.slice(0, 500)}`);
    }
    if (!r.ok || creado.response !== "success") {
      // `creado.message` casi siempre trae el motivo real y legible del
      // rechazo (`{"message": "CFDI40145 - ..."}`, verificado con un rechazo
      // real) — se usa ESE, no el texto crudo de 1000 caracteres (JSON +
      // el XML completo) que antes se le mostraba al cajero sin poder
      // distinguir qué tenía que corregir.
      const bruto = extraerMensaje(creado.message);
      throw new Error(
        bruto
          ? `Factura.com rechazó el comprobante: ${mensajeAmigable(bruto)}`
          : `Factura.com rechazó el comprobante (HTTP ${r.status}): ${texto.slice(0, 1000)}`,
      );
    }

    const uuid = creado.UUID;
    const uid = creado.invoice_uid ?? creado.uid;
    if (!uuid || !uid) throw new Error("Factura.com no devolvió el UUID o el uid del timbre");

    const [xmlBytes, pdf] = await Promise.all([
      this.archivo("xml", uid),
      this.archivo("pdf", uid),
    ]);

    return {
      uuid,
      xmlTimbrado: new TextDecoder("utf-8").decode(xmlBytes),
      pdf,
    };
  }

  /**
   * UID interno de Factura.com a partir del UUID fiscal: la app sólo guarda
   * el UUID. `GET /v4/cfdi/uuid/{uuid}` (documentado, NO verificado todavía
   * con una llamada real). Si no lo encuentra se usa el UUID tal cual: su
   * documentación de cancelación dice que la ruta acepta "el UID o UUID".
   */
  private async uidDeUuid(uuid: string): Promise<string> {
    const r = await this.pedir(`/v4/cfdi/uuid/${encodeURIComponent(uuid)}`);
    const cuerpo = (await r.json().catch(() => ({}))) as {
      UID?: string;
      Data?: { UID?: string };
      data?: { UID?: string };
    };
    return cuerpo.Data?.UID ?? cuerpo.data?.UID ?? cuerpo.UID ?? uuid;
  }

  /**
   * `POST /v4/cfdi40/{uid}/cancel` con `{ motivo }` — según su documentación
   * (https://factura.com/apidocs/cancelar-cfdi-40.html), NO verificado con
   * una llamada real. `folioSustituto` sólo aplica al motivo 01, que la app
   * no ofrece; la documentación no aclara si con 02/03 va vacío u omitido:
   * se omite. Como al timbrar, un rechazo puede llegar con HTTP 200 y
   * `response: "error"`, así que se lee el cuerpo.
   */
  async cancelar(uuid: string, motivo: MotivoCancelacion): Promise<Cancelacion> {
    const uid = await this.uidDeUuid(uuid);
    const r = await this.pedir(`/v4/cfdi40/${encodeURIComponent(uid)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ motivo }),
    });
    const texto = await r.text();
    let cuerpo: { response?: string; message?: MensajePac; respuestaapi?: { response?: string; acuse?: string } };
    try {
      cuerpo = JSON.parse(texto);
    } catch {
      throw new Error(`Factura.com: respuesta inesperada al cancelar (HTTP ${r.status}): ${texto.slice(0, 500)}`);
    }
    if (!r.ok || cuerpo.response !== "success") {
      const bruto = extraerMensaje(cuerpo.message);
      throw new Error(
        bruto
          ? `Factura.com no canceló el comprobante: ${mensajeAmigable(bruto)}`
          : `Factura.com no canceló el CFDI (HTTP ${r.status}): ${texto.slice(0, 1000)}`,
      );
    }
    return {
      acuse: cuerpo.respuestaapi?.acuse ?? null,
      mensaje: typeof cuerpo.message === "string" ? cuerpo.message : texto.slice(0, 500),
    };
  }
}
