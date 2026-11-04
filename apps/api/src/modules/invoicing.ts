/** Facturación electrónica: comprobantes, emisión SRI/UpConta, RIDE, notas y modos de facturación. */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildClaveAcceso,
  DOC_TYPES,
  FORMAS_DE_PAGO,
  PORCENTAJES_DE_IVA,
  SRI_ENDPOINTS,
  TIPOS_DE_COMPROBANTE,
  type DocTypeCode,
} from '../../../../packages/shared/src/index.ts';
import {
  buildFacturaXml,
  buildGuiaRemisionXml,
  buildNotaCreditoXml,
  buildNotaDebitoXml,
  buildRetencionXml,
  consultarAutorizacion,
  createMockSriClient,
  generarRideGuiaPdf,
  generarRidePdf,
  generarRideRetencionPdf,
  sendRecepcion,
  signXml,
  verifySignedXml,
  type FacturaInput,
  type GuiaRemisionInput,
  type NotaCreditoInput,
  type NotaDebitoInput,
  type RetencionInput,
  type TaxLine,
} from '../../../../packages/sri/src/index.ts';
import { ApiError, Router, bodyOf, pageParams, paginated, requireUser, str } from '../http.ts';
import { audit, auditList, camelAll, execute, nowIso, parseJson, queryAll, queryOne, transaction } from '../db.ts';
import { sendMail } from '../mailer.ts';
import { newId } from '../ids.ts';
import { getCompany, getEstablishments } from './company.ts';
import { ensureClient, ensureConsumidorFinal, findClient } from './clients.ts';
import { findProduct } from './catalog.ts';
import { applySaleMovements, assertStockForSale } from './inventory.ts';

const SEQUENCE_FIELD: Record<string, string> = {
  '01': 'seq_invoice',
  '02': 'seq_sales_note',
  '03': 'seq_invoice',
  '04': 'seq_credit_note',
  '05': 'seq_debit_note',
  '06': 'seq_waybill',
  '07': 'seq_retention',
  '11': 'seq_invoice',
};

/** Motivos de traslado del SRI (catálogo de la guía de remisión). */
const MOTIVOS_TRASLADO = [
  { id: '01', label: 'Compras' },
  { id: '02', label: 'Devolución de compras' },
  { id: '03', label: 'Ventas' },
  { id: '04', label: 'Devolución de ventas' },
  { id: '05', label: 'Traslado entre establecimientos de la misma empresa' },
  { id: '06', label: 'Consignación' },
  { id: '07', label: 'Transferencia de bienes muebles por fusión, escisión, donación' },
  { id: '08', label: 'Traslado de bienes para transformación' },
  { id: '09', label: 'Traslado por cobrar' },
  { id: '10', label: 'Otros' },
  { id: '11', label: 'Importación' },
  { id: '12', label: 'Exportación' },
];

const TIPOS_DOC_SUSTENTO = [
  { id: '01', label: 'Factura' },
  { id: '03', label: 'Liquidación de compra' },
  { id: '04', label: 'Nota de Crédito' },
  { id: '05', label: 'Nota de Débito' },
  { id: '07', label: 'Comprobante de Retención' },
];

const CODIGOS_SUSTENTO = [
  { id: '01', label: 'Factura de compra' },
  { id: '02', label: 'Factura de venta' },
  { id: '03', label: 'Liquidación de compra' },
  { id: '04', label: 'Nota de crédito' },
  { id: '05', label: 'Nota de débito' },
  { id: '07', label: 'Comprobante de retención' },
];

/** Retenciones de IVA (código 2): porcentaje del IVA del comprobante de sustento. */
const RETENCIONES_IVA = [
  { codigo: '2', codigoPorcentaje: '1', tarifa: 10, label: '10% del IVA' },
  { codigo: '2', codigoPorcentaje: '2', tarifa: 20, label: '20% del IVA' },
  { codigo: '2', codigoPorcentaje: '3', tarifa: 30, label: '30% del IVA' },
  { codigo: '2', codigoPorcentaje: '4', tarifa: 50, label: '50% del IVA' },
  { codigo: '2', codigoPorcentaje: '5', tarifa: 70, label: '70% del IVA' },
  { codigo: '2', codigoPorcentaje: '6', tarifa: 100, label: '100% del IVA' },
];

/**
 * Retenciones de renta más usadas (referencia). El SRI publica el catálogo completo
 * de códigos de porcentaje; la interfaz permite escribir un código de porcentaje
 * distinto cuando el caso lo requiera.
 */
const RETENCIONES_RENTA_SUGERIDAS = [
  { codigo: '1', codigoPorcentaje: '303', tarifa: 10, label: '303 · Honorarios y servicios profesionales (10%)' },
  { codigo: '1', codigoPorcentaje: '304', tarifa: 10, label: '304 · Comisiones (10%)' },
  { codigo: '1', codigoPorcentaje: '307', tarifa: 1, label: '307 · Arrendamiento mercantil (1%)' },
  { codigo: '1', codigoPorcentaje: '309', tarifa: 1, label: '309 · Publicidad y comunicación (1%)' },
  { codigo: '1', codigoPorcentaje: '312', tarifa: 1, label: '312 · Transporte privado de carga (1%)' },
  { codigo: '1', codigoPorcentaje: '314', tarifa: 1, label: '314 · Transferencia de bienes muebles (1%)' },
  { codigo: '1', codigoPorcentaje: '320', tarifa: 1, label: '320 · Seguros y reaseguros (1%)' },
  { codigo: '1', codigoPorcentaje: '332', tarifa: 2, label: '332 · Pagos locales (2%)' },
  { codigo: '1', codigoPorcentaje: '340', tarifa: 2, label: '340 · Otras retenciones (2%)' },
  { codigo: '6', codigoPorcentaje: '6', tarifa: 5, label: 'ISD · Salida de divisas (5%)' },
];

interface VoucherRow {
  id: string;
  doc_type: string;
  status: string;
  environment: number;
  establishment_id: string | null;
  establishment_code: string;
  emission_point_id: string | null;
  emission_point_code: string;
  sequential: string;
  access_key: string | null;
  authorization_number: string | null;
  authorization_date: string | null;
  issue_date: string;
  client_id: string | null;
  client_id_type: string | null;
  client_id_number: string | null;
  client_name: string | null;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  source: string;
  info_adicional: string;
  sri_messages: string;
  xml_signed: string | null;
  xml_authorized: string | null;
  related_voucher_id: string | null;
  reason: string | null;
  extra_json: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface VoucherItemRow {
  id: string;
  voucher_id: string;
  product_id: string | null;
  code: string;
  aux_code: string | null;
  description: string;
  quantity: number;
  unit_price_cents: number;
  discount_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  iva_code: string;
  taxes: string;
}

interface PaymentRow {
  id: string;
  voucher_id: string;
  method: string;
  amount_cents: number;
  term: number;
}

function voucherNumber(row: VoucherRow): string {
  return `${row.establishment_code}-${row.emission_point_code}-${row.sequential || '000000000'}`;
}

export function voucherDto(row: VoucherRow, includeChildren = true) {
  const items = includeChildren
    ? queryAll<VoucherItemRow>('SELECT * FROM voucher_items WHERE voucher_id = ? ORDER BY rowid ASC', [row.id])
    : [];
  const payments = includeChildren
    ? queryAll<PaymentRow>('SELECT * FROM voucher_payments WHERE voucher_id = ? ORDER BY rowid ASC', [row.id])
    : [];
  const related = row.related_voucher_id
    ? queryOne<VoucherRow>('SELECT * FROM vouchers WHERE id = ?', [row.related_voucher_id])
    : undefined;
  return {
    id: row.id,
    docType: row.doc_type as DocTypeCode,
    docTypeName: DOC_TYPES[row.doc_type as DocTypeCode]?.name ?? row.doc_type,
    status: row.status,
    environment: row.environment,
    number: voucherNumber(row),
    establishmentCode: row.establishment_code,
    emissionPointCode: row.emission_point_code,
    sequential: row.sequential,
    accessKey: row.access_key,
    hasAuthorizedXml: Boolean(row.xml_authorized),
    authorizationNumber: row.authorization_number,
    authorizationDate: row.authorization_date,
    issueDate: row.issue_date,
    clientId: row.client_id,
    clientName: row.client_name,
    clientIdType: row.client_id_type,
    clientIdNumber: row.client_id_number,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    source: row.source,
    infoAdicional: parseJson(row.info_adicional, [] as { nombre: string; valor: string }[]),
    sriMessages: parseJson(row.sri_messages, [] as { identificador?: string; mensaje?: string; tipo?: string; informacionAdicional?: string }[]),
    relatedVoucherId: row.related_voucher_id,
    relatedVoucherNumber: related ? voucherNumber(related) : null,
    reason: row.reason,
    extra: parseJson(row.extra_json, {} as Record<string, unknown>),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => ({
      id: item.id,
      productId: item.product_id,
      code: item.code,
      auxCode: item.aux_code,
      description: item.description,
      quantity: Number(item.quantity),
      unitPriceCents: item.unit_price_cents,
      discountCents: item.discount_cents,
      subtotalCents: item.subtotal_cents,
      taxCents: item.tax_cents,
      totalCents: item.total_cents,
      ivaCode: item.iva_code,
      taxes: parseJson(item.taxes, [] as TaxLine[]),
    })),
    payments: payments.map((payment) => ({
      method: payment.method,
      amountCents: payment.amount_cents,
      term: payment.term,
    })),
    movements: includeChildren ? auditList('vouchers', row.id) : [],
  };
}

function ivaRate(code: string): number {
  return PORCENTAJES_DE_IVA.find((iva) => iva.id === code)?.value ?? 0;
}

function ivaTarifaPercent(code: string): number {
  return Math.round(ivaRate(code) * 100);
}

/**
 * El SRI exige el código de 2 dígitos de la tabla de formas de pago, no el
 * nombre. La interfaz envía etiquetas amigables ("efectivo", "transferencia");
 * aquí se traducen antes de construir el XML.
 */
const SRI_PAYMENT_CODES: Record<string, string> = {
  efectivo: '01',
  cheque: '02',
  letra: '03',
  'letra de cambio': '03',
  'tarjeta de credito': '04',
  'tarjeta de crédito': '04',
  'tarjeta credito': '04',
  'tarjeta de debito': '05',
  'tarjeta de débito': '05',
  'tarjeta debito': '05',
  'dinero electronico': '06',
  'dinero electrónico': '06',
  'tarjeta prepago': '07',
  transferencia: '08',
  'transferencia bancaria': '08',
  compensacion: '09',
  'compensación de deudas': '09',
  'tarjeta regalo': '10',
  'cheque certificado': '11',
  'cheque de gerencia': '12',
  'cheque de viajero': '14',
  'carta de credito': '15',
  'carta de crédito': '15',
  otros: '20',
};

