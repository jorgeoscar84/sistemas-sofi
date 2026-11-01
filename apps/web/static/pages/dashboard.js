/** Dashboard: métricas de facturación, catálogo e inventario. */

import { apiGet, esc, fmtDate, money, pageHead, renderTable, spinnerHtml, statusBadge, toastError } from '../lib.js';

export async function render(root, ctx) {
  root.innerHTML = `
    ${pageHead('Panel de control', 'Resumen de facturación electrónica, inventario y clientes', `
      <a class="btn primary" href="#/invoicing/new">＋ Nueva factura</a>
      <a class="btn" href="#/pos">🛒 Punto de venta</a>
    `)}
    <div id="dashboard-body">${spinnerHtml()}</div>`;

  try {
    const [data, company] = await Promise.all([apiGet('/dashboard'), apiGet('/company').catch(() => null)]);
    const body = document.getElementById('dashboard-body');
    const maxMonth = Math.max(1, ...data.monthlySeries.map((month) => month.totalCents));
    body.innerHTML = `
      ${company ? `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap">
        <div>
          <div class="muted small">Empresa emisora</div>
          <h3 style="margin:2px 0 4px">${esc(company.name)} · RUC ${esc(company.ruc)}</h3>
          <div class="small muted">${esc(company.address || '')}</div>
        </div>
        <div class="inline">
          <span class="badge ${company.environment === 2 ? 'red' : 'amber'}">${company.environment === 2 ? 'SRI Producción' : 'SRI Pruebas'}</span>
          <span class="badge blue">Modo ${esc({ mock: 'Simulado', 'direct-sri': 'SRI directo', upconta: 'UpConta' }[company.sriMode] || company.sriMode)}</span>
          <span class="badge ${company.hasSignature ? 'green' : 'gray'}">${company.hasSignature ? 'Certificado cargado' : 'Sin certificado'}</span>
        </div>
      </div>` : ''}

      <div class="grid cols-4">
        <div class="stat"><div class="label">Facturas del mes</div><div class="value">${data.invoicesThisMonth}</div><div class="foot">autorizadas en el SRI</div></div>
        <div class="stat"><div class="label">Total facturado (mes)</div><div class="value">${money(data.totalBilledThisMonthCents)}</div><div class="foot">comprobantes autorizados</div></div>
        <div class="stat"><div class="label">Borradores</div><div class="value">${data.drafts}</div><div class="foot">pendientes de emisión</div></div>
        <div class="stat"><div class="label">Rechazados / offline</div><div class="value ${data.failed ? 'neg' : ''}">${data.failed}</div><div class="foot">requieren reintento</div></div>
        <div class="stat"><div class="label">Productos y servicios</div><div class="value">${data.products}</div><div class="foot">activos en el catálogo</div></div>
        <div class="stat"><div class="label">Stock bajo</div><div class="value ${data.lowStock ? 'neg' : ''}">${data.lowStock}</div><div class="foot">ítems bajo el mínimo</div></div>
        <div class="stat"><div class="label">Valor del inventario</div><div class="value">${money(data.stockValueCents)}</div><div class="foot">costo promedio ponderado</div></div>
        <div class="stat"><div class="label">Clientes</div><div class="value">${data.clients}</div><div class="foot">registrados y activos</div></div>
      </div>

      <div class="split mt-16">
        <div class="card">
          <div class="card-head"><h3>Últimos comprobantes</h3><a class="btn sm" href="#/invoicing">Ver todos</a></div>
          <div id="recent-table"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Facturación últimos 6 meses</h3></div>
          <div style="display:grid;gap:10px">
            ${data.monthlySeries
              .map(
                (month) => `
              <div>
                <div class="flex between small" style="margin-bottom:3px">
                  <span class="muted">${esc(month.month)}</span>
                  <b>${money(month.totalCents)}</b>
                </div>
                <div style="height:10px;background:#f1f5f9;border-radius:999px;overflow:hidden">
                  <div style="height:100%;width:${Math.max(2, Math.round((month.totalCents / maxMonth) * 100))}%;background:linear-gradient(90deg,#ff6b35,#ff8f5e);border-radius:999px"></div>
                </div>
                <div class="small muted" style="margin-top:2px">${month.count} comprobante(s)</div>
              </div>`,
              )
              .join('')}
          </div>
        </div>
      </div>`;

    renderTable(document.getElementById('recent-table'), {
      columns: [
        {
          label: 'Comprobante',
          render: (row) => `<a href="#/invoicing/${esc(row.id)}" class="mono">${esc(row.number || '—')}</a>`,
        },
        { label: 'Cliente', render: (row) => `<span class="truncate">${esc(row.clientName || 'Consumidor final')}</span>` },
        { label: 'Fecha', render: (row) => fmtDate(row.issueDate), className: 'nowrap' },
        { label: 'Total', align: 'num', render: (row) => money(row.totalCents) },
        { label: 'Estado', render: (row) => statusBadge(row.status) },
      ],
      rows: data.recentVouchers,
      empty: 'Aún no hay comprobantes emitidos',
    });
  } catch (error) {
    document.getElementById('dashboard-body').innerHTML = `<div class="card"><h3>No se pudo cargar el panel</h3><p class="muted">${esc(error.message)}</p></div>`;
    toastError(error);
  }
  void ctx;
}
