/**
 * Módulo de plataforma (superadministrador): licencias/empresas y sus métricas.
 *
 * El superadministrador crea empresas (licencias), asigna su administrador,
 * activa/suspende/renueva licencias y puede entrar a configurar cualquier empresa.
 */

import {
  ApiError,
  Router,
  bodyOf,
  hashPassword,
  requireSuperadmin,
  str,
} from '../http.ts';
import { nowIso, pAll, pExec } from '../db.ts';
import { licenseDto, licenseState, type LicenseStatus, type PlatformCompanyRow } from '../licensing.ts';
import { newId } from '../ids.ts';
import {
  addCompanyUser,
  getPlatformCompany,
  provisionCompany,
  tenantCompanyConfig,
  tenantMetrics,
  tenantUsers,
  companyDatabasePath,
} from '../provisioning.ts';

const LICENSE_STATUSES: LicenseStatus[] = ['active', 'trial', 'suspended', 'expired'];
const PLANS = ['basico', 'profesional', 'empresarial'];

function licenseOf(company: PlatformCompanyRow) {
  return licenseDto(company);
}

function companyRow(company: PlatformCompanyRow) {
  const state = licenseState(company);
  return {
    id: company.id,
    ruc: company.ruc,
    name: company.name,
    tradeName: company.trade_name,
    email: company.email,
    phone: company.phone,
    address: company.address,
    adminUserId: company.admin_user_id,
    plan: company.license_plan,
    status: state.status,
    statusLabel: state.label,
    usable: state.usable,
    daysLeft: state.daysLeft,
    expiresAt: company.license_expires_at,
    notes: company.license_notes,
    paymentReference: company.payment_reference,
    createdAt: company.created_at,
    updatedAt: company.updated_at,
    databasePath: companyDatabasePath(company.id),
  };
}

function parseExpiry(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw ApiError.badRequest('Fecha de vencimiento inválida');
  return date.toISOString();
}