function sriPaymentCode(method: string): string {
  const text = String(method ?? '').trim();
  if (/^(0[1-9]|1[0-9]|2[0-1])$/.test(text)) return text;
  return SRI_PAYMENT_CODES[text.toLowerCase()] ?? '01';
}

/* ------------------------------------------------------------- numeración */

function reserveSequential(emissionPointId: string, docType: string, dateIso: string) {
  const field = SEQUENCE_FIELD[docType] ?? 'seq_invoice';
  const point = queryOne<Record<string, unknown>>('SELECT * FROM emission_points WHERE id = ?', [emissionPointId]);
  if (!point) throw ApiError.badRequest('Punto de emisión no encontrado');
  const establishment = queryOne<Record<string, unknown>>('SELECT * FROM establishments WHERE id = ?', [
    point.establishment_id,
  ]);
  if (!establishment) throw ApiError.badRequest('Establecimiento no encontrado');
  const company = getCompany();
  const sequential = Number(point[field] ?? 1) || 1;
  execute(`UPDATE emission_points SET ${field} = ? , updated_at = ? WHERE id = ?`, [sequential + 1, nowIso(), emissionPointId]);
  const accessKey = buildClaveAcceso({
    fechaEmision: new Date(dateIso),
    codDoc: docType,
    ruc: company.ruc,
    ambiente: company.environment === 2 ? '2' : '1',
    estab: String(establishment.code),
    ptoEmi: String(point.code),
    secuencial: sequential,
  });
  return {
    sequential: String(sequential).padStart(9, '0'),
    accessKey,
    establishmentCode: String(establishment.code),
    emissionPointCode: String(point.code),
    establishmentId: String(establishment.id),
    emissionPointId: String(point.id),
    environment: company.environment,
  };
}

/* -------------------------------------------------------- creación interno */

export interface VoucherItemInput {
  productId?: string;
  code?: string;
  auxCode?: string;
  description?: string;
  quantity: number;
  unitPriceCents?: number;
  discountCents?: number;
  ivaCode?: string;
}

export interface CreateVoucherInput {
  docType?: string;
  establishmentId?: string;
  emissionPointId?: string;
  clientId?: string;
  issueDate?: string;
  currency?: string;
  draft?: boolean;
  source?: string;
  items: VoucherItemInput[];
  payments?: { method: string; amountCents: number; term?: number }[];
  infoAdicional?: { nombre: string; valor: string }[];
  relatedVoucherId?: string | null;
  reason?: string | null;
  /** Datos específicos del comprobante (destinatarios de guía, docs de retención). */
  extra?: Record<string, unknown>;
}

export interface CreateVoucherResult {
  voucher: VoucherRow;
  changeCents: number;
  warnings: string[];
}

export async function createVoucher(input: CreateVoucherInput, userId: string | null): Promise<CreateVoucherResult> {
  const company = getCompany();
  const docType = input.docType ?? '01';
  if (!DOC_TYPES[docType as DocTypeCode]) throw ApiError.badRequest(`Tipo de comprobante inválido: ${docType}`);
  const isRetention = docType === '07';
  const isWaybill = docType === '06';
  if (!isRetention && (!input.items || input.items.length === 0)) {
    throw ApiError.badRequest('El comprobante debe tener al menos un ítem');
  }
  if (isRetention) {
    const docs = (input.extra?.docs ?? []) as Record<string, unknown>[];
    if (!Array.isArray(docs) || docs.length === 0) {
      throw ApiError.badRequest('El comprobante de retención requiere al menos un documento de sustento');
    }
  }
  if (isWaybill) {
    const destinatarios = (input.extra?.destinatarios ?? []) as Record<string, unknown>[];
    if (!Array.isArray(destinatarios) || destinatarios.length === 0) {
      throw ApiError.badRequest('La guía de remisión requiere al menos un destinatario');
    }
  }

  const establishments = getEstablishments();
  const establishment = input.establishmentId
    ? establishments.find((e) => e.id === input.establishmentId)
    : establishments[0];
  if (!establishment) throw ApiError.badRequest('No hay establecimientos configurados');
  const emissionPoint = input.emissionPointId
    ? establishment.emissionPoints.find((p) => p.id === input.emissionPointId)
    : establishment.emissionPoints[0];
  if (!emissionPoint) throw ApiError.badRequest('No hay puntos de emisión configurados en el establecimiento');

  const client = input.clientId ? findClient(input.clientId) : ensureConsumidorFinal();
  if (!client) throw ApiError.badRequest('Cliente no encontrado');

  const issueDate = input.issueDate ? new Date(input.issueDate) : new Date();
  if (Number.isNaN(issueDate.getTime())) throw ApiError.badRequest('Fecha de emisión inválida');

  // Construir líneas y calcular impuestos
  const lines = input.items.map((item) => {
    const product = item.productId ? findProduct(item.productId) : undefined;
    if (item.productId && !product) throw ApiError.badRequest(`Producto no encontrado: ${item.productId}`);
    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw ApiError.badRequest('La cantidad de cada ítem debe ser mayor a 0');
    const unitPrice = product
      ? product.price_cents
      : Math.round(Number(item.unitPriceCents ?? 0));
    if (unitPrice < 0) throw ApiError.badRequest('El precio unitario no puede ser negativo');
    const discount = Math.max(0, Math.round(Number(item.discountCents ?? 0)));
    const subtotal = Math.round(unitPrice * quantity) - discount;
    if (subtotal < 0) throw ApiError.badRequest('El descuento no puede superar el subtotal del ítem');
    const ivaCode = product ? product.iva_code : item.ivaCode ?? '4';
    const rate = ivaRate(ivaCode);
    const tax = Math.round(subtotal * rate);
    const taxes: TaxLine[] = [
      {
        codigo: '2',
        codigoPorcentaje: ivaCode,
        tarifa: ivaTarifaPercent(ivaCode),
        baseImponible: subtotal / 100,
        valor: tax / 100,
      },
    ];
    return {
      productId: product?.id ?? null,
      code: product ? product.code : str(item.code, 'items.code') || 'S/C',
      auxCode: product ? product.aux_code : str(item.auxCode, 'items.auxCode') || null,
      description: product ? product.description : str(item.description, 'items.description', { required: true }),
      quantity,
      unitPrice,
      discount,
      subtotal,
      tax,
      total: subtotal + tax,
      ivaCode,
      taxes,
    };
  });

  let subtotalCents = lines.reduce((sum, line) => sum + line.subtotal, 0);
  let discountCents = lines.reduce((sum, line) => sum + line.discount, 0);
  let taxCents = lines.reduce((sum, line) => sum + line.tax, 0);
  let totalCents = subtotalCents + taxCents;
  const extra: Record<string, unknown> = input.extra ?? {};

  if (isRetention) {
    const docs = (extra.docs ?? []) as Record<string, unknown>[];
    let retained = 0;
    for (const doc of docs) {
      const retenciones = (doc.retenciones ?? []) as Record<string, unknown>[];
      for (const retention of retenciones) retained += Math.round(Number(retention.valorRetenidoCents ?? 0));
    }
    if (retained <= 0) throw ApiError.badRequest('La retención debe tener valores retenidos mayores a cero');
    subtotalCents = retained;
    totalCents = retained;
    discountCents = 0;
    taxCents = 0;
  }
  if (isWaybill) {
    // La guía de remisión no tiene importes.
    subtotalCents = 0;
    discountCents = 0;
    taxCents = 0;
    totalCents = 0;
  }

  const draft = Boolean(input.draft);
  const isNote = docType === '04' || docType === '05';
  const isSpecial = isNote || isRetention || isWaybill;
  const payments = (isSpecial
    ? [{ method: 'efectivo', amountCents: totalCents, term: 0 }]
    : input.payments && input.payments.length
      ? input.payments
      : [{ method: 'efectivo', amountCents: totalCents, term: 0 }]
  ).map((payment) => ({
    method: str(payment.method, 'payments.method', { required: true }),
    amountCents: Math.round(Number(payment.amountCents ?? 0)),
    term: Math.round(Number(payment.term ?? 0)),
  }));
  const paid = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const isPointOfSale = input.source === 'pos' || input.source === 'quick';
  if (!draft && !isSpecial && paid < totalCents) throw ApiError.badRequest('La suma de los pagos es menor al total del comprobante');
  if (!draft && !isSpecial && !isPointOfSale && paid !== totalCents) {
    throw ApiError.badRequest('La suma de los pagos debe ser igual al total');
  }
  const changeCents = Math.max(0, paid - totalCents);

  const related = input.relatedVoucherId
    ? queryOne<VoucherRow>('SELECT * FROM vouchers WHERE id = ?', [input.relatedVoucherId])
    : undefined;
  if (input.relatedVoucherId && !related) throw ApiError.badRequest('Comprobante relacionado no encontrado');

  // Validar stock antes de reservar el secuencial y crear el comprobante:
  // un rechazo por inventario no debe consumir numeración ni dejar facturas emitidas.
  if (!draft && docType === '01') {
    assertStockForSale(
      lines
        .filter((line) => line.productId)
        .map((line) => ({ productId: String(line.productId), quantity: line.quantity })),
    );
  }

  const result = transaction(() => {
    const id = newId();
    const now = nowIso();
    let sequential = '';
    let accessKey: string | null = null;
    let establishmentCode = establishment.code;
    let emissionPointCode = emissionPoint.code;
    let environment = company.environment;
    if (!draft) {
      const reserved = reserveSequential(emissionPoint.id, docType, issueDate.toISOString());
      sequential = reserved.sequential;
      accessKey = reserved.accessKey;
      establishmentCode = reserved.establishmentCode;
      emissionPointCode = reserved.emissionPointCode;
      environment = reserved.environment;
    }
    execute(
      `INSERT INTO vouchers (id, doc_type, status, environment, establishment_id, establishment_code, emission_point_id,
        emission_point_code, sequential, access_key, issue_date, client_id, client_id_type, client_id_number, client_name,
        subtotal_cents, discount_cents, tax_cents, total_cents, currency, source, info_adicional, sri_messages,
        related_voucher_id, reason, extra_json, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        docType,
        draft ? 'draft' : 'sent',
        environment,
        establishment.id,
        establishmentCode,
        emissionPoint.id,
        emissionPointCode,
        sequential,
        accessKey,
        issueDate.toISOString(),
        client.id,
        client.id_type,
        client.id_number,
        client.name,
        subtotalCents,
        discountCents,
        taxCents,
        totalCents,
        input.currency ?? 'DOLAR',
        input.source ?? 'standard',
        JSON.stringify(input.infoAdicional ?? []),
        '[]',
        related?.id ?? null,
        input.reason ?? null,
        JSON.stringify(extra),
        userId,
        now,
        now,
      ],
    );
    for (const line of lines) {
      execute(
        `INSERT INTO voucher_items (id, voucher_id, product_id, code, aux_code, description, quantity, unit_price_cents,
          discount_cents, subtotal_cents, tax_cents, total_cents, iva_code, taxes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newId(),
          id,
          line.productId,
          line.code,
          line.auxCode,
          line.description,
          line.quantity,
          line.unitPrice,
          line.discount,
          line.subtotal,
          line.tax,
          line.total,
          line.ivaCode,
          JSON.stringify(line.taxes),
        ],
      );
    }
    for (const payment of payments) {
      execute('INSERT INTO voucher_payments (id, voucher_id, method, amount_cents, term) VALUES (?,?,?,?,?)', [
        newId(),
        id,
        payment.method,
        payment.amountCents,
        payment.term,
      ]);
    }
    audit('vouchers', id, 'created', draft ? 'Borrador creado' : 'Comprobante creado', userId);
    return id;
  });

  const row = queryOne<VoucherRow>('SELECT * FROM vouchers WHERE id = ?', [result])!;
  let finalRow = row;
  if (!draft) {
    finalRow = await emitVoucher(result, userId);
  }
  return { voucher: finalRow, changeCents, warnings: [] };
}

