/**
 * Aprovisionamiento de empresas (licencias) sobre la capa PostgreSQL multiempresa.
 *
 * Crear una empresa implica:
 *  1. crear su schema aislado (`tenant_<id>`),
 *  2. sembrar la configuración mínima para poder facturar (empresa, establecimiento,
 *     punto de emisión, bodega, unidades, categorías y consumidor final),
 *  3. registrar la licencia en la plataforma y
 *  4. crear el usuario administrador de la empresa.
 *
 * Todas las funciones que acceden a datos son async: la capa `db.ts` usa
 * PostgreSQL (o PGlite) con contexto de empresa vía AsyncLocalStorage.
 */

import { ApiError, hashPassword } from './http.ts';
import {
  createTenantDb,
  execute,
  nowIso,
  pAll,
  pExec,
  pOne,
  queryOne,
  runWithTenantAsync,
  tenantDatabaseExists,
  tenantDbPath,
} from './db.ts';
import type { Row } from './db.ts';
import { newId } from './ids.ts';
import { licenseState, type PlatformCompanyRow } from './licensing.ts';

export interface ProvisionCompanyInput {
  ruc: string;
  name: string;
  tradeName?: string;
  email?: string;
  phone?: string;
  address?: string;
  environment?: number;
  sriMode?: 'mock' | 'direct-sri' | 'upconta';
  plan?: string;
  licenseStatus?: 'active' | 'trial';
  licenseExpiresAt?: string | null;
  licenseNotes?: string;
  paymentReference?: string;
  createdBy?: string | null;
  adminUsername: string;
  adminPassword: string;
  adminName: string;
  adminEmail?: string;
}

export interface ProvinceResult {
  company: PlatformCompanyRow;
  admin: { id: string; username: string; name: string; role: string };
}

const UNITS = [
  ['UNI', 'Unidad', 'UNI'],
  ['KG', 'Kilogramo', 'Kg'],
  ['LT', 'Litro', 'L'],
  ['CAJ', 'Caja', 'Caja'],
  ['SER', 'Servicio', 'Serv'],
];

const CATEGORIES = ['General', 'Tecnología', 'Alimentos y bebidas', 'Servicios profesionales'];

function normalizeRuc(value: string): string {
  const ruc = String(value ?? '').trim();
  if (!/^\d{13}$/.test(ruc)) throw ApiError.badRequest('El RUC debe tener 13 dígitos numéricos');
  return ruc;
}

function normalizeUsername(value: string): string {
  const username = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(username)) {
    throw ApiError.badRequest('El usuario debe tener entre 3 y 60 caracteres (letras, números, punto, guion o guion bajo)');
  }
  return username;
}

export async function ensureUsernameAvailable(username: string): Promise<void> {
  if (await pOne('SELECT id FROM platform_users WHERE username = ?', [username])) {
    throw ApiError.conflict('Ya existe un usuario con ese nombre de usuario en la plataforma');
  }
}

export async function ensureRucAvailable(ruc: string, exceptCompanyId?: string): Promise<void> {
  const existing = await pOne<{ id: string }>('SELECT id FROM platform_companies WHERE ruc = ?', [ruc]);
  if (existing && existing.id !== exceptCompanyId) {
    throw ApiError.conflict('Ya existe una empresa/licencia registrada con ese RUC');
  }
}

