/**
 * Catálogos del SRI observados en el servicio de facturación electrónica identificado
 * (`GET /v3/administrative/invoices/get-options` de UpConta, ver docs/upconta-api/samples).
 *
 * Los valores `id` son los códigos que viajan al XML del SRI.
 */

export interface CatalogOption {
  id: string;
  description: string;
  value?: number;
}

export type DocTypeCode = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '11';

export const IMPUESTOS: CatalogOption[] = [
  { id: '2', description: 'IVA' },
  { id: '3', description: 'ICE' },
  { id: '5', description: 'IRBPNR' },
];

export const FORMAS_DE_PAGO: CatalogOption[] = [
  { id: '01', description: 'SIN UTILIZACION DEL SISTEMA FINANCIERO' },
  { id: '15', description: 'COMPENSACIÓN DE DEUDAS' },
  { id: '16', description: 'TARJETA DE DÉBITO' },
  { id: '17', description: 'DINERO ELECTRÓNICO' },
  { id: '18', description: 'TARJETA PREPAGO' },
  { id: '19', description: 'TARJETA DE CRÉDITO' },
  { id: '20', description: 'OTROS CON UTILIZACION DEL SISTEMA FINANCIERO' },
  { id: '21', description: 'ENDOSO DE TÍTULOS' },
  { id: 'efectivo', description: 'EFECTIVO' },
  { id: 'transferencia', description: 'TRANSFERENCIA' },
  { id: 'deuna', description: 'DEUNA' },
  { id: 'cheque', description: 'CHEQUE' },
];

export const TIPOS_DE_COMPROBANTE: CatalogOption[] = [
  { id: '01', description: 'Factura' },
  { id: '02', description: 'Nota de venta' },
  { id: '03', description: 'Liquidación de compra' },
  { id: '04', description: 'Nota de Crédito' },
  { id: '05', description: 'Nota de Débito' },
  { id: '06', description: 'Guía de Remisión' },
  { id: '07', description: 'Comprobante de Retención' },
  { id: '08', description: 'Liquidación de compra' },
  { id: '11', description: 'Ticket de Avión' },
];

export const TIPOS_DE_IDENTIFICACION: CatalogOption[] = [
  { id: '04', description: 'RUC' },
  { id: '05', description: 'Cédula' },
  { id: '06', description: 'Pasaporte' },
  { id: '07', description: 'Consumidor Final' },
  { id: '08', description: 'Identificación del exterior' },
  { id: '09', description: 'Placa' },
];

export const PORCENTAJES_DE_IVA: CatalogOption[] = [
  { id: '0', description: '0%', value: 0 },
  { id: '2', description: '12%', value: 0.12 },
  { id: '4', description: '15%', value: 0.15 },
  { id: '5', description: '5%', value: 0.05 },
  { id: '8', description: '8%', value: 0.08 },
  { id: '10', description: '13%', value: 0.13 },
  { id: '6', description: 'No objeto de impuesto', value: 0 },
  { id: '7', description: 'Exento de IVA', value: 0 },
];

export const PORCENTAJES_DE_IRBPNR: CatalogOption[] = [
  { id: '5001', description: 'Botellas plásticas no retornables', value: 0.02 },
];

/** Catálogo ICE (extracto de los códigos vigentes observados; ampliable por configuración). */
export const PORCENTAJES_DE_ICE: CatalogOption[] = [
  { id: '3011', description: 'Cigarrillos rubios' },
  { id: '3021', description: 'Cigarrillos negros' },
  { id: '3023', description: 'Productos del tabaco y sucedáneos del tabaco excepto cigarrillos', value: 1.5 },
  { id: '3031', description: 'Bebidas alcohólicas', value: 0.75 },
  { id: '3033', description: 'Alcohol', value: 0.75 },
  { id: '3041', description: 'Cerveza industrial gran escala', value: 0.75 },
  { id: '3041A', description: 'Cerveza industrial mediana escala', value: 0.75 },
  { id: '3041B', description: 'Cerveza industrial pequeña escala', value: 0.75 },
  { id: '3043', description: 'Cerveza artesanal' },
  { id: '3053', description: 'Bebidas gaseosas con alto contenido de azúcar' },
  { id: '3054', description: 'Bebidas gaseosas con bajo contenido de azúcar', value: 0.1 },
  { id: '3073', description: 'Vehículos motorizados cuyo PVP sea hasta de 20000 USD', value: 0.05 },
  { id: '3075', description: 'Vehículos motorizados PVP entre 30000 y 40000', value: 0.15 },
  { id: '3077', description: 'Vehículos motorizados cuyo PVP superior USD 40.000 hasta 50.000', value: 0.2 },
  { id: '3078', description: 'Vehículos motorizados cuyo PVP superior USD 50.000 hasta 60.000', value: 0.25 },
  { id: '3079', description: 'Vehículos motorizados cuyo PVP superior USD 60.000 hasta 70.000', value: 0.3 },
  { id: '3080', description: 'Vehículos motorizados cuyo PVP superior USD 70.000', value: 0.35 },
  { id: '3081', description: 'Aviones, tricares, yates, barcos de recreo', value: 0.15 },
  { id: '3092', description: 'Servicios de televisión prepagada', value: 0.15 },
  { id: '3093', description: 'Servicios telefonía sociedades', value: 0.15 },
  { id: '3101', description: 'Bebidas energizantes', value: 0.1 },
  { id: '3111', description: 'Bebidas no alcohólicas' },
  { id: '3610', description: 'Perfumes y aguas de tocador', value: 0.2 },
  { id: '3620', description: 'Videojuegos', value: 0.35 },
  { id: '3630', description: 'Armas de fuego, armas deportivas y municiones', value: 3 },
  { id: '3640', description: 'Focos incandescentes', value: 1 },
  { id: '3660', description: 'Cuotas membresías afiliaciones acciones', value: 0.35 },
  { id: '3671', description: 'Calefones y sistemas de calentamiento de agua a gas', value: 1 },
  { id: '3680', description: 'Fundas plásticas' },
  { id: '3681', description: 'Servicios de telefonía móvil personas naturales', value: 0.1 },
  { id: '3682', description: 'Consumibles tabaco calentado y líquidos con nicotina', value: 1.5 },
  { id: '3684', description: 'Vehículos motorizados camionetas y de rescate PVP hasta 30.000 USD', value: 0.05 },
  { id: '3686', description: 'Vehículos motorizados excepto camionetas PVP 20.000 a 30.000', value: 0.1 },
  { id: '3688', description: 'Vehículos híbridos PVP hasta USD 35.000', value: 0 },
  { id: '3691', description: 'Vehículos híbridos PVP 35.000 a 40.000', value: 0.08 },
  { id: '3692', description: 'Vehículos híbridos PVP 40.000 a 50.000', value: 0.14 },
  { id: '3695', description: 'Vehículos híbridos PVP 50.000 a 60.000', value: 0.2 },
  { id: '3696', description: 'Vehículos híbridos PVP 60.000 a 70.000', value: 0.26 },
  { id: '3698', description: 'Vehículos híbridos PVP superior a USD 70.000', value: 0.32 },
];

