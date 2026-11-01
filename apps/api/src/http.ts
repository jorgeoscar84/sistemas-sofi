/**
 * HTTP sin framework: router, autenticación JWT (HMAC-SHA256), parseo de body,
 * respuestas JSON y servido de archivos estáticos para el frontend.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.ts';
import { TenantRequiredError, pOne, runWithTenantAsync } from './db.ts';
import { licenseState, type PlatformCompanyRow } from './licensing.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'BadRequest', message, details);
  }
  static unauthorized(message = 'No autenticado') {
    return new ApiError(401, 'Unauthorized', message);
  }
  static forbidden(message = 'No autorizado') {
    return new ApiError(403, 'Forbidden', message);
  }
  static notFound(message = 'Recurso no encontrado') {
    return new ApiError(404, 'NotFound', message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'Conflict', message, details);
  }
}

/* ------------------------------------------------------------------ JWT */

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signToken(payload: Record<string, unknown>, expiresInSeconds = config.jwtExpiresInSeconds): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSeconds }));
  const signature = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- Hash */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  const derived = crypto.scryptSync(password, salt, expected.length || 64);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/* ------------------------------------------------------------- Tipos */

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: 'superadmin' | 'admin' | 'facturador' | 'inventario' | 'contador';
  permissions: string[];
  /** Empresa activa de la petición (null para el superadministrador sin empresa seleccionada). */
  companyId: string | null;
  isSuperadmin: boolean;
  authType: 'session' | 'api-token';
}

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  authUser?: AuthUser;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  permission?: string;
}

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  superadmin: ['*'],
  admin: ['*'],
  facturador: [
    'invoicing:read',
    'invoicing:create',
    'invoicing:send',
    'clients:read',
    'clients:write',
    'catalog:read',
    'dashboard:read',
  ],
  inventario: ['catalog:read', 'catalog:write', 'inventory:read', 'inventory:write', 'dashboard:read'],
  contador: ['invoicing:read', 'catalog:read', 'inventory:read', 'dashboard:read', 'reports:read'],
};

export function hasPermission(user: AuthUser, permission: string): boolean {
  if (user.role === 'admin' || user.role === 'superadmin') return true;
  const rolePerms = ROLE_PERMISSIONS[user.role] ?? [];
  if (rolePerms.includes('*')) return true;
  return [...rolePerms, ...user.permissions].includes(permission);
}