export function registerPlatformRoutes(router: Router): void {
  /* ------------------------------------------------------------- resumen */

  router.get('/api/platform/overview', null, (ctx) => {
    requireSuperadmin(ctx);
    const companies = pAll<PlatformCompanyRow>('SELECT * FROM platform_companies ORDER BY created_at DESC');
    let users = 0;
    let vouchers = 0;
    let products = 0;
    let issued = 0;
    const byStatus: Record<string, number> = { active: 0, trial: 0, suspended: 0, expired: 0 };
    for (const company of companies) {
      const state = licenseState(company);
      byStatus[state.status] = (byStatus[state.status] ?? 0) + 1;
      users += tenantUsers(company.id).length;
      const metrics = tenantMetrics(company.id);
      vouchers += metrics.vouchers;
      issued += metrics.issued;
      products += metrics.products;
    }
    return {
      totalCompanies: companies.length,
      byStatus,
      users,
      vouchers,
      issued,
      products,
      timestamp: nowIso(),
    };
  });

  /* --------------------------------------------------------- licencias */

  router.get('/api/platform/companies', null, (ctx) => {
    requireSuperadmin(ctx);
    const companies = pAll<PlatformCompanyRow>('SELECT * FROM platform_companies ORDER BY created_at DESC');
    return companies.map((company) => {
      const metrics = tenantMetrics(company.id);
      const config = tenantCompanyConfig(company.id);
      const users = tenantUsers(company.id);
      return {
        ...companyRow(company),
        license: licenseOf(company),
        metrics: {
          ...metrics,
          users: users.length,
        },
        config: config
          ? {
              ruc: String(config.ruc ?? ''),
              name: String(config.name ?? ''),
              environment: Number(config.environment ?? 1),
              sriMode: String(config.sri_mode ?? 'mock'),
              hasSignature: Boolean(config.certificate_path),
              signatureDigest: String(config.signature_digest ?? 'sha1'),
            }
          : null,
      };
    });
  });

  router.post('/api/platform/companies', null, (ctx) => {
    const auth = requireSuperadmin(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const ruc = str(body.ruc, 'ruc', { required: true });
    const name = str(body.name, 'name', { required: true, max: 200 });
    const adminUsername = str(body.adminUsername, 'adminUsername', { required: true });
    const adminPassword = str(body.adminPassword, 'adminPassword', { required: true });
    const adminName = str(body.adminName, 'adminName') || 'Administrador';
    const plan = (str(body.plan, 'plan') || 'basico').toLowerCase();
    if (!PLANS.includes(plan)) throw ApiError.badRequest(`Plan inválido. Use: ${PLANS.join(', ')}`);
    let licenseExpiresAt = parseExpiry(body.licenseExpiresAt);
    const licenseStatus = (str(body.licenseStatus, 'licenseStatus') || 'trial') as 'active' | 'trial';
    if (licenseStatus !== 'active' && licenseStatus !== 'trial') {
      throw ApiError.badRequest('La licencia nueva debe crearse como "trial" o "active"');
    }
    if (!licenseExpiresAt) {
      const days = Number(body.trialDays ?? 15);
      const base = new Date();
      base.setDate(base.getDate() + (Number.isFinite(days) && days > 0 ? days : 15));
      licenseExpiresAt = base.toISOString();
    }
    const environment = body.environment !== undefined ? Number(body.environment) : 1;
    if (environment !== 1 && environment !== 2) throw ApiError.badRequest('Ambiente inválido');

    const result = provisionCompany({
      ruc,
      name,
      tradeName: str(body.tradeName, 'tradeName') || undefined,
      email: str(body.email, 'email') || undefined,
      phone: str(body.phone, 'phone') || undefined,
      address: str(body.address, 'address') || undefined,
      environment,
      sriMode: 'mock',
      plan,
      licenseStatus,
      licenseExpiresAt,
      licenseNotes: str(body.licenseNotes, 'licenseNotes') || undefined,
      paymentReference: str(body.paymentReference, 'paymentReference') || undefined,
      createdBy: auth.id,
      adminUsername,
      adminPassword,
      adminName,
      adminEmail: str(body.adminEmail, 'adminEmail') || undefined,
    });
    pExec(
      'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [newId(), result.company.id, 'license', result.company.id, 'created', `Licencia creada por ${auth.name} (${plan})`, auth.id, nowIso()],
    );
    return {
      company: companyRow(result.company),
      license: licenseOf(result.company),
      admin: {
        id: result.admin.id,
        username: result.admin.username,
        name: result.admin.name,
        password: adminPassword,
        role: 'admin',
      },
      message: 'Empresa y licencia creadas. El administrador ya puede ingresar.',
    };
  });

  router.get('/api/platform/companies/:id', null, (ctx) => {
    requireSuperadmin(ctx);
    const company = getPlatformCompany(ctx.params.id);
    if (!company) throw ApiError.notFound('Empresa no encontrada');
    const config = tenantCompanyConfig(company.id);
    return {
      ...companyRow(company),
      license: licenseOf(company),
      config,
      users: tenantUsers(company.id).map((user) => ({
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status,
        createdAt: user.created_at,
      })),
      metrics: { ...tenantMetrics(company.id), users: tenantUsers(company.id).length },
    };
  });

  router.put('/api/platform/companies/:id/license', null, (ctx) => {
    const auth = requireSuperadmin(ctx);
    const company = getPlatformCompany(ctx.params.id);
    if (!company) throw ApiError.notFound('Empresa no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const status = body.status !== undefined ? (String(body.status) as LicenseStatus) : (company.license_status as LicenseStatus);
    if (!LICENSE_STATUSES.includes(status)) throw ApiError.badRequest('Estado de licencia inválido');
    const plan = (body.plan !== undefined ? String(body.plan) : company.license_plan).toLowerCase();
    if (!PLANS.includes(plan)) throw ApiError.badRequest(`Plan inválido. Use: ${PLANS.join(', ')}`);
    const expiresAt = body.expiresAt !== undefined ? parseExpiry(body.expiresAt) : company.license_expires_at;
    const notes = body.notes !== undefined ? String(body.notes) : company.license_notes;
    const paymentReference =
      body.paymentReference !== undefined ? String(body.paymentReference) : company.payment_reference;
    pExec(
      'UPDATE platform_companies SET license_status=?, license_plan=?, license_expires_at=?, license_notes=?, payment_reference=?, updated_at=? WHERE id=?',
      [status, plan, expiresAt, notes, paymentReference, nowIso(), company.id],
    );
    pExec(
      'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        newId(),
        company.id,
        'license',
        company.id,
        status === 'suspended' ? 'suspended' : 'updated',
        `Licencia ${status} · plan ${plan}${paymentReference ? ` · pago ${paymentReference}` : ''} (${auth.name})`,
        auth.id,
        nowIso(),
      ],
    );
    const updated = getPlatformCompany(company.id)!;
    return { company: companyRow(updated), license: licenseOf(updated) };
  });

  /** Gancho para automatizar la liberación cuando se detecte un pago. */
  router.post('/api/platform/companies/:id/activate', null, (ctx) => {
    const auth = requireSuperadmin(ctx);
    const company = getPlatformCompany(ctx.params.id);
    if (!company) throw ApiError.notFound('Empresa no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const paymentReference = str(body.paymentReference, 'paymentReference');
    const months = Number(body.months ?? 12);
    const base = company.license_expires_at && new Date(company.license_expires_at).getTime() > Date.now()
      ? new Date(company.license_expires_at)
      : new Date();
    base.setMonth(base.getMonth() + (Number.isFinite(months) && months > 0 ? months : 12));
    pExec(
      'UPDATE platform_companies SET license_status=?, license_expires_at=?, payment_reference=?, updated_at=? WHERE id=?',
      ['active', base.toISOString(), paymentReference || null, nowIso(), company.id],
    );
    pExec(
      'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [
        newId(),
        company.id,
        'license',
        company.id,
        'activated',
        `Licencia activada ${months} mes(es)${paymentReference ? ` · pago ${paymentReference}` : ''} (${auth.name})`,
        auth.id,
        nowIso(),
      ],
    );
    const updated = getPlatformCompany(company.id)!;
    return { company: companyRow(updated), license: licenseOf(updated) };
  });

  router.post('/api/platform/companies/:id/reset-admin-password', null, (ctx) => {
    const auth = requireSuperadmin(ctx);
    const company = getPlatformCompany(ctx.params.id);
    if (!company) throw ApiError.notFound('Empresa no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const password = str(body.password, 'password', { required: true });
    if (password.length < 6) throw ApiError.badRequest('La contraseña debe tener al menos 6 caracteres');
    const targetUserId = str(body.userId, 'userId') || company.admin_user_id || '';
    const user = targetUserId
      ? pAll<{ id: string }>('SELECT id FROM platform_users WHERE id = ? AND company_id = ?', [targetUserId, company.id])[0]
      : undefined;
    if (!user) throw ApiError.notFound('Administrador no encontrado');
    pExec('UPDATE platform_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(password), nowIso(), user.id]);
    pExec(
      'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [newId(), company.id, 'users', user.id, 'password-reset', `Contraseña restablecida por ${auth.name}`, auth.id, nowIso()],
    );
    return { message: 'Contraseña restablecida' };
  });

  router.get('/api/platform/companies/:id/audit', null, (ctx) => {
    requireSuperadmin(ctx);
    const rows = pAll<Record<string, unknown>>(
      'SELECT * FROM platform_audit WHERE company_id = ? ORDER BY created_at DESC LIMIT 100',
      [ctx.params.id],
    );
    return rows.map((row) => ({
      id: String(row.id),
      entity: String(row.entity),
      entityId: String(row.entity_id),
      type: String(row.type),
      note: row.note ? String(row.note) : null,
      userId: row.user_id ? String(row.user_id) : null,
      createdAt: String(row.created_at),
    }));
  });

  /** Agrega un usuario (por ejemplo un administrador adicional) a una empresa. */
  router.post('/api/platform/companies/:id/users/assign-admin', null, (ctx) => {
    const auth = requireSuperadmin(ctx);
    const company = getPlatformCompany(ctx.params.id);
    if (!company) throw ApiError.notFound('Empresa no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const created = addCompanyUser(company.id, {
      username: str(body.username, 'username', { required: true }),
      password: str(body.password, 'password', { required: true }),
      name: str(body.name, 'name', { required: true }),
      email: str(body.email, 'email') || undefined,
      role: 'admin',
    });
    pExec('UPDATE platform_companies SET admin_user_id = ? WHERE id = ?', [created.id, company.id]);
    pExec(
      'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [newId(), company.id, 'users', created.id, 'admin-assigned', `Administrador ${created.username} asignado por ${auth.name}`, auth.id, nowIso()],
    );
    return created;
  });
}
