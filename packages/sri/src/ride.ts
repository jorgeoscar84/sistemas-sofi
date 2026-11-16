/**
 * RIDE (Representación Impresa de Documento Electrónico) en PDF.
 *
 * Formato de factura con:
 *  - recuadro del emisor y recuadro de autorización/clave de acceso,
 *  - código de barras Code128 con la clave de acceso,
 *  - datos del receptor, detalle, desglose tributario y totales.
 *
 * Sin dependencias externas: usa el generador PDF mínimo del paquete.
 */

import { SimplePdf } from './pdf.ts';
import { money2 } from './xml.ts';
import { code128B } from './code128.ts';

export interface RideItem {
  codigo: string;
  descripcion: string;
  unidad?: string;
  cantidad: number;
  precioUnitario: number;
  descuento: number;
  subtotal: number;
  impuestos: { codigo: string; codigoPorcentaje: string; tarifa: number; baseImponible: number; valor: number }[];
}

export interface RideTaxTotal {
  codigo?: string;
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
  emissionLabel?: string;
  authorizationNumber?: string;
  authorizationDate?: string;
  issueDate: string; // dd/mm/aaaa
  dueDate?: string;
  statusLabel?: string;
  client: {
    name: string;
    idType: string;
    idNumber: string;
    address?: string;
    phone?: string;
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

const MARGIN = 36;
const RIGHT = 559;
const CONTENT_WIDTH = RIGHT - MARGIN;
const PAGE_BOTTOM = 70;

const ID_TYPE_LABELS: Record<string, string> = {
  '04': 'RUC',
  '05': 'CÉDULA',
  '06': 'PASAPORTE',
  '07': 'CONSUMIDOR FINAL',
  '08': 'IDENTIFICACIÓN EXTERIOR',
};

export function generarRidePdf(model: RideModel): Buffer {
  const pdf = new SimplePdf();
  let y = 36;

  /* ------------------------------------------------------------ cabecera */
  const headerHeight = 210;
  pdf.box(MARGIN, y, 270, headerHeight, 1);
  pdf.box(306, y, 253, headerHeight, 1);
  drawBoxBorder(pdf, MARGIN, y, 270, headerHeight);
  drawBoxBorder(pdf, 306, y, 253, headerHeight);

  pdf.text(MARGIN + 8, y + 21, model.company.name.toUpperCase(), { size: 12, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 8, y + 42, 'Dirección Matriz:', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(MARGIN + 8, y + 54, truncate(model.company.address || '—', 45), { size: 8 });
  const contact = [model.company.phone, model.company.email].filter(Boolean).join('  ·  ');
  if (contact) pdf.text(MARGIN + 8, y + 68, truncate(contact, 48), { size: 7 });
  pdf.text(MARGIN + 8, y + headerHeight - 16, `Obligado a Llevar Contabilidad: ${model.company.obligedAccounting ? 'SI' : 'NO'}`, {
    size: 7,
  });

  const rightX = 314;
  const rightValueX = RIGHT - 8;
  const row = (label: string, value: string, top: number, valueSize = 7, valueFont: 'Helvetica' | 'Helvetica-Bold' | 'Courier' | 'Courier-Bold' = 'Helvetica') => {
    pdf.text(rightX, top, label, { size: 6.5, font: 'Helvetica-Bold' });
    pdf.textRight(rightValueX, top, truncate(value, 60), { size: valueSize, font: valueFont });
  };
  row('RUC.:', model.company.ruc, y + 18, 8, 'Helvetica-Bold');
  row('FACTURA N.', model.number, y + 35, 8, 'Courier-Bold');
  row('FECHA AUTORIZACIÓN:', formatAuthDate(model.authorizationDate), y + 52, 6.2);
  row('AMBIENTE:', environmentShort(model.environmentLabel), y + 69, 7);
  row('EMISIÓN:', model.emissionLabel ?? 'NORMAL', y + 86, 7);

  // Los códigos de 49 dígitos necesitan su propio renglón para no truncarse.
  pdf.text(rightX, y + 106, 'NÚMERO DE AUTORIZACIÓN:', { size: 6.2, font: 'Helvetica-Bold' });
  pdf.text(rightX, y + 116, model.authorizationNumber ?? model.accessKey ?? '—', { size: 6.1, font: 'Courier' });
  pdf.text(rightX, y + 130, 'CLAVE DE ACCESO:', { size: 6.2, font: 'Helvetica-Bold' });
  pdf.text(rightX, y + 140, model.accessKey || '—', { size: 6.1, font: 'Courier-Bold' });
  drawBarcode(pdf, model.accessKey, rightX, y + 146, 237, 26);
  if (model.statusLabel && model.statusLabel !== 'issued') {
    pdf.text(rightX, y + headerHeight - 10, `ESTADO: ${model.statusLabel.toUpperCase()}`, { size: 6.2 });
  }
  y += headerHeight + 8;

  /* ------------------------------------------------------------- receptor */
  const clientTop = y;
  const clientHeight = model.client.email ? 94 : 78;
  pdf.box(MARGIN, clientTop, CONTENT_WIDTH, clientHeight, 1);
  drawBoxBorder(pdf, MARGIN, clientTop, CONTENT_WIDTH, clientHeight);
  const cx = MARGIN + 8;
  pdf.text(cx, clientTop + 17, 'Nombres:', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(cx + 46, clientTop + 17, truncate(model.client.name, 48), { size: 8 });
  pdf.text(398, clientTop + 17, `${ID_TYPE_LABELS[model.client.idType] ?? 'IDENTIFICACIÓN'}:`, { size: 7, font: 'Helvetica-Bold' });
  pdf.textRight(RIGHT - 8, clientTop + 17, model.client.idNumber, { size: 7.5, font: 'Courier' });

  pdf.text(cx, clientTop + 34, 'Dirección:', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(cx + 46, clientTop + 34, truncate(model.client.address || '—', 76), { size: 7.5 });

  pdf.text(cx, clientTop + 52, 'Fecha Emisión:', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(cx + 76, clientTop + 52, model.issueDate, { size: 7.5 });
  pdf.text(270, clientTop + 52, 'Vence:', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(306, clientTop + 52, model.dueDate ?? model.issueDate, { size: 7.5 });
  pdf.text(390, clientTop + 52, 'Teléfono:', { size: 7, font: 'Helvetica-Bold' });
  pdf.text(438, clientTop + 52, truncate(model.client.phone || '—', 18), { size: 7.5 });

  if (model.client.email) {
    pdf.text(cx, clientTop + 70, 'Correo:', { size: 7, font: 'Helvetica-Bold' });
    pdf.text(cx + 46, clientTop + 70, truncate(model.client.email, 74), { size: 7.5 });
  }
  y = clientTop + clientHeight + 10;

  /* --------------------------------------------------------------- detalle */
  const COL = { code: 36, desc: 102, unit: 318, qty: 358, price: 404, discount: 470, total: 505, right: RIGHT };
  const tableHeaderTop = y;
  pdf.box(MARGIN, tableHeaderTop, CONTENT_WIDTH, 16, 0.92);
  const headerY = tableHeaderTop + 11;
  pdf.text(COL.code + 3, headerY, 'Código', { size: 6.5, font: 'Helvetica-Bold' });
  pdf.text(COL.desc + 3, headerY, 'Descripción', { size: 6.5, font: 'Helvetica-Bold' });
  pdf.text(COL.unit + 3, headerY, 'Med.', { size: 6.5, font: 'Helvetica-Bold' });
  pdf.textRight(COL.qty + 42, headerY, 'Cantidad', { size: 6.5, font: 'Helvetica-Bold' });
  pdf.textRight(COL.price + 60, headerY, 'Precio Unitario', { size: 6.5, font: 'Helvetica-Bold' });
  pdf.textRight(COL.discount + 30, headerY, 'Dto.', { size: 6.5, font: 'Helvetica-Bold' });
  pdf.textRight(COL.right - 3, headerY, 'Total', { size: 6.5, font: 'Helvetica-Bold' });
  y += 16;

  for (const item of model.items) {
    if (y > pdf.height - PAGE_BOTTOM - 220) {
      pdf.addPage();
      y = 40;
    }
    pdf.hline(MARGIN, RIGHT, y + 4, 0.35);
    const rowY = y + 14;
    pdf.text(COL.code + 3, rowY, truncate(item.codigo, 14), { size: 6.8 });
    pdf.text(COL.desc + 3, rowY, truncate(item.descripcion, 44), { size: 6.8 });
    pdf.text(COL.unit + 3, rowY, truncate(item.unidad || 'Unidad', 10), { size: 6.5 });
    pdf.textRight(COL.qty + 42, rowY, trimNum(item.cantidad), { size: 6.8 });
    pdf.textRight(COL.price + 60, rowY, money6(item.precioUnitario), { size: 6.8 });
    pdf.textRight(COL.discount + 30, rowY, money2(item.descuento), { size: 6.8 });
    pdf.textRight(COL.right - 3, rowY, money2(item.subtotal), { size: 6.8, font: 'Helvetica-Bold' });
    y += 18;
  }
  pdf.hline(MARGIN, RIGHT, y + 4, 0.7);
  y += 10;
  pdf.vline(COL.code, tableHeaderTop, y + 4, 0.35);
  pdf.vline(COL.desc, tableHeaderTop, y + 4, 0.35);
  pdf.vline(COL.unit, tableHeaderTop, y + 4, 0.35);
  pdf.vline(COL.qty, tableHeaderTop, y + 4, 0.35);
  pdf.vline(COL.price, tableHeaderTop, y + 4, 0.35);
  pdf.vline(COL.discount, tableHeaderTop, y + 4, 0.35);
  pdf.vline(COL.total, tableHeaderTop, y + 4, 0.35);

  /* ---------------------------------------------------------------- totales */
  const taxBase5 = taxBase(model, (tax) => near(tax.tarifa, 0.05));
  const taxBase15 = taxBase(model, (tax) => near(tax.tarifa, 0.15));
  const taxBase0 = taxBase(model, (tax) => near(tax.tarifa, 0) && tax.codigoPorcentaje !== '6' && tax.codigoPorcentaje !== '7');
  const taxBaseNoObject = taxBase(model, (tax) => tax.codigoPorcentaje === '6');
  const taxBaseExempt = taxBase(model, (tax) => tax.codigoPorcentaje === '7');
  const taxValue5 = taxValue(model, (tax) => near(tax.tarifa, 0.05));
  const taxValue15 = taxValue(model, (tax) => near(tax.tarifa, 0.15));
  const ice = taxValue(model, (tax) => tax.codigo === '3');
  const grossSubtotal = model.subtotal + model.discount;

  const totalsX = 380;
  let ty = y + 8;
  const totalLine = (name: string, value: string, opts: { bold?: boolean; line?: boolean } = {}) => {
    if (opts.line) {
      pdf.hline(totalsX, RIGHT, ty - 8, 0.5);
    }
    pdf.text(totalsX, ty, name, { size: 7.5, font: opts.bold ? 'Helvetica-Bold' : 'Helvetica' });
    pdf.textRight(RIGHT - 4, ty, value, { size: 7.5, font: opts.bold ? 'Helvetica-Bold' : 'Helvetica' });
    ty += 13;
  };
  totalLine('Subtotal:', money2(grossSubtotal));
  totalLine('Descuento:', money2(model.discount));
  totalLine('Subtotal Neto:', money2(model.subtotal));
  totalLine('Subtotal 5%', money2(taxBase5));
  totalLine('Subtotal 15 %', money2(taxBase15));
  totalLine('Subtotal 0%:', money2(taxBase0));
  totalLine('Subtotal No Objeto IVA:', money2(taxBaseNoObject));
  totalLine('Subtotal Exento IVA :', money2(taxBaseExempt));
  totalLine('ICE:', money2(ice));
  totalLine('IVA 5%:', money2(taxValue5));
  totalLine('IVA 15 %', money2(taxValue15));
  totalLine('Propina:', money2(0));
  totalLine('VALOR TOTAL', money2(model.total), { bold: true, line: true });
  pdf.vline(totalsX - 8, y, ty - 6, 0.6);
  pdf.hline(totalsX - 8, RIGHT, y, 0.6);
  pdf.hline(totalsX - 8, RIGHT, ty - 6, 0.6);

  y = Math.max(y, ty) + 10;

  /* ------------------------------------------------------- pagos / extras */
  if (model.payments.length) {
    pdf.text(MARGIN, y, `FORMA DE PAGO: ${model.payments.map((payment) => `${payment.method} ${money2(payment.amount)}`).join('  ·  ')}`, {
      size: 7.5,
      font: 'Helvetica-Bold',
    });
    y += 14;
  }
  if (model.infoAdicional?.length) {
    pdf.text(MARGIN, y, 'INFORMACIÓN ADICIONAL', { size: 7.5, font: 'Helvetica-Bold' });
    y += 11;
    for (const info of model.infoAdicional.slice(0, 12)) {
      pdf.text(MARGIN, y, `${info.nombre}: ${truncate(info.valor, 100)}`, { size: 6.8 });
      y += 9;
    }
  }
  if (model.sriMessages?.length) {
    y += 4;
    pdf.text(MARGIN, y, 'MENSAJES DEL SRI', { size: 7.5, font: 'Helvetica-Bold' });
    y += 11;
    for (const message of model.sriMessages.slice(0, 8)) {
      pdf.text(MARGIN, y, truncate(`[${message.identificador ?? ''}] ${message.mensaje ?? ''}`, 125), { size: 6.2 });
      y += 8;
    }
  }

  /* ------------------------------------------------------------------ pie */
  const footerY = pdf.height - 48;
  pdf.hline(MARGIN, RIGHT, footerY - 12, 0.5);
  pdf.text(
    MARGIN,
    footerY,
    model.company.obligedAccounting
      ? 'Documento generado electrónicamente. Obligado a llevar contabilidad: SI.'
      : 'Documento generado electrónicamente. Obligado a llevar contabilidad: NO.',
    { size: 6.5 },
  );
  pdf.text(
    MARGIN,
    footerY + 9,
    'Consulte la validez de este comprobante en https://cel.sri.gob.ec con la clave de acceso.',
    { size: 6.2 },
  );

  return pdf.build();
}

/* --------------------------------------------------------------- utilidades */

function drawBoxBorder(pdf: SimplePdf, x: number, top: number, width: number, height: number): void {
  pdf.hline(x, x + width, top, 0.7);
  pdf.hline(x, x + width, top + height, 0.7);
  pdf.vline(x, top, top + height, 0.7);
  pdf.vline(x + width, top, top + height, 0.7);
}

function drawBarcode(pdf: SimplePdf, value: string, x: number, top: number, maxWidth: number, height: number): void {
  if (!value) return;
  let pattern: string;
  try {
    pattern = code128B(value);
  } catch {
    return;
  }
  const module = Math.min(0.42, maxWidth / pattern.length);
  const width = pattern.length * module;
  const start = x + (maxWidth - width) / 2;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '1') pdf.bar(start + index * module, top, module, height);
  }
  pdf.text(start, top + height + 8, value, { size: 5.2, font: 'Courier' });
}

function environmentShort(label: string): string {
  return String(label ?? '').split('—')[0]!.trim() || String(label ?? '');
}

function formatAuthDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function near(value: number, expected: number): boolean {
  return Math.abs(Number(value) - expected) < 0.00001;
}

function taxBase(model: RideModel, predicate: (tax: RideTaxTotal) => boolean): number {
  return model.taxTotals.filter(predicate).reduce((sum, tax) => sum + Number(tax.baseImponible || 0), 0);
}

function taxValue(model: RideModel, predicate: (tax: RideTaxTotal) => boolean): number {
  return model.taxTotals.filter(predicate).reduce((sum, tax) => sum + Number(tax.valor || 0), 0);
}

function truncate(value: string, max: number): string {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function trimNum(value: number): string {
  return String(Math.round(Number(value ?? 0) * 1e6) / 1e6);
}

function money6(value: number): string {
  return Number(value ?? 0).toFixed(6);
}
