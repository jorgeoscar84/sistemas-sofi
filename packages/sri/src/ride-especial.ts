/**
 * RIDE para comprobantes especiales: Guía de Remisión y Comprobante de Retención.
 * Reutiliza el generador de PDF mínimo (`pdf.ts`).
 */

import { SimplePdf, textWidth } from './pdf.ts';
import { money2 } from './xml.ts';

const MARGIN = 40;
const RIGHT = 555;

interface RideCompany {
  name: string;
  ruc: string;
  address: string;
  phone?: string;
  email?: string;
  obligedAccounting: boolean;
}

interface RideBase {
  company: RideCompany;
  docTypeName: string;
  number: string;
  accessKey: string;
  environmentLabel: string;
  authorizationNumber?: string;
  authorizationDate?: string;
  issueDate: string;
  statusLabel?: string;
  sriMessages?: { identificador?: string; mensaje?: string; informacionAdicional?: string }[];
}

function header(pdf: SimplePdf, model: RideBase): number {
  let y = 50;
  pdf.rect(MARGIN, y - 6, RIGHT - MARGIN, 58, 0.96);
  pdf.text(MARGIN + 10, y + 6, model.company.name.toUpperCase(), { size: 13, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 10, y + 20, `R.U.C.: ${model.company.ruc}`, { size: 9, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 10, y + 32, `Dirección: ${model.company.address}`, { size: 8 });
  const contact = [model.company.phone, model.company.email].filter(Boolean).join('  ·  ');
  if (contact) pdf.text(MARGIN + 10, y + 44, contact, { size: 8 });
  pdf.text(RIGHT - 10 - textWidth(model.docTypeName.toUpperCase(), 11, 'Helvetica-Bold'), y + 8, model.docTypeName.toUpperCase(), {
    size: 11,
    font: 'Helvetica-Bold',
  });
  pdf.textRight(RIGHT - 10, y + 22, 'N.º:', { size: 8, font: 'Helvetica-Bold' });
  pdf.textRight(RIGHT - 10, y + 33, model.number, { size: 10, font: 'Courier-Bold' });
  pdf.textRight(RIGHT - 10, y + 46, model.statusLabel ?? '', { size: 8 });
  y += 74;
  pdf.text(MARGIN, y, 'CLAVE DE ACCESO:', { size: 8, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 92, y, model.accessKey, { size: 9, font: 'Courier-Bold' });
  y += 10;
  pdf.text(MARGIN, y, 'AMBIENTE:', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 92, y, model.environmentLabel, { size: 8 });
  if (model.authorizationNumber) {
    y += 10;
    pdf.text(MARGIN, y, 'AUTORIZACIÓN:', { size: 7, font: 'Helvetica-Bold' });
    pdf.text(MARGIN + 92, y, model.authorizationNumber, { size: 8, font: 'Courier' });
    if (model.authorizationDate) {
      pdf.text(MARGIN + 380, y, model.authorizationDate.slice(0, 19).replace('T', ' '), { size: 8 });
    }
  }
  y += 16;
  pdf.line(MARGIN, y, RIGHT, y, 0.8);
  return y + 14;
}

function footer(pdf: SimplePdf, model: RideBase): void {
  const footerY = pdf.height - 50;
  pdf.line(MARGIN, footerY - 10, RIGHT, footerY - 10, 0.5);
  pdf.text(
    MARGIN,
    footerY,
    model.company.obligedAccounting
      ? 'Documento generado electrónicamente. Obligado a llevar contabilidad: SI.'
      : 'Documento generado electrónicamente. Obligado a llevar contabilidad: NO.',
    { size: 7 },
  );
  pdf.text(MARGIN, footerY + 9, 'Consulte la validez de este comprobante en https://cel.sri.gob.ec con la clave de acceso.', {
    size: 6.5,
  });
  if (model.sriMessages && model.sriMessages.length) {
    let y = footerY - 22;
    for (const message of model.sriMessages.slice(0, 4)) {
      pdf.text(MARGIN, y, truncate(`[${message.identificador ?? ''}] ${message.mensaje ?? ''}`, 118), { size: 6 });
      y -= 8;
    }
  }
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ------------------------------------------------------- GUÍA DE REMISIÓN */

export interface RideGuiaDestinatario {
  identificacion: string;
  razonSocial: string;
  direccion: string;
  motivoTraslado: string;
  items: { codigo: string; descripcion: string; cantidad: number }[];
}

export interface RideGuiaModel extends RideBase {
  dirPartida: string;
  transportista: { razonSocial: string; ruc: string; tipoIdentificacion: string; placa: string };
  fechaIniTransporte: string;
  fechaFinTransporte: string;
  destinatarios: RideGuiaDestinatario[];
}

export function generarRideGuiaPdf(model: RideGuiaModel): Buffer {
  const pdf = new SimplePdf();
  let y = header(pdf, model);

  pdf.text(MARGIN, y, 'DATOS DEL TRANSPORTE', { size: 9, font: 'Helvetica-Bold' });
  y += 12;
  pdf.text(MARGIN, y, `Transportista: ${model.transportista.razonSocial}`, { size: 8 });
  pdf.text(MARGIN + 320, y, `RUC: ${model.transportista.ruc}`, { size: 8 });
  y += 10;
  pdf.text(MARGIN, y, `Placa: ${model.transportista.placa}`, { size: 8, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 120, y, `Inicio: ${model.fechaIniTransporte}`, { size: 8 });
  pdf.text(MARGIN + 300, y, `Fin: ${model.fechaFinTransporte}`, { size: 8 });
  y += 10;
  pdf.text(MARGIN, y, `Punto de partida: ${model.dirPartida}`, { size: 8 });
  y += 8;
  pdf.text(MARGIN, y, `Fecha de emisión: ${model.issueDate}`, { size: 8 });
  y += 16;
  pdf.line(MARGIN, y, RIGHT, y, 0.5);
  y += 14;

  for (const [index, destinatario] of model.destinatarios.entries()) {
    if (y > pdf.height - 160) {
      pdf.addPage();
      y = 50;
    }
    pdf.text(MARGIN, y, `DESTINATARIO ${index + 1}`, { size: 9, font: 'Helvetica-Bold' });
    y += 12;
    pdf.text(MARGIN, y, `Razón social: ${destinatario.razonSocial}`, { size: 8 });
    pdf.text(MARGIN + 320, y, `Identificación: ${destinatario.identificacion}`, { size: 8 });
    y += 10;
    pdf.text(MARGIN, y, `Dirección: ${destinatario.direccion}`, { size: 8 });
    y += 10;
    pdf.text(MARGIN, y, `Motivo del traslado: ${destinatario.motivoTraslado}`, { size: 8 });
    y += 14;

    pdf.rect(MARGIN, y - 9, RIGHT - MARGIN, 14, 0.92);
    pdf.text(MARGIN + 2, y, 'Código', { size: 7, font: 'Helvetica-Bold' });
    pdf.text(MARGIN + 110, y, 'Descripción', { size: 7, font: 'Helvetica-Bold' });
    pdf.textRight(RIGHT - 4, y, 'Cantidad', { size: 7, font: 'Helvetica-Bold' });
    y += 12;
    for (const item of destinatario.items) {
      if (y > pdf.height - 120) {
        pdf.addPage();
        y = 50;
      }
      pdf.text(MARGIN + 2, y, truncate(item.codigo, 22), { size: 7 });
      pdf.text(MARGIN + 110, y, truncate(item.descripcion, 62), { size: 7 });
      pdf.textRight(RIGHT - 4, y, String(item.cantidad), { size: 7 });
      y += 11;
    }
    y += 10;
    pdf.line(MARGIN, y, RIGHT, y, 0.4);
    y += 14;
  }

  footer(pdf, model);
  return pdf.build();
}

/* -------------------------------------------------- COMPROBANTE RETENCIÓN */

export interface RideRetencion {
  codigo: string;
  etiqueta: string;
  codigoPorcentaje: string;
  tarifa: number;
  baseImponible: number;
  valorRetenido: number;
}

export interface RideRetencionDoc {
  codDocSustento: string;
  numDocSustento: string;
  fechaEmisionDocSustento: string;
  numAutDocSustento: string;
  importeTotal: number;
  retenciones: RideRetencion[];
}

export interface RideRetencionModel extends RideBase {
  sujeto: { razonSocial: string; identificacion: string; tipoIdentificacion: string };
  periodoFiscal: string;
  docs: RideRetencionDoc[];
  totalRetenido: number;
}

export function generarRideRetencionPdf(model: RideRetencionModel): Buffer {
  const pdf = new SimplePdf();
  let y = header(pdf, model);

  pdf.text(MARGIN, y, 'SUJETO RETENIDO', { size: 9, font: 'Helvetica-Bold' });
  y += 12;
  pdf.text(MARGIN, y, `Razón social: ${model.sujeto.razonSocial}`, { size: 8 });
  pdf.text(MARGIN + 320, y, `Identificación: ${model.sujeto.identificacion}`, { size: 8 });
  y += 10;
  pdf.text(MARGIN, y, `Período fiscal: ${model.periodoFiscal}`, { size: 8 });
  pdf.text(MARGIN + 320, y, `Fecha de emisión: ${model.issueDate}`, { size: 8 });
  y += 16;
  pdf.line(MARGIN, y, RIGHT, y, 0.5);
  y += 14;

  pdf.rect(MARGIN, y - 9, RIGHT - MARGIN, 14, 0.92);
  pdf.text(MARGIN + 2, y, 'Documento sustento', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 160, y, 'N.º', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 300, y, 'Fecha', { size: 7, font: 'Helvetica-Bold' });
  pdf.textRight(MARGIN + 430, y, 'Importe', { size: 7, font: 'Helvetica-Bold' });
  y += 12;

  for (const doc of model.docs) {
    if (y > pdf.height - 140) {
      pdf.addPage();
      y = 50;
    }
    pdf.text(MARGIN + 2, y, doc.codDocSustento, { size: 7 });
    pdf.text(MARGIN + 160, y, truncate(doc.numDocSustento, 22), { size: 7 });
    pdf.text(MARGIN + 300, y, doc.fechaEmisionDocSustento, { size: 7 });
    pdf.textRight(MARGIN + 430, y, money2(doc.importeTotal), { size: 7 });
    y += 11;
    pdf.text(MARGIN + 2, y, truncate(`Autorización: ${doc.numAutDocSustento}`, 90), { size: 6.5 });
    y += 12;

    pdf.rect(MARGIN, y - 9, RIGHT - MARGIN, 14, 0.95);
    pdf.text(MARGIN + 2, y, 'Impuesto', { size: 7, font: 'Helvetica-Bold' });
    pdf.text(MARGIN + 90, y, 'Código', { size: 7, font: 'Helvetica-Bold' });
    pdf.text(MARGIN + 200, y, 'Tarifa', { size: 7, font: 'Helvetica-Bold' });
    pdf.textRight(MARGIN + 330, y, 'Base imponible', { size: 7, font: 'Helvetica-Bold' });
    pdf.textRight(RIGHT - 4, y, 'Valor retenido', { size: 7, font: 'Helvetica-Bold' });
    y += 12;
    for (const retencion of doc.retenciones) {
      pdf.text(MARGIN + 2, y, retencion.etiqueta, { size: 7 });
      pdf.text(MARGIN + 90, y, `${retencion.codigo}/${retencion.codigoPorcentaje}`, { size: 7 });
      pdf.text(MARGIN + 200, y, `${retencion.tarifa}%`, { size: 7 });
      pdf.textRight(MARGIN + 330, y, money2(retencion.baseImponible), { size: 7 });
      pdf.textRight(RIGHT - 4, y, money2(retencion.valorRetenido), { size: 7 });
      y += 10;
    }
    y += 8;
  }

  y += 6;
  pdf.line(MARGIN + 330, y, RIGHT, y, 0.5);
  y += 14;
  pdf.text(MARGIN + 330, y, 'TOTAL RETENIDO', { size: 9, font: 'Helvetica-Bold' });
  pdf.textRight(RIGHT - 4, y, money2(model.totalRetenido), { size: 10, font: 'Helvetica-Bold' });

  footer(pdf, model);
  return pdf.build();
}
