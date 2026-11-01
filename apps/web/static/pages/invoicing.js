/**
 * Facturación electrónica: listado, creación, detalle y notas de crédito/débito.
 * Vanilla JS ESM, sin dependencias. Exporta render(root, ctx).
 */
import {
  apiGet,
  apiPost,
  apiDelete,
  esc,
  money,
  centsFromInput,
  decimalFromCents,
  fmtQty,
  fmtDate,
  fmtDateTime,
  statusBadge,
  docTypeName,
  toast,
  toastError,
  modal,
  closeModal,
  confirmDialog,
  renderTable,
  pageHead,
  field,
  option,
  paramsOf,
  download,
  todayInput,
  copyText,
  spinnerHtml,
  debounce,
} from '../lib.js';

/* ============================================================ constantes */

const PAGE_SIZE = 25;

const DOC_TYPE_FILTERS = [
  ['01', 'Factura'],
  ['04', 'Nota de crédito'],
  ['05', 'Nota de débito'],
  ['02', 'Nota de venta'],
  ['07', 'Comprobante de retención'],
];

const STATUS_FILTERS = [
  ['draft', 'Borrador'],
  ['sent', 'Enviado al SRI'],
  ['issued', 'Autorizado'],
  ['failed', 'Rechazado'],
  ['offline', 'Offline'],
  ['canceled', 'Anulado'],
];

const ID_TYPE_LABELS = {
  '04': 'RUC',
  '05': 'Cédula',
  '06': 'Pasaporte',
  '07': 'Consumidor final',
  '08': 'Identificación del exterior',
  '09': 'Placa',
};

const MOVEMENT_META = {
  created: { label: 'Creado', tone: 'gray' },
  'sending-sri': { label: 'Enviando al SRI', tone: 'blue' },
  sent: { label: 'Enviado al SRI', tone: 'blue' },
  authorized: { label: 'Autorizado', tone: 'green' },
  issued: { label: 'Autorizado', tone: 'green' },
  failed: { label: 'Rechazado', tone: 'red' },
  offline: { label: 'Offline', tone: 'amber' },
  canceled: { label: 'Anulado', tone: 'amber' },
};

const IVA_FALLBACK = [
  { id: '0', description: '0%', value: 0 },
  { id: '2', description: '12%', value: 0.12 },
  { id: '4', description: '15%', value: 0.15 },
  { id: '5', description: '5%', value: 0.05 },
  { id: '8', description: '8%', value: 0.08 },
  { id: '10', description: '13%', value: 0.13 },
  { id: '6', description: 'No objeto de impuesto', value: 0 },
  { id: '7', description: 'Exento de IVA', value: 0 },
];

const PAYMENT_FALLBACK = [
  { id: 'efectivo', description: 'EFECTIVO' },
  { id: 'transferencia', description: 'TRANSFERENCIA' },
  { id: 'deuna', description: 'DEUNA' },
  { id: '19', description: 'TARJETA DE CRÉDITO' },
  { id: '16', description: 'TARJETA DE DÉBITO' },
  { id: 'cheque', description: 'CHEQUE' },
  { id: '01', description: 'SIN UTILIZACIÓN DEL SISTEMA FINANCIERO' },
];

/* =============================================================== helpers */

function ivaList(options) {
  return options && Array.isArray(options.iva) && options.iva.length ? options.iva : IVA_FALLBACK;
}

function ivaRate(options, code) {
  const item = ivaList(options).find((iva) => iva.id === String(code));
  return item && Number.isFinite(Number(item.value)) ? Number(item.value) : 0;
}

function ivaDescription(options, code) {
  const item = ivaList(options).find((iva) => iva.id === String(code));
  return item ? item.description : `IVA ${code}`;
}

function paymentMethods(options) {
  return options && Array.isArray(options.paymentMethods) && options.paymentMethods.length
    ? options.paymentMethods
    : PAYMENT_FALLBACK;
}

function paymentLabel(options, method) {
  const item = paymentMethods(options).find((entry) => entry.id === String(method));
  return item ? item.description : String(method || 'EFECTIVO');
}

function paymentSelectOptions(options, selected) {
  return paymentMethods(options)
    .map((method) => option(method.id, method.description, selected || 'efectivo'))
    .join('');
}

function idTypeLabel(code) {
  return ID_TYPE_LABELS[code] || code || '—';
}

function lineAmounts(line, options) {
  const quantity = Number(line.quantity) || 0;
  const price = Math.round(Number(line.unitPriceCents) || 0);
  const discount = Math.max(0, Math.round(Number(line.discountCents) || 0));
  const subtotal = Math.max(0, Math.round(price * quantity) - discount);
  const tax = Math.round(subtotal * ivaRate(options, line.ivaCode));
  return { subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax };
}

function computeTotals(lines, options) {
  const byRate = new Map();
  let subtotalCents = 0;
  let discountCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    const amounts = lineAmounts(line, options);
    subtotalCents += amounts.subtotalCents;
    taxCents += amounts.taxCents;
    discountCents += Math.max(0, Math.round(Number(line.discountCents) || 0));
    const tarifa = Math.round(ivaRate(options, line.ivaCode) * 100);
    const key = String(tarifa);
    const current = byRate.get(key) || { tarifa, baseCents: 0, taxCents: 0 };
    current.baseCents += amounts.subtotalCents;
    current.taxCents += amounts.taxCents;
    byRate.set(key, current);
  }
  return {
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    byRate: [...byRate.values()].sort((a, b) => a.tarifa - b.tarifa),
  };
}

function lineInputValue(centsValue) {
  return decimalFromCents(Math.round(Number(centsValue) || 0));
}

function issueDatePayload(dateValue) {
  return dateValue ? `${dateValue}T12:00:00` : undefined;
}

function withBusy(button, fn) {
  const original = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.dataset.originalLabel = original;
    button.textContent = 'Procesando…';
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    });
}

function errorCard(title, message) {
  return `<div class="card"><h3>${esc(title)}</h3><p class="muted">${esc(message)}</p><a class="btn" href="#/invoicing">← Volver a comprobantes</a></div>`;
}

function downloadFile(button, path, fallbackName) {
  return withBusy(button, () => download(path, fallbackName)).catch((error) => toastError(error));
}

function openInfoModal(title, bodyHtml) {
  modal({ title, body: bodyHtml, size: 'sm', actions: [{ label: 'Cerrar', className: 'primary', onClick: () => closeModal() }] });
}

function sriMessagesHtml(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  return `<div class="card" style="margin:0;background:var(--red-soft);border-color:#fecaca">
    <h3 style="color:#991b1b">Mensajes del SRI</h3>
    ${messages
      .map(
        (message) => `<div style="margin-bottom:8px">
          <span class="badge red">${esc(message.tipo || 'ERROR')}</span>
          <b class="small"> ${esc(message.identificador || message.code || '')}</b>
          <div class="small">${esc(message.mensaje || message.message || '')}</div>
          ${message.informacionAdicional ? `<div class="muted small">${esc(message.informacionAdicional)}</div>` : ''}
        </div>`,
      )
      .join('')}
  </div>`;
}

function emissionResultHtml(voucher) {
  const messages = Array.isArray(voucher.sriMessages) ? voucher.sriMessages : [];
  return `
    <div class="inline center gap-8" style="margin-bottom:14px">
      ${statusBadge(voucher.status)}
      <span class="muted">${esc(docTypeName(voucher.docType))}</span>
      <span class="mono">${esc(voucher.number || '—')}</span>
    </div>
    ${
      voucher.accessKey
        ? `<div class="field" style="margin-bottom:12px"><label>Clave de acceso</label>
            <div class="inline"><input class="mono" readonly value="${esc(voucher.accessKey)}" style="flex:1;min-width:0" />
            <button class="btn sm" data-copy="${esc(voucher.accessKey)}">Copiar</button></div></div>`
        : ''
    }
    ${
      voucher.authorizationNumber
        ? `<div class="kv" style="margin-bottom:12px">
            <dt>N.º autorización</dt><dd class="mono">${esc(voucher.authorizationNumber)}</dd>
            <dt>Fecha autorización</dt><dd>${fmtDateTime(voucher.authorizationDate)}</dd>
          </div>`
        : ''
    }
    ${messages.length ? sriMessagesHtml(messages) : ''}
    ${
      voucher.status === 'issued'
        ? '<p class="muted small" style="margin:12px 0 0">Comprobante autorizado por el SRI. Puede descargar el RIDE o consultar el detalle.</p>'
        : voucher.status === 'draft'
          ? '<p class="muted small" style="margin:12px 0 0">Borrador guardado. Podrá emitirlo desde el detalle del comprobante.</p>'
          : '<p class="muted small" style="margin:12px 0 0">Revise los mensajes del SRI y reintente desde el detalle del comprobante.</p>'
    }`;
}

