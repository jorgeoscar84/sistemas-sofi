/** Inventario: bodegas, stock, comprobantes de stock y Kardex (costo promedio ponderado). */

import { ApiError, Router, bodyOf, pageParams, paginated, requireUser, str } from '../http.ts';
import { audit, camel, camelAll, execute, nowIso, queryAll, queryOne, transaction } from '../db.ts';
import { newId } from '../ids.ts';
import { findProduct } from './catalog.ts';

export type MovementDirection = 'in' | 'out';

export interface StockMovementInput {
  voucherId: string | null;
  voucherCode: string | null;
  productId: string;
  warehouseId: string;
  date: string;
  type: string;
  description: string;
  direction: MovementDirection;
  quantity: number;
  unitCostCents: number;
}

interface StockRow {
  product_id: string;
  warehouse_id: string;
  amount: number;
  avg_cost_cents: number;
}

function getStockRow(productId: string, warehouseId: string): StockRow {
  return (
    queryOne<StockRow>('SELECT * FROM stocks WHERE product_id = ? AND warehouse_id = ?', [productId, warehouseId]) ?? {
      product_id: productId,
      warehouse_id: warehouseId,
      amount: 0,
      avg_cost_cents: 0,
    }
  );
}

/** Aplica un movimiento de stock y actualiza el saldo y el costo promedio ponderado. */
export function applyMovement(input: StockMovementInput): { movementId: string; balanceQty: number; balanceCostCents: number } {
  const current = getStockRow(input.productId, input.warehouseId);
  const currentQty = Number(current.amount ?? 0);
  const currentAvg = Number(current.avg_cost_cents ?? 0);
  let newQty: number;
  let newAvg: number;

  if (input.direction === 'in') {
    const unitCost = Math.max(0, Math.round(input.unitCostCents));
    newQty = currentQty + input.quantity;
    newAvg =
      newQty > 0
        ? Math.round((currentAvg * currentQty + unitCost * input.quantity) / newQty)
        : unitCost;
  } else {
    if (input.quantity - currentQty > 1e-9) {
      const product = queryOne<{ code: string; description: string }>(
        'SELECT code, description FROM products WHERE id = ?',
        [input.productId],
      );
      const warehouse = queryOne<{ name: string }>('SELECT name FROM warehouses WHERE id = ?', [input.warehouseId]);
      const label = product ? `${product.code} · ${product.description}` : input.productId;
      throw ApiError.badRequest(
        `Stock insuficiente de "${label}" en ${warehouse?.name ?? 'la bodega'} ` +
          `(disponible ${currentQty}, solicitado ${input.quantity}). ` +
          'Registre un ingreso de inventario o desactive el control de stock del producto.',
      );
    }
    newQty = currentQty - input.quantity;
    newAvg = currentQty > 0 ? currentAvg : input.unitCostCents;
  }

  const balanceCost = Math.round(newAvg * newQty);
  const movementId = newId();
  execute(
    `INSERT INTO stock_movements (id, voucher_id, voucher_code, product_id, warehouse_id, date, type, description,
      quantity_in, quantity_out, unit_cost_cents, balance_qty, balance_cost_cents, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      movementId,
      input.voucherId,
      input.voucherCode,
      input.productId,
      input.warehouseId,
      input.date,
      input.type,
      input.description,
      input.direction === 'in' ? input.quantity : 0,
      input.direction === 'out' ? input.quantity : 0,
      Math.round(input.unitCostCents),
      newQty,
      balanceCost,
      nowIso(),
    ],
  );
  execute(
    `INSERT INTO stocks (product_id, warehouse_id, amount, avg_cost_cents, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(product_id, warehouse_id) DO UPDATE SET amount=excluded.amount,
       avg_cost_cents=excluded.avg_cost_cents, updated_at=excluded.updated_at`,
    [input.productId, input.warehouseId, newQty, newAvg, nowIso()],
  );
  return { movementId, balanceQty: newQty, balanceCostCents: balanceCost };
}

/** Recalcula saldos y costo promedio de un producto/bodega a partir de sus movimientos. */
function recomputeStock(productId: string, warehouseId: string): void {
  const movements = queryAll<{
    id: string;
    quantity_in: number;
    quantity_out: number;
    unit_cost_cents: number;
  }>(
    'SELECT id, quantity_in, quantity_out, unit_cost_cents FROM stock_movements WHERE product_id = ? AND warehouse_id = ? ORDER BY date ASC, created_at ASC',
    [productId, warehouseId],
  );
  let qty = 0;
  let avg = 0;
  for (const movement of movements) {
    const qIn = Number(movement.quantity_in ?? 0);
    const qOut = Number(movement.quantity_out ?? 0);
    const unitCost = Number(movement.unit_cost_cents ?? 0);
    if (qIn > 0) {
      const newQty = qty + qIn;
      avg = newQty > 0 ? Math.round((avg * qty + unitCost * qIn) / newQty) : unitCost;
      qty = newQty;
    } else if (qOut > 0) {
      qty = Math.max(0, qty - qOut);
    }
    execute('UPDATE stock_movements SET balance_qty = ?, balance_cost_cents = ? WHERE id = ?', [
      qty,
      Math.round(avg * qty),
      movement.id,
    ]);
  }
  execute(
    `INSERT INTO stocks (product_id, warehouse_id, amount, avg_cost_cents, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(product_id, warehouse_id) DO UPDATE SET amount=excluded.amount,
       avg_cost_cents=excluded.avg_cost_cents, updated_at=excluded.updated_at`,
    [productId, warehouseId, qty, avg, nowIso()],
  );
}

function nextVoucherCode(): string {
  const total = queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM stock_vouchers')?.total ?? 0;
  return `CS-${String(total + 1).padStart(6, '0')}`;
}

function voucherDto(row: Record<string, unknown>) {
  const items = queryAll<Record<string, unknown>>(
    `SELECT i.*, p.code AS product_code, p.description AS product_description
     FROM stock_voucher_items i JOIN products p ON p.id = i.product_id WHERE i.voucher_id = ?`,
    [row.id],
  );
  return {
    id: String(row.id),
    code: String(row.code),
    type: String(row.type),
    date: String(row.date),
    warehouseId: String(row.warehouse_id),
    toWarehouseId: row.to_warehouse_id ? String(row.to_warehouse_id) : null,
    provider: row.provider ? String(row.provider) : null,
    observation: row.observation ? String(row.observation) : null,
    totalCents: Number(row.total_cents ?? 0),
    status: String(row.status),
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
    items: items.map((item) => ({
      id: String(item.id),
      productId: String(item.product_id),
      productCode: String(item.product_code),
      productDescription: String(item.product_description),
      quantity: Number(item.quantity),
      unitCostCents: Number(item.unit_cost_cents),
      lot: item.lot ? String(item.lot) : null,
      expiresAt: item.expires_at ? String(item.expires_at) : null,
    })),
  };
}

export interface StockVoucherInput {
  type: 'income' | 'outgoes' | 'transfer' | 'adjust';
  date?: string;
  warehouseId: string;
  toWarehouseId?: string | null;
  provider?: string | null;
  observation?: string | null;
  items: { productId: string; quantity: number; unitCostCents?: number; lot?: string | null; expiresAt?: string | null }[];
}

/** Crea un comprobante de stock y aplica sus movimientos (usado también por el seed). */
export function createStockVoucher(input: StockVoucherInput, userId: string | null) {
  if (!['income', 'outgoes', 'transfer', 'adjust'].includes(input.type)) {
    throw ApiError.badRequest('Tipo de comprobante de stock inválido');
  }
  if (!input.items || input.items.length === 0) throw ApiError.badRequest('El comprobante no tiene ítems');
  if (!queryOne('SELECT id FROM warehouses WHERE id = ?', [input.warehouseId])) {
    throw ApiError.badRequest('La bodega de origen no existe');
  }
  if (input.type === 'transfer') {
    if (!input.toWarehouseId) throw ApiError.badRequest('La transferencia requiere bodega de destino');
    if (input.toWarehouseId === input.warehouseId) throw ApiError.badRequest('La bodega de destino debe ser diferente');
    if (!queryOne('SELECT id FROM warehouses WHERE id = ?', [input.toWarehouseId])) {
      throw ApiError.badRequest('La bodega de destino no existe');
    }
  }

  return transaction(() => {
    const id = newId();
    const code = nextVoucherCode();
    const date = input.date ?? nowIso();
    let totalCents = 0;

    const resolved = input.items.map((item) => {
      const product = findProduct(item.productId);
      if (!product) throw ApiError.badRequest(`Producto no encontrado: ${item.productId}`);
      const quantity = Number(item.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw ApiError.badRequest(`Cantidad inválida para el producto ${product.code}`);
      }
      const current = getStockRow(item.productId, input.warehouseId);
      const fallbackCost = Number(product.cost_cents ?? 0) || Number(current.avg_cost_cents ?? 0);
      const unitCostCents =
        item.unitCostCents !== undefined && item.unitCostCents !== null && Number(item.unitCostCents) > 0
          ? Math.round(Number(item.unitCostCents))
          : fallbackCost;
      totalCents += Math.round(unitCostCents * quantity);
      return { ...item, product, quantity, unitCostCents };
    });

    execute(
      `INSERT INTO stock_vouchers (id, code, type, date, warehouse_id, to_warehouse_id, provider, observation,
        total_cents, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        code,
        input.type,
        date,
        input.warehouseId,
        input.type === 'transfer' ? input.toWarehouseId ?? null : null,
        input.provider ?? null,
        input.observation ?? null,
        totalCents,
        'applied',
        userId,
        nowIso(),
        nowIso(),
      ],
    );

    for (const item of resolved) {
      execute(
        'INSERT INTO stock_voucher_items (id, voucher_id, product_id, quantity, unit_cost_cents, lot, expires_at) VALUES (?,?,?,?,?,?,?)',
        [newId(), id, item.productId, item.quantity, item.unitCostCents, item.lot ?? null, item.expiresAt ?? null],
      );
      if (input.type === 'income') {
        applyMovement({
          voucherId: id,
          voucherCode: code,
          productId: item.productId,
          warehouseId: input.warehouseId,
          date,
          type: 'income',
          description: `Ingreso ${code}`,
          direction: 'in',
          quantity: item.quantity,
          unitCostCents: item.unitCostCents,
        });
      } else if (input.type === 'outgoes') {
        applyMovement({
          voucherId: id,
          voucherCode: code,
          productId: item.productId,
          warehouseId: input.warehouseId,
          date,
          type: 'outgoes',
          description: `Egreso ${code}`,
          direction: 'out',
          quantity: item.quantity,
          unitCostCents: item.unitCostCents,
        });
      } else if (input.type === 'transfer') {
        applyMovement({
          voucherId: id,
          voucherCode: code,
          productId: item.productId,
          warehouseId: input.warehouseId,
          date,
          type: 'transfer-out',
          description: `Transferencia ${code} (salida)`,
          direction: 'out',
          quantity: item.quantity,
          unitCostCents: item.unitCostCents,
        });
        applyMovement({
          voucherId: id,
          voucherCode: code,
          productId: item.productId,
          warehouseId: input.toWarehouseId!,
          date,
          type: 'transfer-in',
          description: `Transferencia ${code} (entrada)`,
          direction: 'in',
          quantity: item.quantity,
          unitCostCents: item.unitCostCents,
        });
      }
    }

    if (userId) audit('stock_vouchers', id, 'created', `Creado por usuario`, userId);
    return voucherDto(queryOne('SELECT * FROM stock_vouchers WHERE id = ?', [id])!);
  });
}