/* ------------------------------------------------------------------ emisión */

function buildXmlForVoucher(row: VoucherRow, items: VoucherItemRow[], payments: PaymentRow[]): string {
  const company = getCompany();
  const establishment = row.establishment_id
    ? queryOne<Record<string, unknown>>('SELECT * FROM establishments WHERE id = ?', [row.establishment_id])
    : undefined;
  const point = row.emission_point_id
    ? queryOne<Record<string, unknown>>('SELECT * FROM emission_points WHERE id = ?', [row.emission_point_id])
    : undefined;
  const client = row.client_id ? findClient(row.client_id) : undefined;
  const infoTributaria = {
    ambiente: (row.environment === 2 ? '2' : '1') as '1' | '2',
    tipoEmision: '1' as const,
    razonSocial: company.name,
    nombreComercial: company.trade_name,
    ruc: company.ruc,
    claveAcceso: row.access_key ?? '',
    codDoc: row.doc_type,
    estab: String(establishment?.code ?? row.establishment_code),
    ptoEmi: String(point?.code ?? row.emission_point_code),
    secuencial: row.sequential,
    dirMatriz: company.address ?? '',
    agenteRetencion: company.agent_retention,
    contribuyenteRimpe: company.rimpe,
  };
  const comprador = {
    tipoIdentificacion: row.client_id_type ?? '07',
    razonSocial: row.client_name ?? 'CONSUMIDOR FINAL',
    identificacion: row.client_id_number ?? '9999999999999',
    direccion: client?.address ?? null,
    email: client?.email ?? null,
  };
  const detalles = items.map((item) => ({
    codigoPrincipal: item.code,
    codigoAuxiliar: item.aux_code,
    descripcion: item.description,
    cantidad: Number(item.quantity),
    precioUnitario: item.unit_price_cents / 100,
    descuento: item.discount_cents / 100,
    subtotal: item.subtotal_cents / 100,
    impuestos: parseJson<TaxLine[]>(item.taxes, []),
  }));
  const infoAdicional = parseJson<{ nombre: string; valor: string }[]>(row.info_adicional, []);
  const pagos = payments.map((payment) => ({
    formaPago: sriPaymentCode(payment.method),
    total: payment.amount_cents / 100,
    plazo: payment.term || undefined,
  }));

  if (row.doc_type === '01') {
    const input: FacturaInput = {
      infoTributaria,
      infoFactura: {
        fechaEmision: formatFecha(row.issue_date),
        dirEstablecimiento: establishment?.address ? String(establishment.address) : company.address,
        obligadoContabilidad: company.obliged_accounting ? 'SI' : 'NO',
        comprador,
        totalSinImpuestos: row.subtotal_cents / 100,
        totalDescuento: row.discount_cents / 100,
        totalConImpuestos: buildTotalImpuestos(items),
        propina: 0,
        importeTotal: row.total_cents / 100,
        moneda: row.currency,
        pagos,
      },
      detalles,
      infoAdicional,
    };
    return buildFacturaXml(input);
  }

  const related = row.related_voucher_id
    ? queryOne<VoucherRow>('SELECT * FROM vouchers WHERE id = ?', [row.related_voucher_id])
    : undefined;
  if (row.doc_type === '04') {
    const input: NotaCreditoInput = {
      infoTributaria,
      infoNotaCredito: {
        fechaEmision: formatFecha(row.issue_date),
        dirEstablecimiento: establishment?.address ? String(establishment.address) : company.address,
        tipoIdentificacionComprador: comprador.tipoIdentificacion,
        razonSocialComprador: comprador.razonSocial,
        identificacionComprador: comprador.identificacion,
        obligadoContabilidad: company.obliged_accounting ? 'SI' : 'NO',
        codDocModificado: '01',
        numDocModificado: related ? voucherNumber(related) : '',
        fechaEmisionDocSustento: related ? formatFecha(related.issue_date) : formatFecha(row.issue_date),
        totalSinImpuestos: row.subtotal_cents / 100,
        valorModificacion: row.total_cents / 100,
        moneda: row.currency,
        totalConImpuestos: buildTotalImpuestos(items),
        motivo: row.reason ?? 'Nota de crédito',
      },
      detalles,
      infoAdicional,
    };
    return buildNotaCreditoXml(input);
  }
  if (row.doc_type === '05') {
    const input: NotaDebitoInput = {
      infoTributaria,
      infoNotaDebito: {
        fechaEmision: formatFecha(row.issue_date),
        dirEstablecimiento: establishment?.address ? String(establishment.address) : company.address,
        tipoIdentificacionComprador: comprador.tipoIdentificacion,
        razonSocialComprador: comprador.razonSocial,
        identificacionComprador: comprador.identificacion,
        obligadoContabilidad: company.obliged_accounting ? 'SI' : 'NO',
        codDocModificado: '01',
        numDocModificado: related ? voucherNumber(related) : '',
        fechaEmisionDocSustento: related ? formatFecha(related.issue_date) : formatFecha(row.issue_date),
        totalSinImpuestos: row.subtotal_cents / 100,
        impuestos: buildTotalImpuestos(items).map((tax) => ({
          codigo: tax.codigo,
          codigoPorcentaje: tax.codigoPorcentaje,
          tarifa: tax.tarifa,
          baseImponible: tax.baseImponible,
          valor: tax.valor,
        })),
        valorTotal: row.total_cents / 100,
        motivo: row.reason ?? 'Nota de débito',
      },
      infoAdicional,
    };
    return buildNotaDebitoXml(input);
  }
  if (row.doc_type === '06') {
    const extra = parseJson<Record<string, unknown>>(row.extra_json, {});
    const transportista = (extra.transportista ?? {}) as Record<string, unknown>;
    const destinatarios = (extra.destinatarios ?? []) as Record<string, unknown>[];
    const input: GuiaRemisionInput = {
      infoTributaria,
      infoGuiaRemision: {
        dirEstablecimiento: establishment?.address ? String(establishment.address) : company.address,
        dirPartida: String(extra.dirPartida ?? company.address ?? ''),
        razonSocialTransportista: String(transportista.razonSocial ?? company.name),
        tipoIdentificacionTransportista: String(transportista.tipoIdentificacion ?? '04'),
        rucTransportista: String(transportista.ruc ?? company.ruc),
        obligadoContabilidad: company.obliged_accounting ? 'SI' : 'NO',
        fechaIniTransporte: String(extra.fechaIniTransporte ?? formatFecha(row.issue_date)),
        fechaFinTransporte: String(extra.fechaFinTransporte ?? formatFecha(row.issue_date)),
        placa: String(transportista.placa ?? ''),
      },
      destinatarios: destinatarios.map((destinatario) => ({
        identificacionDestinatario: String(destinatario.identificacion ?? ''),
        razonSocialDestinatario: String(destinatario.razonSocial ?? ''),
        dirDestinatario: String(destinatario.direccion ?? ''),
        motivoTraslado: String(destinatario.motivoTraslado ?? ''),
        codDocSustento: destinatario.codDocSustento ? String(destinatario.codDocSustento) : null,
        numDocSustento: destinatario.numDocSustento ? String(destinatario.numDocSustento) : null,
        numAutDocSustento: destinatario.numAutDocSustento ? String(destinatario.numAutDocSustento) : null,
        fechaEmisionDocSustento: destinatario.fechaEmisionDocSustento
          ? String(destinatario.fechaEmisionDocSustento)
          : null,
        detalles: ((destinatario.items ?? []) as Record<string, unknown>[]).map((item) => ({
          codigoInterno: String(item.codigo ?? item.codigoInterno ?? ''),
          descripcion: String(item.descripcion ?? ''),
          cantidad: Number(item.cantidad ?? 1),
        })),
      })),
    };
    return buildGuiaRemisionXml(input);
  }
  if (row.doc_type === '07') {
    const extra = parseJson<Record<string, unknown>>(row.extra_json, {});
    const sujeto = (extra.sujeto ?? {}) as Record<string, unknown>;
    const docs = (extra.docs ?? []) as Record<string, unknown>[];
    const input: RetencionInput = {
      infoTributaria,
      infoCompRetencion: {
        fechaEmision: formatFecha(row.issue_date),
        dirEstablecimiento: establishment?.address ? String(establishment.address) : company.address,
        obligadoContabilidad: company.obliged_accounting ? 'SI' : 'NO',
        tipoIdentificacionSujetoRetenido: String(sujeto.tipoIdentificacion ?? row.client_id_type ?? '04'),
        razonSocialSujetoRetenido: String(sujeto.razonSocial ?? row.client_name ?? ''),
        identificacionSujetoRetenido: String(sujeto.identificacion ?? row.client_id_number ?? ''),
        periodoFiscal: String(extra.periodoFiscal ?? ''),
      },
      docsSustento: docs.map((doc) => ({
        codSustento: String(doc.codSustento ?? '01'),
        codDocSustento: String(doc.codDocSustento ?? '01'),
        numDocSustento: String(doc.numDocSustento ?? ''),
        fechaEmisionDocSustento: String(doc.fechaEmisionDocSustento ?? formatFecha(row.issue_date)),
        numAutDocSustento: String(doc.numAutDocSustento ?? ''),
        pagoLocExt: String(doc.pagoLocExt ?? '01'),
        totalSinImpuestos: Number(doc.totalSinImpuestosCents ?? 0) / 100,
        importeTotal: Number(doc.importeTotalCents ?? 0) / 100,
        impuestosDocSustento: ((doc.impuestos ?? []) as Record<string, unknown>[]).map((impuesto) => ({
          codImpuestoDocSustento: String(impuesto.codImpuestoDocSustento ?? '2'),
          codigoPorcentaje: String(impuesto.codigoPorcentaje ?? '4'),
          baseImponible: Number(impuesto.baseImponibleCents ?? 0) / 100,
          tarifa: Number(impuesto.tarifa ?? 0),
          valorImpuesto: Number(impuesto.valorImpuestoCents ?? 0) / 100,
        })),
        retenciones: ((doc.retenciones ?? []) as Record<string, unknown>[]).map((retencion) => ({
          codigo: String(retencion.codigo ?? '1'),
          codigoPorcentaje: String(retencion.codigoPorcentaje ?? ''),
          tarifa: Number(retencion.tarifa ?? 0),
          baseImponible: Number(retencion.baseImponibleCents ?? 0) / 100,
          valorRetenido: Number(retencion.valorRetenidoCents ?? 0) / 100,
        })),
      })),
    };
    return buildRetencionXml(input);
  }
  throw ApiError.badRequest(`Tipo de comprobante no soportado para XML: ${row.doc_type}`);
}

