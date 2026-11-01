/** Catálogo: categorías, unidades de medida, productos y servicios. */

import { PORCENTAJES_DE_ICE, PORCENTAJES_DE_IVA } from '../../../../packages/shared/src/index.ts';
import { ApiError, Router, bodyOf, pageParams, paginated, requireUser, str } from '../http.ts';
import { audit, camelAll, execute, nowIso, queryAll, queryOne } from '../db.ts';
import { newId } from '../ids.ts';

interface ProductRow {
  id: string;
  type: string;
  code: string;
  aux_code: string | null;
  description: string;
  category_id: string | null;
  unit_id: string | null;
  price_cents: number;
  cost_cents: number;
  iva_code: string;
  ice_code: string | null;
  irbpnr_code: string | null;
  status: string;
  track_stock: number;
  min_stock: number;
  created_at: string;
  updated_at: string;
}

function productDto(row: ProductRow) {
  const stocks = queryAll<{ warehouse_id: string; name: string; amount: number; avg_cost_cents: number }>(
    `SELECT s.warehouse_id, w.name, s.amount, s.avg_cost_cents FROM stocks s
     JOIN warehouses w ON w.id = s.warehouse_id WHERE s.product_id = ? ORDER BY w.name ASC`,
    [row.id],
  );
  const totalStock = stocks.reduce((sum, s) => sum + Number(s.amount ?? 0), 0);
  return {
    id: row.id,
    type: row.type,
    code: row.code,
    auxCode: row.aux_code,
    description: row.description,
    categoryId: row.category_id,
    unitId: row.unit_id,
    priceCents: row.price_cents,
    costCents: row.cost_cents,
    ivaCode: row.iva_code,
    iceCode: row.ice_code,
    irbpnrCode: row.irbpnr_code,
    status: row.status,
    trackStock: Boolean(row.track_stock),
    minStock: Number(row.min_stock ?? 0),
    stocks: stocks.map((s) => ({
      warehouseId: s.warehouse_id,
      warehouseName: s.name,
      amount: Number(s.amount ?? 0),
    })),
    totalStock,
    createdAt: row.created_at,
  };
}

export function findProduct(id: string): ProductRow | undefined {
  return queryOne<ProductRow>('SELECT * FROM products WHERE id = ?', [id]);
}

function validateIva(code: string): void {
  if (!PORCENTAJES_DE_IVA.some((iva) => iva.id === code)) {
    throw ApiError.badRequest(`Código de IVA inválido: ${code}`);
  }
}

