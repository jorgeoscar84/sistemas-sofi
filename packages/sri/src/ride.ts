/**
 * RIDE (Representación Impresa de Documento Electrónico) en PDF.
 * Replica la estructura estándar del RIDE del SRI, sin dependencias.
 */

import { SimplePdf, textWidth } from './pdf.ts';
import { money2 } from './xml.ts';

export interface RideItem {
  codigo: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuento: number;
  subtotal: number;
  impuestos: { codigo: string; codigoPorcentaje: string; tarifa: number; baseImponible: number; valor: number }[];
}

export interface RideTaxTotal {
  codigoPorcentaje: string;
  tarifa: number;
  baseImponible: number;
  valor: number;
}

export interface RideModel {
  company: {
    name: string;
    ruc: string;
    address: string;
    phone?: string;
    email?: string;
    obligedAccounting: boolean;
  };
  docTypeName: string;
  docTypeCode: string;
  number: string; // 001-002-000000001
  accessKey: string;
  environmentLabel: string;
  authorizationNumber?: string;
  authorizationDate?: string;
  issueDate: string; // dd/mm/aaaa
  statusLabel?: string;
  client: {
    name: string;
    idType: string;
    idNumber: string;
    address?: string;
    email?: string;
  };
  items: RideItem[];
  taxTotals: RideTaxTotal[];
  subtotal: number;
  discount: number;
  total: number;
  payments: { method: string; amount: number }[];
  infoAdicional?: { nombre: string; valor: string }[];
  sriMessages?: { mensaje?: string; informacionAdicional?: string; identificador?: string }[];
}

const MARGIN = 40;
const RIGHT = 555;
const PAGE_BOTTOM = 100;