function buildTotalImpuestos(items: VoucherItemRow[]): TaxLine[] {
  const grouped = new Map<string, TaxLine>();
  for (const item of items) {
    for (const tax of parseJson<TaxLine[]>(item.taxes, [])) {
      const key = `${tax.codigo}|${tax.codigoPorcentaje}`;
      const current = grouped.get(key);
      if (current) {
        current.baseImponible = Number((current.baseImponible + tax.baseImponible).toFixed(2));
        current.valor = Number((current.valor + tax.valor).toFixed(2));
      } else {
        grouped.set(key, { ...tax });
      }
    }
  }
  return [...grouped.values()];
}

function formatFecha(iso: string): string {
  const date = new Date(iso);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

interface EmissionOutcome {
  status: string;
  authorizationNumber?: string | null;
  authorizationDate?: string | null;
  xmlSigned: string | null;
  /** XML devuelto por el SRI ya autorizado (contiene la firma y la autorización). */
  authorizedXml?: string | null;
  messages: { identificador?: string; mensaje?: string; tipo?: string; informacionAdicional?: string }[];
  signatureVerified?: boolean;
}

/** Registra la interacción con el SRI para auditoría y soporte. */
function logSriTransaction(
  voucherId: string,
  stage: string,
  environment: number,
  httpStatus: number | undefined,
  responseXml: string | undefined,
  error: string | undefined,
  requestSummary?: string,
): void {
  execute(
    `INSERT INTO sri_transactions (id, voucher_id, stage, environment, http_status, request_summary, response_xml, error, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      newId(),
      voucherId,
      stage,
      environment,
      httpStatus ?? null,
      requestSummary ?? null,
      responseXml ?? null,
      error ?? null,
      nowIso(),
    ],
  );
}

async function emitToSri(row: VoucherRow, xml: string): Promise<EmissionOutcome> {
  const company = getCompany();
  const mode = company.sri_mode;
  if (mode === 'mock') {
    const mock = createMockSriClient();
    const reception = mock.sendRecepcion(xml);
    if (reception.estado !== 'RECIBIDA') {
      return {
        status: 'failed',
        xmlSigned: xml,
        messages: reception.comprobantes[0]?.mensajes ?? [],
        signatureVerified: false,
      };
    }
    const authorization = mock.consultarAutorizacion(row.access_key ?? '');
    if (authorization.estado === 'AUTORIZADO') {
      return {
        status: 'issued',
        authorizationNumber: authorization.numeroAutorizacion ?? null,
        authorizationDate: authorization.fechaAutorizacion ?? nowIso(),
        xmlSigned: xml,
        authorizedXml: xml,
        messages: [],
        signatureVerified: false,
      };
    }
    return { status: 'failed', xmlSigned: xml, messages: authorization.mensajes, signatureVerified: false };
  }

  if (mode === 'direct-sri') {
    if (!/^\d{13}$/.test(company.ruc)) {
      throw ApiError.badRequest('El RUC de la empresa debe tener 13 dígitos numéricos para emitir al SRI');
    }
    if (!company.certificate_path) throw ApiError.badRequest('No hay certificado configurado para el modo direct-sri');
    const certPath = path.join(company.certificate_path, 'certificate.pem');
    const keyPath = path.join(company.certificate_path, 'private-key.pem');
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      throw ApiError.badRequest('No se encontraron los archivos PEM del certificado');
    }
    const digestAlgorithm = company.signature_digest === 'sha256' ? 'sha256' : 'sha1';
    const signed = signXml(xml, {
      certificatePem: fs.readFileSync(certPath, 'utf8'),
      privateKeyPem: fs.readFileSync(keyPath, 'utf8'),
      digestAlgorithm,
    });
    // Guardarraíl: nunca enviar al SRI un XML cuya firma no se valide localmente.
    const verification = verifySignedXml(signed.xml);
    if (!verification.valid) {
      execute('UPDATE vouchers SET xml_signed = ?, updated_at = ? WHERE id = ?', [signed.xml, nowIso(), row.id]);
      logSriTransaction(row.id, 'local-verification', row.environment, undefined, undefined, verification.details.join('; '));
      return {
        status: 'failed',
        xmlSigned: signed.xml,
        messages: [
          {
            identificador: 'LOCAL',
            mensaje: 'La firma electrónica generada no superó la verificación local; no se envió al SRI',
            tipo: 'ERROR',
            informacionAdicional: verification.details.join('; '),
          },
        ],
        signatureVerified: false,
      };
    }
    const ambiente = row.environment === 2 ? 2 : 1;
    const reception = await sendRecepcion(signed.xml, ambiente);
    logSriTransaction(
      row.id,
      'recepcion',
      ambiente,
      reception.httpStatus,
      reception.rawResponse ?? reception.comprobantes.map((c) => c.mensajes.map((m) => `[${m.identificador}] ${m.mensaje}`).join(' | ')).join(' || '),
      reception.error,
      `POST ${SRI_ENDPOINTS[ambiente].recepcion}`,
    );
    if (reception.estado === 'DEVUELTA') {
      return {
        status: 'failed',
        xmlSigned: signed.xml,
        messages: reception.comprobantes[0]?.mensajes ?? [],
        signatureVerified: true,
      };
    }
    if (reception.estado === 'ERROR') {
      return {
        status: 'offline',
        xmlSigned: signed.xml,
        messages: [{ mensaje: reception.error ?? 'SRI no disponible', tipo: 'ERROR' }],
        signatureVerified: true,
      };
    }
    let authorization = await consultarAutorizacion(row.access_key ?? '', ambiente);
    for (let attempt = 0; attempt < 3 && authorization.estado === 'PENDIENTE'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      authorization = await consultarAutorizacion(row.access_key ?? '', ambiente);
    }
    logSriTransaction(
      row.id,
      'autorizacion',
      ambiente,
      authorization.httpStatus,
      authorization.rawResponse ?? authorization.mensajes.map((m) => `[${m.identificador}] ${m.mensaje}`).join(' | '),
      authorization.error,
      `POST ${SRI_ENDPOINTS[ambiente].autorizacion} · clave ${row.access_key}`,
    );
    if (authorization.estado === 'AUTORIZADO') {
      return {
        status: 'issued',
        authorizationNumber: authorization.numeroAutorizacion ?? null,
        authorizationDate: authorization.fechaAutorizacion ?? nowIso(),
        xmlSigned: signed.xml,
        authorizedXml: authorization.comprobanteXml ?? signed.xml,
        messages: [],
        signatureVerified: true,
      };
    }
    if (authorization.estado === 'PENDIENTE') {
      return { status: 'sent', xmlSigned: signed.xml, messages: [], signatureVerified: true };
    }
    return {
      status: authorization.estado === 'ERROR' ? 'offline' : 'failed',
      xmlSigned: signed.xml,
      messages: authorization.mensajes,
      signatureVerified: true,
    };
  }

  // upconta
  const baseUrl = (company.upconta_base_url ?? 'https://api.upconta.com').replace(/\/$/, '');
  const token = company.upconta_token;
  if (!token) throw ApiError.badRequest('No hay token de integración de UpConta configurado');
  const items = queryAll<VoucherItemRow>('SELECT * FROM voucher_items WHERE voucher_id = ?', [row.id]);
  const payments = queryAll<PaymentRow>('SELECT * FROM voucher_payments WHERE voucher_id = ?', [row.id]);
  const body = {
    client: row.client_id,
    infoTributaria: { estab: company.upconta_estab ?? row.establishment_code, ptoEmi: company.upconta_pto_emi ?? row.emission_point_code },
    detalles: items.map((item) => ({
      product: item.product_id,
      codigoPrincipal: item.code,
      descripcion: item.description,
      cantidad: Number(item.quantity),
      precioUnitario: item.unit_price_cents / 100,
      descuentoInicial: item.discount_cents / 100,
    })),
    pagos: payments.map((payment) => ({ formaPago: payment.method, total: payment.amount_cents / 100 })),
  };
  try {
    const response = await fetch(`${baseUrl}/v3/administrative/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { message: text };
    }
    if (!response.ok) {
      return {
        status: 'failed',
        xmlSigned: xml,
        messages: [{ mensaje: String(data.message ?? `HTTP ${response.status}`), tipo: 'ERROR' }],
      };
    }
    const infoTributaria = (data.infoTributaria ?? {}) as Record<string, unknown>;
    return {
      status: String(data.status ?? 'issued') === 'issued' ? 'issued' : 'sent',
      authorizationNumber: data.authorizationNumber ? String(data.authorizationNumber) : null,
      authorizationDate: data.authorizationDate ? String(data.authorizationDate) : null,
      xmlSigned: xml,
      messages: [],
    };
  } catch (error) {
    return {
      status: 'offline',
      xmlSigned: xml,
      messages: [{ mensaje: error instanceof Error ? error.message : 'Error de conexión con UpConta', tipo: 'ERROR' }],
    };
  }
}

