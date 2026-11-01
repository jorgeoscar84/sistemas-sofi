/** Integración: driver UpConta (mismo servicio identificado) y tokens de API. */

import { ApiError, Router, bodyOf, randomToken, requireTenant, requireUser, sha256, str } from '../http.ts';
import { execute, nowIso, pAll, pExec, pOne } from '../db.ts';
import { newId } from '../ids.ts';
import { companyDto, getCompany } from './company.ts';
import fs from 'node:fs';
import path from 'node:path';
import { SRI_ENDPOINTS } from '../../../../packages/shared/src/index.ts';
import { inspectSigningMaterial, probarConectividadSri } from '../../../../packages/sri/src/index.ts';

export function registerIntegrationRoutes(router: Router): void {
  router.get('/api/integration/upconta', 'company:read', () => {
    const company = getCompany();
    return {
      mode: company.sri_mode,
      baseUrl: company.upconta_base_url ?? 'https://api.upconta.com',
      token: company.upconta_token ? '********' : null,
      ruc: company.upconta_ruc,
      estab: company.upconta_estab,
      ptoEmi: company.upconta_pto_emi,
      environment: company.environment,
      documentation: 'https://docs.upconta.com/api/administrative/vouchers/invoices.html',
    };
  });

  router.put('/api/integration/upconta', 'company:write', (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const company = getCompany();
    const token = body.token !== undefined && body.token !== '********' ? str(body.token, 'token') || null : company.upconta_token;
    execute(
      'UPDATE company SET upconta_base_url=?, upconta_token=?, upconta_ruc=?, upconta_estab=?, upconta_pto_emi=?, updated_at=? WHERE id=?',
      [
        body.baseUrl !== undefined ? str(body.baseUrl, 'baseUrl') || null : company.upconta_base_url,
        token,
        body.ruc !== undefined ? str(body.ruc, 'ruc') || null : company.upconta_ruc,
        body.estab !== undefined ? str(body.estab, 'estab') || null : company.upconta_estab,
        body.ptoEmi !== undefined ? str(body.ptoEmi, 'ptoEmi') || null : company.upconta_pto_emi,
        nowIso(),
        company.id,
      ],
    );
    void auth;
    return companyDto(getCompany()).upconta;
  });

  router.post('/api/integration/upconta/test', 'company:write', async () => {
    const company = getCompany();
    const baseUrl = (company.upconta_base_url ?? 'https://api.upconta.com').replace(/\/$/, '');
    if (!company.upconta_token) throw ApiError.badRequest('Configure el token de integración de UpConta');
    try {
      const response = await fetch(`${baseUrl}/v4/auth/user`, {
        headers: { Authorization: company.upconta_token },
      });
      const text = await response.text();
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = { message: text };
      }
      return {
        ok: response.ok,
        status: response.status,
        baseUrl,
        business: data.business ?? null,
        ruc: data.ruc ?? null,
        message: response.ok ? 'Conexión verificada con el servicio de facturación electrónica' : String(data.message ?? text),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        baseUrl,
        message: error instanceof Error ? error.message : 'No se pudo conectar',
      };
    }
  });

  /* ------------------------------------------------- conectividad SRI */

  router.get('/api/integration/sri/status', 'company:read', () => {
    const company = getCompany();
    const certificateDir = company.certificate_path;
    let certificate = null;
    if (certificateDir && fs.existsSync(path.join(certificateDir, 'certificate.pem'))) {
      try {
        certificate = inspectSigningMaterial(
          fs.readFileSync(path.join(certificateDir, 'certificate.pem'), 'utf8'),
          fs.readFileSync(path.join(certificateDir, 'private-key.pem'), 'utf8'),
        );
      } catch {
        certificate = null;
      }
    }
    return {
      mode: company.sri_mode,
      environment: company.environment,
      environmentLabel: company.environment === 2 ? 'Producción' : 'Pruebas',
      endpoints: SRI_ENDPOINTS[company.environment === 2 ? 2 : 1],
      hasSignature: Boolean(certificate),
      certificate,
      note:
        company.sri_mode === 'mock'
          ? 'Modo simulado: los comprobantes se autorizan localmente.'
          : company.sri_mode === 'direct-sri'
            ? 'Modo direct-sri: se firma con el certificado y se envían los comprobantes a los servicios web del SRI.'
            : 'Modo UpConta: la emisión se delega en el servicio externo configurado.',
    };
  });

  router.post('/api/integration/sri/test', 'company:write', async () => {
    const company = getCompany();
    const ambiente = company.environment === 2 ? 2 : 1;
    const connectivity = await probarConectividadSri(ambiente);
    const certificateDir = company.certificate_path;
    let certificateOk = false;
    let certificate = null;
    if (certificateDir && fs.existsSync(path.join(certificateDir, 'certificate.pem'))) {
      try {
        certificate = inspectSigningMaterial(
          fs.readFileSync(path.join(certificateDir, 'certificate.pem'), 'utf8'),
          fs.readFileSync(path.join(certificateDir, 'private-key.pem'), 'utf8'),
        );
        certificateOk = !certificate.expired;
      } catch {
        certificateOk = false;
      }
    }
    return {
      ok: connectivity.ok,
      ambiente,
      ambienteLabel: ambiente === 2 ? 'Producción' : 'Pruebas',
      servicioRecepcion: SRI_ENDPOINTS[ambiente].recepcion,
      httpStatus: connectivity.status ?? null,
      latencyMs: connectivity.ms,
      error: connectivity.error ?? null,
      certificado: certificate,
      certificadoValido: certificateOk,
      modo: company.sri_mode,
      recomendacion:
        company.sri_mode === 'direct-sri' && !certificateOk
          ? 'Cargue un certificado válido en Administración → Empresa y SRI.'
          : null,
    };
  });

  /* -------------------------------------------------------- API tokens */

  router.get('/api/integration/tokens', 'company:read', (ctx) => {
    const companyId = requireTenant(ctx);
    return pAll<Record<string, unknown>>(
      'SELECT id, name, status, created_at FROM platform_api_tokens WHERE company_id = ? ORDER BY created_at DESC',
      [companyId],
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      status: String(row.status),
      createdAt: String(row.created_at),
    }));
  });

  router.post('/api/integration/tokens', 'company:write', (ctx) => {
    const companyId = requireTenant(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const name = str(body.name, 'name', { required: true, max: 120 });
    const token = randomToken(24);
    const id = newId();
    pExec('INSERT INTO platform_api_tokens (id, company_id, name, token_hash, status, created_at) VALUES (?,?,?,?,?,?)', [
      id,
      companyId,
      name,
      sha256(token),
      'active',
      nowIso(),
    ]);
    return {
      id,
      name,
      token,
      message: 'Guarde este token: no se volverá a mostrar. Úselo con "Authorization: ApiToken <token>".',
    };
  });

  router.delete('/api/integration/tokens/:id', 'company:write', (ctx) => {
    const companyId = requireTenant(ctx);
    const row = pOne('SELECT id FROM platform_api_tokens WHERE id = ? AND company_id = ?', [ctx.params.id, companyId]);
    if (!row) throw ApiError.notFound('Token no encontrado');
    pExec("UPDATE platform_api_tokens SET status = 'revoked' WHERE id = ? AND company_id = ?", [ctx.params.id, companyId]);
    return { message: 'Token revocado' };
  });
}