/** Muestra el resultado de una emisión y ofrece ver el detalle / descargar el RIDE. */
function openEmissionResult(voucher, ctx) {
  const modalEl = modal({
    title: voucher.status === 'issued' ? 'Comprobante autorizado' : 'Resultado de la emisión',
    body: emissionResultHtml(voucher),
    size: 'sm',
    actions: [
      {
        label: 'Ver comprobante',
        className: 'primary',
        onClick: () => {
          closeModal();
          ctx.navigate(`/invoicing/${voucher.id}`);
        },
      },
      {
        label: 'Descargar RIDE',
        onClick: () => {
          download(`/vouchers/${voucher.id}/pdf`, `RIDE-${voucher.number || voucher.id}.pdf`).catch(toastError);
        },
      },
      { label: 'Cerrar', onClick: () => closeModal() },
    ],
  });
  modalEl.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => copyText(button.dataset.copy || ''));
  });
}

/* ============================================================ ruteo raíz */

export async function render(root, ctx) {
  const path = ctx.path || '';
  if (path === '/invoicing') return renderList(root, ctx);
  if (path === '/invoicing/new') return renderCreate(root, ctx);
  if (path === '/invoicing/notes/new') return renderNoteCreate(root, ctx);
  if (ctx.params && ctx.params.id) return renderDetail(root, ctx);
  root.innerHTML = errorCard('Pantalla no encontrada', 'No se reconoce la ruta de facturación solicitada.');
}

/* ================================================================ listado */

async function renderList(root, ctx) {
  const state = { page: 1, limit: PAGE_SIZE, docType: '', status: '', q: '', from: '', to: '', rows: [], total: 0 };

  root.innerHTML = `
    ${pageHead(
      'Comprobantes',
      'Facturas, notas de crédito y débito emitidas al SRI',
      `<a class="btn primary" href="#/invoicing/new">+ Nueva factura</a>
       <a class="btn" href="#/quick-billing">⚡ Facturación rápida</a>
       <a class="btn" href="#/pos">🛒 Punto de venta</a>`,
    )}
    <div class="card">
      <form id="filters" class="form-grid">
        ${field(
          'Tipo de documento',
          `<select name="docType">${option('', 'Todos los tipos', true)}${DOC_TYPE_FILTERS.map(([value, label]) =>
            option(value, `${value} · ${label}`, false),
          ).join('')}</select>`,
        )}
        ${field('Estado', `<select name="status">${option('', 'Todos los estados', true)}${STATUS_FILTERS.map(([value, label]) =>
          option(value, label, false),
        ).join('')}</select>`)}
        ${field('Desde', '<input type="date" name="from" />')}
        ${field('Hasta', '<input type="date" name="to" />')}
        <div class="field full">
          <label>Buscar</label>
          <div class="search">
            <input type="search" name="q" placeholder="Cliente, número, clave de acceso o autorización" />
          </div>
        </div>
      </form>
      <div class="inline mt-16">
        <button class="btn primary" id="apply-filters" type="button">Aplicar filtros</button>
        <button class="btn ghost" id="clear-filters" type="button">Limpiar</button>
        <span class="muted small" id="filters-hint"></span>
      </div>
    </div>
    <div class="card">
      <div id="list-table">${spinnerHtml('Cargando comprobantes…')}</div>
      <div class="inline between mt-16" id="list-pager"></div>
    </div>`;

  const form = root.querySelector('#filters');
  const tableBox = root.querySelector('#list-table');
  const pager = root.querySelector('#list-pager');

  const columns = [
    {
      key: 'number',
      label: 'Número',
      render: (row) =>
        `<a href="#/invoicing/${esc(row.id)}" class="mono">${esc(row.number || '—')}</a>`,
    },
    {
      key: 'docTypeName',
      label: 'Tipo',
      render: (row) => `<span class="nowrap">${esc(row.docTypeName || docTypeName(row.docType))}</span>`,
    },
    {
      key: 'clientName',
      label: 'Cliente',
      render: (row) =>
        `<div>${esc(row.clientName || 'CONSUMIDOR FINAL')}</div>
         <div class="muted small">${esc(row.clientIdNumber || '')}</div>`,
    },
    { key: 'issueDate', label: 'Fecha', render: (row) => `<span class="nowrap">${fmtDate(row.issueDate)}</span>` },
    { key: 'totalCents', label: 'Total', align: 'num', render: (row) => `<b>${money(row.totalCents)}</b>` },
    { key: 'status', label: 'Estado', render: (row) => statusBadge(row.status) },
    {
      key: 'accessKey',
      label: 'Clave de acceso',
      render: (row) =>
        row.accessKey
          ? `<div class="inline gap-8">
               <span class="mono truncate" title="${esc(row.accessKey)}">${esc(row.accessKey)}</span>
               <button class="btn ghost sm" data-action="copy" data-id="${esc(row.id)}" title="Copiar clave">copiar</button>
             </div>`
          : '<span class="muted">—</span>',
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (row) => `<div class="row-actions">
        <button class="btn sm" data-action="view" data-id="${esc(row.id)}">Ver</button>
        <button class="btn sm" data-action="pdf" data-id="${esc(row.id)}">PDF</button>
        ${row.accessKey ? `<button class="btn sm" data-action="xml" data-id="${esc(row.id)}">XML</button>` : ''}
        ${
          ['failed', 'offline'].includes(row.status)
            ? `<button class="btn sm" data-action="retry" data-id="${esc(row.id)}">Reintentar</button>`
            : ''
        }
      </div>`,
    },
  ];

  function readFilters() {
    state.docType = form.querySelector('[name="docType"]').value;
    state.status = form.querySelector('[name="status"]').value;
    state.from = form.querySelector('[name="from"]').value;
    state.to = form.querySelector('[name="to"]').value;
    state.q = form.querySelector('[name="q"]').value.trim();
    state.page = 1;
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    pager.innerHTML = `
      <span class="muted small">${state.total} comprobante(s) · página ${state.page} de ${pages}</span>
      <div class="inline">
        <button class="btn sm" data-page="prev" ${state.page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
        <button class="btn sm" data-page="next" ${state.page >= pages ? 'disabled' : ''}>Siguiente ›</button>
      </div>`;
  }

  async function load() {
    tableBox.innerHTML = spinnerHtml('Cargando comprobantes…');
    const hint = root.querySelector('#filters-hint');
    if (hint) hint.textContent = 'Consultando…';
    try {
      const response = await apiGet(
        '/vouchers',
        paramsOf({
          docType: state.docType,
          status: state.status,
          q: state.q,
          from: state.from,
          to: state.to,
          page: state.page,
          limit: state.limit,
        }),
      );
      state.rows = Array.isArray(response.data) ? response.data : [];
      state.total = Number(response.total) || 0;
      if (hint) hint.textContent = `${state.total} resultado(s)`;
      renderTable(tableBox, {
        columns,
        rows: state.rows,
        empty: 'No hay comprobantes para los filtros seleccionados',
      });
    } catch (error) {
      tableBox.innerHTML = `<div class="empty-state">No se pudo cargar la lista</div>`;
      if (hint) hint.textContent = '';
      toastError(error);
    }
    renderPager();
  }

  const debouncedApply = debounce(() => {
    readFilters();
    load();
  }, 350);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    readFilters();
    load();
  });
  form.querySelectorAll('select').forEach((select) => select.addEventListener('change', () => debouncedApply()));
  form.querySelectorAll('input[type="date"]').forEach((input) => input.addEventListener('change', () => debouncedApply()));
  form.querySelector('[name="q"]').addEventListener('input', () => debouncedApply());
  root.querySelector('#apply-filters').addEventListener('click', () => {
    readFilters();
    load();
  });
  root.querySelector('#clear-filters').addEventListener('click', () => {
    form.reset();
    readFilters();
    load();
  });

  pager.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (!button) return;
    if (button.dataset.page === 'prev' && state.page > 1) state.page -= 1;
    if (button.dataset.page === 'next') state.page += 1;
    load();
  });

  tableBox.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const row = state.rows.find((item) => item.id === button.dataset.id);
    if (!row) return;
    const action = button.dataset.action;
    if (action === 'view') return ctx.navigate(`/invoicing/${row.id}`);
    if (action === 'copy') return copyText(row.accessKey || '');
    if (action === 'pdf') return downloadFile(button, `/vouchers/${row.id}/pdf`, `RIDE-${row.number || row.id}.pdf`);
    if (action === 'xml') return downloadFile(button, `/vouchers/${row.id}/xml`, `${row.accessKey || row.id}.xml`);
    if (action === 'retry') {
      try {
        const updated = await withBusy(button, () => apiPost(`/vouchers/${row.id}/retry`));
        if (updated.status === 'issued') toast('Comprobante autorizado por el SRI');
        else {
          toast('El comprobante no fue autorizado. Revise los mensajes del SRI.', 'warn');
          ctx.navigate(`/invoicing/${row.id}`);
        }
        load();
      } catch (error) {
        toastError(error);
      }
    }
  });

  await load();
}

