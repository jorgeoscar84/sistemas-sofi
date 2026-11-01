/**
 * Aprovisionamiento de empresas (licencias).
 *
 * Crear una empresa implica:
 *  1. crear su base de datos aislada (`data/tenants/<id>.db`),
 *  2. sembrar la configuración mínima para poder facturar (empresa, establecimiento,
 *     punto de emisión, bodega, unidades, categorías y consumidor final),
 *  3. registrar la licencia en la plataforma y
 *  4. crear el usuario administrador de la empresa.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ApiError, hashPassword } from './http.ts';
import { pAll, pExec, pOne, nowIso, runWithTenant } from './db.ts';
import {
  createTenantDb,
  getPlatformDb,
  queryAll,
  queryOne,
  execute,
  tenantDatabaseExists,
  tenantDbPath,
} from './db.ts';
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

export function ensureUsernameAvailable(username: string): void {
  if (pOne('SELECT id FROM platform_users WHERE username = ?', [username])) {
    throw ApiError.conflict('Ya existe un usuario con ese nombre de usuario en la plataforma');
  }
}

export function ensureRucAvailable(ruc: string, exceptCompanyId?: string): void {
  const existing = pOne<{ id: string }>('SELECT id FROM platform_companies WHERE ruc = ?', [ruc]);
  if (existing && existing.id !== exceptCompanyId) {
    throw ApiError.conflict('Ya existe una empresa/licencia registrada con ese RUC');
  }
}

/** Crea la configuración inicial dentro de la base de datos aislada de la empresa. */
function seedTenantConfig(input: ProvisionCompanyInput, companyId: string): void {
  const now = nowIso();
  execute(
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
  execute('INSERT INTO establishments (id, code, name, address, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', [
    establishmentId,
    '001',
    'Matriz',
    input.address || 'Ecuador',
    'active',
    now,
    now,
  ]);
  execute(
    'INSERT INTO emission_points (id, establishment_id, code, name, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [newId(), establishmentId, '001', 'Caja principal', 'active', now, now],
  );
  execute(
    'INSERT INTO warehouses (id, code, name, description, color, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [newId(), 'BOD01', 'Bodega principal', 'Bodega de la matriz', '#ff5a1f', 'active', now, now],
  );
  for (const [code, name, abbr] of UNITS) {
    execute('INSERT INTO units (id, code, name, abbr) VALUES (?,?,?,?)', [newId(), code, name, abbr]);
  }
  for (const name of CATEGORIES) {
    execute('INSERT INTO categories (id, name, parent_id, created_at) VALUES (?,?,?,?)', [newId(), name, null, now]);
  }
  // Cliente por defecto "CONSUMIDOR FINAL" para poder facturar de inmediato.
  execute(
    'INSERT INTO clients (id, id_type, id_number, name, email, phone, address, subject_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [newId(), '07', '9999999999999', 'CONSUMIDOR FINAL', null, null, null, '01', 'active', now, now],
  );
  void companyId;
}

export function provisionCompany(input: ProvisionCompanyInput): ProvinceResult {
  const ruc = normalizeRuc(input.ruc);
  const adminUsername = normalizeUsername(input.adminUsername);
  const adminPassword = String(input.adminPassword ?? '');
  if (adminPassword.length < 6) throw ApiError.badRequest('La contraseña del administrador debe tener al menos 6 caracteres');
  ensureRucAvailable(ruc);
  ensureUsernameAvailable(adminUsername);

  const companyId = newId();
  const now = nowIso();
  try {
    createTenantDb(companyId);
    runWithTenant(companyId, () => seedTenantConfig({ ...input, ruc }, companyId));
  } catch (error) {
    try {
      if (tenantDatabaseExists(companyId)) fs.rmSync(tenantDbPath(companyId), { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }

  const adminId = newId();
  try {
    pExec(
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
    pExec(
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
    pExec('UPDATE platform_companies SET admin_user_id = ? WHERE id = ?', [adminId, companyId]);
  } catch (error) {
    try {
      if (tenantDatabaseExists(companyId)) fs.rmSync(tenantDbPath(companyId), { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }

  const company = pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [companyId])!;
  return { company, admin: { id: adminId, username: adminUsername, name: String(input.adminName ?? 'Administrador'), role: 'admin' } };
}

export function addCompanyUser(
  companyId: string,
  input: { username: string; password: string; name: string; email?: string; role?: string },
): { id: string; username: string; name: string; role: string } {
  const username = normalizeUsername(input.username);
  const password = String(input.password ?? '');
  if (password.length < 6) throw ApiError.badRequest('La contraseña debe tener al menos 6 caracteres');
  ensureUsernameAvailable(username);
  const roles = ['admin', 'facturador', 'inventario', 'contador'];
  const role = input.role && roles.includes(input.role) ? input.role : 'admin';
  const id = newId();
  const now = nowIso();
  pExec(
    `INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, companyId, username, hashPassword(password), String(input.name ?? '').trim() || username, String(input.email ?? '').trim() || null, role, '[]', 'active', now, now],
  );
  return { id, username, name: String(input.name ?? username), role };
}

export function getPlatformCompany(companyId: string): PlatformCompanyRow | undefined {
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

export function tenantMetrics(companyId: string): Omit<TenantMetrics, 'users' | 'licenseUsable'> {
  if (!tenantDatabaseExists(companyId)) {
    return { products: 0, clients: 0, vouchers: 0, issued: 0, lastVoucherDate: null };
  }
  return runWithTenant(companyId, () => {
    const count = (table: string, where = '') =>
      (queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table} ${where}`)?.total ?? 0);
    const last = queryOne<{ issue_date: string }>('SELECT issue_date FROM vouchers ORDER BY issue_date DESC LIMIT 1');
    return {
      products: count('products'),
      clients: count('clients'),
      vouchers: count('vouchers'),
      issued: count('vouchers', "WHERE status = 'issued'"),
      lastVoucherDate: last?.issue_date ?? null,
    };
  });
}

export function tenantCompanyConfig(companyId: string) {
  if (!tenantDatabaseExists(companyId)) return null;
  return runWithTenant(companyId, () => queryOne<Record<string, unknown>>('SELECT * FROM company LIMIT 1') ?? null);
}

export function tenantUsers(companyId: string) {
  return pAll(
    'SELECT id, username, name, email, role, status, created_at FROM platform_users WHERE company_id = ? ORDER BY created_at ASC',
    [companyId],
  );
}

export function tenantUserCount(companyId: string): number {
  return pOne<{ total: number }>('SELECT COUNT(*) AS total FROM platform_users WHERE company_id = ?', [companyId])?.total ?? 0;
}

export function licenseSummary(company: PlatformCompanyRow) {
  return licenseState(company);
}

/** Ruta del archivo de base de datos de una empresa (para respaldos). */
export function companyDatabasePath(companyId: string): string {
  return tenantDbPath(companyId);
}

void getPlatformDb;
void path;
