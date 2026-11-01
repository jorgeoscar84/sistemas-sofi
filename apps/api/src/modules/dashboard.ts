/** Dashboard: métricas de facturación, catálogo e inventario. */

import { Router } from '../http.ts';
import { queryAll, queryOne } from '../db.ts';
import { voucherDto } from './invoicing.ts';

export function registerDashboardRoutes(router: Router): void {
  router.get('/api/dashboard', 'dashboard:read', () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const invoicesThisMonth =
      queryOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM vouchers WHERE doc_type = '01' AND status = 'issued' AND issue_date >= ?",
        [monthStart],
      )?.total ?? 0;
    const billed =
      queryOne<{ total: number }>(
        "SELECT COALESCE(SUM(total_cents),0) AS total FROM vouchers WHERE doc_type = '01' AND status = 'issued' AND issue_date >= ?",
        [monthStart],
      )?.total ?? 0;
    const drafts = queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM vouchers WHERE status = 'draft'")?.total ?? 0;
    const failed =
      queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM vouchers WHERE status IN ('failed','offline')")?.total ?? 0;
    const products = queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM products WHERE status = 'active'")?.total ?? 0;
    const lowStock =
      queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM stocks s JOIN products p ON p.id = s.product_id WHERE s.amount <= p.min_stock')?.total ??
      0;
    const stockValue =
      queryOne<{ value: number }>('SELECT COALESCE(SUM(amount * avg_cost_cents),0) AS value FROM stocks')?.value ?? 0;
    const clients = queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM clients WHERE status = 'active'")?.total ?? 0;

    const recentRows = queryAll<Record<string, unknown>>(
      'SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 10',
    );
    const monthlySeries: { month: string; totalCents: number; count: number }[] = [];
    for (let offset = 5; offset >= 0; offset--) {
      const start = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - offset + 1, 1);
      const row = queryOne<{ total: number; count: number }>(
        "SELECT COALESCE(SUM(total_cents),0) AS total, COUNT(*) AS count FROM vouchers WHERE doc_type='01' AND status='issued' AND issue_date >= ? AND issue_date < ?",
        [start.toISOString(), end.toISOString()],
      );
      monthlySeries.push({
        month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
        totalCents: Number(row?.total ?? 0),
        count: Number(row?.count ?? 0),
      });
    }

    return {
      invoicesThisMonth,
      totalBilledThisMonthCents: Number(billed),
      drafts,
      failed,
      products,
      lowStock,
      stockValueCents: Number(stockValue),
      clients,
      recentVouchers: recentRows.map((row) => voucherDto(row as never, false)),
      monthlySeries,
    };
  });
}