/* ============================================================== creación */

async function renderCreate(root, ctx) {
  root.innerHTML = spinnerHtml('Cargando opciones de facturación…');
  let options;
  try {
    options = await apiGet('/vouchers/options');
  } catch (error) {
    root.innerHTML = errorCard('No se pudieron cargar las opciones', error.message || 'Error desconocido');
    return;
  }

  const establishments = Array.isArray(options.establishments) ? options.establishments : [];
  if (!establishments.length) {
    root.innerHTML = errorCard(
      'Sin establecimientos configurados',
      'Registre al menos un establecimiento y punto de emisión en Administración → Empresa y SRI.',
    );
    return;
  }

  const state = {
    options,
    estId: establishments[0].id,
    pointId: (establishments[0].emissionPoints || [])[0] ? establishments[0].emissionPoints[0].id : '',
    client: null,
    lines: [],
    payments: [{ method: 'efectivo', amountCents: 0 }],
    autoPayment: true,
    info: [],
    saving: false,
  };

  const ivaOptionsHtml = (selected) =>
    ivaList(options)
      .map((iva) => option(iva.id, iva.description, selected))
      .join('');

  root.innerHTML = `
    ${pageHead(
      'Nueva factura',
      'Emisión de comprobante electrónico (factura 01)',
      '<a class="btn" href="#/invoicing">← Volver</a>',
    )}
    <div class="split">
      <div>
        <div class="card">
          <div class="card-head"><h3>Datos del comprobante</h3><span class="muted small">El secuencial y la clave de acceso se asignan al emitir</span></div>
          <div class="form-grid">
            ${field('Establecimiento', `<select id="est-select">${establishments
              .map((est) => option(est.id, `${est.code} · ${est.name}`, est.id === state.estId))
              .join('')}</select>`)}
            ${field('Punto de emisión', `<select id="point-select"></select>`)}
            ${field('Fecha de emisión', `<input type="date" id="issue-date" value="${todayInput()}" />`)}
            ${field('Moneda', '<input type="text" value="DOLAR" readonly />')}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Receptor</h3>
            <button class="btn sm ghost" id="cf-btn" type="button">Usar consumidor final</button>
          </div>
          <div class="search" style="position:relative">
            <input type="search" id="client-search" placeholder="Buscar cliente por nombre, cédula/RUC o correo…" autocomplete="off" />
            <div id="client-results" class="hidden" style="position:absolute;left:0;right:0;top:100%;z-index:40;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);margin-top:4px;max-height:280px;overflow:auto"></div>
          </div>
          <div id="client-selected" class="mt-8"></div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Detalle</h3><span class="muted small">Precio e IVA se precargan del producto y pueden editarse</span></div>
          <div class="search" style="position:relative;max-width:560px">
            <input type="search" id="product-search" placeholder="Agregar producto: código o descripción…" autocomplete="off" />
            <div id="product-results" class="hidden" style="position:absolute;left:0;right:0;top:100%;z-index:40;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);margin-top:4px;max-height:300px;overflow:auto"></div>
          </div>
          <div id="lines-container" class="mt-16"></div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Pagos</h3><span class="muted small">Al emitir, la suma de pagos debe ser igual al total</span></div>
          <div id="payments-container"></div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Información adicional</h3>
            <button class="btn sm ghost" id="add-info" type="button">+ Agregar campo</button>
          </div>
          <div id="info-container"></div>
        </div>
      </div>

      <div>
        <div class="card">
          <h3>Resumen</h3>
          <div id="totals-container"></div>
          <div class="grid mt-16" style="gap:8px">
            <button class="btn primary block lg" id="emit-btn" type="button">Emitir factura</button>
            <button class="btn block" id="draft-btn" type="button">Guardar borrador</button>
            <a class="btn ghost block" href="#/invoicing">Cancelar</a>
          </div>
          <p class="muted small mt-16">En modo simulado el SRI autoriza localmente. Si el envío falla, el comprobante queda rechazado u offline y puede reintentarse desde el detalle.</p>
        </div>
      </div>
    </div>`;

  /* ------------------------------------------------------- estructura UI */

  const estSelect = root.querySelector('#est-select');
  const pointSelect = root.querySelector('#point-select');
  const issueDateInput = root.querySelector('#issue-date');
  const clientSearch = root.querySelector('#client-search');
  const clientResults = root.querySelector('#client-results');
  const clientSelected = root.querySelector('#client-selected');
  const productSearch = root.querySelector('#product-search');
  const productResults = root.querySelector('#product-results');
  const linesContainer = root.querySelector('#lines-container');
  const paymentsContainer = root.querySelector('#payments-container');
  const infoContainer = root.querySelector('#info-container');
  const totalsContainer = root.querySelector('#totals-container');
  const emitButton = root.querySelector('#emit-btn');
  const draftButton = root.querySelector('#draft-btn');

  function currentEstablishment() {
    return establishments.find((est) => est.id === estSelect.value) || establishments[0];
  }

  function renderPoints() {
    const establishment = currentEstablishment();
    const points = establishment.emissionPoints || [];
    const keep = points.some((point) => point.id === state.pointId);
    state.pointId = keep ? state.pointId : points[0] ? points[0].id : '';
    pointSelect.innerHTML = points.length
      ? points.map((point) => option(point.id, `${point.code} · ${point.name}`, point.id === state.pointId)).join('')
      : '<option value="">Sin puntos de emisión</option>';
  }

  estSelect.addEventListener('change', () => {
    state.estId = estSelect.value;
    renderPoints();
  });
  pointSelect.addEventListener('change', () => {
    state.pointId = pointSelect.value;
  });

  /* ------------------------------------------------------------- cliente */

  function renderClientSelected() {
    clientSelected.innerHTML = state.client
      ? `<span class="badge blue">${esc(state.client.name)}</span>
         <span class="muted small">${esc(idTypeLabel(state.client.idType))} · ${esc(state.client.idNumber)}</span>
         <button class="btn ghost sm" id="client-reset" type="button">Quitar</button>`
      : `<span class="badge gray">CONSUMIDOR FINAL</span>
         <span class="muted small">9999999999999 · no se registran datos del receptor</span>`;
    const reset = clientSelected.querySelector('#client-reset');
    if (reset) {
      reset.addEventListener('click', () => {
        state.client = null;
        clientSearch.value = '';
        renderClientSelected();
      });
    }
  }

  function hideClientResults() {
    clientResults.classList.add('hidden');
    clientResults.innerHTML = '';
  }

  async function searchClients(term) {
    try {
      const response = await apiGet('/clients', { q: term, limit: 10 });
      const clients = Array.isArray(response.data) ? response.data : [];
      if (!clients.length) {
        clientResults.innerHTML = '<div class="muted small" style="padding:10px">Sin coincidencias</div>';
        clientResults.classList.remove('hidden');
        return;
      }
      clientResults.innerHTML = clients
        .map(
          (client) => `<button class="btn ghost block" type="button" data-client-id="${esc(client.id)}" style="justify-content:flex-start;text-align:left;width:100%">
            <b>${esc(client.name)}</b><span class="muted small">&nbsp;${esc(idTypeLabel(client.idType))} ${esc(client.idNumber)}</span>
          </button>`,
        )
        .join('');
      clientResults.classList.remove('hidden');
      clientResults.querySelectorAll('[data-client-id]').forEach((button) => {
        button.addEventListener('click', () => {
          const client = clients.find((item) => item.id === button.dataset.clientId);
          if (!client) return;
          state.client = { id: client.id, name: client.name, idType: client.idType, idNumber: client.idNumber };
          clientSearch.value = client.name;
          hideClientResults();
          renderClientSelected();
        });
      });
    } catch (error) {
      toastError(error);
    }
  }

  const debouncedClientSearch = debounce((term) => searchClients(term), 300);
  clientSearch.addEventListener('input', () => {
    const term = clientSearch.value.trim();
    if (term.length < 1) {
      hideClientResults();
      return;
    }
    debouncedClientSearch(term);
  });
  clientSearch.addEventListener('blur', () => setTimeout(hideClientResults, 180));
  root.querySelector('#cf-btn').addEventListener('click', () => {
    state.client = null;
    clientSearch.value = '';
    renderClientSelected();
    hideClientResults();
  });

  /* ------------------------------------------------------------ productos */

  function hideProductResults() {
    productResults.classList.add('hidden');
    productResults.innerHTML = '';
  }

  function addProduct(product) {
    const existing = state.lines.find((line) => line.productId === product.id);
    if (existing) {
      existing.quantity = Number(existing.quantity) + 1;
    } else {
      state.lines.push({
        key: `${product.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        productId: product.id,
        code: product.code,
        description: product.description,
        quantity: 1,
        unitPriceCents: Math.round(Number(product.priceCents) || 0),
        discountCents: 0,
        ivaCode: String(product.ivaCode || '4'),
      });
    }
    renderLines();
    updateTotalsUI();
  }

  async function searchProducts(term) {
    try {
      const products = await apiGet('/products/search', { q: term });
      const list = Array.isArray(products) ? products : [];
      if (!list.length) {
        productResults.innerHTML = '<div class="muted small" style="padding:10px">Sin coincidencias</div>';
        productResults.classList.remove('hidden');
        return;
      }
      productResults.innerHTML = list
        .map(
          (product) => `<button class="btn ghost block" type="button" data-product-id="${esc(product.id)}" style="justify-content:space-between;text-align:left;width:100%">
            <span><b>${esc(product.description)}</b> <span class="muted small">${esc(product.code)}</span></span>
            <span class="right">${money(product.priceCents)}</span>
          </button>`,
        )
        .join('');
      productResults.classList.remove('hidden');
      productResults.querySelectorAll('[data-product-id]').forEach((button) => {
        button.addEventListener('click', () => {
          const product = list.find((item) => item.id === button.dataset.productId);
          if (!product) return;
          addProduct(product);
          productSearch.value = '';
          hideProductResults();
        });
      });
    } catch (error) {
      toastError(error);
    }
  }

  const debouncedProductSearch = debounce((term) => searchProducts(term), 300);
  productSearch.addEventListener('input', () => {
    const term = productSearch.value.trim();
    if (!term) {
      hideProductResults();
      return;
    }
    debouncedProductSearch(term);
  });
  productSearch.addEventListener('blur', () => setTimeout(hideProductResults, 180));

  /* --------------------------------------------------------------- líneas */

  function renderLines() {
    if (!state.lines.length) {
      linesContainer.innerHTML = '<div class="empty-state" style="padding:30px"><div class="icon">▦</div>Agregue productos o servicios al detalle</div>';
      return;
    }
    linesContainer.innerHTML = `<div class="table-wrap"><table class="tbl">
      <thead><tr>
        <th>Producto / servicio</th><th>IVA</th><th style="width:96px">Cantidad</th><th style="width:120px">P. unitario</th>
        <th style="width:110px">Descuento</th><th class="num">Total</th><th></th>
      </tr></thead>
      <tbody>
        ${state.lines
          .map(
            (line) => `<tr data-line-key="${esc(line.key)}">
              <td><div class="mono small muted">${esc(line.code || '')}</div><div>${esc(line.description)}</div></td>
              <td><select data-line-field="ivaCode" style="min-width:120px">${ivaOptionsHtml(line.ivaCode)}</select></td>
              <td><input type="number" min="0.01" step="0.01" data-line-field="quantity" value="${esc(String(line.quantity))}" /></td>
              <td><input type="number" min="0" step="0.01" data-line-field="unitPrice" value="${lineInputValue(line.unitPriceCents)}" /></td>
              <td><input type="number" min="0" step="0.01" data-line-field="discount" value="${lineInputValue(line.discountCents)}" /></td>
              <td class="num" data-line-total>${money(lineAmounts(line, options).totalCents)}</td>
              <td class="right"><button class="btn ghost sm" type="button" data-remove-line title="Quitar ítem">✕</button></td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table></div>`;
  }

  function updateLineTotal(key) {
    const line = state.lines.find((item) => item.key === key);
    if (!line) return;
    const row = linesContainer.querySelector(`[data-line-key="${key}"]`);
    if (!row) return;
    const totalCell = row.querySelector('[data-line-total]');
    if (totalCell) totalCell.textContent = money(lineAmounts(line, options).totalCents);
  }

  linesContainer.addEventListener('input', (event) => {
    const input = event.target.closest('[data-line-field]');
    if (!input) return;
    const row = input.closest('[data-line-key]');
    const line = state.lines.find((item) => item.key === row.dataset.lineKey);
    if (!line) return;
    const fieldName = input.dataset.lineField;
    if (fieldName === 'quantity') line.quantity = Math.max(0, Number(input.value) || 0);
    else if (fieldName === 'unitPrice') line.unitPriceCents = centsFromInput(input.value);
    else if (fieldName === 'discount') line.discountCents = centsFromInput(input.value);
    updateLineTotal(line.key);
    updateTotalsUI();
  });

  linesContainer.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-line-field="ivaCode"]');
    if (!select) return;
    const row = select.closest('[data-line-key]');
    const line = state.lines.find((item) => item.key === row.dataset.lineKey);
    if (!line) return;
    line.ivaCode = select.value;
    updateLineTotal(line.key);
    updateTotalsUI();
  });

  linesContainer.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-line]');
    if (!button) return;
    const row = button.closest('[data-line-key]');
    state.lines = state.lines.filter((line) => line.key !== row.dataset.lineKey);
    renderLines();
    updateTotalsUI();
  });

  /* --------------------------------------------------------------- pagos */

  function renderPayments() {
    paymentsContainer.innerHTML = `${state.payments
      .map(
        (payment, index) => `<div class="inline" data-payment-index="${index}" style="margin-bottom:8px">
          <select class="grow" data-payment-field="method">${paymentSelectOptions(options, payment.method)}</select>
          <input type="number" min="0" step="0.01" style="max-width:150px" data-payment-field="amount" value="${lineInputValue(payment.amountCents)}" />
          <button class="btn ghost sm" type="button" data-remove-payment title="Quitar pago">✕</button>
        </div>`,
      )
      .join('')}
      <div class="inline mt-8">
        <button class="btn sm" id="add-payment" type="button">+ Agregar forma de pago</button>
        <button class="btn sm" id="use-total" type="button">Usar el total</button>
        <span class="small" id="payment-diff"></span>
      </div>`;
  }

  paymentsContainer.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-payment-field="method"]');
    if (!select) return;
    const row = select.closest('[data-payment-index]');
    const payment = state.payments[Number(row.dataset.paymentIndex)];
    if (!payment) return;
    payment.method = select.value;
    state.autoPayment = false;
  });

  paymentsContainer.addEventListener('input', (event) => {
    const input = event.target.closest('input[data-payment-field="amount"]');
    if (!input) return;
    const row = input.closest('[data-payment-index]');
    const payment = state.payments[Number(row.dataset.paymentIndex)];
    if (!payment) return;
    payment.amountCents = centsFromInput(input.value);
    state.autoPayment = false;
    updatePaymentDiff();
  });

  paymentsContainer.addEventListener('click', (event) => {
    if (event.target.closest('#add-payment')) {
      state.payments.push({ method: 'efectivo', amountCents: 0 });
      state.autoPayment = false;
      renderPayments();
      updatePaymentDiff();
      return;
    }
    if (event.target.closest('#use-total')) {
      const totals = computeTotals(state.lines, options);
      state.payments = [{ method: state.payments[0] ? state.payments[0].method : 'efectivo', amountCents: totals.totalCents }];
      state.autoPayment = true;
      renderPayments();
      updatePaymentDiff();
      return;
    }
    const remove = event.target.closest('[data-remove-payment]');
    if (remove) {
      const row = remove.closest('[data-payment-index]');
      state.payments.splice(Number(row.dataset.paymentIndex), 1);
      if (!state.payments.length) state.payments.push({ method: 'efectivo', amountCents: 0 });
      state.autoPayment = false;
      renderPayments();
      updatePaymentDiff();
    }
  });

  function paidCents() {
    return state.payments.reduce((sum, payment) => sum + (Number(payment.amountCents) || 0), 0);
  }

  function updatePaymentDiff() {
    const diffBox = paymentsContainer.querySelector('#payment-diff');
    if (!diffBox) return;
    const totals = computeTotals(state.lines, options);
    const diff = paidCents() - totals.totalCents;
    if (!state.lines.length) {
      diffBox.innerHTML = '<span class="muted">Agregue ítems para calcular el total</span>';
    } else if (diff === 0) {
      diffBox.innerHTML = '<span class="badge green">Pagos completos</span>';
    } else if (diff > 0) {
      diffBox.innerHTML = `<span class="badge amber">Sobran ${money(diff)}</span>`;
    } else {
      diffBox.innerHTML = `<span class="badge red">Faltan ${money(-diff)}</span>`;
    }
  }

  /* ---------------------------------------------------- información extra */

  function renderInfo() {
    if (!state.info.length) {
      infoContainer.innerHTML = '<div class="muted small">Sin información adicional (opcional).</div>';
      return;
    }
    infoContainer.innerHTML = state.info
      .map(
        (pair, index) => `<div class="inline" data-info-index="${index}" style="margin-bottom:8px">
          <input type="text" placeholder="Nombre (p. ej. Orden de compra)" style="flex:1;min-width:160px" data-info-field="nombre" value="${esc(pair.nombre)}" />
          <input type="text" placeholder="Valor" style="flex:1;min-width:160px" data-info-field="valor" value="${esc(pair.valor)}" />
          <button class="btn ghost sm" type="button" data-remove-info title="Quitar campo">✕</button>
        </div>`,
      )
      .join('');
  }

  infoContainer.addEventListener('input', (event) => {
    const input = event.target.closest('[data-info-field]');
    if (!input) return;
    const row = input.closest('[data-info-index]');
    const pair = state.info[Number(row.dataset.infoIndex)];
    if (!pair) return;
    pair[input.dataset.infoField] = input.value;
  });

  infoContainer.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-info]');
    if (!remove) return;
    const row = remove.closest('[data-info-index]');
    state.info.splice(Number(row.dataset.infoIndex), 1);
    renderInfo();
  });

  root.querySelector('#add-info').addEventListener('click', () => {
    state.info.push({ nombre: '', valor: '' });
    renderInfo();
  });

  /* -------------------------------------------------------------- totales */

  function updateTotalsUI() {
    const totals = computeTotals(state.lines, options);
    if (state.autoPayment && state.payments.length === 1) {
      state.payments[0].amountCents = totals.totalCents;
      const amountInput = paymentsContainer.querySelector('input[data-payment-field="amount"]');
      if (amountInput) amountInput.value = lineInputValue(totals.totalCents);
    }
    totalsContainer.innerHTML = `
      <div class="totals-row"><span>Subtotal</span><b>${money(totals.subtotalCents)}</b></div>
      ${totals.discountCents ? `<div class="totals-row muted"><span>Descuentos aplicados</span><span>${money(totals.discountCents)}</span></div>` : ''}
      ${
        totals.byRate.length
          ? totals.byRate
              .map(
                (item) =>
                  `<div class="totals-row"><span>IVA ${esc(String(item.tarifa))}%</span><b>${money(item.taxCents)}</b></div>`,
              )
              .join('')
          : `<div class="totals-row muted"><span>IVA</span><span>${money(0)}</span></div>`
      }
      <div class="totals-row grand"><span>Total</span><span>${money(totals.totalCents)}</span></div>`;
    updatePaymentDiff();
  }

  /* ------------------------------------------------------------ submit */

  function buildItemsPayload() {
    return state.lines.map((line) => ({
      productId: line.productId,
      quantity: Number(line.quantity) || 0,
      unitPriceCents: Math.round(Number(line.unitPriceCents) || 0),
      discountCents: Math.round(Number(line.discountCents) || 0),
      ivaCode: line.ivaCode,
    }));
  }

  function validate(draft) {
    if (!state.lines.length) {
      toastError('Agregue al menos un producto o servicio');
      return false;
    }
    for (const line of state.lines) {
      if (!(Number(line.quantity) > 0)) {
        toastError(`La cantidad de "${line.description}" debe ser mayor a 0`);
        return false;
      }
    }
    if (!state.estId || !state.pointId) {
      toastError('Seleccione establecimiento y punto de emisión');
      return false;
    }
    if (!issueDateInput.value) {
      toastError('Seleccione la fecha de emisión');
      return false;
    }
    if (!draft) {
      const totals = computeTotals(state.lines, options);
      if (paidCents() !== totals.totalCents) {
        toastError('La suma de los pagos debe ser igual al total del comprobante');
        return false;
      }
    }
    return true;
  }

  async function submit(draft, button) {
    if (state.saving || !validate(draft)) return;
    state.saving = true;
    emitButton.disabled = true;
    draftButton.disabled = true;
    try {
      const payload = {
        docType: '01',
        establishmentId: state.estId,
        emissionPointId: state.pointId,
        clientId: state.client ? state.client.id : undefined,
        issueDate: issueDatePayload(issueDateInput.value),
        currency: 'DOLAR',
        draft,
        source: 'standard',
        items: buildItemsPayload(),
        payments: state.payments.map((payment) => ({
          method: payment.method,
          amountCents: Math.round(Number(payment.amountCents) || 0),
          term: 0,
        })),
        infoAdicional: state.info
          .filter((pair) => pair.nombre.trim() && pair.valor.trim())
          .map((pair) => ({ nombre: pair.nombre.trim(), valor: pair.valor.trim() })),
      };
      const voucher = await withBusy(button, () => apiPost('/vouchers', payload));
      if (draft) {
        toast('Borrador guardado');
        ctx.navigate(`/invoicing/${voucher.id}`);
        return;
      }
      openEmissionResult(voucher, ctx);
      if (voucher.status === 'issued') toast('Factura autorizada por el SRI');
      else toast('La factura no fue autorizada. Revise los mensajes del SRI.', 'warn');
    } catch (error) {
      toastError(error);
    } finally {
      state.saving = false;
      emitButton.disabled = false;
      draftButton.disabled = false;
    }
  }

  emitButton.addEventListener('click', () => submit(false, emitButton));
  draftButton.addEventListener('click', () => submit(true, draftButton));

  /* ------------------------------------------------------------- arranque */

  renderPoints();
  renderClientSelected();
  renderLines();
  renderPayments();
  renderInfo();
  updateTotalsUI();
}

