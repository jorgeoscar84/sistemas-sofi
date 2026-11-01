/**
 * Construcción de los XML del SRI (Ecuador).
 * Implementación sin dependencias externas: los documentos se generan compactos
 * (sin espacios entre etiquetas) y con atributos en orden canónico para que el
 * digest de la firma XAdES sea estable.
 */

export function escapeXml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Número con 2 decimales fijos (formato del SRI: 1234.56). */
export function money2(value: number): string {
  return (Math.round(Number(value || 0) * 100) / 100).toFixed(2);
}

/** Cantidad con hasta 6 decimales, sin ceros innecesarios (formato del SRI). */
export function qty(value: number): string {
  const n = Number(value || 0);
  return (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '') || '0';
}

export interface TaxLine {
  codigo: string;
  codigoPorcentaje: string;
  tarifa: number;
  baseImponible: number;
  valor: number;
}

export interface XmlInfoTributaria {
  ambiente: '1' | '2';
  tipoEmision: '1' | '2' | '3' | '4';
  razonSocial: string;
  nombreComercial?: string | null;
  ruc: string;
  claveAcceso: string;
  codDoc: string;
  estab: string;
  ptoEmi: string;
  secuencial: string;
  dirMatriz: string;
  agenteRetencion?: string | null;
  contribuyenteRimpe?: string | null;
}

function infoTributaria(x: XmlInfoTributaria): string {
  const parts = [
    `<ambiente>${x.ambiente}</ambiente>`,
    `<tipoEmision>${x.tipoEmision}</tipoEmision>`,
    `<razonSocial>${escapeXml(x.razonSocial)}</razonSocial>`,
  ];
  if (x.nombreComercial) parts.push(`<nombreComercial>${escapeXml(x.nombreComercial)}</nombreComercial>`);
  parts.push(
    `<ruc>${escapeXml(x.ruc)}</ruc>`,
    `<claveAcceso>${x.claveAcceso}</claveAcceso>`,
    `<codDoc>${x.codDoc}</codDoc>`,
    `<estab>${x.estab}</estab>`,
    `<ptoEmi>${x.ptoEmi}</ptoEmi>`,
    `<secuencial>${x.secuencial}</secuencial>`,
    `<dirMatriz>${escapeXml(x.dirMatriz)}</dirMatriz>`,
  );
  if (x.agenteRetencion) parts.push(`<agenteRetencion>${escapeXml(x.agenteRetencion)}</agenteRetencion>`);
  if (x.contribuyenteRimpe) parts.push(`<contribuyenteRimpe>${escapeXml(x.contribuyenteRimpe)}</contribuyenteRimpe>`);
  return `<infoTributaria>${parts.join('')}</infoTributaria>`;
}

export interface XmlComprador {
  tipoIdentificacion: string;
  razonSocial: string;
  identificacion: string;
  direccion?: string | null;
  email?: string | null;
}

export interface XmlDetalle {
  codigoPrincipal: string;
  codigoAuxiliar?: string | null;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuento: number;
  subtotal: number;
  impuestos: TaxLine[];
  detallesAdicionales?: { nombre: string; valor: string }[];
}

function impuestosXml(impuestos: TaxLine[]): string {
  return `<impuestos>${impuestos
    .map(
      (t) =>
        `<impuesto><codigo>${t.codigo}</codigo><codigoPorcentaje>${t.codigoPorcentaje}</codigoPorcentaje>` +
        `<tarifa>${money2(t.tarifa)}</tarifa><baseImponible>${money2(t.baseImponible)}</baseImponible>` +
        `<valor>${money2(t.valor)}</valor></impuesto>`,
    )
    .join('')}</impuestos>`;
}

function detalleXml(d: XmlDetalle): string {
  const parts = [
    `<codigoPrincipal>${escapeXml(d.codigoPrincipal)}</codigoPrincipal>`,
  ];
  if (d.codigoAuxiliar) parts.push(`<codigoAuxiliar>${escapeXml(d.codigoAuxiliar)}</codigoAuxiliar>`);
  parts.push(
    `<descripcion>${escapeXml(d.descripcion)}</descripcion>`,
    `<cantidad>${qty(d.cantidad)}</cantidad>`,
    `<precioUnitario>${money2(d.precioUnitario)}</precioUnitario>`,
    `<descuento>${money2(d.descuento)}</descuento>`,
    `<precioTotalSinImpuesto>${money2(d.subtotal)}</precioTotalSinImpuesto>`,
  );
  if (d.detallesAdicionales && d.detallesAdicionales.length) {
    parts.push(
      `<detallesAdicionales>${d.detallesAdicionales
        .map((a) => `<detAdicional nombre="${escapeXml(a.nombre)}" valor="${escapeXml(a.valor)}"/>`)
        .join('')}</detallesAdicionales>`,
    );
  }
  parts.push(impuestosXml(d.impuestos));
  return `<detalle>${parts.join('')}</detalle>`;
}

