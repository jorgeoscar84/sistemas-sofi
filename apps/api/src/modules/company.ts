/** Empresa, establecimientos, puntos de emisión, certificado y catálogos SRI. */

import fs from 'node:fs';
import path from 'node:path';
import { buildCatalogs, CONSUMIDOR_FINAL } from '../../../../packages/shared/src/index.ts';
import { inspectSigningMaterial, parseP12 } from '../../../../packages/sri/src/index.ts';
import { config } from '../config.ts';
import { ApiError, Router, bodyOf, requireUser, str } from '../http.ts';
import { audit, camel, camelAll, execute, nowIso, pExec, pOne, queryAll, queryOne } from '../db.ts';
import { newId } from '../ids.ts';
import { licenseDto, type PlatformCompanyRow } from '../licensing.ts';

interface CompanyRow {
  id: string;
  ruc: string;
  name: string;
  trade_name: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  obliged_accounting: number;
  rimpe: string | null;
  agent_retention: string | null;
  environment: number;
  sri_mode: string;
  signature_digest: string;
  certificate_path: string | null;
  certificate_password_enc: string | null;
  upconta_base_url: string | null;
  upconta_token: string | null;
  upconta_ruc: string | null;
  upconta_estab: string | null;
  upconta_pto_emi: string | null;
  created_at: string;
  updated_at: string;
}

const SEQUENCE_FIELDS = [
  'seq_invoice',
  'seq_credit_note',
  'seq_debit_note',
  'seq_retention',
  'seq_waybill',
  'seq_sales_note',
] as const;