/* ================================================================ detalle */

async function renderDetail(root, ctx) {
  const id = ctx.params.id;
  root.innerHTML = spinnerHtml('Cargando comprobante…');
  let voucher;
  try {
    voucher = await apiGet(`/vouchers/${encodeURIComponent(id)}`);
  } catch (error) {
    root.innerHTML = errorCard('No se pudo cargar el comprobante', error.message || 'Error desconocido');
    return;
  }

  const [companyResult, establishmentsResult, optionsResult] = await Promise.allSettled([
    apiGet('/company'),
    apiGet('/company/establishments'),
    apiGet('/vouchers/options'),
  ]);
  const company = companyResult.status === 'fulfilled' ? companyResult.value : null;
  const establishments = establishmentsResult.status === 'fulfilled' ? establishmentsResult.value || [] : [];
  const options = optionsResult.status === 'fulfilled' ? optionsResult.value : null;
  let client = null;
  if (voucher.clientId) {
    try {
      client = await apiGet(`/clients/${voucher.clientId}`);
    } catch {
      client = null;
    }
  }

  const establishment = establishments.find((item) => item.code === voucher.establishmentCode) || null;
  const point = establishment
    ? (establishment.emissionPoints || []).find((item) => item.code === voucher.emissionPointCode) || null
    : null;

  const status = voucher.status || 'draft';
  const canEmit = status === 'draft';
  const canRetry = status === 'failed' || status === 'offline';
  const canCheckAuthorization = status === 'sent' || status === 'offline';
  const canCancel = status !== 'canceled';
  const canDelete = ['draft', 'failed', 'offline'].includes(status);
  const canNote = voucher.docType === '01' && status === 'issued';
  const hasXml = Boolean(voucher.accessKey);
  const messages = Array.isArray(voucher.sriMessages) ? voucher.sriMessages : [];

  const actionButtons = [
    canEmit ? '<button class="btn primary" data-action="emit" type="button">Emitir factura</button>' : '',
    canRetry ? '<button class="btn primary" data-action="retry" type="button">Reintentar envío al SRI</button>' : '',
    canCheckAuthorization
      ? '<button class="btn primary" data-action="check-authorization" type="button">Consultar autorización</button>'
      : '',
    canNote ? '<button class="btn" data-action="credit-note" type="button">Nota de crédito</button>' : '',
    canNote ? '<button class="btn" data-action="debit-note" type="button">Nota de débito</button>' : '',
    '<button class="btn" data-action="email" type="button">Enviar correo</button>',
    canCancel ? '<button class="btn danger" data-action="cancel" type="button">Anular</button>' : '',
    canDelete ? '<button class="btn danger" data-action="delete" type="button">Eliminar</button>' : '',
  ]
    .filter(Boolean)
    .join('');

  const pageActions = `
    <a class="btn" href="#/invoicing">← Volver</a>
    <button class="btn" data-action="pdf" type="button">Descargar PDF</button>
    ${hasXml ? '<button class="btn" data-action="xml" type="button">Descargar XML firmado</button>' : ''}
    ${voucher.hasAuthorizedXml ? '<button class="btn" data-action="xml-authorized" type="button">Descargar XML autorizado</button>' : ''}
    ${hasXml ? '<button class="btn" data-action="signature-check" type="button">Verificar firma</button>' : ''}
    ${hasXml ? '<button class="btn" data-action="sri-log" type="button">Log SRI</button>' : ''}`;

  function taxesRows() {
    const groups = new Map();
    for (const item of voucher.items || []) {
      for (const tax of item.taxes || []) {
        const key = `${tax.codigoPorcentaje}|${tax.tarifa}`;
        const current = groups.get(key) || { tarifa: tax.tarifa, base: 0, valor: 0 };
        current.base += Number(tax.baseImponible) || 0;
        current.valor += Number(tax.valor) || 0;
        groups.set(key, current);
      }
    }
    return [...groups.values()].sort((a, b) => Number(a.tarifa) - Number(b.tarifa));
  }

  const taxGroups = taxesRows();
  const paymentLabelFor = (method) => paymentLabel(options, method);

  root.innerHTML = `
    ${pageHead(
      `${docTypeName(voucher.docType)} ${voucher.number || ''}`,
      `${voucher.clientName || 'CONSUMIDOR FINAL'} · emitido el ${fmtDate(voucher.issueDate)} · ambiente ${voucher.environment === 2 ? 'producción' : 'pruebas'}`,
      pageActions,
    )}
    ${
      actionButtons
        ? `<div class="card"><div class="inline" id="detail-actions">${actionButtons}</div></div>`
        : ''
    }
    <div class="grid cols-3">
      <div class="card" style="margin-bottom:0">
        <h3>Documento</h3>
        <dl class="kv">
          <dt>Tipo</dt><dd>${esc(voucher.docTypeName || docTypeName(voucher.docType))}</dd>
          <dt>Número</dt><dd class="mono">${esc(voucher.number || '—')}</dd>
          <dt>Estado</dt><dd>${statusBadge(voucher.status)}</dd>
          <dt>Ambiente</dt><dd>${voucher.environment === 2 ? 'Producción' : 'Pruebas'}</dd>
          <dt>Fecha emisión</dt><dd>${fmtDate(voucher.issueDate)}</dd>
          <dt>Moneda</dt><dd>${esc(voucher.currency || 'DOLAR')}</dd>
        </dl>
      </div>
      <div class="card" style="margin-bottom:0">
        <h3>Clave de acceso</h3>
        ${
          voucher.accessKey
            ? `<div class="mono small" style="word-break:break-all;margin-bottom:10px">${esc(voucher.accessKey)}</div>
               <button class="btn sm" type="button" data-copy="${esc(voucher.accessKey)}">Copiar clave</button>`
            : '<p class="muted small">Se asigna al emitir el comprobante.</p>'
        }
      </div>
      <div class="card" style="margin-bottom:0">
        <h3>Autorización SRI</h3>
        <dl class="kv">
          <dt>N.º autorización</dt><dd class="mono small">${esc(voucher.authorizationNumber || '—')}</dd>
          <dt>Fecha</dt><dd>${fmtDateTime(voucher.authorizationDate)}</dd>
          ${voucher.relatedVoucherNumber ? `<dt>Documento modificado</dt><dd class="mono">${esc(voucher.relatedVoucherNumber)}</dd>` : ''}
          ${voucher.reason ? `<dt>Motivo</dt><dd>${esc(voucher.reason)}</dd>` : ''}
          <dt>Origen</dt><dd>${esc(voucher.source || 'standard')}</dd>
        </dl>
      </div>
    </div>

    <div class="grid cols-2 mt-16">
      <div class="card" style="margin-bottom:0">
        <h3>Emisor</h3>
        <dl class="kv">
          <dt>Razón social</dt><dd>${esc(company ? company.name : '—')}</dd>
          <dt>RUC</dt><dd class="mono">${esc(company ? company.ruc : '—')}</dd>
          <dt>Establecimiento</dt><dd>${esc(establishment ? `${establishment.code} · ${establishment.name}` : voucher.establishmentCode || '—')}</dd>
          <dt>Punto de emisión</dt><dd>${esc(point ? `${point.code} · ${point.name}` : voucher.emissionPointCode || '—')}</dd>
          <dt>Dirección</dt><dd>${esc((establishment && establishment.address) || (company && company.address) || '—')}</dd>
        </dl>
      </div>
      <div class="card" style="margin-bottom:0">
        <h3>Receptor</h3>
        <dl class="kv">
          <dt>Razón social</dt><dd>${esc(voucher.clientName || 'CONSUMIDOR FINAL')}</dd>
          <dt>Identificación</dt><dd>${esc(idTypeLabel(voucher.clientIdType))} · <span class="mono">${esc(voucher.clientIdNumber || '9999999999999')}</span></dd>
          <dt>Correo</dt><dd>${esc((client && client.email) || '—')}</dd>
          <dt>Teléfono</dt><dd>${esc((client && client.phone) || '—')}</dd>
          <dt>Dirección</dt><dd>${esc((client && client.address) || '—')}</dd>
        </dl>
      </div>
    </div>

    <div class="split mt-16">
      <div class="card" style="margin-bottom:0">
        <div class="card-head"><h3>Detalle del comprobante</h3><span class="muted small">${(voucher.items || []).length} ítem(s)</span></div>
        ${
          (voucher.items || []).length
            ? `<div class="table-wrap"><table class="tbl">
                <thead><tr>
                  <th>Código</th><th>Descripción</th><th class="num">Cantidad</th><th class="num">P. unitario</th>
                  <th class="num">Desc.</th><th class="num">Subtotal</th><th class="num">IVA</th><th class="num">Total</th>
                </tr></thead>
                <tbody>
                  ${(voucher.items || [])
                    .map((item) => {
                      const taxTotal = (item.taxes || []).reduce((sum, tax) => sum + (Number(tax.valor) || 0) * 100, 0);
                      return `<tr>
                        <td class="mono small">${esc(item.code || '')}</td>
                        <td>${esc(item.description || '')}</td>
                        <td class="num">${fmtQty(item.quantity)}</td>
                        <td class="num">${money(item.unitPriceCents)}</td>
                        <td class="num">${money(item.discountCents)}</td>
                        <td class="num">${money(item.subtotalCents)}</td>
                        <td class="num">${money(Math.round(taxTotal))}</td>
                        <td class="num"><b>${money(item.totalCents)}</b></td>
                      </tr>`;
                    })
                    .join('')}
                </tbody>
              </table></div>`
            : '<div class="empty-state" style="padding:24px">Sin ítems registrados</div>'
        }
      </div>
      <div>
        <div class="card" style="margin-bottom:0">
          <h3>Totales</h3>
          <div class="totals-box">
            <div class="totals-row"><span>Subtotal</span><b>${money(voucher.subtotalCents)}</b></div>
            ${voucher.discountCents ? `<div class="totals-row muted"><span>Descuentos</span><span>${money(voucher.discountCents)}</span></div>` : ''}
            ${
              taxGroups.length
                ? taxGroups
                    .map(
                      (group) =>
                        `<div class="totals-row"><span>IVA ${esc(String(group.tarifa))}% (base ${money(Math.round(group.base * 100))})</span><b>${money(Math.round(group.valor * 100))}</b></div>`,
                    )
                    .join('')
                : `<div class="totals-row muted"><span>IVA</span><span>${money(voucher.taxCents)}</span></div>`
            }
            <div class="totals-row grand"><span>Total</span><span>${money(voucher.totalCents)}</span></div>
          </div>
          <h3 class="mt-16">Pagos</h3>
          ${
            (voucher.payments || []).length
              ? (voucher.payments || [])
                  .map(
                    (payment) =>
                      `<div class="totals-row"><span>${esc(paymentLabelFor(payment.method))}</span><b>${money(payment.amountCents)}</b></div>`,
                  )
                  .join('')
              : '<div class="muted small">Sin pagos registrados</div>'
          }
        </div>
      </div>
    </div>

    ${
      (voucher.infoAdicional || []).length
        ? `<div class="card mt-16" style="margin-bottom:0"><h3>Información adicional</h3><dl class="kv">${(voucher.infoAdicional || [])
            .map((info) => `<dt>${esc(info.nombre)}</dt><dd>${esc(info.valor)}</dd>`)
            .join('')}</dl></div>`
        : ''
    }

    ${messages.length ? `<div class="mt-16">${sriMessagesHtml(messages)}</div>` : ''}

    <div class="card mt-16">
      <h3>Historial de movimientos</h3>
      ${
        (voucher.movements || []).length
          ? `<div class="table-wrap"><table class="tbl">
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th></tr></thead>
              <tbody>
                ${(voucher.movements || [])
                  .map((movement) => {
                    const meta = MOVEMENT_META[movement.type] || { label: movement.type, tone: 'gray' };
                    return `<tr>
                      <td class="nowrap">${fmtDateTime(movement.createdAt)}</td>
                      <td><span class="badge ${meta.tone}">${esc(meta.label)}</span></td>
                      <td>${esc(movement.note || '—')}</td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table></div>`
          : '<div class="empty-state" style="padding:24px">Sin movimientos registrados</div>'
      }
    </div>`;

  /* -------------------------------------------------------------- acciones */

  const copyButton = root.querySelector('[data-copy]');
  if (copyButton) copyButton.addEventListener('click', () => copyText(copyButton.dataset.copy || ''));

  root.querySelectorAll('[data-action]').forEach((button) => {
    const action = button.dataset.action;
    if (action === 'pdf') {
      button.addEventListener('click', () =>
        downloadFile(button, `/vouchers/${voucher.id}/pdf`, `RIDE-${voucher.number || voucher.id}.pdf`),
      );
    } else if (action === 'xml') {
      button.addEventListener('click', () =>
        downloadFile(button, `/vouchers/${voucher.id}/xml`, `${voucher.accessKey || voucher.id}.xml`),
      );
    } else if (action === 'xml-authorized') {
      button.addEventListener('click', () =>
        downloadFile(button, `/vouchers/${voucher.id}/xml?type=authorized`, `${voucher.accessKey || voucher.id}-autorizado.xml`),
      );
    } else if (action === 'check-authorization') {
      button.addEventListener('click', async () => {
        try {
          const updated = await withBusy(button, () => apiPost(`/vouchers/${voucher.id}/check-authorization`));
          if (updated.status === 'issued') {
            toast('Comprobante autorizado por el SRI');
            openEmissionResult(updated, ctx);
          } else if (updated.status === 'failed') {
            toast('El SRI no autorizó el comprobante. Revise los mensajes.', 'warn');
          } else {
            toast('El SRI aún no devuelve autorización. Intente nuevamente en unos minutos.', 'warn');
          }
          if (ctx.refresh) ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      });
    } else if (action === 'signature-check') {
      button.addEventListener('click', async () => {
        try {
          const result = await apiGet(`/vouchers/${voucher.id}/signature-check`);
          const row = (label, value) =>
            `<div class="totals-row"><span>${esc(label)}</span><b>${value ? '<span class="badge green">OK</span>' : '<span class="badge red">FALLA</span>'}</b></div>`;
          openInfoModal(
            'Verificación de firma electrónica',
            `<p class="muted small" style="margin-top:0">La firma se verifica con el certificado incluido en el propio XML (digest del documento, digest de SignedProperties y RSA sobre SignedInfo).</p>
             <div class="totals-box">
               ${row('Firma RSA (SignatureValue)', result.signatureValid)}
               ${row('Digest del comprobante', result.documentDigestValid)}
               ${row('Digest de SignedProperties', result.signedPropertiesDigestValid)}
               ${row('Firma global', result.valid)}
             </div>
             <p class="mono small mt-16">Algoritmo: ${esc((result.digestAlgorithm || 'sha1').toUpperCase())}<br />Titular: ${esc(result.subject || '—')}</p>
             ${(result.details || []).map((detail) => `<div class="small muted">${esc(detail)}</div>`).join('')}`,
          );
        } catch (error) {
          toastError(error);
        }
      });
    } else if (action === 'sri-log') {
      button.addEventListener('click', async () => {
        try {
          const logs = await apiGet(`/vouchers/${voucher.id}/sri-logs`);
          const rows = (logs || [])
            .map(
              (log) => `<tr>
                <td class="mono small">${esc(log.stage)}</td>
                <td class="center">${log.environment === 2 ? 'Producción' : 'Pruebas'}</td>
                <td class="center">${log.httpStatus ?? '—'}</td>
                <td class="small muted">${esc(log.createdAt || '')}</td>
              </tr>
              <tr><td colspan="4"><details><summary class="small">Ver respuesta del SRI</summary><pre class="mono small" style="white-space:pre-wrap;max-height:260px;overflow:auto">${esc((log.responseXml || log.error || 'Sin respuesta registrada').slice(0, 8000))}</pre></details></td></tr>`,
            )
            .join('');
          openInfoModal(
            'Bitácora de comunicación con el SRI',
            logs && logs.length
              ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Etapa</th><th>Ambiente</th><th>HTTP</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table></div>`
              : '<p class="muted">Este comprobante no tiene interacciones registradas con el SRI.</p>',
          );
        } catch (error) {
          toastError(error);
        }
      });
    } else if (action === 'credit-note') {
      button.addEventListener('click', () =>
        ctx.navigate(`/invoicing/notes/new?type=credit&voucherId=${encodeURIComponent(voucher.id)}`),
      );
    } else if (action === 'debit-note') {
      button.addEventListener('click', () =>
        ctx.navigate(`/invoicing/notes/new?type=debit&voucherId=${encodeURIComponent(voucher.id)}`),
      );
    } else if (action === 'emit' || action === 'retry') {
      button.addEventListener('click', async () => {
        const path = action === 'emit' ? 'emit' : 'retry';
        try {
          const updated = await withBusy(button, () => apiPost(`/vouchers/${voucher.id}/${path}`));
          openEmissionResult(updated, ctx);
          if (updated.status === 'issued') toast('Comprobante autorizado por el SRI');
          else toast('El SRI no autorizó el comprobante. Revise los mensajes.', 'warn');
          if (ctx.refresh) ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      });
    } else if (action === 'cancel') {
      button.addEventListener('click', async () => {
        const confirmed = await confirmDialog(
          `¿Anular el comprobante ${voucher.number || voucher.id}? Esta acción cambia su estado a anulado.`,
          { title: 'Anular comprobante', okLabel: 'Anular' },
        );
        if (!confirmed) return;
        try {
          await withBusy(button, () => apiPost(`/vouchers/${voucher.id}/cancel`));
          toast('Comprobante anulado');
          if (ctx.refresh) ctx.refresh();
        } catch (error) {
          toastError(error);
        }
      });
    } else if (action === 'delete') {
      button.addEventListener('click', async () => {
        const confirmed = await confirmDialog(
          `¿Eliminar definitivamente el comprobante ${voucher.number || voucher.id}? Esta acción no se puede deshacer.`,
          { title: 'Eliminar comprobante', okLabel: 'Eliminar' },
        );
        if (!confirmed) return;
        try {
          await withBusy(button, () => apiDelete(`/vouchers/${voucher.id}`));
          toast('Comprobante eliminado');
          ctx.navigate('/invoicing');
        } catch (error) {
          toastError(error);
        }
      });
    } else if (action === 'email') {
      button.addEventListener('click', async () => {
        try {
          const result = await withBusy(button, () => apiPost(`/vouchers/${voucher.id}/email`));
          const to = result && result.to ? result.to : 'sin correo registrado';
          openInfoModal(
            'Envío por correo',
            `<p class="muted small">Destino: <b>${esc(to)}</b></p>
             <p class="small">${esc((result && result.reason) || 'El envío de correo no está configurado.')}</p>
             <p class="muted small" style="margin:0">Puede descargar el RIDE o el XML desde las acciones del comprobante y enviarlos manualmente.</p>`,
          );
        } catch (error) {
          toastError(error);
        }
      });
    }
  });
}