function infoAdicionalXml(info?: { nombre: string; valor: string }[] | null): string {
  if (!info || info.length === 0) return '';
  return `<infoAdicional>${info
    .map((i) => `<campoAdicional nombre="${escapeXml(i.nombre)}">${escapeXml(i.valor)}</campoAdicional>`)
    .join('')}</infoAdicional>`;
}

function xmlDocument(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${inner}`;
}

/* ------------------------------------------------------------------ FACTURA */

export interface FacturaInput {
  infoTributaria: XmlInfoTributaria;
  infoFactura: {
    fechaEmision: string; // dd/mm/aaaa
    dirEstablecimiento?: string | null;
    contribuyenteEspecial?: string | null;
    obligadoContabilidad: 'SI' | 'NO';
    comprador: XmlComprador;
    totalSinImpuestos: number;
    totalDescuento: number;
    totalConImpuestos: TaxLine[];
    propina: number;
    importeTotal: number;
    moneda?: string;
    pagos: { formaPago: string; total: number; plazo?: number }[];
  };
  detalles: XmlDetalle[];
  infoAdicional?: { nombre: string; valor: string }[];
  retenciones?: { codigo: string; codigoPorcentaje: string; tarifa: number; valor: number }[];
}

export function buildFacturaXml(input: FacturaInput): string {
  const f = input.infoFactura;
  const c = f.comprador;
  const infoFactura = [
    `<fechaEmision>${f.fechaEmision}</fechaEmision>`,
    f.dirEstablecimiento ? `<dirEstablecimiento>${escapeXml(f.dirEstablecimiento)}</dirEstablecimiento>` : '',
    f.contribuyenteEspecial ? `<contribuyenteEspecial>${escapeXml(f.contribuyenteEspecial)}</contribuyenteEspecial>` : '',
    `<obligadoContabilidad>${f.obligadoContabilidad}</obligadoContabilidad>`,
    `<tipoIdentificacionComprador>${c.tipoIdentificacion}</tipoIdentificacionComprador>`,
    `<razonSocialComprador>${escapeXml(c.razonSocial)}</razonSocialComprador>`,
    `<identificacionComprador>${escapeXml(c.identificacion)}</identificacionComprador>`,
    c.direccion ? `<direccionComprador>${escapeXml(c.direccion)}</direccionComprador>` : '',
    `<totalSinImpuestos>${money2(f.totalSinImpuestos)}</totalSinImpuestos>`,
    `<totalDescuento>${money2(f.totalDescuento)}</totalDescuento>`,
    `<totalConImpuestos>${f.totalConImpuestos
      .map(
        (t) =>
          `<totalImpuesto><codigo>${t.codigo}</codigo><codigoPorcentaje>${t.codigoPorcentaje}</codigoPorcentaje>` +
          `<baseImponible>${money2(t.baseImponible)}</baseImponible><valor>${money2(t.valor)}</valor></totalImpuesto>`,
      )
      .join('')}</totalConImpuestos>`,
    `<propina>${money2(f.propina)}</propina>`,
    `<importeTotal>${money2(f.importeTotal)}</importeTotal>`,
    `<moneda>${f.moneda ?? 'DOLAR'}</moneda>`,
    `<pagos>${f.pagos
      .map(
        (p) =>
          `<pago><formaPago>${p.formaPago}</formaPago><total>${money2(p.total)}</total>` +
          (p.plazo ? `<plazo>${p.plazo}</plazo>` : '') +
          `<unidadTiempo>dias</unidadTiempo></pago>`,
      )
      .join('')}</pagos>`,
  ].join('');

  const retenciones = input.retenciones?.length
    ? `<retenciones>${input.retenciones
        .map(
          (r) =>
            `<retencion><codigo>${r.codigo}</codigo><codigoPorcentaje>${r.codigoPorcentaje}</codigoPorcentaje>` +
            `<tarifa>${money2(r.tarifa)}</tarifa><valor>${money2(r.valor)}</valor></retencion>`,
        )
        .join('')}</retenciones>`
    : '';

  const inner =
    `<factura id="comprobante" version="1.1.0">` +
    infoTributaria(input.infoTributaria) +
    `<infoFactura>${infoFactura}</infoFactura>` +
    `<detalles>${input.detalles.map(detalleXml).join('')}</detalles>` +
    retenciones +
    infoAdicionalXml(input.infoAdicional) +
    `</factura>`;
  return xmlDocument(inner);
}

/* ------------------------------------------------------------ NOTA DE CRÉDITO */

export interface NotaCreditoInput {
  infoTributaria: XmlInfoTributaria;
  infoNotaCredito: {
    fechaEmision: string;
    dirEstablecimiento?: string | null;
    tipoIdentificacionComprador: string;
    razonSocialComprador: string;
    identificacionComprador: string;
    contribuyenteEspecial?: string | null;
    obligadoContabilidad: 'SI' | 'NO';
    rise?: string | null;
    codDocModificado: string;
    numDocModificado: string;
    fechaEmisionDocSustento: string;
    totalSinImpuestos: number;
    valorModificacion: number;
    moneda?: string;
    totalConImpuestos: TaxLine[];
    motivo: string;
  };
  detalles: XmlDetalle[];
  infoAdicional?: { nombre: string; valor: string }[];
}

export function buildNotaCreditoXml(input: NotaCreditoInput): string {
  const n = input.infoNotaCredito;
  const info = [
    `<fechaEmision>${n.fechaEmision}</fechaEmision>`,
    n.dirEstablecimiento ? `<dirEstablecimiento>${escapeXml(n.dirEstablecimiento)}</dirEstablecimiento>` : '',
    `<tipoIdentificacionComprador>${n.tipoIdentificacionComprador}</tipoIdentificacionComprador>`,
    `<razonSocialComprador>${escapeXml(n.razonSocialComprador)}</razonSocialComprador>`,
    `<identificacionComprador>${escapeXml(n.identificacionComprador)}</identificacionComprador>`,
    n.contribuyenteEspecial ? `<contribuyenteEspecial>${escapeXml(n.contribuyenteEspecial)}</contribuyenteEspecial>` : '',
    `<obligadoContabilidad>${n.obligadoContabilidad}</obligadoContabilidad>`,
    n.rise ? `<rise>${escapeXml(n.rise)}</rise>` : '',
    `<codDocModificado>${n.codDocModificado}</codDocModificado>`,
    `<numDocModificado>${escapeXml(n.numDocModificado)}</numDocModificado>`,
    `<fechaEmisionDocSustento>${n.fechaEmisionDocSustento}</fechaEmisionDocSustento>`,
    `<totalSinImpuestos>${money2(n.totalSinImpuestos)}</totalSinImpuestos>`,
    `<valorModificacion>${money2(n.valorModificacion)}</valorModificacion>`,
    `<moneda>${n.moneda ?? 'DOLAR'}</moneda>`,
    `<totalConImpuestos>${n.totalConImpuestos
      .map(
        (t) =>
          `<totalImpuesto><codigo>${t.codigo}</codigo><codigoPorcentaje>${t.codigoPorcentaje}</codigoPorcentaje>` +
          `<baseImponible>${money2(t.baseImponible)}</baseImponible><valor>${money2(t.valor)}</valor></totalImpuesto>`,
      )
      .join('')}</totalConImpuestos>`,
    `<motivo>${escapeXml(n.motivo)}</motivo>`,
  ].join('');
  const inner =
    `<notaCredito id="comprobante" version="1.1.0">` +
    infoTributaria(input.infoTributaria) +
    `<infoNotaCredito>${info}</infoNotaCredito>` +
    `<detalles>${input.detalles.map(detalleXml).join('')}</detalles>` +
    infoAdicionalXml(input.infoAdicional) +
    `</notaCredito>`;
  return xmlDocument(inner);
}

/* ------------------------------------------------------------- NOTA DE DÉBITO */

export interface NotaDebitoInput {
  infoTributaria: XmlInfoTributaria;
  infoNotaDebito: {
    fechaEmision: string;
    dirEstablecimiento?: string | null;
    tipoIdentificacionComprador: string;
    razonSocialComprador: string;
    identificacionComprador: string;
    contribuyenteEspecial?: string | null;
    obligadoContabilidad: 'SI' | 'NO';
    rise?: string | null;
    codDocModificado: string;
    numDocModificado: string;
    fechaEmisionDocSustento: string;
    totalSinImpuestos: number;
    impuestos: TaxLine[];
    valorTotal: number;
    pagos?: { formaPago: string; total: number }[];
    motivo: string;
  };
  infoAdicional?: { nombre: string; valor: string }[];
}

export function buildNotaDebitoXml(input: NotaDebitoInput): string {
  const n = input.infoNotaDebito;
  const info = [
    `<fechaEmision>${n.fechaEmision}</fechaEmision>`,
    n.dirEstablecimiento ? `<dirEstablecimiento>${escapeXml(n.dirEstablecimiento)}</dirEstablecimiento>` : '',
    `<tipoIdentificacionComprador>${n.tipoIdentificacionComprador}</tipoIdentificacionComprador>`,
    `<razonSocialComprador>${escapeXml(n.razonSocialComprador)}</razonSocialComprador>`,
    `<identificacionComprador>${escapeXml(n.identificacionComprador)}</identificacionComprador>`,
    n.contribuyenteEspecial ? `<contribuyenteEspecial>${escapeXml(n.contribuyenteEspecial)}</contribuyenteEspecial>` : '',
    `<obligadoContabilidad>${n.obligadoContabilidad}</obligadoContabilidad>`,
    n.rise ? `<rise>${escapeXml(n.rise)}</rise>` : '',
    `<codDocModificado>${n.codDocModificado}</codDocModificado>`,
    `<numDocModificado>${escapeXml(n.numDocModificado)}</numDocModificado>`,
    `<fechaEmisionDocSustento>${n.fechaEmisionDocSustento}</fechaEmisionDocSustento>`,
    `<totalSinImpuestos>${money2(n.totalSinImpuestos)}</totalSinImpuestos>`,
    `<impuestos>${n.impuestos
      .map(
        (t) =>
          `<impuesto><codigo>${t.codigo}</codigo><codigoPorcentaje>${t.codigoPorcentaje}</codigoPorcentaje>` +
          `<tarifa>${money2(t.tarifa)}</tarifa><baseImponible>${money2(t.baseImponible)}</baseImponible>` +
          `<valor>${money2(t.valor)}</valor></impuesto>`,
      )
      .join('')}</impuestos>`,
    `<valorTotal>${money2(n.valorTotal)}</valorTotal>`,
    n.pagos?.length
      ? `<pagos>${n.pagos
          .map((p) => `<pago><formaPago>${p.formaPago}</formaPago><total>${money2(p.total)}</total></pago>`)
          .join('')}</pagos>`
      : '',
    `<motivo>${escapeXml(n.motivo)}</motivo>`,
  ].join('');
  const inner =
    `<notaDebito id="comprobante" version="1.0.0">` +
    infoTributaria(input.infoTributaria) +
    `<infoNotaDebito>${info}</infoNotaDebito>` +
    infoAdicionalXml(input.infoAdicional) +
    `</notaDebito>`;
  return xmlDocument(inner);
}

/* --------------------------------------------------------- COMPROBANTE RETENCIÓN */

export interface RetencionInput {
  infoTributaria: XmlInfoTributaria;
  infoCompRetencion: {
    fechaEmision: string;
    dirEstablecimiento?: string | null;
    contribuyenteEspecial?: string | null;
    obligadoContabilidad: 'SI' | 'NO';
    tipoIdentificacionSujetoRetenido: string;
    razonSocialSujetoRetenido: string;
    identificacionSujetoRetenido: string;
    periodoFiscal: string; // mm/aaaa
  };
  docsSustento: {
    codSustento: string;
    codDocSustento: string;
    numDocSustento: string;
    fechaEmisionDocSustento: string;
    numAutDocSustento: string;
    pagoLocExt: string;
    totalSinImpuestos: number;
    importeTotal: number;
    impuestosDocSustento: { codImpuestoDocSustento: string; codigoPorcentaje: string; baseImponible: number; tarifa: number; valorImpuesto: number }[];
    retenciones: { codigo: string; codigoPorcentaje: string; tarifa: number; baseImponible: number; valorRetenido: number }[];
  }[];
}

export function buildRetencionXml(input: RetencionInput): string {
  const i = input.infoCompRetencion;
  const info = [
    `<fechaEmision>${i.fechaEmision}</fechaEmision>`,
    i.dirEstablecimiento ? `<dirEstablecimiento>${escapeXml(i.dirEstablecimiento)}</dirEstablecimiento>` : '',
    i.contribuyenteEspecial ? `<contribuyenteEspecial>${escapeXml(i.contribuyenteEspecial)}</contribuyenteEspecial>` : '',
    `<obligadoContabilidad>${i.obligadoContabilidad}</obligadoContabilidad>`,
    `<tipoIdentificacionSujetoRetenido>${i.tipoIdentificacionSujetoRetenido}</tipoIdentificacionSujetoRetenido>`,
    `<razonSocialSujetoRetenido>${escapeXml(i.razonSocialSujetoRetenido)}</razonSocialSujetoRetenido>`,
    `<identificacionSujetoRetenido>${escapeXml(i.identificacionSujetoRetenido)}</identificacionSujetoRetenido>`,
    `<periodoFiscal>${i.periodoFiscal}</periodoFiscal>`,
  ].join('');
  const docs = input.docsSustento
    .map(
      (d) =>
        `<docSustento>` +
        `<codSustento>${d.codSustento}</codSustento>` +
        `<codDocSustento>${d.codDocSustento}</codDocSustento>` +
        `<numDocSustento>${escapeXml(d.numDocSustento)}</numDocSustento>` +
        `<fechaEmisionDocSustento>${d.fechaEmisionDocSustento}</fechaEmisionDocSustento>` +
        `<numAutDocSustento>${escapeXml(d.numAutDocSustento)}</numAutDocSustento>` +
        `<pagoLocExt>${d.pagoLocExt}</pagoLocExt>` +
        `<totalSinImpuestos>${money2(d.totalSinImpuestos)}</totalSinImpuestos>` +
        `<importeTotal>${money2(d.importeTotal)}</importeTotal>` +
        `<impuestosDocSustento>${d.impuestosDocSustento
          .map(
            (x) =>
              `<impuestoDocSustento><codImpuestoDocSustento>${x.codImpuestoDocSustento}</codImpuestoDocSustento>` +
              `<codigoPorcentaje>${x.codigoPorcentaje}</codigoPorcentaje>` +
              `<baseImponible>${money2(x.baseImponible)}</baseImponible><tarifa>${money2(x.tarifa)}</tarifa>` +
              `<valorImpuesto>${money2(x.valorImpuesto)}</valorImpuesto></impuestoDocSustento>`,
          )
          .join('')}</impuestosDocSustento>` +
        `<retenciones>${d.retenciones
          .map(
            (r) =>
              `<retencion><codigo>${r.codigo}</codigo><codigoPorcentaje>${r.codigoPorcentaje}</codigoPorcentaje>` +
              `<tarifa>${money2(r.tarifa)}</tarifa><baseImponible>${money2(r.baseImponible)}</baseImponible>` +
              `<valorRetenido>${money2(r.valorRetenido)}</valorRetenido></retencion>`,
          )
          .join('')}</retenciones>` +
        `</docSustento>`,
    )
    .join('');
  const inner =
    `<comprobanteRetencion id="comprobante" version="1.0.0">` +
    infoTributaria(input.infoTributaria) +
    `<infoCompRetencion>${info}</infoCompRetencion>` +
    `<docsSustento>${docs}</docsSustento>` +
    `</comprobanteRetencion>`;
  return xmlDocument(inner);
}

/* ---------------------------------------------------------- GUÍA DE REMISIÓN */

export interface GuiaRemisionInput {
  infoTributaria: XmlInfoTributaria;
  infoGuiaRemision: {
    dirEstablecimiento?: string | null;
    dirPartida: string;
    razonSocialTransportista: string;
    tipoIdentificacionTransportista: string;
    rucTransportista: string;
    rise?: string | null;
    obligadoContabilidad: 'SI' | 'NO';
    contribuyenteEspecial?: string | null;
    fechaIniTransporte: string;
    fechaFinTransporte: string;
    placa: string;
  };
  destinatarios: {
    identificacionDestinatario: string;
    razonSocialDestinatario: string;
    dirDestinatario: string;
    motivoTraslado: string;
    docAduaneroUnico?: string | null;
    codEstabDestino?: string | null;
    ruta?: string | null;
    codDocSustento?: string | null;
    numDocSustento?: string | null;
    numAutDocSustento?: string | null;
    fechaEmisionDocSustento?: string | null;
    detalles: { codigoInterno: string; descripcion: string; cantidad: number }[];
  }[];
}

export function buildGuiaRemisionXml(input: GuiaRemisionInput): string {
  const i = input.infoGuiaRemision;
  const info = [
    i.dirEstablecimiento ? `<dirEstablecimiento>${escapeXml(i.dirEstablecimiento)}</dirEstablecimiento>` : '',
    `<dirPartida>${escapeXml(i.dirPartida)}</dirPartida>`,
    `<razonSocialTransportista>${escapeXml(i.razonSocialTransportista)}</razonSocialTransportista>`,
    `<tipoIdentificacionTransportista>${i.tipoIdentificacionTransportista}</tipoIdentificacionTransportista>`,
    `<rucTransportista>${escapeXml(i.rucTransportista)}</rucTransportista>`,
    i.rise ? `<rise>${escapeXml(i.rise)}</rise>` : '',
    `<obligadoContabilidad>${i.obligadoContabilidad}</obligadoContabilidad>`,
    i.contribuyenteEspecial ? `<contribuyenteEspecial>${escapeXml(i.contribuyenteEspecial)}</contribuyenteEspecial>` : '',
    `<fechaIniTransporte>${i.fechaIniTransporte}</fechaIniTransporte>`,
    `<fechaFinTransporte>${i.fechaFinTransporte}</fechaFinTransporte>`,
    `<placa>${escapeXml(i.placa)}</placa>`,
  ].join('');
  const destinatarios = input.destinatarios
    .map(
      (d) =>
        `<destinatario>` +
        `<identificacionDestinatario>${escapeXml(d.identificacionDestinatario)}</identificacionDestinatario>` +
        `<razonSocialDestinatario>${escapeXml(d.razonSocialDestinatario)}</razonSocialDestinatario>` +
        `<dirDestinatario>${escapeXml(d.dirDestinatario)}</dirDestinatario>` +
        `<motivoTraslado>${escapeXml(d.motivoTraslado)}</motivoTraslado>` +
        (d.docAduaneroUnico ? `<docAduaneroUnico>${escapeXml(d.docAduaneroUnico)}</docAduaneroUnico>` : '') +
        (d.codEstabDestino ? `<codEstabDestino>${escapeXml(d.codEstabDestino)}</codEstabDestino>` : '') +
        (d.ruta ? `<ruta>${escapeXml(d.ruta)}</ruta>` : '') +
        (d.codDocSustento ? `<codDocSustento>${d.codDocSustento}</codDocSustento>` : '') +
        (d.numDocSustento ? `<numDocSustento>${escapeXml(d.numDocSustento)}</numDocSustento>` : '') +
        (d.numAutDocSustento ? `<numAutDocSustento>${escapeXml(d.numAutDocSustento)}</numAutDocSustento>` : '') +
        (d.fechaEmisionDocSustento
          ? `<fechaEmisionDocSustento>${d.fechaEmisionDocSustento}</fechaEmisionDocSustento>`
          : '') +
        `<detalles>${d.detalles
          .map(
            (x) =>
              `<detalle><codigoInterno>${escapeXml(x.codigoInterno)}</codigoInterno>` +
              `<descripcion>${escapeXml(x.descripcion)}</descripcion>` +
              `<cantidad>${qty(x.cantidad)}</cantidad></detalle>`,
          )
          .join('')}</detalles>` +
        `</destinatario>`,
    )
    .join('');
  const inner =
    `<guiaRemision id="comprobante" version="1.1.0">` +
    infoTributaria(input.infoTributaria) +
    `<infoGuiaRemision>${info}</infoGuiaRemision>` +
    `<destinatarios>${destinatarios}</destinatarios>` +
    `</guiaRemision>`;
  return xmlDocument(inner);
}

/** Extrae el cuerpo del documento sin la declaración XML (para canonicalización). */
export function documentBody(xml: string): string {
  const idx = xml.indexOf('?>');
  const body = idx >= 0 ? xml.slice(idx + 2) : xml;
  return body.trim();
}
