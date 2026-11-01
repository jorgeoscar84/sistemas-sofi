/** Clientes (receptores de comprobantes). */

import { validateIdentificacion, CONSUMIDOR_FINAL } from '../../../../packages/shared/src/index.ts';
import { ApiError, Router, bodyOf, pageParams, paginated, requireUser, str } from '../http.ts';
import { audit, camel, execute, nowIso, queryAll, queryOne } from '../db.ts';
import { newId } from '../ids.ts';

interface ClientRow {
  id: string;
  id_type: string;
  id_number: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  subject_type: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function clientDto(row: ClientRow) {
  return {
    id: row.id,
    idType: row.id_type,
    idNumber: row.id_number,
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    subjectType: row.subject_type,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** Devuelve (creando si hace falta) el cliente consumidor final. */
export function ensureConsumidorFinal(): ClientRow {
  const existing = queryOne<ClientRow>('SELECT * FROM clients WHERE id_type = ? AND id_number = ?', [
    CONSUMIDOR_FINAL.idType,
    CONSUMIDOR_FINAL.id,
  ]);
  if (existing) return existing;
  const id = newId();
  execute(
    'INSERT INTO clients (id, id_type, id_number, name, email, phone, address, subject_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, CONSUMIDOR_FINAL.idType, CONSUMIDOR_FINAL.id, CONSUMIDOR_FINAL.name, null, null, null, '01', 'active', nowIso(), nowIso()],
  );
  return queryOne<ClientRow>('SELECT * FROM clients WHERE id = ?', [id])!;
}

export function findClient(id: string): ClientRow | undefined {
  return queryOne<ClientRow>('SELECT * FROM clients WHERE id = ?', [id]);
}

/** Busca (o crea) un cliente/persona por identificación, usado por guías y retenciones. */
export function ensureClient(input: { idType?: string; idNumber: string; name: string }): ClientRow {
  const idNumber = (input.idNumber ?? '').trim().toUpperCase();
  const idType = input.idType || guessIdType(idNumber);
  const existing = queryOne<ClientRow>('SELECT * FROM clients WHERE id_number = ?', [idNumber]);
  if (existing) return existing;
  const id = newId();
  execute(
    'INSERT INTO clients (id, id_type, id_number, name, email, phone, address, subject_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [id, idType, idNumber, input.name || idNumber, null, null, null, '01', 'active', nowIso(), nowIso()],
  );
  return queryOne<ClientRow>('SELECT * FROM clients WHERE id = ?', [id])!;
}

function guessIdType(value: string): string {
  if (/^\d{13}$/.test(value)) return '04';
  if (/^\d{10}$/.test(value)) return '05';
  if (value === '9999999999999') return '07';
  if (/^[A-Z]{3}\d{3,}$/.test(value)) return '09';
  return '06';
}

export function registerClientRoutes(router: Router): void {
  router.get('/api/clients/consumidor-final', 'clients:read', () => clientDto(ensureConsumidorFinal()));

  router.get('/api/clients', 'clients:read', (ctx) => {
    const { page, limit, offset } = pageParams(ctx.query);
    const q = (ctx.query.get('q') ?? '').trim();
    const idType = (ctx.query.get('idType') ?? '').trim();
    const where: string[] = ["status = 'active'"];
    const params: unknown[] = [];
    if (q) {
      where.push('(name LIKE ? OR id_number LIKE ? OR email LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (idType) {
      where.push('id_type = ?');
      params.push(idType);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM clients ${clause}`, params)?.total ?? 0;
    const rows = queryAll<ClientRow>(`SELECT * FROM clients ${clause} ORDER BY name ASC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    return paginated(rows.map(clientDto), total, page, limit);
  });

  router.get('/api/clients/:id', 'clients:read', (ctx) => {
    const row = findClient(ctx.params.id);
    if (!row) throw ApiError.notFound('Cliente no encontrado');
    return clientDto(row);
  });

  router.post('/api/clients', 'clients:write', (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const idType = str(body.idType, 'idType', { required: true });
    const idNumber = str(body.idNumber ?? body.id, 'idNumber', { required: true, max: 20 });
    const name = str(body.name, 'name', { required: true, max: 300 });
    if (!validateIdentificacion(idType, idNumber)) {
      throw ApiError.badRequest('La identificación no es válida para el tipo seleccionado');
    }
    if (queryOne('SELECT id FROM clients WHERE id_type = ? AND id_number = ?', [idType, idNumber])) {
      throw ApiError.conflict('Ya existe un cliente con esa identificación');
    }
    const id = newId();
    execute(
      'INSERT INTO clients (id, id_type, id_number, name, email, phone, address, subject_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        idType,
        idNumber,
        name,
        str(body.email, 'email') || null,
        str(body.phone, 'phone') || null,
        str(body.address, 'address') || null,
        str(body.subjectType, 'subjectType') || '01',
        'active',
        nowIso(),
        nowIso(),
      ],
    );
    audit('clients', id, 'created', `Creado por ${auth.name}`, auth.id);
    return clientDto(findClient(id)!);
  });

  router.put('/api/clients/:id', 'clients:write', (ctx) => {
    const auth = requireUser(ctx);
    const row = findClient(ctx.params.id);
    if (!row) throw ApiError.notFound('Cliente no encontrado');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const idType = body.idType !== undefined ? str(body.idType, 'idType', { required: true }) : row.id_type;
    const idNumber =
      body.idNumber !== undefined ? str(body.idNumber, 'idNumber', { required: true, max: 20 }) : row.id_number;
    if (!validateIdentificacion(idType, idNumber)) {
      throw ApiError.badRequest('La identificación no es válida para el tipo seleccionado');
    }
    const duplicated = queryOne('SELECT id FROM clients WHERE id_type = ? AND id_number = ? AND id <> ?', [
      idType,
      idNumber,
      row.id,
    ]);
    if (duplicated) throw ApiError.conflict('Ya existe otro cliente con esa identificación');
    execute('UPDATE clients SET id_type=?, id_number=?, name=?, email=?, phone=?, address=?, subject_type=?, status=?, updated_at=? WHERE id=?', [
      idType,
      idNumber,
      str(body.name, 'name', { required: true, max: 300 }),
      str(body.email, 'email') || null,
      str(body.phone, 'phone') || null,
      str(body.address, 'address') || null,
      body.subjectType !== undefined ? str(body.subjectType, 'subjectType') : row.subject_type,
      body.status !== undefined ? str(body.status, 'status') : row.status,
      nowIso(),
      row.id,
    ]);
    audit('clients', row.id, 'edit', `Editado por ${auth.name}`, auth.id);
    return clientDto(findClient(row.id)!);
  });

  router.delete('/api/clients/:id', 'clients:write', (ctx) => {
    const auth = requireUser(ctx);
    const row = findClient(ctx.params.id);
    if (!row) throw ApiError.notFound('Cliente no encontrado');
    const used = queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM vouchers WHERE client_id = ?', [row.id]);
    if ((used?.total ?? 0) > 0) throw ApiError.badRequest('No se puede eliminar: el cliente tiene comprobantes');
    execute('UPDATE clients SET status = ?, updated_at = ? WHERE id = ?', ['inactive', nowIso(), row.id]);
    audit('clients', row.id, 'deleted', `Desactivado por ${auth.name}`, auth.id);
    return { message: 'Cliente desactivado' };
  });
}

export { camel };
