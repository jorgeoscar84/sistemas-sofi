/**
 * Inventario: bodegas, stock por bodega, comprobantes de stock, ajustes y Kardex.
 * Contrato de página: `export async function render(root, ctx)`.
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  centsFromInput,
  closeModal,
  confirmDialog,
  debounce,
  decimalFromCents,
  download,
  esc,
  field,
  fmtDate,
  fmtQty,
  modal,
  money,
  option,
  pageHead,
  readForm,
  renderTable,
  spinnerHtml,
  statusBadge,
  toast,
  toastError,
  todayInput,
} from '../lib.js';

const PAGE_SIZE = 25;
const KARDEX_PAGE_SIZE = 50;

const TYPE_META = {
  income: { label: 'Ingreso', tone: 'green' },
  outgoes: { label: 'Egreso', tone: 'red' },
  transfer: { label: 'Transferencia', tone: 'blue' },
  adjust: { label: 'Ajuste', tone: 'amber' },
};

const MOVEMENT_TYPE_META = {
  income: { label: 'Ingreso', tone: 'green' },
  outgoes: { label: 'Egreso', tone: 'red' },
  'transfer-in': { label: 'Transf. entrada', tone: 'blue' },
  'transfer-out': { label: 'Transf. salida', tone: 'blue' },
  transfer: { label: 'Transferencia', tone: 'blue' },
  adjust: { label: 'Ajuste', tone: 'amber' },
  sale: { label: 'Venta', tone: 'orange' },
};

/* ------------------------------------------------------------------ utils */

function typeBadge(type) {
  const meta = TYPE_META[type] || { label: type, tone: 'gray' };
  return `<span class="badge ${meta.tone}">${esc(meta.label)}</span>`;
}

function movementTypeBadge(type) {
  const meta = MOVEMENT_TYPE_META[type] || { label: type, tone: 'gray' };
  return `<span class="badge ${meta.tone}">${esc(meta.label)}</span>`;
}

