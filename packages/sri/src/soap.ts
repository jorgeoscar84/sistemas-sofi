/**
 * Cliente de los servicios web del SRI (Recepción y Autorización).
 * Usa `fetch` nativo de Node 24 y el parser XML propio, sin dependencias SOAP.
 */

import { SRI_ENDPOINTS } from '../../shared/src/index.ts';
import { child, childText, findAll, find, innerText, parseXml } from './xml-parse.ts';

export interface SriMensaje {
  identificador?: string;
  mensaje?: string;
  informacionAdicional?: string;
  tipo?: string;
}

export interface SriReceptionResult {
  estado: 'RECIBIDA' | 'DEVUELTA' | 'ERROR';
  comprobantes: {
    claveAcceso: string;
    estado: string;
    mensajes: SriMensaje[];
  }[];
  httpStatus?: number;
  error?: string;
  rawRequest?: string;
  rawResponse?: string;
}

export interface SriAuthorizationResult {
  estado: 'AUTORIZADO' | 'NO AUTORIZADO' | 'PENDIENTE' | 'ERROR';
  numeroAutorizacion?: string;
  fechaAutorizacion?: string;
  comprobanteXml?: string;
  mensajes: SriMensaje[];
  httpStatus?: number;
  error?: string;
  rawRequest?: string;
  rawResponse?: string;
}

const FETCH_TIMEOUT_MS = Number(process.env.SRI_TIMEOUT_MS ?? '25000');

function endpoint(ambiente: 1 | 2) {
  return SRI_ENDPOINTS[ambiente];
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseMensajes(node: ReturnType<typeof parseXml>): SriMensaje[] {
  const mensajes: SriMensaje[] = [];
  for (const mensajeNode of findAll(node, 'mensaje')) {
    const identificador = childText(mensajeNode, 'identificador');
    const mensaje = childText(mensajeNode, 'mensaje');
    const informacionAdicional = childText(mensajeNode, 'informacionAdicional');
    const tipo = childText(mensajeNode, 'tipo');
    if (!identificador && !mensaje && !informacionAdicional) continue;
    mensajes.push({ identificador, mensaje, informacionAdicional, tipo });
  }
  return mensajes;
}

async function postSoap(url: string, envelope: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml' },
      body: envelope,
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Envía el XML firmado al servicio de recepción del SRI. */
export async function sendRecepcion(xmlSigned: string, ambiente: 1 | 2): Promise<SriReceptionResult> {
  const url = endpoint(ambiente).recepcion;
  const base64 = Buffer.from(xmlSigned, 'utf8').toString('base64');
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">` +
    `<soapenv:Header/><soapenv:Body><ec:validarComprobante><xml>${base64}</xml></ec:validarComprobante></soapenv:Body>` +
    `</soapenv:Envelope>`;
  try {
    const { status, body } = await postSoap(url, envelope);
    const doc = parseXml(body);
    const respuesta = find(doc, 'RespuestaRecepcionComprobante');
    const estadoRaw = (childText(respuesta, 'estado') ?? '').toUpperCase();
    const comprobantes: SriReceptionResult['comprobantes'] = [];
    if (respuesta) {
      for (const comprobanteNode of findAll(respuesta, 'comprobante')) {
        comprobantes.push({
          claveAcceso: childText(comprobanteNode, 'claveAcceso') ?? '',
          estado: childText(comprobanteNode, 'estado') ?? estadoRaw,
          mensajes: parseMensajes(comprobanteNode),
        });
      }
    }
    if (comprobantes.length === 0) {
      comprobantes.push({ claveAcceso: '', estado: estadoRaw, mensajes: parseMensajes(respuesta ?? doc) });
    }
    let estado: SriReceptionResult['estado'] = 'ERROR';
    if (estadoRaw === 'RECIBIDA') estado = 'RECIBIDA';
    else if (estadoRaw === 'DEVUELTA') estado = 'DEVUELTA';
    return { estado, comprobantes, httpStatus: status, rawRequest: envelope, rawResponse: body };
  } catch (error) {
    return {
      estado: 'ERROR',
      comprobantes: [],
      error: error instanceof Error ? error.message : String(error),
      rawRequest: envelope,
    };
  }
}

/** Consulta la autorización de una clave de acceso. */
export async function consultarAutorizacion(
  claveAcceso: string,
  ambiente: 1 | 2,
): Promise<SriAuthorizationResult> {
  const url = endpoint(ambiente).autorizacion;
  const envelope =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">` +
    `<soapenv:Header/><soapenv:Body><ec:autorizacionComprobante>` +
    `<claveAccesoComprobante>${escapeXmlText(claveAcceso)}</claveAccesoComprobante>` +
    `</ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>`;
  try {
    const { status, body } = await postSoap(url, envelope);
    const doc = parseXml(body);
    const respuesta = find(doc, 'RespuestaAutorizacionComprobante') ?? doc;
    const autorizacion = findAll(respuesta, 'autorizacion')[0];
    const estadoRaw = (childText(autorizacion ?? respuesta, 'estado') ?? '').toUpperCase();
    const mensajes = parseMensajes(autorizacion ?? respuesta);
    let comprobanteXml: string | undefined;
    if (autorizacion) {
      const comprobanteNode = child(autorizacion, 'comprobante');
      if (comprobanteNode) {
        const raw = innerText(comprobanteNode);
        comprobanteXml = raw || undefined;
      }
    }
    let estado: SriAuthorizationResult['estado'] = 'ERROR';
    if (estadoRaw === 'AUTORIZADO') estado = 'AUTORIZADO';
    else if (estadoRaw === 'NO AUTORIZADO' || estadoRaw === 'RECHAZADA') estado = 'NO AUTORIZADO';
    else if (estadoRaw === 'PENDIENTE' || estadoRaw === 'EN PROCESO' || estadoRaw === '') estado = 'PENDIENTE';
    return {
      estado,
      numeroAutorizacion: childText(autorizacion, 'numeroAutorizacion'),
      fechaAutorizacion: childText(autorizacion, 'fechaAutorizacion'),
      comprobanteXml,
      mensajes,
      httpStatus: status,
      rawRequest: envelope,
      rawResponse: body,
    };
  } catch (error) {
    return {
      estado: 'ERROR',
      mensajes: [],
      error: error instanceof Error ? error.message : String(error),
      rawRequest: envelope,
    };
  }
}

/** URL del portal público de consulta de comprobantes (para enlaces en la UI). */
export function portalConsulta(ambiente: 1 | 2): string {
  return endpoint(ambiente).portal;
}

/** Comprueba la disponibilidad del servicio de recepción (WSDL). */
export async function probarConectividadSri(
  ambiente: 1 | 2,
): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const response = await fetch(`${endpoint(ambiente).recepcion}?wsdl`, {
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    return { ok: response.ok && text.includes('wsdl'), status: response.status, ms: Date.now() - start };
  } catch (error) {
    return { ok: false, ms: Date.now() - start, error: error instanceof Error ? error.message : String(error) };
  }
}


