/**
 * Autenticación, usuarios, roles y permisos.
 *
 * Los usuarios viven en la base de la plataforma (`platform_users`). Cada usuario
 * (excepto el superadministrador) pertenece a una empresa y sólo opera sobre la
 * base de datos aislada de esa empresa.
 */

import {
  ApiError,
  ROLE_PERMISSIONS,
  Router,
  bodyOf,
  hashPassword,
  pageParams,
  paginated,
  requireSuperadmin,
  requireTenant,
  requireUser,
  signToken,
  str,
  verifyPassword,
  type AuthUser,
} from '../http.ts';
import { audit, nowIso, pAll, pExec, pOne } from '../db.ts';
import { companySummary, licenseDto, licenseState, type PlatformCompanyRow } from '../licensing.ts';
import { newId } from '../ids.ts';

interface UserRow {
  id: string;
  company_id: string | null;
  username: string;
  password_hash: string;
  name: string;
  email: string | null;
  role: AuthUser['role'];
  permissions: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export const ROLE_LABELS: Record<string, string> = {
  superadmin: 'Superadministrador',
  admin: 'Administrador',
  facturador: 'Facturador',
  inventario: 'Inventario',
  contador: 'Contador',
};

function safePermissions(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function userDto(row: UserRow) {
  return {
    id: row.id,
    companyId: row.company_id,
    username: row.username,
    name: row.name,
    email: row.email,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] ?? row.role,
    permissions: safePermissions(row.permissions),
    status: row.status,
    isSuperadmin: row.role === 'superadmin',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EDITABLE_ROLES: AuthUser['role'][] = ['admin', 'facturador', 'inventario', 'contador'];

function findUserById(id: string): UserRow | undefined {
  return pOne<UserRow>('SELECT * FROM platform_users WHERE id = ?', [id]);
}

function licenseFor(companyId: string | null) {
  if (!companyId) return { company: null, license: null };
  const company = pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [companyId]);
  return { company: company ?? null, license: licenseDto(company ?? null) };
}

export function registerAuthRoutes(router: Router): void {
  router.post('/api/auth/login', null, (ctx) => {
    const body = bodyOf<{ username?: string; password?: string }>(ctx);
    const username = str(body.username, 'username', { required: true });
    const password = str(body.password, 'password', { required: true });
    const user = pOne<UserRow>('SELECT * FROM platform_users WHERE username = ?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw ApiError.unauthorized('Usuario o contraseña incorrectos');
    }
    if (user.status !== 'active') throw ApiError.forbidden('El usuario está inactivo');
    let company: PlatformCompanyRow | null = null;
    if (user.role !== 'superadmin') {
      if (!user.company_id) throw ApiError.forbidden('El usuario no tiene una empresa asignada');
      company = pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [user.company_id]) ?? null;
      if (!company) throw ApiError.forbidden('La empresa del usuario no existe');
      const state = licenseState(company);
      if (!state.usable) {
        throw ApiError.forbidden(
          `La licencia de la empresa está ${state.label.toLowerCase()}. Contacte al administrador de la plataforma.`,
        );
      }
    }
    const token = signToken({ sub: user.id, role: user.role, type: 'session' });
    return {
      token,
      user: userDto(user),
      company: company ? companySummary(company) : null,
      license: company ? licenseDto(company) : null,
    };
  });

  router.get('/api/auth/me', null, (ctx) => {
    const auth = requireUser(ctx);
    const user = findUserById(auth.id);
    if (!user) throw ApiError.notFound('Usuario no encontrado');
    const { company, license } = licenseFor(auth.companyId);
    const companies = auth.isSuperadmin
      ? pAll<PlatformCompanyRow>('SELECT * FROM platform_companies ORDER BY name ASC').map((row) => ({
          ...companySummary(row),
          plan: row.license_plan,
          createdAt: row.created_at,
        }))
      : [];
    return {
      user: userDto(user),
      company: company ? companySummary(company) : null,
      license,
      companies,
      isSuperadmin: auth.isSuperadmin,
      authType: auth.authType,
      ...userDto(user),
    };
  });

  router.post('/api/auth/change-password', null, (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<{ currentPassword?: string; newPassword?: string }>(ctx);
    const current = str(body.currentPassword, 'currentPassword', { required: true });
    const next = str(body.newPassword, 'newPassword', { required: true });
    if (next.length < 6) throw ApiError.badRequest('La nueva contraseña debe tener al menos 6 caracteres');
    const user = findUserById(auth.id);
    if (!user || !verifyPassword(current, user.password_hash)) {
      throw ApiError.badRequest('La contraseña actual no es correcta');
    }
    pExec('UPDATE platform_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(next), nowIso(), user.id]);
    return { message: 'Contraseña actualizada' };
  });

  router.get('/api/roles', null, () => {
    return Object.entries(ROLE_PERMISSIONS)
      .filter(([role]) => role !== 'superadmin')
      .map(([role, permissions]) => ({
        role,
        label: ROLE_LABELS[role] ?? role,
        permissions,
      }));
  });

  /** Licencia de la empresa activa (para mostrar avisos en la interfaz). */
  router.get('/api/license', null, (ctx) => {
    const auth = requireUser(ctx);
    const { company, license } = licenseFor(auth.companyId);
    return {
      company: company ? companySummary(company) : null,
      license,
      isSuperadmin: auth.isSuperadmin,
    };
  });

  /* ------------------------------------------------------------- usuarios */

  router.get('/api/users', 'users:read', (ctx) => {
    const companyId = requireTenant(ctx);
    const { page, limit, offset } = pageParams(ctx.query);
    const q = (ctx.query.get('q') ?? '').trim();
    const role = (ctx.query.get('role') ?? '').trim();
    const where: string[] = ['company_id = ?'];
    const params: unknown[] = [companyId];
    if (q) {
      where.push('(username LIKE ? OR name LIKE ? OR email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (role) {
      where.push('role = ?');
      params.push(role);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = pOne<{ total: number }>(`SELECT COUNT(*) AS total FROM platform_users ${clause}`, params)?.total ?? 0;
    const rows = pAll<UserRow>(`SELECT * FROM platform_users ${clause} ORDER BY created_at ASC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    return paginated(rows.map(userDto), total, page, limit);
  });

  router.get('/api/users/:id', 'users:read', (ctx) => {
    const companyId = requireTenant(ctx);
    const row = pOne<UserRow>('SELECT * FROM platform_users WHERE id = ? AND company_id = ?', [ctx.params.id, companyId]);
    if (!row) throw ApiError.notFound('Usuario no encontrado');
    return userDto(row);
  });

  router.post('/api/users', 'users:write', (ctx) => {
    const auth = requireUser(ctx);
    const companyId = requireTenant(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const username = str(body.username, 'username', { required: true, max: 60 });
    const name = str(body.name, 'name', { required: true, max: 120 });
    const password = str(body.password, 'password', { required: true });
    const role = str(body.role, 'role', { required: true }) as AuthUser['role'];
    if (password.length < 6) throw ApiError.badRequest('La contraseña debe tener al menos 6 caracteres');
    if (!EDITABLE_ROLES.includes(role)) throw ApiError.badRequest('Rol inválido');
    if (pOne('SELECT id FROM platform_users WHERE username = ?', [username])) {
      throw ApiError.conflict('Ya existe un usuario con ese nombre de usuario');
    }
    const id = newId();
    const now = nowIso();
    pExec(
      `INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        companyId,
        username,
        hashPassword(password),
        name,
        str(body.email, 'email') || null,
        role,
        JSON.stringify(Array.isArray(body.permissions) ? body.permissions : []),
        'active',
        now,
        now,
      ],
    );
    audit('users', id, 'created', `Creado por ${auth.name}`, auth.id);
    return userDto(findUserById(id)!);
  });

  router.put('/api/users/:id', 'users:write', (ctx) => {
    const auth = requireUser(ctx);
    const companyId = requireTenant(ctx);
    const row = pOne<UserRow>('SELECT * FROM platform_users WHERE id = ? AND company_id = ?', [ctx.params.id, companyId]);
    if (!row) throw ApiError.notFound('Usuario no encontrado');
    if (row.role === 'superadmin') throw ApiError.forbidden('El superadministrador no se edita desde una empresa');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const name = body.name !== undefined ? str(body.name, 'name', { required: true }) : row.name;
    const email = body.email !== undefined ? str(body.email, 'email') || null : row.email;
    const role = body.role !== undefined ? (str(body.role, 'role', { required: true }) as AuthUser['role']) : row.role;
    const status = body.status !== undefined ? str(body.status, 'status', { required: true }) : row.status;
    if (!EDITABLE_ROLES.includes(role)) throw ApiError.badRequest('Rol inválido');
    if (status !== 'active' && status !== 'inactive') throw ApiError.badRequest('Estado inválido');
    if ((role !== 'admin' || status !== 'active') && row.role === 'admin') ensureAnotherAdmin(companyId, row.id);
    const passwordHash = body.password ? hashPassword(str(body.password, 'password', { required: true })) : row.password_hash;
    pExec(
      'UPDATE platform_users SET name=?, email=?, role=?, status=?, password_hash=?, permissions=?, updated_at=? WHERE id=?',
      [
        name,
        email,
        role,
        status,
        passwordHash,
        body.permissions !== undefined && Array.isArray(body.permissions)
          ? JSON.stringify(body.permissions)
          : row.permissions,
        nowIso(),
        row.id,
      ],
    );
    audit('users', row.id, 'edit', `Editado por ${auth.name}`, auth.id);
    return userDto(findUserById(row.id)!);
  });

  router.delete('/api/users/:id', 'users:write', (ctx) => {
    const auth = requireUser(ctx);
    const companyId = requireTenant(ctx);
    const row = pOne<UserRow>('SELECT * FROM platform_users WHERE id = ? AND company_id = ?', [ctx.params.id, companyId]);
    if (!row) throw ApiError.notFound('Usuario no encontrado');
    if (row.role === 'superadmin') throw ApiError.forbidden('El superadministrador no se desactiva desde una empresa');
    if (row.role === 'admin') ensureAnotherAdmin(companyId, row.id);
    pExec('UPDATE platform_users SET status = ?, updated_at = ? WHERE id = ?', ['inactive', nowIso(), row.id]);
    audit('users', row.id, 'deleted', `Desactivado por ${auth.name}`, auth.id);
    return { message: 'Usuario desactivado', id: row.id };
  });

  /* ----------------------------------- superadministrador: usuarios por empresa */

  router.get('/api/platform/companies/:id/users', null, (ctx) => {
    requireSuperadmin(ctx);
    const rows = pAll<UserRow>('SELECT * FROM platform_users WHERE company_id = ? ORDER BY created_at ASC', [
      ctx.params.id,
    ]);
    return rows.map(userDto);
  });

  router.post('/api/platform/companies/:id/users', null, (ctx) => {
    const auth = requireSuperadmin(ctx);
    const company = pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [ctx.params.id]);
    if (!company) throw ApiError.notFound('Empresa no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const username = str(body.username, 'username', { required: true, max: 60 });
    const name = str(body.name, 'name', { required: true, max: 120 });
    const password = str(body.password, 'password', { required: true });
    const role = (str(body.role, 'role') || 'admin') as AuthUser['role'];
    if (!EDITABLE_ROLES.includes(role)) throw ApiError.badRequest('Rol inválido');
    if (password.length < 6) throw ApiError.badRequest('La contraseña debe tener al menos 6 caracteres');
    if (pOne('SELECT id FROM platform_users WHERE username = ?', [username])) {
      throw ApiError.conflict('Ya existe un usuario con ese nombre de usuario');
    }
    const id = newId();
    const now = nowIso();
    pExec(
      `INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, company.id, username, hashPassword(password), name, str(body.email, 'email') || null, role, '[]', 'active', now, now],
    );
    if (!company.admin_user_id && role === 'admin') {
      pExec('UPDATE platform_companies SET admin_user_id = ? WHERE id = ?', [id, company.id]);
    }
    pExec(
      'INSERT INTO platform_audit (id, company_id, entity, entity_id, type, note, user_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [newId(), company.id, 'users', id, 'created', `Usuario ${username} creado por ${auth.name}`, auth.id, now],
    );
    return userDto(findUserById(id)!);
  });
}

function ensureAnotherAdmin(companyId: string, excludeId: string): void {
  const others = pOne<{ total: number }>(
    "SELECT COUNT(*) AS total FROM platform_users WHERE company_id = ? AND role = 'admin' AND status = 'active' AND id <> ?",
    [companyId, excludeId],
  );
  if ((others?.total ?? 0) === 0) {
    throw ApiError.badRequest('No se puede desactivar al último administrador activo de la empresa');
  }
}

void companySummary;
void licenseState;