function statCard(label, value) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`;
}

function footerHtml(prevLabel = '← Anterior') {
  return `<div class="flex between center mt-16">
    <span class="muted small" id="list-count"></span>
    <div class="inline">
      <button class="btn sm" id="prev-page" type="button">${prevLabel}</button>
      <button class="btn sm" id="next-page" type="button">Siguiente →</button>
    </div>
  </div>`;
}

function syncPager(page, limit, total) {
  const prev = document.getElementById('prev-page');
  const next = document.getElementById('next-page');
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page * limit >= total;
}

function errorCard(message, backHref) {
  return `<div class="card">
    <h3>No se pudo cargar la pantalla</h3>
    <p class="muted">${esc(message)}</p>
    ${backHref ? `<a class="btn" href="${esc(backHref)}">Volver</a>` : ''}
  </div>`;
}

function warehouseOptions(warehouses, selected = '', { empty = true, excludeId = '' } = {}) {
  const items = warehouses.filter((warehouse) => warehouse.id !== excludeId);
  return (
    (empty ? '<option value="">— Seleccione bodega —</option>' : '') +
    items
      .map((warehouse) =>
        option(
          warehouse.id,
          `${warehouse.code ? `${warehouse.code} · ` : ''}${warehouse.name}`,
          selected,
          warehouse.status === 'inactive' ? 'disabled' : '',
        ),
      )
      .join('')
  );
}

let warehousesFallbackWarned = false;

/**
 * Lista de bodegas. Si `GET /warehouses` falla, deriva las bodegas con stock
 * para que las pantallas de inventario sigan siendo operativas.
 */
async function loadWarehouses() {
  try {
    const data = await apiGet('/warehouses');
    return Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  } catch (error) {
    try {
      const data = await apiGet('/stocks', { page: 1, limit: 500 });
      const rows = Array.isArray(data?.data) ? data.data : [];
      const map = new Map();
      for (const row of rows) {
        if (row.warehouseId && !map.has(row.warehouseId)) {
          map.set(row.warehouseId, {
            id: row.warehouseId,
            code: '',
            name: row.warehouseName || row.warehouseId,
            description: null,
            color: null,
            status: 'active',
          });
        }
      }
      if (!warehousesFallbackWarned) {
        warehousesFallbackWarned = true;
        toast('No se pudo listar las bodegas desde la API; se obtuvieron del stock.', 'warn');
      }
      return [...map.values()];
    } catch {
      toastError(error);
      return [];
    }
  }
}

/**
 * Buscador de productos con lista de resultados.
 * Devuelve `{ clear, close }` para limpiar el estado del buscador.
 */
function wireProductSearch({ inputId, resultsId, onPick, placeholder = 'Buscar producto por código o descripción…' }) {
  const input = document.getElementById(inputId);
  const resultsBox = document.getElementById(resultsId);
  let results = [];

  const paint = () => {
    if (!results.length) return;
    resultsBox.innerHTML = `<div class="card" style="padding:8px;margin:-2px 0 12px">
      ${results
        .map(
          (product) => `<button type="button" class="btn ghost block" data-add="${esc(product.id)}"
            style="justify-content:space-between;text-align:left">
            <span><span class="mono">${esc(product.code)}</span> · ${esc(product.description)}</span>
            <span class="muted small">stock ${fmtQty(product.totalStock)}</span>
          </button>`,
        )
        .join('')}
    </div>`;
    resultsBox.querySelectorAll('[data-add]').forEach((button) => {
      button.addEventListener('click', () => {
        const product = results.find((item) => item.id === button.dataset.add);
        if (product) {
          clear();
          onPick(product);
        }
      });
    });
  };

  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) {
      resultsBox.innerHTML = '';
      results = [];
      return;
    }
    try {
      const data = await apiGet('/products/search', { q, type: 'product' });
      results = Array.isArray(data) ? data : [];
      if (!results.length) {
        resultsBox.innerHTML = `<div class="muted small" style="padding:2px 0 12px">Sin resultados para «${esc(q)}»</div>`;
        return;
      }
      paint();
    } catch (error) {
      toastError(error);
    }
  }, 250);

  const clear = () => {
    input.value = '';
    resultsBox.innerHTML = '';
    results = [];
  };
  const close = () => {
    resultsBox.innerHTML = '';
    results = [];
  };

  input.placeholder = placeholder;
  input.addEventListener('input', search);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (results[0]) {
        const first = results[0];
        clear();
        onPick(first);
      }
    }
  });
  document.addEventListener('click', (event) => {
    if (!resultsBox.contains(event.target) && event.target !== input) close();
  });
  return { clear, close };
}

/* --------------------------------------------------------------- stock */

async function renderStocks(root, ctx) {
  const state = { page: 1, q: '', warehouseId: '', lowStock: false };
  let total = 0;

  root.innerHTML = `
    ${pageHead(
      'Stock por bodega',
      'Saldos, costo promedio ponderado y valorización del inventario',
      `<a class="btn" href="#/inventory/adjust">Ajuste de stock</a>
       <a class="btn primary" href="#/inventory/movements/new">＋ Nuevo comprobante</a>`,
    )}
    <div class="grid cols-4" style="margin-bottom:18px">
      ${statCard('Valor del inventario', `<span id="stat-stock-value">—</span>`)}
      ${statCard('Registros', `<span id="stat-stock-records">—</span>`)}
      ${statCard('Stock bajo (página)', `<span id="stat-stock-low">—</span>`)}
      ${statCard('Bodegas', `<span id="stat-stock-warehouses">—</span>`)}
    </div>
    <div class="card">
      <div class="inline" style="margin-bottom:14px">
        <select id="stock-warehouse" style="width:240px"><option value="">Todas las bodegas</option></select>
        <div class="search grow"><input id="stock-search" type="search" placeholder="Buscar por código o descripción" /></div>
        <label class="check"><input type="checkbox" id="stock-low" /> Solo stock bajo</label>
      </div>
      <div id="stocks-table">${spinnerHtml()}</div>
      ${footerHtml()}
    </div>`;

  const warehouses = await loadWarehouses();
  const warehouseSelect = document.getElementById('stock-warehouse');
  warehouseSelect.innerHTML =
    '<option value="">Todas las bodegas</option>' +
    warehouses
      .map((warehouse) => option(warehouse.id, `${warehouse.code ? `${warehouse.code} · ` : ''}${warehouse.name}`, ''))
      .join('');
  const warehouseCount = document.getElementById('stat-stock-warehouses');
  if (warehouseCount) warehouseCount.textContent = String(warehouses.filter((w) => w.status !== 'inactive').length);

  const load = async () => {
    const table = document.getElementById('stocks-table');
    renderTable(table, { columns: [], rows: [], loading: true });
    try {
      const data = await apiGet('/stocks', {
        warehouseId: state.warehouseId,
        q: state.q,
        lowStock: state.lowStock ? 'true' : '',
        page: state.page,
        limit: PAGE_SIZE,
      });
      const rows = Array.isArray(data.data) ? data.data : [];
      total = Number(data.total || 0);
      const summary = data.summary || {};
      const valueNode = document.getElementById('stat-stock-value');
      if (valueNode) valueNode.textContent = money(summary.totalValueCents);
      const recordsNode = document.getElementById('stat-stock-records');
      if (recordsNode) recordsNode.textContent = fmtQty(total, 0);
      const lowNode = document.getElementById('stat-stock-low');
      if (lowNode) lowNode.textContent = fmtQty(rows.filter((row) => row.lowStock).length, 0);
      const count = document.getElementById('list-count');
      if (count) count.textContent = `${total} registro(s) · página ${data.page || state.page}`;

      renderTable(table, {
        columns: [
          {
            label: 'Producto',
            render: (row) => `<span class="mono">${esc(row.code)}</span> ${esc(row.description)}`,
          },
          { label: 'Bodega', render: (row) => esc(row.warehouseName || '—') },
          { label: 'Cantidad', align: 'num', render: (row) => fmtQty(row.amount) },
          { label: 'Costo promedio', align: 'num', render: (row) => money(row.avgCostCents) },
          { label: 'Valor', align: 'num', render: (row) => `<b>${money(row.totalCents)}</b>` },
          { label: 'Mínimo', align: 'num', render: (row) => fmtQty(row.minStock) },
          {
            label: 'Estado',
            render: (row) =>
              row.lowStock
                ? '<span class="badge red">Stock bajo</span>'
                : '<span class="badge green">OK</span>',
          },
        ],
        rows,
        empty: 'No hay registros de stock con los filtros seleccionados',
      });
      syncPager(state.page, PAGE_SIZE, total);
    } catch (error) {
      table.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  document.getElementById('stock-warehouse').addEventListener('change', (event) => {
    state.warehouseId = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('stock-search').addEventListener(
    'input',
    debounce((event) => {
      state.q = event.target.value.trim();
      state.page = 1;
      load();
    }, 300),
  );
  document.getElementById('stock-low').addEventListener('change', (event) => {
    state.lowStock = event.target.checked;
    state.page = 1;
    load();
  });
  document.getElementById('prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  document.getElementById('next-page').addEventListener('click', () => {
    if (state.page * PAGE_SIZE < total) {
      state.page += 1;
      load();
    }
  });

  await load();
  void ctx;
}

/* ---------------------------------------------------- comprobantes de stock */

async function renderMovements(root, ctx) {
  const state = { page: 1, type: '', from: '', to: '' };
  let total = 0;
  let rows = [];
  let warehouses = [];

  root.innerHTML = `
    ${pageHead(
      'Comprobantes de stock',
      'Ingresos, egresos, transferencias y ajustes que alimentan el Kardex',
      `<a class="btn" href="#/inventory/adjust">Ajuste de stock</a>
       <a class="btn primary" href="#/inventory/movements/new">＋ Nuevo comprobante</a>`,
    )}
    <div class="card">
      <div class="inline" style="margin-bottom:14px">
        <select id="movement-type-filter" style="width:200px">
          <option value="">Todos los tipos</option>
          ${option('income', 'Ingreso')}${option('outgoes', 'Egreso')}${option('transfer', 'Transferencia')}${option(
            'adjust',
            'Ajuste',
          )}
        </select>
        <input id="movement-from" type="date" style="width:170px" title="Desde" />
        <input id="movement-to" type="date" style="width:170px" title="Hasta" />
        <button class="btn" type="button" id="movement-clear">Limpiar</button>
      </div>
      <div id="movements-table">${spinnerHtml()}</div>
      ${footerHtml()}
    </div>`;

  warehouses = await loadWarehouses();
  const warehouseName = (id) => warehouses.find((warehouse) => warehouse.id === id)?.name || '—';

  const openDetail = async (id) => {
    try {
      const voucher = await apiGet(`/stock-vouchers/${id}`);
      const items = Array.isArray(voucher.items) ? voucher.items : [];
      const itemsHtml = items.length
        ? `<div class="table-wrap"><table class="tbl"><thead><tr>
             <th>Producto</th><th class="num">Cantidad</th><th class="num">Costo unitario</th><th class="num">Subtotal</th>
             <th>Lote</th><th>Vence</th></tr></thead><tbody>
             ${items
               .map(
                 (item) => `<tr>
                   <td><span class="mono">${esc(item.productCode)}</span> ${esc(item.productDescription)}</td>
                   <td class="num">${fmtQty(item.quantity)}</td>
                   <td class="num">${money(item.unitCostCents)}</td>
                   <td class="num">${money(Math.round(Number(item.quantity || 0) * Number(item.unitCostCents || 0)))}</td>
                   <td>${esc(item.lot || '—')}</td>
                   <td>${esc(item.expiresAt ? fmtDate(item.expiresAt) : '—')}</td>
                 </tr>`,
               )
               .join('')}
           </tbody></table></div>`
        : '<div class="empty-state">Sin ítems</div>';
      modal({
        title: `Comprobante ${voucher.code}`,
        size: 'lg',
        body: `
          <dl class="kv">
            <dt>Tipo</dt><dd>${typeBadge(voucher.type)}</dd>
            <dt>Fecha</dt><dd>${fmtDate(voucher.date)}</dd>
            <dt>Bodega origen</dt><dd>${esc(warehouseName(voucher.warehouseId))}</dd>
            ${
              voucher.toWarehouseId
                ? `<dt>Bodega destino</dt><dd>${esc(warehouseName(voucher.toWarehouseId))}</dd>`
                : ''
            }
            <dt>Proveedor</dt><dd>${esc(voucher.provider || '—')}</dd>
            <dt>Observación</dt><dd>${esc(voucher.observation || '—')}</dd>
            <dt>Total</dt><dd><b>${money(voucher.totalCents)}</b></dd>
            <dt>Estado</dt><dd>${statusBadge(voucher.status)}</dd>
          </dl>
          <h4 class="mt-16" style="margin-bottom:8px">Ítems</h4>
          ${itemsHtml}`,
        actions: [{ label: 'Cerrar', onClick: closeModal }],
      });
    } catch (error) {
      toastError(error);
    }
  };

  const load = async () => {
    const table = document.getElementById('movements-table');
    renderTable(table, { columns: [], rows: [], loading: true });
    try {
      const data = await apiGet('/stock-vouchers', {
        type: state.type,
        from: state.from,
        to: state.to ? `${state.to}T23:59:59.999Z` : '',
        page: state.page,
        limit: PAGE_SIZE,
      });
      rows = Array.isArray(data.data) ? data.data : [];
      total = Number(data.total || 0);
      const count = document.getElementById('list-count');
      if (count) count.textContent = `${total} comprobante(s) · página ${data.page || state.page}`;

      renderTable(table, {
        columns: [
          { label: 'Código', render: (row) => `<span class="mono">${esc(row.code)}</span>` },
          { label: 'Tipo', render: (row) => typeBadge(row.type) },
          { label: 'Fecha', render: (row) => fmtDate(row.date) },
          {
            label: 'Bodega(s)',
            render: (row) => {
              const origin = esc(warehouseName(row.warehouseId));
              if (!row.toWarehouseId) return origin;
              return `${origin} <span class="muted">→</span> ${esc(warehouseName(row.toWarehouseId))}`;
            },
          },
          { label: 'Proveedor', render: (row) => esc(row.provider || '—') },
          { label: 'Total', align: 'num', render: (row) => money(row.totalCents) },
          { label: 'Estado', render: (row) => statusBadge(row.status) },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `<div class="row-actions">
              <button class="btn sm" type="button" data-view="${esc(row.id)}">Ver</button>
              ${
                row.type === 'adjust'
                  ? ''
                  : `<button class="btn sm danger" type="button" data-delete="${esc(row.id)}">Eliminar</button>`
              }
            </div>`,
          },
        ],
        rows,
        empty: 'No hay comprobantes de stock registrados',
      });

      table.querySelectorAll('[data-view]').forEach((button) => {
        button.addEventListener('click', () => openDetail(button.dataset.view));
      });
      table.querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          const voucher = rows.find((item) => item.id === button.dataset.delete);
          const ok = await confirmDialog(
            `¿Eliminar el comprobante ${voucher?.code || ''}? Se revertirán sus movimientos y se recalculará el stock.`,
            { okLabel: 'Eliminar' },
          );
          if (!ok) return;
          try {
            await apiDelete(`/stock-vouchers/${button.dataset.delete}`);
            toast('Comprobante eliminado y stock recalculado');
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
      syncPager(state.page, PAGE_SIZE, total);
    } catch (error) {
      table.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  document.getElementById('movement-type-filter').addEventListener('change', (event) => {
    state.type = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('movement-from').addEventListener('change', (event) => {
    state.from = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('movement-to').addEventListener('change', (event) => {
    state.to = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('movement-clear').addEventListener('click', () => {
    state.type = '';
    state.from = '';
    state.to = '';
    state.page = 1;
    document.getElementById('movement-type-filter').value = '';
    document.getElementById('movement-from').value = '';
    document.getElementById('movement-to').value = '';
    load();
  });
  document.getElementById('prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  document.getElementById('next-page').addEventListener('click', () => {
    if (state.page * PAGE_SIZE < total) {
      state.page += 1;
      load();
    }
  });

  await load();
  void ctx;
}

/* ------------------------------------------------- nuevo comprobante de stock */

async function renderMovementForm(root, ctx) {
  root.innerHTML = spinnerHtml();
  const warehouses = await loadWarehouses();

  if (!warehouses.length) {
    root.innerHTML = errorCard(
      'No hay bodegas disponibles. Cree una bodega en Inventario → Bodegas antes de registrar movimientos.',
      '#/inventory/warehouses',
    );
    return;
  }

  root.innerHTML = `
    ${pageHead(
      'Nuevo comprobante de stock',
      'Ingreso, egreso o transferencia entre bodegas',
      '<a class="btn" href="#/inventory/movements">← Volver</a>',
    )}
    <div class="card">
      <form id="movement-form" novalidate>
        <div class="form-grid">
          ${field(
            'Tipo de comprobante',
            `<select name="type" id="movement-type">
              ${option('income', 'Ingreso', true)}${option('outgoes', 'Egreso')}${option('transfer', 'Transferencia')}
            </select>`,
          )}
          ${field('Fecha', `<input name="date" type="date" value="${todayInput()}" required />`)}
          ${field(
            'Bodega origen',
            `<select name="warehouseId" id="warehouse-origin" required>${warehouseOptions(warehouses)}</select>`,
          )}
          <div class="field hidden" id="to-warehouse-field">
            <label>Bodega destino</label>
            <select name="toWarehouseId" id="warehouse-destination">${warehouseOptions(warehouses)}</select>
          </div>
          <div class="field" id="provider-field">
            <label>Proveedor</label>
            <input name="provider" type="text" maxlength="200" placeholder="Proveedor (solo ingreso)" />
          </div>
          ${field(
            'Observación',
            `<textarea name="observation" maxlength="500" placeholder="Detalle del movimiento"></textarea>`,
            { full: true },
          )}
        </div>
      </form>
    </div>
    <div class="card">
      <h3>Líneas del comprobante</h3>
      <div class="search" style="margin-bottom:10px">
        <input id="movement-product-search" type="search" placeholder="Buscar producto por código o descripción…" />
      </div>
      <div id="movement-product-results"></div>
      <div id="movement-lines">${spinnerHtml('Agregue productos con el buscador')}</div>
      <div class="totals-box mt-16" id="movement-totals"></div>
    </div>
    <div class="flex gap-8 mt-16">
      <button class="btn primary" type="button" id="save-movement">Guardar y aplicar</button>
      <a class="btn" href="#/inventory/movements">Cancelar</a>
    </div>`;

  const form = document.getElementById('movement-form');
  const typeSelect = document.getElementById('movement-type');
  const originSelect = document.getElementById('warehouse-origin');
  const destinationSelect = document.getElementById('warehouse-destination');
  const lines = [];
  let type = typeSelect.value;

  const renderLines = () => {
    const table = document.getElementById('movement-lines');
    if (!lines.length) {
      table.innerHTML = '<div class="empty-state"><div class="icon">📦</div>Agregue productos con el buscador de arriba</div>';
      return;
    }
    const columns = [
      {
        label: 'Producto',
        render: (row) => `<span class="mono">${esc(row.code)}</span> ${esc(row.description)}`,
      },
      {
        label: 'Cantidad',
        align: 'num',
        render: (row) =>
          `<input type="number" min="0.01" step="0.01" style="width:110px;text-align:right"
             data-line="${lines.indexOf(row)}" data-field="quantity" value="${esc(row.quantity)}" />`,
      },
    ];
    if (type === 'income') {
      columns.push({
        label: 'Costo unitario',
        align: 'num',
        render: (row) =>
          `<input type="number" min="0" step="0.01" style="width:120px;text-align:right"
             data-line="${lines.indexOf(row)}" data-field="unitCost" value="${esc(row.unitCost)}" />`,
      });
    }
    columns.push(
      {
        label: 'Lote',
        render: (row) =>
          `<input type="text" style="width:130px" data-line="${lines.indexOf(row)}" data-field="lot"
             value="${esc(row.lot)}" placeholder="opcional" />`,
      },
      {
        label: 'Vencimiento',
        render: (row) =>
          `<input type="date" style="width:150px" data-line="${lines.indexOf(row)}" data-field="expiresAt"
             value="${esc(row.expiresAt)}" />`,
      },
      {
        label: 'Acciones',
        align: 'right',
        render: (row) =>
          `<button class="btn sm danger" type="button" data-remove="${lines.indexOf(row)}">Quitar</button>`,
      },
    );
    renderTable(table, { columns, rows: lines, empty: '' });
    table.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        lines.splice(Number(button.dataset.remove), 1);
        renderLines();
        renderTotals();
      });
    });
  };

  const renderTotals = () => {
    const box = document.getElementById('movement-totals');
    if (!box) return;
    const count = lines.length;
    if (type === 'income') {
      const totalCents = lines.reduce(
        (sum, line) => sum + Math.round(Number(line.quantity || 0) * centsFromInput(line.unitCost)),
        0,
      );
      box.innerHTML = `
        <div class="totals-row"><span>Ítems</span><span>${count}</span></div>
        <div class="totals-row grand"><span>Total estimado</span><span>${money(totalCents)}</span></div>`;
    } else {
      box.innerHTML = `
        <div class="totals-row"><span>Ítems</span><span>${count}</span></div>
        <div class="totals-row"><span class="muted">El costo de ${type === 'transfer' ? 'la transferencia' : 'el egreso'} se toma del costo promedio actual al aplicar el comprobante.</span><span></span></div>`;
    }
  };

  const addProduct = async (product) => {
    if (lines.some((line) => line.productId === product.id)) {
      toast('El producto ya está en el comprobante', 'warn');
      return;
    }
    let unitCost = 0;
    if (type === 'income') {
      try {
        const detail = await apiGet(`/products/${product.id}`);
        unitCost = decimalFromCents(detail.costCents);
      } catch {
        unitCost = 0;
      }
    }
    lines.push({
      productId: product.id,
      code: product.code,
      description: product.description,
      quantity: 1,
      unitCost,
      lot: '',
      expiresAt: '',
    });
    renderLines();
    renderTotals();
  };

  const syncType = () => {
    type = typeSelect.value;
    const isTransfer = type === 'transfer';
    document.getElementById('to-warehouse-field').classList.toggle('hidden', !isTransfer);
    document.getElementById('provider-field').classList.toggle('hidden', type !== 'income');
    if (isTransfer && destinationSelect.value === originSelect.value) destinationSelect.value = '';
    renderLines();
    renderTotals();
  };

  document.getElementById('movement-lines').addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const index = Number(target.dataset.line);
    const fieldName = target.dataset.field;
    if (!Number.isInteger(index) || !fieldName || !lines[index]) return;
    lines[index][fieldName] = target.value;
    renderTotals();
  });

  wireProductSearch({
    inputId: 'movement-product-search',
    resultsId: 'movement-product-results',
    onPick: (product) => addProduct(product),
  });

  typeSelect.addEventListener('change', syncType);
  originSelect.addEventListener('change', () => {
    destinationSelect.innerHTML = warehouseOptions(warehouses, destinationSelect.value, {
      excludeId: originSelect.value,
    });
  });

  document.getElementById('save-movement').addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const values = readForm(form);
    if (!values.warehouseId) {
      toast('Seleccione la bodega de origen', 'warn');
      return;
    }
    if (type === 'transfer') {
      if (!values.toWarehouseId) {
        toast('Seleccione la bodega de destino', 'warn');
        return;
      }
      if (values.toWarehouseId === values.warehouseId) {
        toast('La bodega destino debe ser diferente a la de origen', 'warn');
        return;
      }
    }
    if (!lines.length) {
      toast('Agregue al menos una línea al comprobante', 'warn');
      return;
    }
    for (const line of lines) {
      if (!(Number(line.quantity) > 0)) {
        toast(`Cantidad inválida para ${line.code}`, 'warn');
        return;
      }
      if (type === 'income' && !(Number(line.unitCost) >= 0)) {
        toast(`Costo inválido para ${line.code}`, 'warn');
        return;
      }
    }

    const payload = {
      type,
      date: values.date,
      warehouseId: values.warehouseId,
      toWarehouseId: type === 'transfer' ? values.toWarehouseId : null,
      provider: String(values.provider || '').trim() || null,
      observation: String(values.observation || '').trim() || null,
      items: lines.map((line) => ({
        productId: line.productId,
        quantity: Number(line.quantity),
        ...(type === 'income' ? { unitCostCents: centsFromInput(line.unitCost) } : {}),
        lot: String(line.lot || '').trim() || null,
        expiresAt: line.expiresAt || null,
      })),
    };

    const button = document.getElementById('save-movement');
    button.disabled = true;
    button.textContent = 'Guardando…';
    try {
      const voucher = await apiPost('/stock-vouchers', payload);
      toast(`Comprobante ${voucher.code} aplicado al inventario`);
      ctx.navigate('/inventory/movements');
    } catch (error) {
      toastError(error);
      button.disabled = false;
      button.textContent = 'Guardar y aplicar';
    }
  });

  syncType();
  void ctx;
}

/* ------------------------------------------------------- ajuste de stock */

async function renderAdjust(root, ctx) {
  root.innerHTML = spinnerHtml();
  const warehouses = await loadWarehouses();

  if (!warehouses.length) {
    root.innerHTML = errorCard(
      'No hay bodegas disponibles. Cree una bodega en Inventario → Bodegas antes de ajustar stock.',
      '#/inventory/warehouses',
    );
    return;
  }

  root.innerHTML = `
    ${pageHead(
      'Ajuste de stock',
      'Fije la cantidad objetivo por producto; se genera el ingreso o egreso por la diferencia',
      '<a class="btn" href="#/inventory/stocks">Ver stock</a>',
    )}
    <div class="card">
      <div class="form-grid">
        ${field(
          'Bodega',
          `<select id="adjust-warehouse">${warehouseOptions(warehouses)}</select>`,
          { help: 'El stock se ajusta únicamente en la bodega seleccionada' },
        )}
        ${field('Fecha', `<input id="adjust-date" type="date" value="${todayInput()}" />`)}
      </div>
    </div>
    <div class="card">
      <h3>Productos a ajustar</h3>
      <div class="search" style="margin-bottom:10px">
        <input id="adjust-product-search" type="search" disabled placeholder="Seleccione una bodega para buscar productos…" />
      </div>
      <div id="adjust-product-results"></div>
      <div id="adjust-lines"></div>
      <div class="totals-box mt-16" id="adjust-totals"></div>
    </div>
    <div class="flex gap-8 mt-16">
      <button class="btn primary" type="button" id="save-adjust">Aplicar ajuste</button>
      <a class="btn" href="#/inventory/stocks">Cancelar</a>
    </div>`;

  const warehouseSelect = document.getElementById('adjust-warehouse');
  const productInput = document.getElementById('adjust-product-search');
  const lines = [];
  let stockMap = new Map();

  const currentOf = (productId) => Number(stockMap.get(productId)?.amount ?? 0);

  const refreshStockMap = async () => {
    const warehouseId = warehouseSelect.value;
    if (!warehouseId) {
      stockMap = new Map();
      lines.length = 0;
      renderLines();
      return;
    }
    try {
      const data = await apiGet('/stocks', { warehouseId, page: 1, limit: 500 });
      const rows = Array.isArray(data.data) ? data.data : [];
      stockMap = new Map(rows.map((row) => [row.productId, row]));
      for (const line of lines) line.current = currentOf(line.productId);
      productInput.disabled = false;
      productInput.placeholder = 'Buscar producto por código o descripción…';
      renderLines();
    } catch (error) {
      toastError(error);
    }
  };

  const diffBadge = (line) => {
    const diff = Number(line.target) - Number(line.current);
    if (!Number.isFinite(diff) || Math.abs(diff) < 1e-9) return '<span class="badge gray">Sin cambio</span>';
    return diff > 0
      ? `<span class="badge green">+${fmtQty(diff)}</span>`
      : `<span class="badge red">${fmtQty(diff)}</span>`;
  };

  const renderLines = () => {
    const container = document.getElementById('adjust-lines');
    if (!lines.length) {
      container.innerHTML =
        '<div class="empty-state"><div class="icon">📦</div>Agregue productos para ajustar la cantidad objetivo</div>';
      renderTotals();
      return;
    }
    renderTable(container, {
      columns: [
        {
          label: 'Producto',
          render: (row) => `<span class="mono">${esc(row.code)}</span> ${esc(row.description)}`,
        },
        { label: 'Cantidad actual', align: 'num', render: (row) => fmtQty(row.current) },
        {
          label: 'Cantidad objetivo',
          align: 'num',
          render: (row) =>
            `<input type="number" min="0" step="0.01" style="width:120px;text-align:right"
               data-line="${lines.indexOf(row)}" data-field="target" value="${esc(row.target)}" />`,
        },
        { label: 'Diferencia', align: 'num', render: (row) => `<span data-diff="${lines.indexOf(row)}">${diffBadge(row)}</span>` },
        {
          label: 'Acciones',
          align: 'right',
          render: (row) =>
            `<button class="btn sm danger" type="button" data-remove="${lines.indexOf(row)}">Quitar</button>`,
        },
      ],
      rows: lines,
      empty: '',
    });
    container.querySelectorAll('[data-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        lines.splice(Number(button.dataset.remove), 1);
        renderLines();
      });
    });
  };

  const renderTotals = () => {
    const box = document.getElementById('adjust-totals');
    if (!box) return;
    const changed = lines.filter((line) => Math.abs(Number(line.target) - Number(line.current)) > 1e-9);
    box.innerHTML = `
      <div class="totals-row"><span>Productos</span><span>${lines.length}</span></div>
      <div class="totals-row grand"><span>Con diferencia</span><span>${changed.length}</span></div>`;
  };

  document.getElementById('adjust-lines').addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const index = Number(target.dataset.line);
    const fieldName = target.dataset.field;
    if (!Number.isInteger(index) || fieldName !== 'target' || !lines[index]) return;
    lines[index].target = target.value;
    const diffNode = document.querySelector(`[data-diff="${index}"]`);
    if (diffNode) diffNode.innerHTML = diffBadge(lines[index]);
    renderTotals();
  });

  const addProduct = (product) => {
    if (!warehouseSelect.value) {
      toast('Seleccione primero la bodega', 'warn');
      return;
    }
    if (lines.some((line) => line.productId === product.id)) {
      toast('El producto ya está en el ajuste', 'warn');
      return;
    }
    const current = currentOf(product.id);
    lines.push({
      productId: product.id,
      code: product.code,
      description: product.description,
      current,
      target: current,
    });
    renderLines();
  };

  wireProductSearch({
    inputId: 'adjust-product-search',
    resultsId: 'adjust-product-results',
    onPick: addProduct,
  });

  warehouseSelect.addEventListener('change', refreshStockMap);

  document.getElementById('save-adjust').addEventListener('click', async () => {
    const warehouseId = warehouseSelect.value;
    if (!warehouseId) {
      toast('Seleccione la bodega', 'warn');
      return;
    }
    if (!lines.length) {
      toast('Agregue al menos un producto', 'warn');
      return;
    }
    const items = [];
    for (const line of lines) {
      const target = Number(line.target);
      if (!Number.isFinite(target) || target < 0) {
        toast(`Cantidad objetivo inválida para ${line.code}`, 'warn');
        return;
      }
      if (Math.abs(target - Number(line.current)) < 1e-9) continue;
      items.push({ productId: line.productId, targetQuantity: target });
    }
    if (!items.length) {
      toast('No hay diferencias que ajustar', 'warn');
      return;
    }
    const button = document.getElementById('save-adjust');
    button.disabled = true;
    button.textContent = 'Aplicando…';
    try {
      const voucher = await apiPost('/stock-vouchers/adjust', {
        warehouseId,
        date: document.getElementById('adjust-date').value || undefined,
        items,
      });
      toast(`Ajuste ${voucher.code} aplicado al inventario`);
      ctx.navigate('/inventory/movements');
    } catch (error) {
      toastError(error);
      button.disabled = false;
      button.textContent = 'Aplicar ajuste';
    }
  });

  renderLines();
  void ctx;
}

/* ---------------------------------------------------------------- kardex */

async function renderKardex(root, ctx) {
  const state = { productId: '', warehouseId: '', from: '', to: '', page: 1 };
  let total = 0;
  let selectedProduct = null;

  root.innerHTML = `
    ${pageHead(
      'Kardex valorado',
      'Movimientos, saldos y costo promedio ponderado por producto y bodega',
      '<button class="btn" type="button" id="export-kardex">⬇ Exportar CSV</button>',
    )}
    <div class="card">
      <div class="form-grid">
        <div class="field full">
          <label>Producto</label>
          <div class="search"><input id="kardex-product-search" type="search" placeholder="Buscar producto por código o descripción…" /></div>
          <div id="kardex-product-results"></div>
          <div id="kardex-product-selected" class="small" style="margin-top:2px"></div>
        </div>
        ${field('Bodega', `<select id="kardex-warehouse"><option value="">Todas las bodegas</option></select>`)}
        <div class="inline" style="align-self:end;padding-bottom:2px">
          <div class="field"><label>Desde</label><input id="kardex-from" type="date" /></div>
          <div class="field"><label>Hasta</label><input id="kardex-to" type="date" /></div>
          <button class="btn" type="button" id="kardex-search">Consultar</button>
        </div>
      </div>
    </div>
    <div class="grid cols-4" style="margin-bottom:18px">
      ${statCard('Saldo inicial', '<span id="kardex-opening">—</span>')}
      ${statCard('Entradas', '<span id="kardex-in">—</span>')}
      ${statCard('Salidas', '<span id="kardex-out">—</span>')}
      ${statCard('Saldo final', '<span id="kardex-closing">—</span>')}
    </div>
    <div class="card">
      <div id="kardex-table"></div>
      ${footerHtml()}
    </div>`;

  const warehouses = await loadWarehouses();
  const warehouseSelect = document.getElementById('kardex-warehouse');
  warehouseSelect.innerHTML =
    '<option value="">Todas las bodegas</option>' +
    warehouses.map((warehouse) => option(warehouse.id, `${warehouse.code ? `${warehouse.code} · ` : ''}${warehouse.name}`, '')).join('');

  const productInput = document.getElementById('kardex-product-search');
  const chip = document.getElementById('kardex-product-selected');

  const paintChip = () => {
    chip.innerHTML = selectedProduct
      ? `<span class="badge orange">${esc(selectedProduct.code)} · ${esc(selectedProduct.description)}</span>
         <button class="btn sm ghost" type="button" id="kardex-clear-product">Quitar</button>`
      : '<span class="muted">Seleccione un producto para consultar su Kardex</span>';
    const clearButton = document.getElementById('kardex-clear-product');
    if (clearButton) {
      clearButton.addEventListener('click', () => {
        selectedProduct = null;
        state.productId = '';
        state.page = 1;
        paintChip();
        showEmpty('Seleccione un producto para consultar el Kardex');
        paintSummary(null);
      });
    }
  };

  const paintSummary = (summary) => {
    const opening = document.getElementById('kardex-opening');
    const incoming = document.getElementById('kardex-in');
    const outgoing = document.getElementById('kardex-out');
    const closing = document.getElementById('kardex-closing');
    if (opening) opening.textContent = summary ? fmtQty(summary.openingQty) : '—';
    if (incoming) incoming.textContent = summary ? fmtQty(summary.inQty) : '—';
    if (outgoing) outgoing.textContent = summary ? fmtQty(summary.outQty) : '—';
    if (closing) closing.textContent = summary ? fmtQty(summary.closingQty) : '—';
  };

  const showEmpty = (message) => {
    const table = document.getElementById('kardex-table');
    table.innerHTML = `<div class="empty-state"><div class="icon">📈</div>${esc(message)}</div>`;
    const count = document.getElementById('list-count');
    if (count) count.textContent = '';
    syncPager(1, KARDEX_PAGE_SIZE, 0);
  };

  const load = async () => {
    if (!state.productId) {
      paintSummary(null);
      showEmpty('Seleccione un producto para consultar el Kardex');
      return;
    }
    const table = document.getElementById('kardex-table');
    renderTable(table, { columns: [], rows: [], loading: true });
    try {
      const data = await apiGet('/kardex', {
        productId: state.productId,
        warehouseId: state.warehouseId,
        from: state.from,
        to: state.to ? `${state.to}T23:59:59.999Z` : '',
        page: state.page,
        limit: KARDEX_PAGE_SIZE,
      });
      const rows = Array.isArray(data.data) ? data.data : [];
      total = Number(data.total || 0);
      paintSummary(data.summary || {});
      const count = document.getElementById('list-count');
      if (count) count.textContent = `${total} movimiento(s) · página ${data.page || state.page}`;

      renderTable(table, {
        columns: [
          { label: 'Fecha', render: (row) => fmtDate(row.date) },
          { label: 'Comprobante', render: (row) => `<span class="mono">${esc(row.voucherCode || '—')}</span>` },
          { label: 'Tipo', render: (row) => movementTypeBadge(row.type) },
          { label: 'Detalle', render: (row) => esc(row.description || '—') },
          { label: 'Bodega', render: (row) => esc(row.warehouseName || '—') },
          { label: 'Entradas', align: 'num', render: (row) => (row.quantityIn ? fmtQty(row.quantityIn) : '') },
          { label: 'Salidas', align: 'num', render: (row) => (row.quantityOut ? fmtQty(row.quantityOut) : '') },
          { label: 'Costo unitario', align: 'num', render: (row) => money(row.unitCostCents) },
          { label: 'Saldo', align: 'num', render: (row) => `<b>${fmtQty(row.balanceQty)}</b>` },
          { label: 'Costo promedio', align: 'num', render: (row) => money(row.avgCostCents) },
          { label: 'Saldo valorado', align: 'num', render: (row) => money(row.balanceCostCents) },
        ],
        rows,
        empty: 'El producto no tiene movimientos de inventario en el período',
      });
      syncPager(state.page, KARDEX_PAGE_SIZE, total);
    } catch (error) {
      table.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${esc(error.message)}</div>`;
      paintSummary(null);
      toastError(error);
    }
  };

  wireProductSearch({
    inputId: 'kardex-product-search',
    resultsId: 'kardex-product-results',
    onPick: (product) => {
      selectedProduct = product;
      state.productId = product.id;
      state.page = 1;
      paintChip();
      load();
    },
  });

  paintChip();
  showEmpty('Seleccione un producto para consultar el Kardex');

  document.getElementById('kardex-warehouse').addEventListener('change', (event) => {
    state.warehouseId = event.target.value;
    state.page = 1;
    if (state.productId) load();
  });
  document.getElementById('kardex-from').addEventListener('change', (event) => {
    state.from = event.target.value;
    state.page = 1;
    if (state.productId) load();
  });
  document.getElementById('kardex-to').addEventListener('change', (event) => {
    state.to = event.target.value;
    state.page = 1;
    if (state.productId) load();
  });
  document.getElementById('kardex-search').addEventListener('click', () => {
    state.page = 1;
    load();
  });
  document.getElementById('prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  document.getElementById('next-page').addEventListener('click', () => {
    if (state.page * KARDEX_PAGE_SIZE < total) {
      state.page += 1;
      load();
    }
  });
  document.getElementById('export-kardex').addEventListener('click', async () => {
    if (!state.productId) {
      toast('Seleccione un producto para exportar el Kardex', 'warn');
      return;
    }
    const params = new URLSearchParams();
    params.set('productId', state.productId);
    if (state.warehouseId) params.set('warehouseId', state.warehouseId);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', `${state.to}T23:59:59.999Z`);
    try {
      await download(`/kardex/export?${params.toString()}`, 'kardex.csv');
    } catch (error) {
      toastError(error);
    }
  });

  void ctx;
}