/** Emite un comprobante (mock, SRI directo o UpConta) y actualiza stock al autorizar. */
export async function emitVoucher(voucherId: string, userId: string | null): Promise<VoucherRow> {
  let row = queryOne<VoucherRow>('SELECT * FROM vouchers WHERE id = ?', [voucherId]);
  if (!row) throw ApiError.notFound('Comprobante no encontrado');
  if (['issued', 'canceled'].includes(row.status)) {
    throw ApiError.badRequest(`El comprobante ya está ${row.status === 'issued' ? 'autorizado' : 'anulado'}`);
  }
  if (!row.access_key || !row.sequential) {
    throw ApiError.badRequest('El comprobante no tiene secuencial/clave de acceso asignados');
  }
  const items = queryAll<VoucherItemRow>('SELECT * FROM voucher_items WHERE voucher_id = ?', [voucherId]);
  const payments = queryAll<PaymentRow>('SELECT * FROM voucher_payments WHERE voucher_id = ?', [voucherId]);
  const company = getCompany();

  void company;
  let xml: string;
  try {
    xml = buildXmlForVoucher(row, items, payments);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw ApiError.badRequest(`No se pudo generar el XML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const outcome = await emitToSri(row, xml);
  const authorizedXml = outcome.status === 'issued' ? outcome.authorizedXml ?? outcome.xmlSigned : null;
  execute(
    'UPDATE vouchers SET status=?, authorization_number=?, authorization_date=?, xml_signed=?, xml_authorized=?, sri_messages=?, updated_at=? WHERE id=?',
    [
      outcome.status,
      outcome.authorizationNumber ?? null,
      outcome.authorizationDate ?? null,
      outcome.xmlSigned,
      authorizedXml,
      JSON.stringify(outcome.messages ?? []),
      nowIso(),
      row.id,
    ],
  );
  audit(
    'vouchers',
    row.id,
    outcome.status === 'issued' ? 'authorized' : outcome.status,
    `Emisión: ${outcome.status}` +
      (outcome.signatureVerified === true ? ' · firma verificada localmente' : '') +
      (outcome.signatureVerified === false && outcome.status === 'failed' ? ' · firma NO verificada' : ''),
    userId,
  );
  if (outcome.status === 'issued' && row.doc_type === '01') {
    const saleItems = items
      .filter((item) => item.product_id)
      .map((item) => ({ productId: String(item.product_id), quantity: Number(item.quantity) }));
    if (saleItems.length) applySaleMovements(row.id, row.access_key ?? row.id, row.issue_date, saleItems, userId);
  }
  return queryOne<VoucherRow>('SELECT * FROM vouchers WHERE id = ?', [row.id])!;
}

/* ---------------------------------------------------------------- rutas */

function getVoucherOrThrow(id: string): VoucherRow {
  const row = queryOne<VoucherRow>('SELECT * FROM vouchers WHERE id = ?', [id]);
  if (!row) throw ApiError.notFound('Comprobante no encontrado');
  return row;
}

function docTypeOptions() {
  return TIPOS_DE_COMPROBANTE.filter((doc) => DOC_TYPES[doc.id as DocTypeCode]);
}

/** Listado paginado de comprobantes filtrado por tipo de documento. */
function listVouchersByDocType(ctx: Parameters<typeof requireUser>[0], docType: string) {
  const { page, limit, offset } = pageParams(ctx.query);
  const where: string[] = ['doc_type = ?'];
  const params: unknown[] = [docType];
  const status = ctx.query.get('status') ?? '';
  const q = (ctx.query.get('q') ?? '').trim();
  const from = ctx.query.get('from') ?? '';
  const to = ctx.query.get('to') ?? '';
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (from) {
    where.push('issue_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('issue_date <= ?');
    params.push(to);
  }
  if (q) {
    where.push('(client_name LIKE ? OR access_key LIKE ? OR sequential LIKE ? OR authorization_number LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM vouchers ${clause}`, params)?.total ?? 0;
  const rows = queryAll<VoucherRow>(`SELECT * FROM vouchers ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  return paginated(rows.map((row) => voucherDto(row, false)), total, page, limit);
}

export function registerInvoicingRoutes(router: Router): void {
  router.get('/api/vouchers/options', 'invoicing:read', () => {
    const establishments = getEstablishments();
    const clients = queryAll<Record<string, unknown>>(
      "SELECT id, id_type, id_number, name FROM clients WHERE status = 'active' ORDER BY name ASC LIMIT 500",
    );
    const products = queryAll<Record<string, unknown>>(
      "SELECT id, type, code, description, price_cents, iva_code, track_stock FROM products WHERE status = 'active' ORDER BY description ASC LIMIT 500",
    );
    return {
      establishments,
      clients: clients.map((row) => ({
        id: String(row.id),
        idType: String(row.id_type),
        idNumber: String(row.id_number),
        name: String(row.name),
      })),
      products: products.map((row) => ({
        id: String(row.id),
        type: String(row.type),
        code: String(row.code),
        description: String(row.description),
        priceCents: Number(row.price_cents ?? 0),
        ivaCode: String(row.iva_code ?? '4'),
        trackStock: Boolean(row.track_stock),
      })),
      docTypes: docTypeOptions(),
      paymentMethods: FORMAS_DE_PAGO,
      iva: PORCENTAJES_DE_IVA,
    };
  });

  router.get('/api/vouchers', 'invoicing:read', (ctx) => {
    const { page, limit, offset } = pageParams(ctx.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const docType = ctx.query.get('docType') ?? '';
    const status = ctx.query.get('status') ?? '';
    const q = (ctx.query.get('q') ?? '').trim();
    const from = ctx.query.get('from') ?? '';
    const to = ctx.query.get('to') ?? '';
    const clientId = ctx.query.get('clientId') ?? '';
    if (docType) {
      where.push('doc_type = ?');
      params.push(docType);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (clientId) {
      where.push('client_id = ?');
      params.push(clientId);
    }
    if (from) {
      where.push('issue_date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('issue_date <= ?');
      params.push(to);
    }
    if (q) {
      where.push('(client_name LIKE ? OR access_key LIKE ? OR sequential LIKE ? OR authorization_number LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM vouchers ${clause}`, params)?.total ?? 0;
    const rows = queryAll<VoucherRow>(`SELECT * FROM vouchers ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    return paginated(rows.map((row) => voucherDto(row, false)), total, page, limit);
  });

  router.get('/api/vouchers/:id', 'invoicing:read', (ctx) => voucherDto(getVoucherOrThrow(ctx.params.id)));

  router.post('/api/vouchers', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const created = await createVoucher(normalizeCreateInput(body), auth.id);
    return voucherDto(created.voucher);
  });

  router.post('/api/vouchers/:id/emit', 'invoicing:send', async (ctx) => {
    const auth = requireUser(ctx);
    return voucherDto(await emitVoucher(ctx.params.id, auth.id));
  });

  router.post('/api/vouchers/:id/retry', 'invoicing:send', async (ctx) => {
    const auth = requireUser(ctx);
    return voucherDto(await emitVoucher(ctx.params.id, auth.id));
  });

  router.post('/api/vouchers/:id/cancel', 'invoicing:send', (ctx) => {
    const auth = requireUser(ctx);
    const row = getVoucherOrThrow(ctx.params.id);
    if (row.status === 'canceled') throw ApiError.badRequest('El comprobante ya está anulado');
    execute("UPDATE vouchers SET status = 'canceled', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    audit('vouchers', row.id, 'canceled', `Anulado por ${auth.name}`, auth.id);
    return voucherDto(getVoucherOrThrow(row.id));
  });

  router.delete('/api/vouchers/:id', 'invoicing:create', (ctx) => {
    const row = getVoucherOrThrow(ctx.params.id);
    if (!['draft', 'failed', 'offline'].includes(row.status)) {
      throw ApiError.badRequest('Solo se pueden eliminar comprobantes en borrador o rechazados');
    }
    execute('DELETE FROM voucher_payments WHERE voucher_id = ?', [row.id]);
    execute('DELETE FROM voucher_items WHERE voucher_id = ?', [row.id]);
    execute('DELETE FROM vouchers WHERE id = ?', [row.id]);
    return { message: 'Comprobante eliminado' };
  });

  router.get('/api/vouchers/:id/xml', 'invoicing:read', (ctx) => {
    const row = getVoucherOrThrow(ctx.params.id);
    const requestedType = ctx.query.get('type') ?? '';
    const useSigned = requestedType === 'signed' || !row.xml_authorized;
    const content = useSigned ? row.xml_signed : row.xml_authorized;
    if (!content) throw ApiError.badRequest('El comprobante aún no tiene XML generado');
    const suffix = useSigned ? 'firmado' : 'autorizado';
    return {
      __file: Buffer.from(content, 'utf8'),
      contentType: 'application/xml; charset=utf-8',
      filename: `${row.access_key ?? row.id}-${suffix}.xml`,
    };
  });

  /** Verificación local de la firma del XML guardado (soporte/diagnóstico). */
  router.get('/api/vouchers/:id/signature-check', 'invoicing:read', (ctx) => {
    const row = getVoucherOrThrow(ctx.params.id);
    if (!row.xml_signed) throw ApiError.badRequest('El comprobante no tiene XML firmado');
    const verification = verifySignedXml(row.xml_signed);
    return {
      voucherId: row.id,
      status: row.status,
      digestAlgorithm: verification.digestAlgorithm,
      valid: verification.valid,
      signatureValid: verification.signatureValid,
      documentDigestValid: verification.documentDigestValid,
      signedPropertiesDigestValid: verification.signedPropertiesDigestValid,
      subject: verification.subject,
      details: verification.details,
    };
  });

  /** Consulta manual de autorización al SRI (para estados `sent` u `offline`). */
  router.post('/api/vouchers/:id/check-authorization', 'invoicing:send', async (ctx) => {
    const auth = requireUser(ctx);
    const row = getVoucherOrThrow(ctx.params.id);
    const company = getCompany();
    if (company.sri_mode !== 'direct-sri') {
      throw ApiError.badRequest('La consulta de autorización requiere el modo direct-sri');
    }
    if (!row.access_key) throw ApiError.badRequest('El comprobante no tiene clave de acceso');
    if (row.status === 'issued') return voucherDto(row);
    const ambiente = row.environment === 2 ? 2 : 1;
    let result = await consultarAutorizacion(row.access_key, ambiente);
    for (let attempt = 0; attempt < 2 && result.estado === 'PENDIENTE'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      result = await consultarAutorizacion(row.access_key, ambiente);
    }
    logSriTransaction(
      row.id,
      'consulta-autorizacion',
      ambiente,
      result.httpStatus,
      result.rawResponse ?? result.mensajes.map((m) => `[${m.identificador}] ${m.mensaje}`).join(' | '),
      result.error,
      `POST ${SRI_ENDPOINTS[ambiente].autorizacion} · clave ${row.access_key}`,
    );
    if (result.estado === 'AUTORIZADO') {
      execute(
        "UPDATE vouchers SET status='issued', authorization_number=?, authorization_date=?, xml_authorized=?, sri_messages=?, updated_at=? WHERE id=?",
        [
          result.numeroAutorizacion ?? null,
          result.fechaAutorizacion ?? nowIso(),
          result.comprobanteXml ?? row.xml_signed,
          '[]',
          nowIso(),
          row.id,
        ],
      );
      audit('vouchers', row.id, 'authorized', `Autorización confirmada por ${auth.name}`, auth.id);
      if (row.doc_type === '01' && row.status !== 'issued') {
        // El stock ya se descontó si la emisión había quedado en `sent`; no se repite.
      }
    } else if (result.estado === 'NO AUTORIZADO') {
      execute("UPDATE vouchers SET status='failed', sri_messages=?, updated_at=? WHERE id=?", [
        JSON.stringify(result.mensajes ?? []),
        nowIso(),
        row.id,
      ]);
      audit('vouchers', row.id, 'failed', `Rechazo del SRI al consultar autorización (${auth.name})`, auth.id);
    } else if (result.estado === 'ERROR' && row.status !== 'issued') {
      execute("UPDATE vouchers SET status='offline', sri_messages=?, updated_at=? WHERE id=?", [
        JSON.stringify([{ identificador: 'RED', mensaje: result.error ?? 'No se pudo consultar el SRI', tipo: 'ERROR' }]),
        nowIso(),
        row.id,
      ]);
    }
    return voucherDto(getVoucherOrThrow(row.id));
  });

  /** Bitácora de las interacciones con el SRI (SOAP crudo). */
  router.get('/api/vouchers/:id/sri-logs', 'invoicing:read', (ctx) => {
    const row = getVoucherOrThrow(ctx.params.id);
    const logs = queryAll<Record<string, unknown>>(
      'SELECT id, stage, environment, http_status, request_summary, response_xml, error, created_at FROM sri_transactions WHERE voucher_id = ? ORDER BY created_at ASC',
      [row.id],
    );
    return logs.map((log) => ({
      id: String(log.id),
      stage: String(log.stage),
      environment: Number(log.environment),
      httpStatus: log.http_status === null ? null : Number(log.http_status),
      requestSummary: log.request_summary ? String(log.request_summary) : null,
      responseXml: log.response_xml ? String(log.response_xml) : null,
      error: log.error ? String(log.error) : null,
      createdAt: String(log.created_at),
    }));
  });

  router.get('/api/vouchers/:id/pdf', 'invoicing:read', (ctx) => {
    const row = getVoucherOrThrow(ctx.params.id);
    return {
      __file: buildRideBuffer(row),
      contentType: 'application/pdf',
      filename: `RIDE-${voucherNumber(row)}.pdf`,
    };
  });

  router.post('/api/vouchers/:id/email', 'invoicing:read', async (ctx) => {
    const auth = requireUser(ctx);
    const row = getVoucherOrThrow(ctx.params.id);
    const client = row.client_id ? findClient(row.client_id) : undefined;
    const company = getCompany();
    if (!client?.email) {
      return { sent: false, to: null, reason: 'El cliente no tiene correo electrónico registrado.' };
    }
    if (row.status !== 'issued') {
      return { sent: false, to: client.email, reason: 'Solo se envían comprobantes autorizados por el SRI.' };
    }
    const number = voucherNumber(row);
    const xml = row.xml_authorized || row.xml_signed || '';
    const subject = `Factura electrónica ${number} - ${company.name}`;
    const text = [
      `Estimado/a ${client.name},`,
      '',
      `Adjuntamos la factura electrónica ${number}, autorizada por el SRI.`,
      `Total: USD ${(row.total_cents / 100).toFixed(2)}`,
      `Clave de acceso / autorización: ${row.authorization_number ?? row.access_key ?? ''}`,
      '',
      `Emisor: ${company.name} · RUC ${company.ruc}`,
      '',
      'Este mensaje fue generado automáticamente por el sistema de facturación.',
    ].join('\r\n');
    try {
      await sendMail({
        to: client.email,
        subject,
        text,
        attachments: [
          { filename: `${number}.pdf`, contentType: 'application/pdf', content: buildRideBuffer(row) },
          ...(xml
            ? [{ filename: `${number}.xml`, contentType: 'application/xml', content: Buffer.from(xml, 'utf8') }]
            : []),
        ],
      });
      audit('vouchers', row.id, 'email', `Factura enviada a ${client.email}`, auth.id);
      return { sent: true, to: client.email, subject };
    } catch (error) {
      return {
        sent: false,
        to: client.email,
        reason: `No se pudo enviar: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  router.post('/api/vouchers/:id/credit-note', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const original = getVoucherOrThrow(ctx.params.id);
    if (original.doc_type !== '01') throw ApiError.badRequest('Solo se pueden emitir notas de crédito sobre facturas');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const items = (Array.isArray(body.items) && body.items.length
      ? (body.items as Record<string, unknown>[])
      : queryAll<VoucherItemRow>('SELECT * FROM voucher_items WHERE voucher_id = ?', [original.id]).map((item) => ({
          productId: item.product_id,
          quantity: Number(item.quantity),
          unitPriceCents: item.unit_price_cents,
          discountCents: item.discount_cents,
          code: item.code,
          description: item.description,
          ivaCode: item.iva_code,
        }))) as Record<string, unknown>[];
    const result = await createVoucher(
      {
        docType: '04',
        establishmentId: original.establishment_id ?? undefined,
        emissionPointId: original.emission_point_id ?? undefined,
        clientId: original.client_id ?? undefined,
        items: items.map((item) => ({
          productId: item.productId ? String(item.productId) : undefined,
          code: item.code ? String(item.code) : undefined,
          description: item.description ? String(item.description) : undefined,
          quantity: Number(item.quantity ?? 1),
          unitPriceCents: item.unitPriceCents !== undefined ? Number(item.unitPriceCents) : undefined,
          discountCents: item.discountCents !== undefined ? Number(item.discountCents) : undefined,
          ivaCode: item.ivaCode ? String(item.ivaCode) : undefined,
        })),
        payments: [{ method: 'efectivo', amountCents: 0 }],
        relatedVoucherId: original.id,
        reason: str(body.reason, 'reason') || 'Nota de crédito',
        source: 'credit-note',
      },
      auth.id,
    );
    return voucherDto(result.voucher);
  });

  router.post('/api/vouchers/:id/debit-note', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const original = getVoucherOrThrow(ctx.params.id);
    if (original.doc_type !== '01') throw ApiError.badRequest('Solo se pueden emitir notas de débito sobre facturas');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    if (!items.length) throw ApiError.badRequest('La nota de débito requiere ítems');
    const result = await createVoucher(
      {
        docType: '05',
        establishmentId: original.establishment_id ?? undefined,
        emissionPointId: original.emission_point_id ?? undefined,
        clientId: original.client_id ?? undefined,
        items: items.map((item) => ({
          productId: item.productId ? String(item.productId) : undefined,
          code: item.code ? String(item.code) : undefined,
          description: item.description ? String(item.description) : undefined,
          quantity: Number(item.quantity ?? 1),
          unitPriceCents: item.unitPriceCents !== undefined ? Number(item.unitPriceCents) : undefined,
          discountCents: item.discountCents !== undefined ? Number(item.discountCents) : undefined,
          ivaCode: item.ivaCode ? String(item.ivaCode) : undefined,
        })),
        payments: [{ method: 'efectivo', amountCents: 0 }],
        relatedVoucherId: original.id,
        reason: str(body.reason, 'reason') || 'Nota de débito',
        source: 'debit-note',
      },
      auth.id,
    );
    return voucherDto(result.voucher);
  });

  /* ------------------------------------------- guías de remisión (doc 06) */

  router.get('/api/waybills/options', 'invoicing:read', () => {
    const establishments = getEstablishments();
    const clients = queryAll<Record<string, unknown>>(
      "SELECT id, id_type, id_number, name FROM clients WHERE status = 'active' ORDER BY name ASC LIMIT 500",
    );
    const products = queryAll<Record<string, unknown>>(
      "SELECT id, code, description, price_cents FROM products WHERE status = 'active' AND type = 'product' ORDER BY description ASC LIMIT 500",
    );
    return {
      establishments,
      clients: clients.map((row) => ({
        id: String(row.id),
        idType: String(row.id_type),
        idNumber: String(row.id_number),
        name: String(row.name),
      })),
      products: products.map((row) => ({
        id: String(row.id),
        code: String(row.code),
        description: String(row.description),
      })),
      motivosTraslado: MOTIVOS_TRASLADO,
      tiposIdentificacion: [
        { id: '04', label: 'RUC' },
        { id: '05', label: 'Cédula' },
        { id: '06', label: 'Pasaporte' },
        { id: '08', label: 'Identificación del exterior' },
        { id: '09', label: 'Placa' },
      ],
      tiposDocSustento: TIPOS_DOC_SUSTENTO,
    };
  });

  router.get('/api/waybills', 'invoicing:read', (ctx) => listVouchersByDocType(ctx, '06'));

  router.post('/api/waybills', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const transportista = (body.transportista ?? {}) as Record<string, unknown>;
    const destinatarios = Array.isArray(body.destinatarios)
      ? (body.destinatarios as Record<string, unknown>[])
      : [];
    if (!destinatarios.length) throw ApiError.badRequest('Agregue al menos un destinatario');
    if (!str(transportista.ruc, 'transportista.ruc', { required: true })) {
      throw ApiError.badRequest('El RUC del transportista es obligatorio');
    }
    if (!str(transportista.placa, 'transportista.placa', { required: true })) {
      throw ApiError.badRequest('La placa del vehículo es obligatoria');
    }
    const inicio = str(body.fechaIniTransporte, 'fechaIniTransporte', { required: true });
    const fin = str(body.fechaFinTransporte, 'fechaFinTransporte', { required: true });
    const normalizedDestinatarios = destinatarios.map((destinatario, index) => {
      const items = Array.isArray(destinatario.items) ? (destinatario.items as Record<string, unknown>[]) : [];
      if (!items.length) {
        throw ApiError.badRequest(`El destinatario ${index + 1} no tiene bienes transportados`);
      }
      return {
        identificacion: str(destinatario.identificacion, 'destinatario.identificacion', { required: true }),
        razonSocial: str(destinatario.razonSocial, 'destinatario.razonSocial', { required: true }),
        direccion: str(destinatario.direccion, 'destinatario.direccion', { required: true }),
        motivoTraslado: str(destinatario.motivoTraslado, 'destinatario.motivoTraslado', { required: true }),
        codDocSustento: str(destinatario.codDocSustento, 'codDocSustento') || null,
        numDocSustento: str(destinatario.numDocSustento, 'numDocSustento') || null,
        numAutDocSustento: str(destinatario.numAutDocSustento, 'numAutDocSustento') || null,
        fechaEmisionDocSustento: str(destinatario.fechaEmisionDocSustento, 'fechaEmisionDocSustento') || null,
        items: items.map((item) => {
          const product = item.productId ? findProduct(String(item.productId)) : undefined;
          return {
            productId: product?.id ?? null,
            codigo: product ? product.code : str(item.codigo, 'item.codigo') || 'S/C',
            descripcion: product ? product.description : str(item.descripcion, 'item.descripcion', { required: true }),
            cantidad: Math.max(1, Number(item.cantidad ?? 1)),
          };
        }),
      };
    });
    const firstDestinatario = normalizedDestinatarios[0]!;
    const client = ensureClient({
      idNumber: firstDestinatario.identificacion,
      name: firstDestinatario.razonSocial,
    });
    const flattenedItems = normalizedDestinatarios.flatMap((destinatario) =>
      destinatario.items.map((item) => ({
        productId: item.productId ?? undefined,
        code: item.codigo,
        description: item.descripcion,
        quantity: item.cantidad,
        unitPriceCents: 0,
        ivaCode: '0',
      })),
    );
    const result = await createVoucher(
      {
        docType: '06',
        establishmentId: body.establishmentId ? String(body.establishmentId) : undefined,
        emissionPointId: body.emissionPointId ? String(body.emissionPointId) : undefined,
        clientId: client.id,
        issueDate: body.issueDate ? String(body.issueDate) : undefined,
        draft: Boolean(body.draft),
        source: 'waybill',
        items: flattenedItems,
        extra: {
          dirPartida: str(body.dirPartida, 'dirPartida', { required: true }),
          transportista: {
            razonSocial: str(transportista.razonSocial, 'transportista.razonSocial', { required: true }),
            ruc: str(transportista.ruc, 'transportista.ruc', { required: true }),
            tipoIdentificacion: str(transportista.tipoIdentificacion, 'transportista.tipoIdentificacion') || '04',
            placa: str(transportista.placa, 'transportista.placa', { required: true }),
          },
          fechaIniTransporte: inicio,
          fechaFinTransporte: fin,
          destinatarios: normalizedDestinatarios,
        },
      },
      auth.id,
    );
    return voucherDto(result.voucher);
  });

  /* ------------------------------------------------- retenciones (doc 07) */

  router.get('/api/retentions/options', 'invoicing:read', () => {
    const establishments = getEstablishments();
    const clients = queryAll<Record<string, unknown>>(
      "SELECT id, id_type, id_number, name FROM clients WHERE status = 'active' ORDER BY name ASC LIMIT 500",
    );
    return {
      establishments,
      clients: clients.map((row) => ({
        id: String(row.id),
        idType: String(row.id_type),
        idNumber: String(row.id_number),
        name: String(row.name),
      })),
      tiposIdentificacion: [
        { id: '04', label: 'RUC' },
        { id: '05', label: 'Cédula' },
        { id: '06', label: 'Pasaporte' },
        { id: '08', label: 'Identificación del exterior' },
      ],
      tiposDocSustento: TIPOS_DOC_SUSTENTO,
      codigosSustento: CODIGOS_SUSTENTO,
      retencionesIVA: RETENCIONES_IVA,
      retencionesRentaSugeridas: RETENCIONES_RENTA_SUGERIDAS,
      impuestos: [
        { id: '1', label: 'Renta', codigo: '1' },
        { id: '2', label: 'IVA', codigo: '2' },
        { id: '6', label: 'ISD', codigo: '6' },
      ],
    };
  });

  router.get('/api/retentions', 'invoicing:read', (ctx) => listVouchersByDocType(ctx, '07'));

  router.post('/api/retentions', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const sujeto = (body.sujeto ?? {}) as Record<string, unknown>;
    const docs = Array.isArray(body.docs) ? (body.docs as Record<string, unknown>[]) : [];
    if (!docs.length) throw ApiError.badRequest('Agregue al menos un documento de sustento');
    const periodoFiscal = str(body.periodoFiscal, 'periodoFiscal', { required: true });
    if (!/^\d{2}\/\d{4}$/.test(periodoFiscal)) {
      throw ApiError.badRequest('El período fiscal debe tener formato MM/AAAA');
    }
    const normalizedDocs = docs.map((doc, index) => {
      const retenciones = Array.isArray(doc.retenciones) ? (doc.retenciones as Record<string, unknown>[]) : [];
      if (!retenciones.length) {
        throw ApiError.badRequest(`El documento ${index + 1} no tiene retenciones`);
      }
      const normalizedRetenciones = retenciones.map((retencion) => {
        const codigo = str(retencion.codigo, 'retencion.codigo', { required: true });
        const baseImponibleCents = Math.round(Number(retencion.baseImponibleCents ?? 0));
        const tarifa = Number(retencion.tarifa ?? 0);
        if (baseImponibleCents <= 0) throw ApiError.badRequest('La base imponible debe ser mayor a cero');
        if (!Number.isFinite(tarifa) || tarifa <= 0) throw ApiError.badRequest('La tarifa de retención debe ser mayor a cero');
        const valorRetenidoCents =
          retencion.valorRetenidoCents !== undefined
            ? Math.round(Number(retencion.valorRetenidoCents))
            : Math.round((baseImponibleCents * tarifa) / 100);
        if (valorRetenidoCents <= 0) throw ApiError.badRequest('El valor retenido debe ser mayor a cero');
        return {
          codigo,
          etiqueta: str(retencion.etiqueta, 'retencion.etiqueta') || (codigo === '2' ? 'IVA' : codigo === '6' ? 'ISD' : 'Renta'),
          codigoPorcentaje: str(retencion.codigoPorcentaje, 'retencion.codigoPorcentaje', { required: true }),
          tarifa,
          baseImponibleCents,
          valorRetenidoCents,
        };
      });
      const totalRetenido = normalizedRetenciones.reduce((sum, item) => sum + item.valorRetenidoCents, 0);
      const impuestos = Array.isArray(doc.impuestos)
        ? (doc.impuestos as Record<string, unknown>[]).map((impuesto) => ({
            codImpuestoDocSustento: str(impuesto.codImpuestoDocSustento, 'impuesto.codImpuestoDocSustento') || '2',
            codigoPorcentaje: str(impuesto.codigoPorcentaje, 'impuesto.codigoPorcentaje') || '4',
            baseImponibleCents: Math.round(Number(impuesto.baseImponibleCents ?? 0)),
            tarifa: Number(impuesto.tarifa ?? 0),
            valorImpuestoCents: Math.round(Number(impuesto.valorImpuestoCents ?? 0)),
          }))
        : [];
      return {
        codSustento: str(doc.codSustento, 'codSustento') || '01',
        codDocSustento: str(doc.codDocSustento, 'codDocSustento', { required: true }),
        numDocSustento: str(doc.numDocSustento, 'numDocSustento', { required: true }),
        fechaEmisionDocSustento: str(doc.fechaEmisionDocSustento, 'fechaEmisionDocSustento', { required: true }),
        numAutDocSustento: str(doc.numAutDocSustento, 'numAutDocSustento') || '',
        pagoLocExt: str(doc.pagoLocExt, 'pagoLocExt') || '01',
        totalSinImpuestosCents: Math.round(Number(doc.totalSinImpuestosCents ?? 0)),
        importeTotalCents: Math.round(Number(doc.importeTotalCents ?? 0)),
        impuestos,
        retenciones: normalizedRetenciones,
        totalRetenidoCents: totalRetenido,
      };
    });
    const client = ensureClient({
      idType: str(sujeto.tipoIdentificacion, 'sujeto.tipoIdentificacion') || undefined,
      idNumber: str(sujeto.identificacion, 'sujeto.identificacion', { required: true }),
      name: str(sujeto.razonSocial, 'sujeto.razonSocial', { required: true }),
    });
    const result = await createVoucher(
      {
        docType: '07',
        establishmentId: body.establishmentId ? String(body.establishmentId) : undefined,
        emissionPointId: body.emissionPointId ? String(body.emissionPointId) : undefined,
        clientId: client.id,
        issueDate: body.issueDate ? String(body.issueDate) : undefined,
        draft: Boolean(body.draft),
        source: 'retention',
        items: [],
        extra: {
          sujeto: {
            tipoIdentificacion: str(sujeto.tipoIdentificacion, 'sujeto.tipoIdentificacion') || '04',
            identificacion: str(sujeto.identificacion, 'sujeto.identificacion', { required: true }),
            razonSocial: str(sujeto.razonSocial, 'sujeto.razonSocial', { required: true }),
          },
          periodoFiscal,
          docs: normalizedDocs,
        },
      },
      auth.id,
    );
    return voucherDto(result.voucher);
  });

  router.post('/api/quick-invoices', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    if (!items.length) throw ApiError.badRequest('Agregue al menos un ítem');
    const result = await createVoucher(
      {
        docType: '01',
        clientId: body.clientId ? String(body.clientId) : undefined,
        source: 'quick',
        items: items.map((item) => ({
          productId: item.productId ? String(item.productId) : undefined,
          code: item.code ? String(item.code) : undefined,
          description: item.description ? String(item.description) : undefined,
          quantity: Number(item.quantity ?? 1),
          unitPriceCents: item.unitPriceCents !== undefined ? Number(item.unitPriceCents) : undefined,
          discountCents: item.discountCents !== undefined ? Number(item.discountCents) : undefined,
          ivaCode: item.ivaCode ? String(item.ivaCode) : undefined,
        })),
        payments:
          Number(body.amountCents ?? 0) > 0
            ? [{ method: String(body.paymentMethod ?? 'efectivo'), amountCents: Number(body.amountCents) }]
            : undefined,
        draft: Boolean(body.draft),
      },
      auth.id,
    );
    return { voucher: voucherDto(result.voucher), changeCents: result.changeCents };
  });

  router.post('/api/pos/sales', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    if (!items.length) throw ApiError.badRequest('El carrito está vacío');
    const payments = Array.isArray(body.payments) ? (body.payments as Record<string, unknown>[]) : [];
    const result = await createVoucher(
      {
        docType: '01',
        clientId: body.clientId ? String(body.clientId) : undefined,
        source: 'pos',
        items: items.map((item) => ({
          productId: item.productId ? String(item.productId) : undefined,
          quantity: Number(item.quantity ?? 1),
          unitPriceCents: item.unitPriceCents !== undefined ? Number(item.unitPriceCents) : undefined,
          discountCents: item.discountCents !== undefined ? Number(item.discountCents) : undefined,
        })),
        payments: payments.map((payment) => ({
          method: String(payment.method ?? 'efectivo'),
          amountCents: Number(payment.amountCents ?? 0),
          term: Number(payment.term ?? 0),
        })),
      },
      auth.id,
    );
    return { voucher: voucherDto(result.voucher), changeCents: result.changeCents };
  });

  /* ---------------------------------------------- API de integración (v1) */
  router.post('/api/v1/vouchers', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const created = await createVoucher(normalizeCreateInput(body), auth.id);
    return voucherDto(created.voucher);
  });

  router.post('/api/v1/vouchers/bulk', 'invoicing:create', async (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<{ vouchers?: Record<string, unknown>[] }>(ctx);
    const list = Array.isArray(body.vouchers) ? body.vouchers : [];
    if (!list.length) throw ApiError.badRequest('Envíe al menos un comprobante en "vouchers"');
    const results: { ok: boolean; id?: string; accessKey?: string | null; status?: string; error?: string }[] = [];
    for (const item of list) {
      try {
        const created = await createVoucher(normalizeCreateInput(item), auth.id);
        results.push({
          ok: true,
          id: created.voucher.id,
          accessKey: created.voucher.access_key,
          status: created.voucher.status,
        });
      } catch (error) {
        results.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { total: results.length, ok: results.filter((r) => r.ok).length, results };
  });

  router.get('/api/v1/vouchers/:id', 'invoicing:read', (ctx) => {
    const row = getVoucherOrThrow(ctx.params.id);
    return {
      id: row.id,
      docType: row.doc_type,
      status: row.status,
      accessKey: row.access_key,
      authorizationNumber: row.authorization_number,
      authorizationDate: row.authorization_date,
      number: voucherNumber(row),
      totalCents: row.total_cents,
      issueDate: row.issue_date,
    };
  });
}

function normalizeCreateInput(body: Record<string, unknown>): CreateVoucherInput {
  const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  return {
    docType: body.docType ? String(body.docType) : '01',
    establishmentId: body.establishmentId ? String(body.establishmentId) : undefined,
    emissionPointId: body.emissionPointId ? String(body.emissionPointId) : undefined,
    clientId: body.clientId ? String(body.clientId) : undefined,
    issueDate: body.issueDate ? String(body.issueDate) : undefined,
    currency: body.currency ? String(body.currency) : undefined,
    draft: Boolean(body.draft),
    source: body.source ? String(body.source) : 'standard',
    items: items.map((item) => ({
      productId: item.productId ? String(item.productId) : undefined,
      code: item.code ? String(item.code) : undefined,
      auxCode: item.auxCode ? String(item.auxCode) : undefined,
      description: item.description ? String(item.description) : undefined,
      quantity: Number(item.quantity ?? 1),
      unitPriceCents: item.unitPriceCents !== undefined ? Number(item.unitPriceCents) : undefined,
      discountCents: item.discountCents !== undefined ? Number(item.discountCents) : undefined,
      ivaCode: item.ivaCode ? String(item.ivaCode) : undefined,
    })),
    payments: Array.isArray(body.payments)
      ? (body.payments as Record<string, unknown>[]).map((payment) => ({
          method: String(payment.method ?? 'efectivo'),
          amountCents: Number(payment.amountCents ?? 0),
          term: Number(payment.term ?? 0),
        }))
      : undefined,
    infoAdicional: Array.isArray(body.infoAdicional)
      ? (body.infoAdicional as Record<string, unknown>[]).map((info) => ({
          nombre: String(info.nombre ?? ''),
          valor: String(info.valor ?? ''),
        }))
      : undefined,
  };
}

function rideBase(row: VoucherRow) {
  const company = getCompany();
  return {
    company: {
      name: company.name,
      ruc: company.ruc,
      address: company.address ?? '',
      phone: company.phone ?? undefined,
      email: company.email ?? undefined,
      obligedAccounting: Boolean(company.obliged_accounting),
    },
    docTypeName: DOC_TYPES[row.doc_type as DocTypeCode]?.name ?? 'Comprobante',
    number: voucherNumber(row),
    accessKey: row.access_key ?? '',
    environmentLabel:
      row.environment === 2
        ? 'PRODUCCIÓN — los comprobantes tienen valor tributario'
        : 'PRUEBAS — los comprobantes NO tienen valor tributario',
    authorizationNumber: row.authorization_number ?? undefined,
    authorizationDate: row.authorization_date ?? undefined,
    issueDate: formatFecha(row.issue_date),
    statusLabel: row.status,
    sriMessages: parseJson<{ identificador?: string; mensaje?: string }[]>(row.sri_messages, []),
  };
}

function buildGuiaRide(row: VoucherRow): Buffer {
  const extra = parseJson<Record<string, unknown>>(row.extra_json, {});
  const transportista = (extra.transportista ?? {}) as Record<string, unknown>;
  const destinatarios = ((extra.destinatarios ?? []) as Record<string, unknown>[]).map((destinatario) => ({
    identificacion: String(destinatario.identificacion ?? ''),
    razonSocial: String(destinatario.razonSocial ?? ''),
    direccion: String(destinatario.direccion ?? ''),
    motivoTraslado: String(destinatario.motivoTraslado ?? ''),
    items: ((destinatario.items ?? []) as Record<string, unknown>[]).map((item) => ({
      codigo: String(item.codigo ?? ''),
      descripcion: String(item.descripcion ?? ''),
      cantidad: Number(item.cantidad ?? 0),
    })),
  }));
  return generarRideGuiaPdf({
    ...rideBase(row),
    dirPartida: String(extra.dirPartida ?? ''),
    transportista: {
      razonSocial: String(transportista.razonSocial ?? ''),
      ruc: String(transportista.ruc ?? ''),
      tipoIdentificacion: String(transportista.tipoIdentificacion ?? '04'),
      placa: String(transportista.placa ?? ''),
    },
    fechaIniTransporte: String(extra.fechaIniTransporte ?? formatFecha(row.issue_date)),
    fechaFinTransporte: String(extra.fechaFinTransporte ?? formatFecha(row.issue_date)),
    destinatarios,
  });
}

function buildRetencionRide(row: VoucherRow): Buffer {
  const extra = parseJson<Record<string, unknown>>(row.extra_json, {});
  const sujeto = (extra.sujeto ?? {}) as Record<string, unknown>;
  const docs = ((extra.docs ?? []) as Record<string, unknown>[]).map((doc) => ({
    codDocSustento: String(doc.codDocSustento ?? ''),
    numDocSustento: String(doc.numDocSustento ?? ''),
    fechaEmisionDocSustento: String(doc.fechaEmisionDocSustento ?? ''),
    numAutDocSustento: String(doc.numAutDocSustento ?? ''),
    importeTotal: Number(doc.importeTotalCents ?? 0) / 100,
    retenciones: ((doc.retenciones ?? []) as Record<string, unknown>[]).map((retencion) => ({
      codigo: String(retencion.codigo ?? ''),
      etiqueta: String(retencion.etiqueta ?? (String(retencion.codigo) === '2' ? 'IVA' : String(retencion.codigo) === '6' ? 'ISD' : 'Renta')),
      codigoPorcentaje: String(retencion.codigoPorcentaje ?? ''),
      tarifa: Number(retencion.tarifa ?? 0),
      baseImponible: Number(retencion.baseImponibleCents ?? 0) / 100,
      valorRetenido: Number(retencion.valorRetenidoCents ?? 0) / 100,
    })),
  }));
  return generarRideRetencionPdf({
    ...rideBase(row),
    sujeto: {
      razonSocial: String(sujeto.razonSocial ?? row.client_name ?? ''),
      identificacion: String(sujeto.identificacion ?? row.client_id_number ?? ''),
      tipoIdentificacion: String(sujeto.tipoIdentificacion ?? row.client_id_type ?? '04'),
    },
    periodoFiscal: String(extra.periodoFiscal ?? ''),
    docs,
    totalRetenido: row.total_cents / 100,
  });
}

function buildRideBuffer(row: VoucherRow): Buffer {
  if (row.doc_type === '06') return buildGuiaRide(row);
  if (row.doc_type === '07') return buildRetencionRide(row);
  const company = getCompany();
  const client = row.client_id ? findClient(row.client_id) : undefined;
  const items = queryAll<VoucherItemRow>('SELECT * FROM voucher_items WHERE voucher_id = ?', [row.id]);
  const payments = queryAll<PaymentRow>('SELECT * FROM voucher_payments WHERE voucher_id = ?', [row.id]);
  const taxTotals = buildTotalImpuestos(items).map((tax) => ({
    codigoPorcentaje: tax.codigoPorcentaje,
    tarifa: tax.tarifa / 100,
    baseImponible: tax.baseImponible,
    valor: tax.valor,
  }));
  const paymentLabels = new Map(FORMAS_DE_PAGO.map((method) => [method.id, method.description]));
  return generarRidePdf({
    company: {
      name: company.name,
      ruc: company.ruc,
      address: company.address ?? '',
      phone: company.phone ?? undefined,
      email: company.email ?? undefined,
      obligedAccounting: Boolean(company.obliged_accounting),
    },
    docTypeName: DOC_TYPES[row.doc_type as DocTypeCode]?.name ?? 'Comprobante',
    docTypeCode: row.doc_type,
    number: voucherNumber(row),
    accessKey: row.access_key ?? '',
    environmentLabel:
      row.environment === 2
        ? 'PRODUCCIÓN — los comprobantes tienen valor tributario'
        : 'PRUEBAS — los comprobantes NO tienen valor tributario',
    authorizationNumber: row.authorization_number ?? undefined,
    authorizationDate: row.authorization_date ?? undefined,
    issueDate: formatFecha(row.issue_date),
    statusLabel: row.status,
    client: {
      name: row.client_name ?? 'CONSUMIDOR FINAL',
      idType: row.client_id_type ?? '07',
      idNumber: row.client_id_number ?? '9999999999999',
      address: client?.address ?? undefined,
      email: client?.email ?? undefined,
    },
    items: items.map((item) => ({
      codigo: item.code,
      descripcion: item.description,
      cantidad: Number(item.quantity),
      precioUnitario: item.unit_price_cents / 100,
      descuento: item.discount_cents / 100,
      subtotal: item.subtotal_cents / 100,
      impuestos: parseJson<TaxLine[]>(item.taxes, []),
    })),
    taxTotals,
    subtotal: row.subtotal_cents / 100,
    discount: row.discount_cents / 100,
    total: row.total_cents / 100,
    payments: payments.map((payment) => ({
      method: paymentLabels.get(payment.method) ?? payment.method,
      amount: payment.amount_cents / 100,
    })),
    infoAdicional: parseJson<{ nombre: string; valor: string }[]>(row.info_adicional, []),
    sriMessages: parseJson<{ identificador?: string; mensaje?: string }[]>(row.sri_messages, []),
  });
}

export { buildRideBuffer, buildTotalImpuestos };