export function registerCatalogRoutes(router: Router): void {
  /* ------------------------------------------------------------ categorías */
  router.get('/api/categories', 'catalog:read', () =>
    camelAll(queryAll('SELECT id, name, parent_id FROM categories ORDER BY name ASC')),
  );

  router.post('/api/categories', 'catalog:write', (ctx) => {
    const body = bodyOf<Record<string, unknown>>(ctx);
    const name = str(body.name, 'name', { required: true, max: 200 });
    const id = newId();
    execute('INSERT INTO categories (id, name, parent_id, created_at) VALUES (?,?,?,?)', [
      id,
      name,
      str(body.parentId, 'parentId') || null,
      nowIso(),
    ]);
    return { id, name, parentId: str(body.parentId, 'parentId') || null };
  });

  router.put('/api/categories/:id', 'catalog:write', (ctx) => {
    const row = queryOne('SELECT * FROM categories WHERE id = ?', [ctx.params.id]);
    if (!row) throw ApiError.notFound('Categoría no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    execute('UPDATE categories SET name = ?, parent_id = ? WHERE id = ?', [
      body.name !== undefined ? str(body.name, 'name', { required: true }) : row.name,
      body.parentId !== undefined ? str(body.parentId, 'parentId') || null : row.parent_id,
      ctx.params.id,
    ]);
    return camelAll(queryAll('SELECT id, name, parent_id FROM categories ORDER BY name ASC'));
  });

  router.delete('/api/categories/:id', 'catalog:write', (ctx) => {
    execute('UPDATE products SET category_id = NULL WHERE category_id = ?', [ctx.params.id]);
    execute('DELETE FROM categories WHERE id = ?', [ctx.params.id]);
    return { message: 'Categoría eliminada' };
  });

  /* -------------------------------------------------------------- unidades */
  router.get('/api/units', 'catalog:read', () =>
    camelAll(queryAll('SELECT id, code, name, abbr FROM units ORDER BY name ASC')),
  );

  router.post('/api/units', 'catalog:write', (ctx) => {
    const body = bodyOf<Record<string, unknown>>(ctx);
    const code = str(body.code, 'code', { required: true, max: 10 }).toUpperCase();
    if (queryOne('SELECT id FROM units WHERE code = ?', [code])) throw ApiError.conflict('Ya existe una unidad con ese código');
    const id = newId();
    execute('INSERT INTO units (id, code, name, abbr) VALUES (?,?,?,?)', [
      id,
      code,
      str(body.name, 'name', { required: true }),
      str(body.abbr, 'abbr') || code,
    ]);
    return { id, code, name: str(body.name, 'name', { required: true }), abbr: str(body.abbr, 'abbr') || code };
  });

  router.put('/api/units/:id', 'catalog:write', (ctx) => {
    const row = queryOne('SELECT * FROM units WHERE id = ?', [ctx.params.id]);
    if (!row) throw ApiError.notFound('Unidad no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    execute('UPDATE units SET code=?, name=?, abbr=? WHERE id=?', [
      body.code !== undefined ? str(body.code, 'code', { required: true }).toUpperCase() : row.code,
      body.name !== undefined ? str(body.name, 'name', { required: true }) : row.name,
      body.abbr !== undefined ? str(body.abbr, 'abbr') || row.abbr : row.abbr,
      ctx.params.id,
    ]);
    return camelAll(queryAll('SELECT id, code, name, abbr FROM units ORDER BY name ASC'));
  });

  router.delete('/api/units/:id', 'catalog:write', (ctx) => {
    execute('UPDATE products SET unit_id = NULL WHERE unit_id = ?', [ctx.params.id]);
    execute('DELETE FROM units WHERE id = ?', [ctx.params.id]);
    return { message: 'Unidad eliminada' };
  });

  /* -------------------------------------------------------------- opciones */
  router.get('/api/products/options', 'catalog:read', () => ({
    categories: camelAll(queryAll('SELECT id, name, parent_id FROM categories ORDER BY name ASC')),
    units: camelAll(queryAll('SELECT id, code, name, abbr FROM units ORDER BY name ASC')),
    iva: PORCENTAJES_DE_IVA,
    ice: PORCENTAJES_DE_ICE,
  }));

  /* ------------------------------------------------------- búsqueda rápida */
  router.get('/api/products/search', 'catalog:read', (ctx) => {
    const q = (ctx.query.get('q') ?? '').trim();
    const type = ctx.query.get('type');
    const where: string[] = ["status = 'active'"];
    const params: unknown[] = [];
    if (q) {
      where.push('(code LIKE ? OR description LIKE ? OR aux_code LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    const rows = queryAll<ProductRow>(
      `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY description ASC LIMIT 20`,
      params,
    );
    return rows.map((row) => {
      const stock = queryOne<{ total: number }>(
        'SELECT COALESCE(SUM(amount),0) AS total FROM stocks WHERE product_id = ?',
        [row.id],
      );
      return {
        id: row.id,
        type: row.type,
        code: row.code,
        description: row.description,
        priceCents: row.price_cents,
        ivaCode: row.iva_code,
        trackStock: Boolean(row.track_stock),
        totalStock: Number(stock?.total ?? 0),
      };
    });
  });

  /* ------------------------------------------------------------- productos */
  router.get('/api/products', 'catalog:read', (ctx) => {
    const { page, limit, offset } = pageParams(ctx.query);
    const type = (ctx.query.get('type') ?? '').trim();
    const q = (ctx.query.get('q') ?? '').trim();
    const categoryId = (ctx.query.get('categoryId') ?? '').trim();
    const status = (ctx.query.get('status') ?? '').trim();
    const where: string[] = [];
    const params: unknown[] = [];
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    if (q) {
      where.push('(code LIKE ? OR description LIKE ? OR aux_code LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (categoryId) {
      where.push('category_id = ?');
      params.push(categoryId);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM products ${clause}`, params)?.total ?? 0;
    const rows = queryAll<ProductRow>(`SELECT * FROM products ${clause} ORDER BY description ASC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]);
    return paginated(rows.map(productDto), total, page, limit);
  });

  router.get('/api/products/:id', 'catalog:read', (ctx) => {
    const row = findProduct(ctx.params.id);
    if (!row) throw ApiError.notFound('Producto no encontrado');
    return productDto(row);
  });

  router.post('/api/products', 'catalog:write', (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const type = str(body.type, 'type') || 'product';
    if (!['product', 'service'].includes(type)) throw ApiError.badRequest('Tipo inválido (product|service)');
    const code = str(body.code, 'code', { required: true, max: 60 });
    const description = str(body.description, 'description', { required: true, max: 300 });
    const ivaCode = str(body.ivaCode, 'ivaCode') || '4';
    validateIva(ivaCode);
    if (queryOne('SELECT id FROM products WHERE type = ? AND code = ?', [type, code])) {
      throw ApiError.conflict('Ya existe un producto con ese código');
    }
    const id = newId();
    execute(
      `INSERT INTO products (id, type, code, aux_code, description, category_id, unit_id, price_cents, cost_cents,
        iva_code, ice_code, irbpnr_code, status, track_stock, min_stock, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        type,
        code,
        str(body.auxCode, 'auxCode') || null,
        description,
        str(body.categoryId, 'categoryId') || null,
        str(body.unitId, 'unitId') || null,
        Math.round(Number(body.priceCents ?? 0)) || 0,
        Math.round(Number(body.costCents ?? 0)) || 0,
        ivaCode,
        str(body.iceCode, 'iceCode') || null,
        str(body.irbpnrCode, 'irbpnrCode') || null,
        str(body.status, 'status') || 'active',
        body.trackStock === undefined ? 1 : body.trackStock ? 1 : 0,
        Number(body.minStock ?? 0) || 0,
        nowIso(),
        nowIso(),
      ],
    );
    audit('products', id, 'created', `Creado por ${auth.name}`, auth.id);
    return productDto(findProduct(id)!);
  });

  router.put('/api/products/:id', 'catalog:write', (ctx) => {
    const auth = requireUser(ctx);
    const row = findProduct(ctx.params.id);
    if (!row) throw ApiError.notFound('Producto no encontrado');
    const body = bodyOf<Record<string, unknown>>(ctx);
    const ivaCode = body.ivaCode !== undefined ? str(body.ivaCode, 'ivaCode', { required: true }) : row.iva_code;
    validateIva(ivaCode);
    execute(
      `UPDATE products SET aux_code=?, description=?, category_id=?, unit_id=?, price_cents=?, cost_cents=?, iva_code=?,
        ice_code=?, irbpnr_code=?, status=?, track_stock=?, min_stock=?, updated_at=? WHERE id=?`,
      [
        body.auxCode !== undefined ? str(body.auxCode, 'auxCode') || null : row.aux_code,
        body.description !== undefined ? str(body.description, 'description', { required: true }) : row.description,
        body.categoryId !== undefined ? str(body.categoryId, 'categoryId') || null : row.category_id,
        body.unitId !== undefined ? str(body.unitId, 'unitId') || null : row.unit_id,
        body.priceCents !== undefined ? Math.round(Number(body.priceCents)) || 0 : row.price_cents,
        body.costCents !== undefined ? Math.round(Number(body.costCents)) || 0 : row.cost_cents,
        ivaCode,
        body.iceCode !== undefined ? str(body.iceCode, 'iceCode') || null : row.ice_code,
        body.irbpnrCode !== undefined ? str(body.irbpnrCode, 'irbpnrCode') || null : row.irbpnr_code,
        body.status !== undefined ? str(body.status, 'status') : row.status,
        body.trackStock !== undefined ? (body.trackStock ? 1 : 0) : row.track_stock,
        body.minStock !== undefined ? Number(body.minStock) || 0 : row.min_stock,
        nowIso(),
        row.id,
      ],
    );
    audit('products', row.id, 'edit', `Editado por ${auth.name}`, auth.id);
    return productDto(findProduct(row.id)!);
  });

  router.delete('/api/products/:id', 'catalog:write', (ctx) => {
    const auth = requireUser(ctx);
    const row = findProduct(ctx.params.id);
    if (!row) throw ApiError.notFound('Producto no encontrado');
    execute('UPDATE products SET status = ?, updated_at = ? WHERE id = ?', ['inactive', nowIso(), row.id]);
    audit('products', row.id, 'deleted', `Desactivado por ${auth.name}`, auth.id);
    return { message: 'Producto desactivado' };
  });
}