/* --------------------------------------------------------------- bodegas */

async function renderWarehouses(root, ctx) {
  root.innerHTML = `
    ${pageHead(
      'Bodegas',
      'Almacenes donde se controla el inventario',
      '<button class="btn primary" type="button" id="new-warehouse">＋ Nueva bodega</button>',
    )}
    <div class="card"><div id="warehouses-table">${spinnerHtml()}</div></div>`;

  let items = [];

  const openForm = (warehouse) => {
    const isEdit = Boolean(warehouse);
    const color = warehouse?.color && /^#[0-9a-fA-F]{6}$/.test(warehouse.color) ? warehouse.color : '#0f172a';
    const body = `<form id="warehouse-form">
      <div class="form-grid">
        ${field(
          'Código',
          `<input name="code" required maxlength="20" value="${esc(warehouse?.code || '')}" placeholder="B01" ${
            isEdit ? 'readonly' : ''
          } />`,
          { help: isEdit ? 'El código no se puede modificar' : 'Único (ej. B01, MATRIZ)' },
        )}
        ${field('Nombre', `<input name="name" required maxlength="120" value="${esc(warehouse?.name || '')}" placeholder="Bodega principal" />`)}
        ${field(
          'Descripción',
          `<input name="description" maxlength="300" value="${esc(warehouse?.description || '')}" placeholder="Opcional" />`,
          { full: true },
        )}
        ${field('Color', `<input name="color" type="color" value="${esc(color)}" style="height:42px;padding:4px" />`)}
        ${
          isEdit
            ? field(
                'Estado',
                `<select name="status">${option('active', 'Activa', warehouse?.status || 'active')}${option(
                  'inactive',
                  'Inactiva',
                  warehouse?.status,
                )}</select>`,
              )
            : ''
        }
      </div>
    </form>`;
    const modalEl = modal({
      title: isEdit ? 'Editar bodega' : 'Nueva bodega',
      body,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: isEdit ? 'Guardar cambios' : 'Crear bodega',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#warehouse-form');
            if (!form.reportValidity()) return;
            const values = readForm(form);
            try {
              if (isEdit) {
                await apiPut(`/warehouses/${warehouse.id}`, {
                  name: String(values.name).trim(),
                  description: String(values.description || '').trim() || null,
                  color: values.color || null,
                  status: values.status,
                });
              } else {
                await apiPost('/warehouses', {
                  code: String(values.code).trim().toUpperCase(),
                  name: String(values.name).trim(),
                  description: String(values.description || '').trim() || null,
                  color: values.color || null,
                });
              }
              closeModal();
              toast(isEdit ? 'Bodega actualizada' : 'Bodega creada');
              await load();
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  };

  const load = async () => {
    const container = document.getElementById('warehouses-table');
    renderTable(container, { columns: [], rows: [], loading: true });
    try {
      const data = await apiGet('/warehouses');
      items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      renderTable(container, {
        columns: [
          { label: 'Código', render: (row) => `<span class="mono">${esc(row.code)}</span>` },
          { label: 'Nombre', render: (row) => `<b>${esc(row.name)}</b>` },
          { label: 'Descripción', render: (row) => `<span class="truncate">${esc(row.description || '—')}</span>` },
          {
            label: 'Color',
            render: (row) =>
              row.color
                ? `<span class="badge" style="background:${esc(row.color)};border-color:${esc(row.color)};width:18px;height:18px;padding:0"></span>
                   <span class="mono small">${esc(row.color)}</span>`
                : '<span class="muted">—</span>',
          },
          { label: 'Estado', render: (row) => statusBadge(row.status) },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `<div class="row-actions">
              <button class="btn sm" type="button" data-edit="${esc(row.id)}">Editar</button>
              ${
                row.status === 'active'
                  ? `<button class="btn sm danger" type="button" data-delete="${esc(row.id)}">Desactivar</button>`
                  : `<button class="btn sm" type="button" data-activate="${esc(row.id)}">Activar</button>`
              }
            </div>`,
          },
        ],
        rows: items,
        empty: 'No hay bodegas registradas',
      });
      container.querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => {
          const warehouse = items.find((item) => item.id === button.dataset.edit);
          openForm(warehouse || null);
        });
      });
      container.querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          const warehouse = items.find((item) => item.id === button.dataset.delete);
          const ok = await confirmDialog(
            `¿Desactivar la bodega "${warehouse?.name || ''}"? Solo es posible si no tiene stock.`,
            { okLabel: 'Desactivar' },
          );
          if (!ok) return;
          try {
            await apiDelete(`/warehouses/${button.dataset.delete}`);
            toast('Bodega desactivada');
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
      container.querySelectorAll('[data-activate]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            await apiPut(`/warehouses/${button.dataset.activate}`, { status: 'active' });
            toast('Bodega activada');
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
    } catch (error) {
      container.innerHTML = `<div class="empty-state">
        <div class="icon">⚠</div>
        <div>${esc(error.message)}</div>
        <button class="btn mt-16" type="button" id="retry-warehouses">Reintentar</button>
      </div>`;
      document.getElementById('retry-warehouses')?.addEventListener('click', () => load());
      toastError(error);
    }
  };

  document.getElementById('new-warehouse').addEventListener('click', () => openForm(null));
  await load();
  void ctx;
}

/* ------------------------------------------------------------------ router */

export async function render(root, ctx) {
  switch (ctx.path) {
    case '/inventory/stocks':
      return renderStocks(root, ctx);
    case '/inventory/movements':
      return renderMovements(root, ctx);
    case '/inventory/movements/new':
      return renderMovementForm(root, ctx);
    case '/inventory/adjust':
      return renderAdjust(root, ctx);
    case '/inventory/kardex':
      return renderKardex(root, ctx);
    case '/inventory/warehouses':
      return renderWarehouses(root, ctx);
    default:
      root.innerHTML = `<div class="card"><h3>Pantalla no encontrada</h3><p class="muted">Ruta: ${esc(
        ctx.path,
      )}</p><a class="btn" href="#/">Volver al inicio</a></div>`;
  }
}