export function generarRidePdf(model: RideModel): Buffer {
  const pdf = new SimplePdf();
  let y = 50;

  // ---------- Cabecera
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
      pdf.text(MARGIN + 360, y, 'FECHA:', { size: 7, font: 'Helvetica-Bold' });
      pdf.text(MARGIN + 400, y, model.authorizationDate.slice(0, 19).replace('T', ' '), { size: 8 });
    }
  }
  y += 16;
  pdf.line(MARGIN, y, RIGHT, y, 0.8);
  y += 14;

  // ---------- Cliente
  pdf.text(MARGIN, y, 'INFORMACIÓN DEL RECEPTOR', { size: 9, font: 'Helvetica-Bold' });
  y += 12;
  pdf.text(MARGIN, y, `Razón social: ${model.client.name}`, { size: 8 });
  pdf.text(MARGIN + 300, y, `Identificación: ${model.client.idNumber}`, { size: 8 });
  y += 10;
  if (model.client.address) pdf.text(MARGIN, y, `Dirección: ${model.client.address}`, { size: 8 });
  pdf.text(MARGIN + 300, y, `Fecha de emisión: ${model.issueDate}`, { size: 8 });
  if (model.client.email) {
    y += 10;
    pdf.text(MARGIN, y, `Correo: ${model.client.email}`, { size: 8 });
  }
  y += 16;
  pdf.line(MARGIN, y, RIGHT, y, 0.8);
  y += 12;

  // ---------- Tabla de ítems
  const colX = [MARGIN, 90, 360, 415, 470, 515];
  const headers = ['Código', 'Descripción', 'Cant.', 'P. Unit.', 'Desc.', 'Subtotal'];
  pdf.rect(MARGIN, y - 9, RIGHT - MARGIN, 14, 0.92);
  headers.forEach((header, i) => {
    const alignRight = i >= 2;
    if (alignRight) pdf.textRight(colX[i + 1]! - 3, y, header, { size: 7, font: 'Helvetica-Bold' });
    else pdf.text(colX[i]! + 2, y, header, { size: 7, font: 'Helvetica-Bold' });
  });
  y += 12;

  for (const item of model.items) {
    if (y > pdf.height - PAGE_BOTTOM) {
      pdf.addPage();
      y = 50;
    }
    pdf.text(colX[0]! + 2, y, truncate(item.codigo, 14), { size: 7 });
    pdf.text(colX[1]! + 2, y, truncate(item.descripcion, 44), { size: 7 });
    pdf.textRight(colX[3]! - 3, y, trimNum(item.cantidad), { size: 7 });
    pdf.textRight(colX[4]! - 3, y, money2(item.precioUnitario), { size: 7 });
    pdf.textRight(colX[5]! - 3, y, money2(item.descuento), { size: 7 });
    pdf.textRight(RIGHT - 3, y, money2(item.subtotal), { size: 7 });
    y += 11;
  }

  y += 4;
  pdf.line(MARGIN, y, RIGHT, y, 0.5);
  y += 12;

  // ---------- Totales (izquierda: impuestos | derecha: totales)
  const taxLeft = MARGIN;
  let ty = y;
  pdf.text(taxLeft, ty, 'DETALLE DE IMPUESTOS', { size: 8, font: 'Helvetica-Bold' });
  ty += 11;
  for (const t of model.taxTotals) {
    const label = `IVA ${t.codigoPorcentaje} (${(t.tarifa * 100).toFixed(0)}%)`;
    pdf.text(taxLeft, ty, label, { size: 7 });
    pdf.textRight(300, ty, `Base: ${money2(t.baseImponible)}`, { size: 7 });
    pdf.textRight(390, ty, `Valor: ${money2(t.valor)}`, { size: 7 });
    ty += 10;
  }

  let ry = y;
  const totalLine = (label: string, value: string, bold = false) => {
    pdf.text(430, ry, label, { size: 8 });
    pdf.textRight(RIGHT - 3, ry, value, { size: 8, font: bold ? 'Helvetica-Bold' : 'Helvetica' });
    ry += 11;
  };
  totalLine('SUBTOTAL', money2(model.subtotal));
  totalLine('DESCUENTO', money2(model.discount));
  totalLine('IVA', money2(model.taxTotals.reduce((sum, t) => sum + t.valor, 0)));
  pdf.line(428, ry - 6, RIGHT, ry - 6, 0.5);
  totalLine('TOTAL', money2(model.total), true);

  y = Math.max(ty, ry) + 4;
  pdf.line(MARGIN, y, RIGHT, y, 0.8);
  y += 12;

  // ---------- Pagos e información adicional
  if (model.payments.length) {
    pdf.text(MARGIN, y, `FORMA DE PAGO: ${model.payments.map((p) => `${p.method} ${money2(p.amount)}`).join('  ·  ')}`, {
      size: 8,
    });
    y += 12;
  }
  if (model.infoAdicional && model.infoAdicional.length) {
    pdf.text(MARGIN, y, 'INFORMACIÓN ADICIONAL', { size: 8, font: 'Helvetica-Bold' });
    y += 10;
    for (const info of model.infoAdicional.slice(0, 12)) {
      pdf.text(MARGIN, y, `${info.nombre}: ${truncate(info.valor, 90)}`, { size: 7 });
      y += 9;
    }
  }

  if (model.sriMessages && model.sriMessages.length) {
    y += 6;
    pdf.text(MARGIN, y, 'MENSAJES DEL SRI', { size: 8, font: 'Helvetica-Bold' });
    y += 10;
    for (const m of model.sriMessages.slice(0, 8)) {
      pdf.text(MARGIN, y, truncate(`[${m.identificador ?? ''}] ${m.mensaje ?? ''}`, 120), { size: 6.5 });
      y += 8;
    }
  }

  // ---------- Pie
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
  pdf.text(
    MARGIN,
    footerY + 9,
    `Consulte la validez de este comprobante en ${'https://cel.sri.gob.ec'} con la clave de acceso.`,
    { size: 6.5 },
  );

  return pdf.build();
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function trimNum(value: number): string {
  return String(Math.round(Number(value ?? 0) * 1e6) / 1e6);
}