export function getCompany(): CompanyRow {
  let row = queryOne<CompanyRow>('SELECT * FROM company LIMIT 1');
  if (!row) {
    const id = newId();
    execute(
      `INSERT INTO company (id, ruc, name, trade_name, address, email, phone, obliged_accounting, rimpe, agent_retention,
        environment, sri_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, '9999999999999', 'MI EMPRESA', 'MI EMPRESA', 'Quito - Ecuador', null, null, 0, null, null, 1, 'mock', nowIso(), nowIso()],
    );
    row = queryOne<CompanyRow>('SELECT * FROM company LIMIT 1')!;
  }
  return row;
}

export function companyDto(row: CompanyRow) {
  const platformRow = pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [row.id]);
  return {
    id: row.id,
    ruc: row.ruc,
    name: row.name,
    tradeName: row.trade_name,
    address: row.address,
    email: row.email,
    phone: row.phone,
    obligedAccounting: Boolean(row.obliged_accounting),
    rimpe: row.rimpe,
    agentRetention: row.agent_retention,
    environment: row.environment,
    sriMode: row.sri_mode,
    signatureDigest: row.signature_digest ?? 'sha1',
    hasSignature: Boolean(row.certificate_path && fs.existsSync(row.certificate_path)),
    upconta: {
      baseUrl: row.upconta_base_url,
      token: row.upconta_token ? '********' : null,
      ruc: row.upconta_ruc,
      estab: row.upconta_estab,
      ptoEmi: row.upconta_pto_emi,
    },
    license: licenseDto(platformRow ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getEstablishments() {
  const rows = queryAll<Record<string, unknown>>('SELECT * FROM establishments ORDER BY code ASC');
  return rows.map((est) => {
    const points = queryAll<Record<string, unknown>>(
      'SELECT * FROM emission_points WHERE establishment_id = ? ORDER BY code ASC',
      [est.id],
    ).map((point) => ({
      id: String(point.id),
      establishmentId: String(point.establishment_id),
      code: String(point.code),
      name: String(point.name),
      status: String(point.status),
      sequences: Object.fromEntries(SEQUENCE_FIELDS.map((field) => [SEQUENCE_LABELS[field] ?? toCamelSequence(field), Number(point[field] ?? 1)])),
    }));
    return {
      id: String(est.id),
      code: String(est.code),
      name: String(est.name),
      address: est.address ? String(est.address) : null,
      status: String(est.status),
      emissionPoints: points,
    };
  });
}

const SEQUENCE_LABELS: Record<string, string> = {
  seq_invoice: 'invoice',
  seq_credit_note: 'creditNote',
  seq_debit_note: 'debitNote',
  seq_retention: 'retentionReceipt',
  seq_waybill: 'waybill',
  seq_sales_note: 'salesNote',
};

function toCamelSequence(field: string): string {
  return field.replace('seq_', '').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function registerCompanyRoutes(router: Router): void {
  router.get('/api/company', 'company:read', () => companyDto(getCompany()));

  router.put('/api/company', 'company:write', (ctx) => {
    const auth = requireUser(ctx);
    const row = getCompany();
    const body = bodyOf<Record<string, unknown>>(ctx);
    const environment = body.environment !== undefined ? Number(body.environment) : row.environment;
    if (environment !== 1 && environment !== 2) throw ApiError.badRequest('Ambiente del SRI inválido (1=pruebas, 2=producción)');
    if (environment === 2 && row.environment !== 2 && body.confirmProduction !== true) {
      throw ApiError.badRequest(
        'El ambiente de PRODUCCIÓN emite comprobantes con valor tributario. Envíe confirmProduction=true para confirmar el cambio.',
      );
    }
    const mode = body.sriMode !== undefined ? String(body.sriMode) : row.sri_mode;
    if (!['mock', 'direct-sri', 'upconta'].includes(mode)) throw ApiError.badRequest('Modo de emisión inválido');
    const signatureDigest = body.signatureDigest !== undefined ? String(body.signatureDigest) : row.signature_digest;
    if (!['sha1', 'sha256'].includes(signatureDigest)) throw ApiError.badRequest('Algoritmo de firma inválido (sha1|sha256)');
    const upconta = (body.upconta ?? {}) as Record<string, unknown>;

    const newRuc = body.ruc !== undefined ? str(body.ruc, 'ruc', { required: true }) : row.ruc;
    if (!/^\d{13}$/.test(newRuc)) {
      throw ApiError.badRequest('El RUC debe tener 13 dígitos numéricos');
    }
    const newName = body.name !== undefined ? str(body.name, 'name', { required: true }) : row.name;
    const newTradeName = body.tradeName !== undefined ? str(body.tradeName, 'tradeName') || null : row.trade_name;
    const newAddress = body.address !== undefined ? str(body.address, 'address') || null : row.address;
    const newEmail = body.email !== undefined ? str(body.email, 'email') || null : row.email;
    const newPhone = body.phone !== undefined ? str(body.phone, 'phone') || null : row.phone;
    // El RUC identifica a la empresa/licencia en la plataforma: validarlo antes de guardar
    // para no exponer nunca un error de restricción SQL.
    const rucOwner = pOne<{ id: string }>('SELECT id FROM platform_companies WHERE ruc = ?', [newRuc]);
    if (rucOwner && rucOwner.id !== row.id) {
      throw ApiError.conflict(
        `Ya existe otra empresa/licencia con el RUC ${newRuc}. Use un RUC diferente o edite la empresa existente.`,
      );
    }

    execute(
      `UPDATE company SET ruc=?, name=?, trade_name=?, address=?, email=?, phone=?, obliged_accounting=?, rimpe=?,
        agent_retention=?, environment=?, sri_mode=?, signature_digest=?, upconta_base_url=?, upconta_token=?,
        upconta_ruc=?, upconta_estab=?, upconta_pto_emi=?, updated_at=? WHERE id=?`,
      [
        newRuc,
        newName,
        newTradeName,
        newAddress,
        newEmail,
        newPhone,
        body.obligedAccounting !== undefined ? (body.obligedAccounting ? 1 : 0) : row.obliged_accounting,
        body.rimpe !== undefined ? str(body.rimpe, 'rimpe') || null : row.rimpe,
        body.agentRetention !== undefined ? str(body.agentRetention, 'agentRetention') || null : row.agent_retention,
        environment,
        mode,
        signatureDigest,
        upconta.baseUrl !== undefined ? str(upconta.baseUrl, 'upconta.baseUrl') || null : row.upconta_base_url,
        upconta.token !== undefined && upconta.token !== '********'
          ? str(upconta.token, 'upconta.token') || null
          : row.upconta_token,
        upconta.ruc !== undefined ? str(upconta.ruc, 'upconta.ruc') || null : row.upconta_ruc,
        upconta.estab !== undefined ? str(upconta.estab, 'upconta.estab') || null : row.upconta_estab,
        upconta.ptoEmi !== undefined ? str(upconta.ptoEmi, 'upconta.ptoEmi') || null : row.upconta_pto_emi,
        nowIso(),
        row.id,
      ],
    );
    // Mantener sincronizados los datos maestros en la licencia (plataforma).
    try {
      pExec(
        'UPDATE platform_companies SET ruc=?, name=?, trade_name=?, email=?, phone=?, address=?, updated_at=? WHERE id=?',
        [newRuc, newName, newTradeName, newEmail, newPhone, newAddress, nowIso(), row.id],
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw ApiError.conflict(`Ya existe otra empresa/licencia con el RUC ${newRuc}.`);
      }
      throw error;
    }
    audit('company', row.id, 'edit', `Configuración actualizada por ${auth.name}`, auth.id);
    return companyDto(getCompany());
  });

  router.get('/api/company/establishments', 'company:read', () => getEstablishments());

  router.post('/api/company/establishments', 'company:write', (ctx) => {
    const body = bodyOf<Record<string, unknown>>(ctx);
    const code = str(body.code, 'code', { required: true, max: 3 });
    if (!/^\d{3}$/.test(code)) throw ApiError.badRequest('El código de establecimiento debe tener 3 dígitos');
    if (queryOne('SELECT id FROM establishments WHERE code = ?', [code])) {
      throw ApiError.conflict('Ya existe un establecimiento con ese código');
    }
    const id = newId();
    execute('INSERT INTO establishments (id, code, name, address, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [
      id,
      code,
      str(body.name, 'name', { required: true }),
      str(body.address, 'address') || null,
      'active',
      nowIso(),
      nowIso(),
    ]);
    return getEstablishments().find((e) => e.id === id);
  });

  router.put('/api/company/establishments/:id', 'company:write', (ctx) => {
    const row = queryOne('SELECT * FROM establishments WHERE id = ?', [ctx.params.id]);
    if (!row) throw ApiError.notFound('Establecimiento no encontrado');
    const body = bodyOf<Record<string, unknown>>(ctx);
    execute('UPDATE establishments SET name=?, address=?, status=?, updated_at=? WHERE id=?', [
      body.name !== undefined ? str(body.name, 'name', { required: true }) : row.name,
      body.address !== undefined ? str(body.address, 'address') || null : row.address,
      body.status !== undefined ? str(body.status, 'status') : row.status,
      nowIso(),
      ctx.params.id,
    ]);
    return getEstablishments().find((e) => e.id === ctx.params.id);
  });

  router.delete('/api/company/establishments/:id', 'company:write', (ctx) => {
    const points = queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM emission_points WHERE establishment_id = ?', [
      ctx.params.id,
    ]);
    if ((points?.total ?? 0) > 0) throw ApiError.badRequest('No se puede eliminar: tiene puntos de emisión');
    const used = queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM vouchers WHERE establishment_id = ?', [
      ctx.params.id,
    ]);
    if ((used?.total ?? 0) > 0) throw ApiError.badRequest('No se puede eliminar: tiene comprobantes emitidos');
    execute('DELETE FROM establishments WHERE id = ?', [ctx.params.id]);
    return { message: 'Establecimiento eliminado' };
  });

  router.post('/api/company/establishments/:id/emission-points', 'company:write', (ctx) => {
    const establishment = queryOne('SELECT * FROM establishments WHERE id = ?', [ctx.params.id]);
    if (!establishment) throw ApiError.notFound('Establecimiento no encontrado');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const code = str(body.code, 'code', { required: true, max: 3 });
    if (!/^\d{3}$/.test(code)) throw ApiError.badRequest('El código del punto de emisión debe tener 3 dígitos');
    if (
      queryOne('SELECT id FROM emission_points WHERE establishment_id = ? AND code = ?', [ctx.params.id, code])
    ) {
      throw ApiError.conflict('Ya existe un punto de emisión con ese código en el establecimiento');
    }
    const id = newId();
    execute(
      `INSERT INTO emission_points (id, establishment_id, code, name, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      [id, ctx.params.id, code, str(body.name, 'name', { required: true }) || 'Punto de emisión', 'active', nowIso(), nowIso()],
    );
    return getEstablishments().find((e) => e.id === ctx.params.id);
  });

  router.put('/api/company/emission-points/:id', 'company:write', (ctx) => {
    const row = queryOne('SELECT * FROM emission_points WHERE id = ?', [ctx.params.id]);
    if (!row) throw ApiError.notFound('Punto de emisión no encontrado');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const sequences = (body.sequences ?? {}) as Record<string, number>;
    const fieldMap: Record<string, string> = {
      invoice: 'seq_invoice',
      creditNote: 'seq_credit_note',
      debitNote: 'seq_debit_note',
      retentionReceipt: 'seq_retention',
      waybill: 'seq_waybill',
      salesNote: 'seq_sales_note',
    };
    execute(
      `UPDATE emission_points SET name=?, status=?, seq_invoice=?, seq_credit_note=?, seq_debit_note=?,
        seq_retention=?, seq_waybill=?, seq_sales_note=?, updated_at=? WHERE id=?`,
      [
        body.name !== undefined ? str(body.name, 'name', { required: true }) : row.name,
        body.status !== undefined ? str(body.status, 'status') : row.status,
        ...Object.values(fieldMap).map((field) => {
          const key = Object.entries(fieldMap).find(([, value]) => value === field)?.[0] ?? field;
          const value = sequences[key];
          return value !== undefined ? Math.max(1, Number(value) || 1) : Number(row[field] ?? 1);
        }),
        nowIso(),
        ctx.params.id,
      ],
    );
    return getEstablishments();
  });

  router.delete('/api/company/emission-points/:id', 'company:write', (ctx) => {
    const used = queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM vouchers WHERE emission_point_id = ?', [
      ctx.params.id,
    ]);
    if ((used?.total ?? 0) > 0) throw ApiError.badRequest('No se puede eliminar: el punto de emisión tiene comprobantes');
    execute('DELETE FROM emission_points WHERE id = ?', [ctx.params.id]);
    return { message: 'Punto de emisión eliminado' };
  });

  /* --------------------------------------------------------- certificado */

  router.post('/api/company/certificate', 'company:write', (ctx) => {
    const body = bodyOf<Record<string, unknown>>(ctx);
    let certificatePem = str(body.certificatePem, 'certificatePem');
    let privateKeyPem = str(body.privateKeyPem, 'privateKeyPem');
    let source = 'pem';
    if (!certificatePem || !privateKeyPem) {
      const p12Base64 = str(body.p12Base64, 'p12Base64');
      const password = String(body.password ?? '');
      if (!p12Base64) {
        throw ApiError.badRequest('Envíe el certificado y la clave en PEM, o un archivo PKCS#12 (.p12) en base64 con su contraseña');
      }
      let parsed;
      try {
        parsed = parseP12(Buffer.from(p12Base64, 'base64'), password);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw ApiError.badRequest(
          `No se pudo leer el archivo PKCS#12. Verifique que el archivo no esté dañado y que la contraseña sea correcta. ` +
            `Detalle técnico: ${detail}. Si persiste, exporte el certificado y la clave a PEM (BEGIN CERTIFICATE / BEGIN PRIVATE KEY) y cárguelos manualmente.`,
        );
      }
      certificatePem = parsed.certificatePem;
      privateKeyPem = parsed.privateKeyPem;
      source = 'p12';
    }
    if (!certificatePem.includes('BEGIN CERTIFICATE')) {
      throw ApiError.badRequest('El certificado debe estar en formato PEM (BEGIN CERTIFICATE)');
    }
    if (!privateKeyPem.includes('BEGIN') || !privateKeyPem.includes('PRIVATE KEY')) {
      throw ApiError.badRequest('La clave privada debe estar en formato PEM (BEGIN PRIVATE KEY / BEGIN RSA PRIVATE KEY)');
    }
    const info = inspectSigningMaterial(certificatePem, privateKeyPem);
    if (info.expired) throw ApiError.badRequest(`El certificado está vencido (válido hasta ${info.validTo})`);
    const company = getCompany();
    const base = path.join(config.certDir, company.id);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'certificate.pem'), certificatePem, 'utf8');
    fs.writeFileSync(path.join(base, 'private-key.pem'), privateKeyPem, 'utf8');
    const meta = { ...info, source, uploadedAt: nowIso() };
    fs.writeFileSync(path.join(base, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    execute('UPDATE company SET certificate_path = ?, updated_at = ? WHERE id = ?', [base, nowIso(), company.id]);
    return { message: 'Certificado guardado', hasSignature: true, certificate: info, source };
  });

  router.get('/api/company/certificate/status', 'company:read', () => {
    const company = getCompany();
    const hasSignature = Boolean(company.certificate_path && fs.existsSync(company.certificate_path));
    const certificateFile = company.certificate_path ? path.join(company.certificate_path, 'certificate.pem') : null;
    const info =
      hasSignature && certificateFile && fs.existsSync(certificateFile)
        ? inspectSigningMaterial(
            fs.readFileSync(certificateFile, 'utf8'),
            fs.readFileSync(path.join(company.certificate_path!, 'private-key.pem'), 'utf8'),
          )
        : null;
    return { hasSignature, path: company.certificate_path, certificate: info };
  });

  /* ----------------------------------------------------------- catálogos */

  router.get('/api/catalogs', null, () => {
    const categories = camelAll(
      queryAll('SELECT id, name, parent_id FROM categories ORDER BY name ASC'),
    );
    const units = camelAll(queryAll('SELECT id, code, name, abbr FROM units ORDER BY name ASC'));
    return { ...buildCatalogs(), categories, units, consumidorFinal: CONSUMIDOR_FINAL };
  });
}

export { camel };