/* ======================================================== notas NC / ND */

async function renderNoteCreate(root, ctx) {
  const type = ctx.query.type === 'debit' ? 'debit' : 'credit';
  const isCredit = type === 'credit';
  const title = isCredit ? 'Nota de crédito' : 'Nota de débito';
  const voucherId = ctx.query.voucherId || ctx.query.id || '';

  if (!voucherId) {
    root.innerHTML = `${pageHead(title, 'Comprobante de modificación sobre una factura')}
      <div class="card"><h3>Falta la factura de referencia</h3>
      <p class="muted">Abra esta pantalla desde el detalle de una factura autorizada usando “Nota de crédito” o “Nota de débito”.</p>
      <a class="btn primary" href="#/invoicing">← Ir a comprobantes</a></div>`;
    return;
  }

  root.innerHTML = spinnerHtml('Cargando factura de referencia…');
  let original;
  try {
    original = await apiGet(`/vouchers/${encodeURIComponent(voucherId)}`);
  } catch (error) {
    root.innerHTML = errorCard('No se pudo cargar la factura', error.message || 'Error desconocido');
    return;
  }
  if (original.docType !== '01') {
    root.innerHTML = errorCard(
      'Comprobante no válido',
      'Las notas de crédito y débito solo pueden emitirse sobre facturas (comprobante 01).',
    );
    return;
  }
  if (!(original.items || []).length) {
    root.innerHTML = errorCard('Factura sin ítems', 'La factura de referencia no tiene ítems para acreditar o debitar.');
    return;
  }

  let options = null;
  try {
    options = await apiGet('/vouchers/options');
  } catch {
    options = null;
  }

  const state = {
    options,
    lines: original.items.map((item) => ({
      key: item.id,
      productId: item.productId || undefined,
      code: item.code || '',
      description: item.description || '',
      quantity: Number(item.quantity) || 1,
      maxQuantity: Number(item.quantity) || 1,
      unitPriceCents: Number(item.unitPriceCents) || 0,
      discountCents: Number(item.discountCents) || 0,
      ivaCode: String(item.ivaCode || '4'),
    })),
    saving: false,
  };

  const ivaOptionsHtml = (selected) =>
    ivaList(options)
      .map((iva) => option(iva.id, iva.description, selected))
      .join('');

  root.innerHTML = `
    ${pageHead(
      title,
      `Sobre la factura ${original.number || ''} · ${original.clientName || 'CONSUMIDOR FINAL'}`,
      `<a class="btn" href="#/invoicing/${esc(original.id)}">← Volver a la factura</a>`,
    )}
    <div class="split">
      <div>
        <div class="card">
          <h3>Motivo</h3>
          <div class="field full">
            <label>Motivo del comprobante *</label>
            <textarea id="reason" maxlength="300" placeholder="${isCredit ? 'Motivo de la nota de crédito (devolución, descuento, corrección…)' : 'Motivo de la nota de débito (cargo adicional, intereses, corrección…)'}"></textarea>
            <div class="help">Obligatorio. Se incluye en el XML enviado al SRI (máximo 300 caracteres).</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h3>Ítems ${isCredit ? 'a acreditar' : 'a debitar'}</h3>
            <button class="btn sm ghost" id="reset-items" type="button">Restablecer ítems de la factura</button>
          </div>
          <div id="note-lines"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Resumen</h3>
          <div class="totals-box">
            <div class="totals-row"><span>Factura original</span><b class="mono">${esc(original.number || '')}</b></div>
            <div class="totals-row"><span>Total factura</span><b>${money(original.totalCents)}</b></div>
            <div id="note-totals" class="mt-8"></div>
          </div>
          <div class="grid mt-16" style="gap:8px">
            <button class="btn primary block lg" id="save-note" type="button">Emitir ${esc(title.toLowerCase())}</button>
            <a class="btn ghost block" href="#/invoicing/${esc(original.id)}">Cancelar</a>
          </div>
          <p class="muted small mt-16">${isCredit ? 'Puede acreditar la factura completa o ajustar cantidades para una nota parcial.' : 'Indique cantidades y valores adicionales a debitar sobre la factura original.'}</p>
        </div>
      </div>
    </div>`;

  const linesBox = root.querySelector('#note-lines');
  const totalsBox = root.querySelector('#note-totals');
  const reasonInput = root.querySelector('#reason');
  const saveButton = root.querySelector('#save-note');

  function resetLines() {
    state.lines = original.items.map((item) => ({
      key: item.id,
      productId: item.productId || undefined,
      code: item.code || '',
      description: item.description || '',
      quantity: Number(item.quantity) || 1,
      maxQuantity: Number(item.quantity) || 1,
      unitPriceCents: Number(item.unitPriceCents) || 0,
      discountCents: Number(item.discountCents) || 0,
      ivaCode: String(item.ivaCode || '4'),
    }));
    renderLines();
    renderTotals();
  }

  function renderLines() {
    linesBox.innerHTML = state.lines.length
      ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>Producto / servicio</th><th class="num">Cant. facturada</th><th style="width:100px">Cantidad</th>
          <th style="width:130px">P. unitario</th><th style="width:110px">Descuento</th><th class="num">Total</th><th></th></tr></thead>
          <tbody>
            ${state.lines
              .map(
                (line) => `<tr data-note-key="${esc(line.key)}">
                  <td><div class="mono small muted">${esc(line.code)}</div><div>${esc(line.description)}</div></td>
                  <td class="num muted">${fmtQty(line.maxQuantity)}</td>
                  <td><input type="number" min="0.01" step="0.01" data-note-field="quantity" value="${esc(String(line.quantity))}" /></td>
                  <td><input type="number" min="0" step="0.01" data-note-field="unitPrice" value="${lineInputValue(line.unitPriceCents)}" /></td>
                  <td><input type="number" min="0" step="0.01" data-note-field="discount" value="${lineInputValue(line.discountCents)}" /></td>
                  <td class="num" data-note-total>${money(lineAmounts(line, options).totalCents)}</td>
                  <td class="right"><button class="btn ghost sm" type="button" data-remove-note-line title="Quitar ítem">✕</button></td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table></div>`
      : '<div class="empty-state" style="padding:24px">No quedan ítems en la nota</div>';
  }

  function renderTotals() {
    const totals = computeTotals(state.lines, options);
    totalsBox.innerHTML = `
      <div class="totals-row"><span>Subtotal</span><b>${money(totals.subtotalCents)}</b></div>
      ${
        totals.byRate.length
          ? totals.byRate
              .map(
                (item) =>
                  `<div class="totals-row"><span>IVA ${esc(String(item.tarifa))}%</span><b>${money(item.taxCents)}</b></div>`,
              )
              .join('')
          : ''
      }
      <div class="totals-row grand"><span>Total ${isCredit ? 'a acreditar' : 'a debitar'}</span><span>${money(totals.totalCents)}</span></div>`;
  }

  function updateNoteLineTotal(key) {
    const line = state.lines.find((item) => item.key === key);
    const row = linesBox.querySelector(`[data-note-key="${key}"]`);
    if (!line || !row) return;
    const cell = row.querySelector('[data-note-total]');
    if (cell) cell.textContent = money(lineAmounts(line, options).totalCents);
  }

  linesBox.addEventListener('input', (event) => {
    const input = event.target.closest('[data-note-field]');
    if (!input) return;
    const row = input.closest('[data-note-key]');
    const line = state.lines.find((item) => item.key === row.dataset.noteKey);
    if (!line) return;
    if (input.dataset.noteField === 'quantity') line.quantity = Math.max(0, Number(input.value) || 0);
    if (input.dataset.noteField === 'unitPrice') line.unitPriceCents = centsFromInput(input.value);
    if (input.dataset.noteField === 'discount') line.discountCents = centsFromInput(input.value);
    updateNoteLineTotal(line.key);
    renderTotals();
  });

  linesBox.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-note-line]');
    if (!remove) return;
    const row = remove.closest('[data-note-key]');
    state.lines = state.lines.filter((line) => line.key !== row.dataset.noteKey);
    renderLines();
    renderTotals();
  });

  root.querySelector('#reset-items').addEventListener('click', resetLines);

  saveButton.addEventListener('click', async () => {
    if (state.saving) return;
    const reason = reasonInput.value.trim();
    if (!reason) {
      toastError('El motivo de la nota es obligatorio');
      reasonInput.focus();
      return;
    }
    if (!state.lines.length) {
      toastError('La nota debe tener al menos un ítem');
      return;
    }
    for (const line of state.lines) {
      if (!(Number(line.quantity) > 0)) {
        toastError(`La cantidad de "${line.description}" debe ser mayor a 0`);
        return;
      }
      if (isCredit && Number(line.quantity) > Number(line.maxQuantity)) {
        toastError(`La cantidad a acreditar de "${line.description}" no puede superar la facturada`);
        return;
      }
    }
    const totals = computeTotals(state.lines, options);
    if (totals.totalCents <= 0) {
      toastError('El total de la nota debe ser mayor a 0');
      return;
    }
    state.saving = true;
    saveButton.disabled = true;
    try {
      const payload = {
        reason,
        items: state.lines.map((line) => ({
          productId: line.productId,
          code: line.code,
          description: line.description,
          quantity: Number(line.quantity),
          unitPriceCents: Math.round(Number(line.unitPriceCents) || 0),
          discountCents: Math.round(Number(line.discountCents) || 0),
          ivaCode: line.ivaCode,
        })),
      };
      const path = isCredit ? 'credit-note' : 'debit-note';
      const note = await withBusy(saveButton, () => apiPost(`/vouchers/${original.id}/${path}`, payload));
      toast(`${title} emitida correctamente`);
      ctx.navigate(`/invoicing/${note.id}`);
    } catch (error) {
      toastError(error);
    } finally {
      state.saving = false;
      saveButton.disabled = false;
    }
  });

  renderLines();
  renderTotals();
  reasonInput.focus();
}