/** Crea la configuración inicial dentro del schema aislado de la empresa. */
async function seedTenantConfig(input: ProvisionCompanyInput, companyId: string): Promise<void> {
  const now = nowIso();
  await execute(
    `INSERT INTO company (id, ruc, name, trade_name, address, email, phone, obliged_accounting, rimpe, agent_retention,
      environment, sri_mode, signature_digest, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      companyId,
      input.ruc,
      input.name,
      input.tradeName || input.name,
      input.address || 'Ecuador',
      input.email || null,
      input.phone || null,
      0,
      null,
      null,
      input.environment === 2 ? 2 : 1,
      input.sriMode || 'mock',
      'sha1',
      now,
      now,
    ],
  );

  const establishmentId = newId();
  await execute('INSERT INTO establishments (id, code, name, address, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [
    establishmentId,
    '001',
    'Matriz',
    input.address || 'Ecuador',
    'active',
    now,
    now,
  ]);
  await execute(
    'INSERT INTO emission_points (id, establishment_id, code, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [newId(), establishmentId, '001', 'Caja principal', 'active', now, now],
  );
  await execute(
    'INSERT INTO warehouses (id, code, name, description, color, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [newId(), 'BOD01', 'Bodega principal', 'Bodega de la matriz', '#ff5a1f', 'active', now, now],
  );
  for (const [code, name, abbr] of UNITS) {
    await execute('INSERT INTO units (id, code, name, abbr) VALUES (?,?,?,?)', [newId(), code, name, abbr]);
  }
  for (const name of CATEGORIES) {
    await execute('INSERT INTO categories (id, name, parent_id, created_at) VALUES (?,?,?,?)', [newId(), name, null, now]);
  }
  // Cliente por defecto "CONSUMIDOR FINAL" para poder facturar de inmediato.
  await execute(
    'INSERT INTO clients (id, id_type, id_number, name, email, phone, address, subject_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [newId(), '07', '9999999999999', 'CONSUMIDOR FINAL', null, null, null, '01', 'active', now, now],
  );
}

export async function provisionCompany(input: ProvisionCompanyInput): Promise<ProvinceResult> {
  const ruc = normalizeRuc(input.ruc);
  const adminUsername = normalizeUsername(input.adminUsername);
  const adminPassword = String(input.adminPassword ?? '');
  if (adminPassword.length < 6) throw ApiError.badRequest('La contraseña del administrador debe tener al menos 6 caracteres');
  await ensureRucAvailable(ruc);
  await ensureUsernameAvailable(adminUsername);

  const companyId = newId();
  const now = nowIso();

  // Schema aislado + configuración inicial.
  await createTenantDb(companyId);
  await runWithTenantAsync(companyId, () => seedTenantConfig({ ...input, ruc }, companyId));

  // Licencia de plataforma y usuario administrador de la empresa.
  // Nota: si falla el registro en plataforma después de crear el schema, no se
  // elimina automáticamente (la capa db no expone drop de un tenant individual);
  // queda un schema huérfano recuperable. Se documenta como riesgo.
  const adminId = newId();
  await pExec(
    `INSERT INTO platform_companies (id, ruc, name, trade_name, email, phone, address, license_status, license_plan,
      license_expires_at, license_notes, payment_reference, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      companyId,
      ruc,
      String(input.name ?? '').trim() || 'EMPRESA SIN NOMBRE',
      String(input.tradeName ?? '').trim() || null,
      String(input.email ?? '').trim() || null,
      String(input.phone ?? '').trim() || null,
      String(input.address ?? '').trim() || null,
      input.licenseStatus === 'trial' ? 'trial' : 'active',
      String(input.plan ?? 'basico').trim() || 'basico',
      input.licenseExpiresAt ?? null,
      String(input.licenseNotes ?? '').trim() || null,
      String(input.paymentReference ?? '').trim() || null,
      input.createdBy ?? null,
      now,
      now,
    ],
  );
  await pExec(
    `INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      adminId,
      companyId,
      adminUsername,
      hashPassword(adminPassword),
      String(input.adminName ?? '').trim() || 'Administrador',
      String(input.adminEmail ?? '').trim() || null,
      'admin',
      '[]',
      'active',
      now,
      now,
    ],
  );
  await pExec('UPDATE platform_companies SET admin_user_id = ? WHERE id = ?', [adminId, companyId]);

  const company = (await pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [companyId]))!;
  return { company, admin: { id: adminId, username: adminUsername, name: String(input.adminName ?? 'Administrador'), role: 'admin' } };
}

export async function addCompanyUser(
  companyId: string,
  input: { username: string; password: string; name: string; email?: string; role?: string },
): Promise<{ id: string; username: string; name: string; role: string }> {
  const username = normalizeUsername(input.username);
  const password = String(input.password ?? '');
  if (password.length < 6) throw ApiError.badRequest('La contraseña debe tener al menos 6 caracteres');
  await ensureUsernameAvailable(username);
  const roles = ['admin', 'facturador', 'inventario', 'contador'];
  const role = input.role && roles.includes(input.role) ? input.role : 'admin';
  const id = newId();
  const now = nowIso();
  await pExec(
    `INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, companyId, username, hashPassword(password), String(input.name ?? '').trim() || username, String(input.email ?? '').trim() || null, role, '[]', 'active', now, now],
  );
  return { id, username, name: String(input.name ?? username), role };
}

export async function getPlatformCompany(companyId: string): Promise<PlatformCompanyRow | undefined> {
  return pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [companyId]);
}

export interface TenantMetrics {
  products: number;
  clients: number;
  vouchers: number;
  issued: number;
  users: number;
  lastVoucherDate: string | null;
  licenseUsable: boolean;
}

export async function tenantMetrics(companyId: string): Promise<Omit<TenantMetrics, 'users' | 'licenseUsable'>> {
  if (!(await tenantDatabaseExists(companyId))) {
    return { products: 0, clients: 0, vouchers: 0, issued: 0, lastVoucherDate: null };
  }
  return runWithTenantAsync(companyId, async () => {
    const count = async (table: string, where = '') =>
      (await queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table} ${where}`))?.total ?? 0;
    const last = await queryOne<{ issue_date: string }>('SELECT issue_date FROM vouchers ORDER BY issue_date DESC LIMIT 1');
    return {
      products: await count('products'),
      clients: await count('clients'),
      vouchers: await count('vouchers'),
      issued: await count('vouchers', "WHERE status = 'issued'"),
      lastVoucherDate: last?.issue_date ?? null,
    };
  });
}

export async function tenantCompanyConfig(companyId: string): Promise<Record<string, unknown> | null> {
  if (!(await tenantDatabaseExists(companyId))) return null;
  return runWithTenantAsync(
    companyId,
    async () => (await queryOne<Record<string, unknown>>('SELECT * FROM company LIMIT 1')) ?? null,
  );
}

export async function tenantUsers(companyId: string): Promise<Row[]> {
  return pAll(
    'SELECT id, username, name, email, role, status, created_at FROM platform_users WHERE company_id = ? ORDER BY created_at ASC',
    [companyId],
  );
}

export async function tenantUserCount(companyId: string): Promise<number> {
  return (await pOne<{ total: number }>('SELECT COUNT(*) AS total FROM platform_users WHERE company_id = ?', [companyId]))?.total ?? 0;
}

export function licenseSummary(company: PlatformCompanyRow) {
  return licenseState(company);
}

/** Identificador lógico del schema de la empresa (para respaldos y reportes). */
export function companyDatabasePath(companyId: string): string {
  return tenantDbPath(companyId);
}