/* ------------------------------------------------------------- Router */

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, permission: string | null, handler: Handler): void {
    const keys: string[] = [];
    const regex = new RegExp(
      `^${pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ method, regex, keys, handler, permission: permission ?? undefined });
  }

  get(pattern: string, permission: string | null, handler: Handler) {
    this.add('GET', pattern, permission, handler);
  }
  post(pattern: string, permission: string | null, handler: Handler) {
    this.add('POST', pattern, permission, handler);
  }
  put(pattern: string, permission: string | null, handler: Handler) {
    this.add('PUT', pattern, permission, handler);
  }
  delete(pattern: string, permission: string | null, handler: Handler) {
    this.add('DELETE', pattern, permission, handler);
  }

  async handle(ctx: Ctx): Promise<{ handled: boolean; result?: unknown }> {
    const pathname = ctx.url.pathname;
    for (const route of this.routes) {
      if (route.method !== ctx.req.method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      route.keys.forEach((key, i) => {
        ctx.params[key] = decodeURIComponent(match[i + 1] ?? '');
      });
      if (route.permission) {
        const user = await authenticate(ctx);
        if (!user) throw ApiError.unauthorized();
        if (!hasPermission(user, route.permission)) {
          throw ApiError.forbidden(`Permiso requerido: ${route.permission}`);
        }
        if (user.role === 'superadmin' && !user.companyId) {
          throw ApiError.badRequest('Seleccione una empresa (encabezado X-Company-Id) para operar');
        }
        if (!user.isSuperadmin && !user.companyId) throw ApiError.forbidden('El usuario no tiene empresa asignada');
      } else {
        await authenticate(ctx);
      }
      const companyId = ctx.authUser?.companyId ?? null;
      return { handled: true, result: await runWithTenantAsync(companyId, () => route.handler(ctx)) };
    }
    return { handled: false };
  }
}

/* --------------------------------------------------------- Autenticación */

interface PlatformUserRow {
  id: string;
  company_id: string | null;
  username: string;
  name: string;
  email: string | null;
  role: AuthUser['role'];
  permissions: string;
  status: string;
}

function parsePermissions(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function assertCompanyUsable(company: PlatformCompanyRow | undefined): PlatformCompanyRow {
  if (!company) throw ApiError.forbidden('La empresa no existe o fue eliminada');
  const state = licenseState(company);
  if (!state.usable) {
    throw ApiError.forbidden(
      `La licencia de la empresa está ${state.label.toLowerCase()}. Contacte al administrador de la plataforma.`,
    );
  }
  return company;
}

export async function authenticate(ctx: Ctx): Promise<AuthUser | null> {
  const header = String(ctx.req.headers.authorization ?? '');
  if (header.startsWith('ApiToken ')) {
    const token = header.slice('ApiToken '.length).trim();
    const row = pOne<{ id: string; name: string; company_id: string | null }>(
      "SELECT t.id, t.name, t.company_id FROM platform_api_tokens t WHERE t.token_hash = ? AND t.status = 'active'",
      [sha256(token)],
    );
    if (!row || !row.company_id) return null;
    assertCompanyUsable(pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [row.company_id]));
    ctx.authUser = {
      id: row.id,
      username: `api:${row.name}`,
      name: `Integración ${row.name}`,
      role: 'admin',
      permissions: [],
      companyId: row.company_id,
      isSuperadmin: false,
      authType: 'api-token',
    };
    return ctx.authUser;
  }
  if (!header.startsWith('Bearer ')) return null;
  const payload = verifyToken(header.slice('Bearer '.length).trim());
  if (!payload || typeof payload.sub !== 'string') return null;
  const row = pOne<PlatformUserRow>('SELECT * FROM platform_users WHERE id = ?', [payload.sub]);
  if (!row || row.status !== 'active') return null;
  const isSuperadmin = row.role === 'superadmin';
  let companyId: string | null = row.company_id;

  if (isSuperadmin) {
    const requested = String(ctx.req.headers['x-company-id'] ?? '').trim();
    if (requested) {
      const company = pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [requested]);
      if (!company) throw ApiError.badRequest('La empresa seleccionada no existe');
      companyId = company.id;
    } else {
      companyId = null;
    }
  } else {
    if (!companyId) {
      throw ApiError.forbidden('El usuario no tiene una empresa asignada');
    }
    assertCompanyUsable(pOne<PlatformCompanyRow>('SELECT * FROM platform_companies WHERE id = ?', [companyId]));
  }

  ctx.authUser = {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    permissions: parsePermissions(row.permissions),
    companyId,
    isSuperadmin,
    authType: 'session',
  };
  return ctx.authUser;
}

export function requireUser(ctx: Ctx): AuthUser {
  if (!ctx.authUser) throw ApiError.unauthorized();
  return ctx.authUser;
}

/** Devuelve la empresa activa de la petición o lanza un error claro. */
export function requireTenant(ctx: Ctx): string {
  const auth = requireUser(ctx);
  if (!auth.companyId) throw ApiError.badRequest('Seleccione una empresa para operar');
  return auth.companyId;
}

export function requireSuperadmin(ctx: Ctx): AuthUser {
  const auth = requireUser(ctx);
  if (!auth.isSuperadmin) throw ApiError.forbidden('Sólo el superadministrador de la plataforma puede realizar esta acción');
  return auth;
}

/* ------------------------------------------------------ utilidades body */

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 25 * 1024 * 1024) throw ApiError.badRequest('Cuerpo de la petición demasiado grande');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/json') || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('JSON inválido en el cuerpo de la petición');
    }
  }
  return raw;
}

/* ------------------------------------------------------------ respuestas */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res: http.ServerResponse, status: number, body: Buffer | string, contentType: string): void {
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Company-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(buffer);
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function serveStatic(ctx: Ctx): boolean {
  const pathname = ctx.url.pathname === '/' ? '/index.html' : ctx.url.pathname;
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(config.webDir, safe);
  if (!filePath.startsWith(config.webDir)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback: cualquier ruta no encontrada sirve el index
    if (!pathname.includes('.')) {
      const indexPath = path.join(config.webDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        send(ctx.res, 200, fs.readFileSync(indexPath), MIME['.html']!);
        return true;
      }
    }
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  send(ctx.res, 200, fs.readFileSync(filePath), MIME[ext] ?? 'application/octet-stream');
  return true;
}

/* ---------------------------------------------------------- servidor */

export function createServer(router: Router): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (req.method === 'OPTIONS') {
      send(res, 204, '', 'text/plain');
      return;
    }
    const ctx: Ctx = { req, res, url, params: {}, query: url.searchParams, body: undefined };
    try {
      if (url.pathname.startsWith('/api/')) {
        ctx.body = await readBody(req);
        const { handled, result } = await router.handle(ctx);
        if (!handled) {
          sendJson(res, 404, { error: 'NotFound', message: `Ruta ${req.method} ${url.pathname} no encontrada` });
          return;
        }
        if (result === undefined || res.writableEnded) return;
        if (result && typeof result === 'object' && '__file' in (result as Record<string, unknown>)) {
          const file = result as { __file: Buffer; contentType: string; filename?: string; status?: number };
          res.setHeader('Content-Disposition', `attachment; filename="${file.filename ?? 'archivo'}"`);
          send(res, file.status ?? 200, file.__file, file.contentType);
          return;
        }
        sendJson(res, 200, result);
        return;
      }
      if (!serveStatic(ctx)) {
        sendJson(res, 404, { error: 'NotFound', message: 'Recurso no encontrado' });
      }
    } catch (error) {
      if (error instanceof TenantRequiredError) {
        sendJson(res, 400, { error: 'TenantRequired', message: error.message });
        return;
      }
      if (error instanceof ApiError) {
        sendJson(res, error.status, { error: error.code, message: error.message, details: error.details });
        return;
      }
      console.error('[api] error no controlado:', error);
      sendJson(res, 500, {
        error: 'InternalServerError',
        message: error instanceof Error ? error.message : 'Error interno del servidor',
      });
    }
  });
}

/* ------------------------------------------------------------- helpers */

export function pageParams(query: URLSearchParams): { page: number; limit: number; offset: number } {
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.get('limit') ?? 25) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

export function paginated<T>(data: T[], total: number, page: number, limit: number) {
  return { page, limit, total, data };
}

export function bodyOf<T = Record<string, unknown>>(ctx: Ctx): T {
  return (ctx.body ?? {}) as T;
}

export function str(value: unknown, field: string, opts: { required?: boolean; max?: number } = {}): string {
  if (value === undefined || value === null || value === '') {
    if (opts.required) throw ApiError.badRequest(`El campo ${field} es obligatorio`);
    return '';
  }
  const text = String(value).trim();
  if (opts.max && text.length > opts.max) throw ApiError.badRequest(`El campo ${field} excede ${opts.max} caracteres`);
  return text;
}

export function num(value: unknown, field: string, fallback?: number): number {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw ApiError.badRequest(`El campo ${field} es obligatorio`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw ApiError.badRequest(`El campo ${field} debe ser numérico`);
  return n;
}

export function intCents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