/** Tipos de documento con los que opera la aplicación. */
export interface DocTypeMeta {
  code: DocTypeCode;
  name: string;
  /** Nombre del nodo raíz del XML del SRI. */
  rootElement: string;
  /** Versión de la ficha técnica del SRI. */
  version: string;
  /** Prefijo del secuencial en el punto de emisión. */
  sequenceField:
    | 'invoice'
    | 'creditNote'
    | 'debitNote'
    | 'retentionReceipt'
    | 'waybill'
    | 'salesNote';
}

export const DOC_TYPES: Record<DocTypeCode, DocTypeMeta> = {
  '01': { code: '01', name: 'Factura', rootElement: 'factura', version: '1.1.0', sequenceField: 'invoice' },
  '02': { code: '02', name: 'Nota de venta', rootElement: 'notaVenta', version: '1.0.0', sequenceField: 'salesNote' },
  '03': {
    code: '03',
    name: 'Liquidación de compra',
    rootElement: 'liquidacionCompra',
    version: '1.1.0',
    sequenceField: 'invoice',
  },
  '04': {
    code: '04',
    name: 'Nota de Crédito',
    rootElement: 'notaCredito',
    version: '1.1.0',
    sequenceField: 'creditNote',
  },
  '05': {
    code: '05',
    name: 'Nota de Débito',
    rootElement: 'notaDebito',
    version: '1.0.0',
    sequenceField: 'debitNote',
  },
  '06': {
    code: '06',
    name: 'Guía de Remisión',
    rootElement: 'guiaRemision',
    version: '1.1.0',
    sequenceField: 'waybill',
  },
  '07': {
    code: '07',
    name: 'Comprobante de Retención',
    rootElement: 'comprobanteRetencion',
    version: '1.0.0',
    sequenceField: 'retentionReceipt',
  },
  '11': { code: '11', name: 'Ticket de Avión', rootElement: 'ticket', version: '1.0.0', sequenceField: 'invoice' },
};

export const SRI_ENDPOINTS = {
  1: {
    label: 'Pruebas',
    recepcion:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    autorizacion:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    consulta: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/ConsultaComprobante',
    portal: 'https://celcer.sri.gob.ec',
  },
  2: {
    label: 'Producción',
    recepcion: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    autorizacion: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    consulta: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/ConsultaComprobante',
    portal: 'https://cel.sri.gob.ec',
  },
} as const;

export const UNIDADES_MEDIDA: CatalogOption[] = [
  { id: 'UNI', description: 'Unidad' },
  { id: 'KG', description: 'Kilogramo' },
  { id: 'G', description: 'Gramo' },
  { id: 'LT', description: 'Litro' },
  { id: 'ML', description: 'Mililitro' },
  { id: 'M', description: 'Metro' },
  { id: 'M2', description: 'Metro cuadrado' },
  { id: 'M3', description: 'Metro cúbico' },
  { id: 'CAJ', description: 'Caja' },
  { id: 'PAQ', description: 'Paquete' },
  { id: 'DOC', description: 'Docena' },
  { id: 'SER', description: 'Servicio' },
  { id: 'H', description: 'Hora' },
];

export const TIPOS_DE_PERSONA: CatalogOption[] = [
  { id: '01', description: 'Persona natural' },
  { id: '02', description: 'Sociedad' },
];

/** Consumidor final por defecto (identificación "9999999999999"). */
export const CONSUMIDOR_FINAL = {
  idType: '07',
  id: '9999999999999',
  name: 'CONSUMIDOR FINAL',
  subjectType: '01',
};

/** Catálogo completo que expone la API en /api/catalogs. */
export function buildCatalogs() {
  return {
    impuestos: IMPUESTOS,
    formasDePago: FORMAS_DE_PAGO,
    tiposDeComprobante: TIPOS_DE_COMPROBANTE,
    tiposDeIdentificacion: TIPOS_DE_IDENTIFICACION,
    porcentajesDeIVA: PORCENTAJES_DE_IVA,
    porcentajesDeICE: PORCENTAJES_DE_ICE,
    porcentajesDeIRBPNR: PORCENTAJES_DE_IRBPNR,
    unidadesMedida: UNIDADES_MEDIDA,
    tiposDePersona: TIPOS_DE_PERSONA,
    docTypes: DOC_TYPES,
    sriEndpoints: SRI_ENDPOINTS,
  };
}