/** Ajuste por cantidad objetivo: genera ingreso o egreso por la diferencia. */
export function adjustStock(
  input: { warehouseId: string; date?: string; items: { productId: string; targetQuantity: number }[] },
  userId: string | null,
) {
  return transaction(() => {
    if (!queryOne('SELECT id FROM warehouses WHERE id = ?', [input.warehouseId])) {
      throw ApiError.badRequest('La bodega no existe');
    }
    const id = newId();
    const code = nextVoucherCode();
    const date = input.date ?? nowIso();
    execute(
      `INSERT INTO stock_vouchers (id, code, type, date, warehouse_id, provider, observation, total_cents, status,
        created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, code, 'adjust', date, input.warehouseId, null, 'Ajuste de stock', 0, 'applied', userId, nowIso(), nowIso()],
    );
    let total = 0;
    for (const item of input.items) {
      const product = findProduct(item.productId);
      if (!product) throw ApiError.badRequest(`Producto no encontrado: ${item.productId}`);
      const current = getStockRow(item.productId, input.warehouseId);
      const currentQty = Number(current.amount ?? 0);
      const target = Number(item.targetQuantity);
      if (!Number.isFinite(target) || target < 0) throw ApiError.badRequest('Cantidad objetivo inválida');
      const diff = target - currentQty;
      if (Math.abs(diff) < 1e-9) continue;
      const unitCost = Number(current.avg_cost_cents ?? 0) || Number(product.cost_cents ?? 0);
      execute(
        'INSERT INTO stock_voucher_items (id, voucher_id, product_id, quantity, unit_cost_cents) VALUES (?,?,?,?,?)',
        [newId(), id, item.productId, Math.abs(diff), unitCost],
      );
      total += Math.round(unitCost * Math.abs(diff));
      applyMovement({
        voucherId: id,
        voucherCode: code,
        productId: item.productId,
        warehouseId: input.warehouseId,
        date,
        type: 'adjust',
        description: `Ajuste ${code} (${diff > 0 ? 'entrada' : 'salida'})`,
        direction: diff > 0 ? 'in' : 'out',
        quantity: Math.abs(diff),
        unitCostCents: unitCost,
      });
    }
    execute('UPDATE stock_vouchers SET total_cents = ? WHERE id = ?', [total, id]);
    if (userId) audit('stock_vouchers', id, 'created', 'Ajuste de stock', userId);
    return voucherDto(queryOne('SELECT * FROM stock_vouchers WHERE id = ?', [id])!);
  });
}

/** Registra los egresos de stock de una venta (usado por facturación). */
/**
 * Verifica disponibilidad de stock ANTES de emitir una factura, para no consumir
 * un secuencial ni crear un comprobante que luego falle en el inventario.
 */
export function assertStockForSale(items: { productId: string; quantity: number }[]): void {
  if (!items.length) return;
  const warehouse = queryOne<{ id: string; name: string }>(
    "SELECT id, name FROM warehouses WHERE status = 'active' ORDER BY code ASC LIMIT 1",
  );
  if (!warehouse) return;
  const required = new Map<string, number>();
  for (const item of items) {
    required.set(item.productId, (required.get(item.productId) ?? 0) + Number(item.quantity));
  }
  for (const [productId, quantity] of required) {
    const product = findProduct(productId);
    if (!product || !product.track_stock) continue;
    const available = Number(getStockRow(productId, warehouse.id).amount ?? 0);
    if (quantity - available > 1e-9) {
      throw ApiError.badRequest(
        `Stock insuficiente de "${product.code} · ${product.description}" en ${warehouse.name} ` +
          `(disponible ${available}, solicitado ${quantity}). ` +
          'Registre un ingreso de inventario o desactive el control de stock del producto.',
      );
    }
  }
}

export function applySaleMovements(
  voucherId: string,
  voucherCode: string,
  date: string,
  items: { productId: string; quantity: number }[],
  userId: string | null,
): void {
  const affected = new Set<string>();
  for (const item of items) {
    const product = findProduct(item.productId);
    if (!product || !product.track_stock) continue;
    // Bodega por defecto: el establecimiento no la define en este esquema, se usa la primera bodega activa.
    const warehouse = queryOne<{ id: string }>(
      "SELECT id FROM warehouses WHERE status = 'active' ORDER BY code ASC LIMIT 1",
    );
    if (!warehouse) continue;
    applyMovement({
      voucherId,
      voucherCode,
      productId: item.productId,
      warehouseId: warehouse.id,
      date,
      type: 'sale',
      description: `Venta ${voucherCode}`,
      direction: 'out',
      quantity: item.quantity,
      unitCostCents: getStockRow(item.productId, warehouse.id).avg_cost_cents,
    });
    affected.add(`${item.productId}|${warehouse.id}`);
  }
  if (userId && affected.size) audit('stock', voucherId, 'sale', `Egreso por venta ${voucherCode}`, userId);
}

export function registerInventoryRoutes(router: Router): void {
  /* --------------------------------------------------------------- bodegas */
  router.get('/api/warehouses', 'inventory:read', () =>
    camelAll(
      queryAll('SELECT id, code, name, description, color, status FROM warehouses ORDER BY code ASC'),
    ),
  );

  router.post('/api/warehouses', 'inventory:write', (ctx) => {
    const body = bodyOf<Record<string, unknown>>(ctx);
    const code = str(body.code, 'code', { required: true, max: 20 });
    if (queryOne('SELECT id FROM warehouses WHERE code = ?', [code])) {
      throw ApiError.conflict('Ya existe una bodega con ese código');
    }
    const id = newId();
    execute('INSERT INTO warehouses (id, code, name, description, color, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [
      id,
      code,
      str(body.name, 'name', { required: true, max: 120 }),
      str(body.description, 'description') || null,
      str(body.color, 'color') || null,
      'active',
      nowIso(),
      nowIso(),
    ]);
    return camel(queryOne('SELECT * FROM warehouses WHERE id = ?', [id])!);
  });

  router.put('/api/warehouses/:id', 'inventory:write', (ctx) => {
    const row = queryOne('SELECT * FROM warehouses WHERE id = ?', [ctx.params.id]);
    if (!row) throw ApiError.notFound('Bodega no encontrada');
    const body = bodyOf<Record<string, unknown>>(ctx);
    execute('UPDATE warehouses SET name=?, description=?, color=?, status=?, updated_at=? WHERE id=?', [
      body.name !== undefined ? str(body.name, 'name', { required: true }) : row.name,
      body.description !== undefined ? str(body.description, 'description') || null : row.description,
      body.color !== undefined ? str(body.color, 'color') || null : row.color,
      body.status !== undefined ? str(body.status, 'status') : row.status,
      nowIso(),
      ctx.params.id,
    ]);
    return camel(queryOne('SELECT * FROM warehouses WHERE id = ?', [ctx.params.id])!);
  });

  router.delete('/api/warehouses/:id', 'inventory:write', (ctx) => {
    const stock = queryOne<{ total: number }>('SELECT COALESCE(SUM(amount),0) AS total FROM stocks WHERE warehouse_id = ?', [
      ctx.params.id,
    ]);
    if (Number(stock?.total ?? 0) > 0) throw ApiError.badRequest('No se puede eliminar: la bodega tiene stock');
    execute("UPDATE warehouses SET status = 'inactive', updated_at = ? WHERE id = ?", [nowIso(), ctx.params.id]);
    return { message: 'Bodega desactivada' };
  });

  /* ---------------------------------------------------------------- stocks */
  router.get('/api/stocks', 'inventory:read', (ctx) => {
    const { page, limit, offset } = pageParams(ctx.query);
    const warehouseId = ctx.query.get('warehouseId') ?? '';
    const q = (ctx.query.get('q') ?? '').trim();
    const lowStock = ctx.query.get('lowStock') === 'true';
    const where: string[] = ["p.status = 'active'"];
    const params: unknown[] = [];
    if (warehouseId) {
      where.push('s.warehouse_id = ?');
      params.push(warehouseId);
    }
    if (q) {
      where.push('(p.code LIKE ? OR p.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (lowStock) where.push('s.amount <= p.min_stock');
    const clause = `WHERE ${where.join(' AND ')}`;
    const total =
      queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM stocks s JOIN products p ON p.id = s.product_id ${clause}`,
        params,
      )?.total ?? 0;
    const rows = queryAll<Record<string, unknown>>(
      `SELECT s.*, p.code, p.description, p.min_stock, p.type, w.name AS warehouse_name
       FROM stocks s JOIN products p ON p.id = s.product_id JOIN warehouses w ON w.id = s.warehouse_id
       ${clause} ORDER BY p.description ASC, w.name ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const totals = queryOne<{ value: number }>(
      `SELECT COALESCE(SUM(s.amount * s.avg_cost_cents),0) AS value FROM stocks s JOIN products p ON p.id = s.product_id ${clause}`,
      params,
    );
    return {
      ...paginated(
        rows.map((row) => ({
          productId: String(row.product_id),
          code: String(row.code),
          description: String(row.description),
          type: String(row.type),
          warehouseId: String(row.warehouse_id),
          warehouseName: String(row.warehouse_name),
          amount: Number(row.amount ?? 0),
          avgCostCents: Number(row.avg_cost_cents ?? 0),
          totalCents: Math.round(Number(row.amount ?? 0) * Number(row.avg_cost_cents ?? 0)),
          minStock: Number(row.min_stock ?? 0),
          lowStock: Number(row.amount ?? 0) <= Number(row.min_stock ?? 0),
        })),
        total,
        page,
        limit,
      ),
      summary: { totalValueCents: Number(totals?.value ?? 0) },
    };
  });

  /* ------------------------------------------------- comprobantes de stock */
  router.get('/api/stock-vouchers', 'inventory:read', (ctx) => {
    const { page, limit, offset } = pageParams(ctx.query);
    const type = ctx.query.get('type') ?? '';
    const from = ctx.query.get('from') ?? '';
    const to = ctx.query.get('to') ?? '';
    const where: string[] = [];
    const params: unknown[] = [];
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    if (from) {
      where.push('date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('date <= ?');
      params.push(to);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM stock_vouchers ${clause}`, params)?.total ?? 0;
    const rows = queryAll<Record<string, unknown>>(
      `SELECT * FROM stock_vouchers ${clause} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return paginated(rows.map(voucherDto), total, page, limit);
  });

  router.get('/api/stock-vouchers/:id', 'inventory:read', (ctx) => {
    const row = queryOne('SELECT * FROM stock_vouchers WHERE id = ?', [ctx.params.id]);
    if (!row) throw ApiError.notFound('Comprobante de stock no encontrado');
    return voucherDto(row);
  });

  router.post('/api/stock-vouchers', 'inventory:write', (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    const voucher = createStockVoucher(
      {
        type: str(body.type, 'type', { required: true }) as StockVoucherInput['type'],
        date: str(body.date, 'date') || undefined,
        warehouseId: str(body.warehouseId, 'warehouseId', { required: true }),
        toWarehouseId: str(body.toWarehouseId, 'toWarehouseId') || null,
        provider: str(body.provider, 'provider') || null,
        observation: str(body.observation, 'observation') || null,
        items: items.map((item) => ({
          productId: str(item.productId, 'items.productId', { required: true }),
          quantity: Number(item.quantity),
          unitCostCents: item.unitCostCents !== undefined ? Number(item.unitCostCents) : undefined,
          lot: str(item.lot, 'items.lot') || null,
          expiresAt: str(item.expiresAt, 'items.expiresAt') || null,
        })),
      },
      auth.id,
    );
    return voucher;
  });

  router.delete('/api/stock-vouchers/:id', 'inventory:write', (ctx) => {
    const row = queryOne('SELECT * FROM stock_vouchers WHERE id = ?', [ctx.params.id]);
    if (!row) throw ApiError.notFound('Comprobante de stock no encontrado');
    if (String(row.type) === 'adjust') {
      throw ApiError.badRequest('No se puede eliminar un ajuste de stock; registre un nuevo ajuste');
    }
    return transaction(() => {
      const movements = queryAll<{ product_id: string; warehouse_id: string }>(
        'SELECT DISTINCT product_id, warehouse_id FROM stock_movements WHERE voucher_id = ?',
        [row.id],
      );
      execute('DELETE FROM stock_movements WHERE voucher_id = ?', [row.id]);
      execute('DELETE FROM stock_voucher_items WHERE voucher_id = ?', [row.id]);
      execute('DELETE FROM stock_vouchers WHERE id = ?', [row.id]);
      for (const movement of movements) recomputeStock(String(movement.product_id), String(movement.warehouse_id));
      return { message: 'Comprobante eliminado y stock recalculado' };
    });
  });

  router.post('/api/stock-vouchers/adjust', 'inventory:write', (ctx) => {
    const auth = requireUser(ctx);
    const body = bodyOf<Record<string, unknown>>(ctx);
    const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
    return adjustStock(
      {
        warehouseId: str(body.warehouseId, 'warehouseId', { required: true }),
        date: str(body.date, 'date') || undefined,
        items: items.map((item) => ({
          productId: str(item.productId, 'productId', { required: true }),
          targetQuantity: Number(item.targetQuantity),
        })),
      },
      auth.id,
    );
  });

  /* ---------------------------------------------------------------- kardex */
  router.get('/api/kardex', 'inventory:read', (ctx) => {
    const { page, limit, offset } = pageParams(ctx.query);
    const productId = ctx.query.get('productId') ?? '';
    const warehouseId = ctx.query.get('warehouseId') ?? '';
    const from = ctx.query.get('from') ?? '';
    const to = ctx.query.get('to') ?? '';
    if (!productId) throw ApiError.badRequest('El parámetro productId es obligatorio para el Kardex');
    const where: string[] = ['m.product_id = ?'];
    const params: unknown[] = [productId];
    if (warehouseId) {
      where.push('m.warehouse_id = ?');
      params.push(warehouseId);
    }
    if (from) {
      where.push('m.date >= ?');
      params.push(from);
    }
    if (to) {
      where.push('m.date <= ?');
      params.push(to);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = queryOne<{ total: number }>(`SELECT COUNT(*) AS total FROM stock_movements m ${clause}`, params)?.total ?? 0;
    const rows = queryAll<Record<string, unknown>>(
      `SELECT m.*, w.name AS warehouse_name FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
       ${clause} ORDER BY m.date ASC, m.created_at ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    // Saldo inicial: último movimiento antes del rango
    let openingQty = 0;
    let openingCost = 0;
    if (from) {
      const opening = queryOne<Record<string, unknown>>(
        `SELECT balance_qty, balance_cost_cents FROM stock_movements m ${clause} AND m.date < ?
         ORDER BY m.date DESC, m.created_at DESC LIMIT 1`,
        [...params, from],
      );
      // La consulta anterior ya filtra por from; recalculamos sin él:
      const openingRow = queryOne<Record<string, unknown>>(
        `SELECT balance_qty, balance_cost_cents FROM stock_movements m
         WHERE m.product_id = ? ${warehouseId ? 'AND m.warehouse_id = ?' : ''} AND m.date < ?
         ORDER BY m.date DESC, m.created_at DESC LIMIT 1`,
        warehouseId ? [productId, warehouseId, from] : [productId, from],
      );
      void opening;
      openingQty = Number(openingRow?.balance_qty ?? 0);
      openingCost = Number(openingRow?.balance_cost_cents ?? 0);
    }
    const totals = queryOne<Record<string, unknown>>(
      `SELECT COALESCE(SUM(m.quantity_in),0) AS inQty, COALESCE(SUM(m.quantity_out),0) AS outQty
       FROM stock_movements m ${clause}`,
      params,
    );
    const closingQty = openingQty + Number(totals?.inQty ?? 0) - Number(totals?.outQty ?? 0);

    return {
      ...paginated(
        rows.map((row) => ({
          date: String(row.date),
          voucherId: row.voucher_id ? String(row.voucher_id) : null,
          voucherCode: row.voucher_code ? String(row.voucher_code) : null,
          type: String(row.type),
          description: row.description ? String(row.description) : '',
          warehouseId: String(row.warehouse_id),
          warehouseName: String(row.warehouse_name),
          quantityIn: Number(row.quantity_in ?? 0),
          quantityOut: Number(row.quantity_out ?? 0),
          unitCostCents: Number(row.unit_cost_cents ?? 0),
          balanceQty: Number(row.balance_qty ?? 0),
          avgCostCents:
            Number(row.balance_qty ?? 0) > 0
              ? Math.round(Number(row.balance_cost_cents ?? 0) / Number(row.balance_qty))
              : Number(row.unit_cost_cents ?? 0),
          balanceCostCents: Number(row.balance_cost_cents ?? 0),
        })),
        total,
        page,
        limit,
      ),
      summary: {
        openingQty,
        openingCostCents: openingCost,
        inQty: Number(totals?.inQty ?? 0),
        outQty: Number(totals?.outQty ?? 0),
        closingQty,
      },
    };
  });

  router.get('/api/kardex/export', 'inventory:read', (ctx) => {
    const productId = ctx.query.get('productId') ?? '';
    if (!productId) throw ApiError.badRequest('El parámetro productId es obligatorio');
    const warehouseId = ctx.query.get('warehouseId') ?? '';
    const from = ctx.query.get('from') ?? '';
    const to = ctx.query.get('to') ?? '';
    const params: unknown[] = [productId];
    let clause = 'WHERE m.product_id = ?';
    if (warehouseId) {
      clause += ' AND m.warehouse_id = ?';
      params.push(warehouseId);
    }
    if (from) {
      clause += ' AND m.date >= ?';
      params.push(from);
    }
    if (to) {
      clause += ' AND m.date <= ?';
      params.push(to);
    }
    const rows = queryAll<Record<string, unknown>>(
      `SELECT m.*, p.code AS product_code, p.description AS product_description, w.name AS warehouse_name
       FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
       ${clause} ORDER BY m.date ASC, m.created_at ASC`,
      params,
    );
    const header = 'Fecha;Comprobante;Tipo;Detalle;Bodega;Entradas;Salidas;Costo unitario;Saldo;Costo promedio;Saldo valorado\n';
    const lines = rows.map((row) =>
      [
        String(row.date).slice(0, 10),
        row.voucher_code ?? '',
        row.type ?? '',
        String(row.description ?? '').replace(/;/g, ','),
        row.warehouse_name ?? '',
        Number(row.quantity_in ?? 0) || '',
        Number(row.quantity_out ?? 0) || '',
        (Number(row.unit_cost_cents ?? 0) / 100).toFixed(2),
        Number(row.balance_qty ?? 0),
        (Number(row.balance_cost_cents ?? 0) / Number(row.balance_qty ?? 1) / 100 || 0).toFixed(2),
        (Number(row.balance_cost_cents ?? 0) / 100).toFixed(2),
      ].join(';'),
    );
    return {
      __file: Buffer.from(`\uFEFF${header}${lines.join('\n')}`, 'utf8'),
      contentType: 'text/csv; charset=utf-8',
      filename: `kardex-${productId}.csv`,
    };
  });
}


