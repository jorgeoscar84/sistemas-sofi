/**
 * Facturación rápida: emisión inmediata de una factura con consumidor final u otro cliente.
 * Vanilla JS ESM, sin dependencias. Exporta render(root, ctx).
 */
import {
  apiGet,
  apiPost,
  esc,
  money,
  centsFromInput,
  decimalFromCents,
  fmtQty,
  statusBadge,
  toast,
  toastError,
  modal,
  closeModal,
  pageHead,
  field,
  option,
  download,
  spinnerHtml,
  debounce,
} from '../lib.js';

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

function ivaList(options) {
  return options && Array.isArray(options.iva) && options.iva.length ? options.iva : IVA_FALLBACK;
}

function ivaRate(options, code) {
  const item = ivaList(options).find((iva) => iva.id === String(code));
  return item && Number.isFinite(Number(item.value)) ? Number(item.value) : 0;
}

function paymentMethods(options) {
  return options && Array.isArray(options.paymentMethods) && options.paymentMethods.length
    ? options.paymentMethods
    : PAYMENT_FALLBACK;
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
  let taxCents = 0;
  for (const line of lines) {
    const amounts = lineAmounts(line, options);
    subtotalCents += amounts.subtotalCents;
    taxCents += amounts.taxCents;
    const tarifa = Math.round(ivaRate(options, line.ivaCode) * 100);
    const key = String(tarifa);
    const current = byRate.get(key) || { tarifa, baseCents: 0, taxCents: 0 };
    current.baseCents += amounts.subtotalCents;
    current.taxCents += amounts.taxCents;
    byRate.set(key, current);
  }
  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    byRate: [...byRate.values()].sort((a, b) => a.tarifa - b.tarifa),
  };
}

function lineInputValue(centsValue) {
  return decimalFromCents(Math.round(Number(centsValue) || 0));
}

function withBusy(button, fn) {
  const original = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Emitiendo…';
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

function openQuickResult(voucher, changeCents, ctx) {
  const messages = Array.isArray(voucher.sriMessages) ? voucher.sriMessages : [];
  const body = `
    <div class="inline center gap-8" style="margin-bottom:14px">
      ${statusBadge(voucher.status)}
      <span class="mono">${esc(voucher.number || '—')}</span>
    </div>
    <div class="totals-box" style="margin-bottom:12px">
      <div class="totals-row"><span>Total facturado</span><b>${money(voucher.totalCents)}</b></div>
      <div class="totals-row"><span>Recibido</span><span>${money(Number(voucher.totalCents || 0) + Number(changeCents || 0))}</span></div>
      <div class="totals-row grand"><span>Vuelto</span><span>${money(changeCents)}</span></div>
    </div>
    ${
      voucher.accessKey
        ? `<div class="field" style="margin-bottom:12px"><label>Clave de acceso</label>
            <div class="inline"><input class="mono" readonly value="${esc(voucher.accessKey)}" style="flex:1;min-width:0" />
            <button class="btn sm" data-copy="${esc(voucher.accessKey)}">Copiar</button></div></div>`
        : ''
    }
    ${
      messages.length
        ? `<div class="card" style="margin:0;background:var(--red-soft);border-color:#fecaca">
            <b>Mensajes del SRI</b>
            ${messages
              .map(
                (message) =>
                  `<div class="small" style="margin-top:6px">${esc(message.mensaje || message.message || '')}</div>`,
              )
              .join('')}
          </div>`
        : ''
    }`;
  const modalEl = modal({
    title: voucher.status === 'issued' ? 'Factura rápida autorizada' : 'Resultado de la emisión',
    body,
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
        onClick: () => download(`/vouchers/${voucher.id}/pdf`, `RIDE-${voucher.number || voucher.id}.pdf`).catch(toastError),
      },
      { label: 'Cerrar', onClick: () => closeModal() },
    ],
  });
  modalEl.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', () => {
      navigator.clipboard
        .writeText(button.dataset.copy || '')
        .then(() => toast('Copiado al portapapeles'))
        .catch(() => toast('No se pudo copiar', 'warn'));
    });
  });
}

export async function render(root, ctx) {
  root.innerHTML = spinnerHtml('Cargando opciones…');
  let options;
  try {
    options = await apiGet('/vouchers/options');
  } catch (error) {
    root.innerHTML = `<div class="card"><h3>No se pudieron cargar las opciones</h3><p class="muted">${esc(error.message || 'Error desconocido')}</p><a class="btn" href="#/invoicing">← Volver a comprobantes</a></div>`;
    return;
  }

  const state = {
    options,
    items: [],
    clientId: '',
    paymentMethod: 'efectivo',
    receivedCents: 0,
    remainingTouched: false,
    emitting: false,
  };

  root.innerHTML = `
    ${pageHead(
      'Facturación rápida',
      'Emita una factura en segundos: producto, cantidad y forma de pago',
      '<a class="btn" href="#/invoicing">← Comprobantes</a>',
    )}
    <div class="split">
      <div>
        <div class="card">
          <div class="card-head"><h3>Producto o servicio</h3><span class="muted small">Busque por código o descripción y presione el resultado</span></div>
          <div class="search" style="position:relative">
            <input type="search" id="quick-search" placeholder="Buscar producto: código o descripción…" autocomplete="off" />
            <div id="quick-results" class="hidden" style="position:absolute;left:0;right:0;top:100%;z-index:40;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);margin-top:4px;max-height:300px;overflow:auto"></div>
          </div>
          <div id="quick-items" class="mt-16"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Cliente</h3><span class="muted small">Opcional: por defecto se factura a consumidor final</span></div>
          ${field(
            'Cliente',
            `<select id="quick-client">
              <option value="">CONSUMIDOR FINAL (9999999999999)</option>
              ${(options.clients || [])
                .map((client) => option(client.id, `${client.name} — ${client.idNumber}`, false))
                .join('')}
            </select>`,
            { full: true },
          )}
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Resumen</h3>
          <div id="quick-totals"></div>
        </div>
        <div class="card">
          <h3>Forma de pago</h3>
          <div class="form-grid">
            ${field(
              'Método',
              `<select id="quick-method">${paymentMethods(options)
                .map((method) => option(method.id, method.description, method.id === 'efectivo'))
                .join('')}</select>`,
              { full: true },
            )}
          </div>
          <div class="form-grid mt-16">
            ${field('Monto recibido', '<input type="number" min="0" step="0.01" id="quick-received" placeholder="Opcional; vacío = pago exacto" />', {
              full: true,
            })}
          </div>
          <div id="quick-change" class="mt-16"></div>
          <div class="grid mt-16" style="gap:8px">
            <button class="btn primary block lg" id="quick-emit" type="button">Emitir factura rápida</button>
            <button class="btn block" id="quick-reset" type="button">Limpiar</button>
          </div>
          <p class="muted small mt-16">La factura se emite de inmediato con el secuencial del punto de emisión configurado.</p>
        </div>
      </div>
    </div>`;

  const searchInput = root.querySelector('#quick-search');
  const resultsBox = root.querySelector('#quick-results');
  const itemsBox = root.querySelector('#quick-items');
  const totalsBox = root.querySelector('#quick-totals');
  const clientSelect = root.querySelector('#quick-client');
  const methodSelect = root.querySelector('#quick-method');
  const receivedInput = root.querySelector('#quick-received');
  const changeBox = root.querySelector('#quick-change');
  const emitButton = root.querySelector('#quick-emit');
  const resetButton = root.querySelector('#quick-reset');

  function hideResults() {
    resultsBox.classList.add('hidden');
    resultsBox.innerHTML = '';
  }

  function addProduct(product) {
    const existing = state.items.find((item) => item.productId === product.id);
    if (existing) existing.quantity = Number(existing.quantity) + 1;
    else {
      state.items.push({
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
    renderItems();
    renderTotals();
  }

  async function searchProducts(term) {
    try {
      const products = await apiGet('/products/search', { q: term });
      const list = Array.isArray(products) ? products : [];
      if (!list.length) {
        resultsBox.innerHTML = '<div class="muted small" style="padding:10px">Sin coincidencias</div>';
        resultsBox.classList.remove('hidden');
        return;
      }
      resultsBox.innerHTML = list
        .map(
          (product) => `<button class="btn ghost block" type="button" data-product-id="${esc(product.id)}" style="justify-content:space-between;text-align:left;width:100%">
            <span><b>${esc(product.description)}</b> <span class="muted small">${esc(product.code)}</span></span>
            <span class="right">${money(product.priceCents)}</span>
          </button>`,
        )
        .join('');
      resultsBox.classList.remove('hidden');
      resultsBox.querySelectorAll('[data-product-id]').forEach((button) => {
        button.addEventListener('click', () => {
          const product = list.find((item) => item.id === button.dataset.productId);
          if (!product) return;
          addProduct(product);
          searchInput.value = '';
          hideResults();
          searchInput.focus();
        });
      });
    } catch (error) {
      toastError(error);
    }
  }

  const debouncedSearch = debounce((term) => searchProducts(term), 300);
  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim();
    if (!term) {
      hideResults();
      return;
    }
    debouncedSearch(term);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = resultsBox.querySelector('[data-product-id]');
    if (first) first.click();
  });
  searchInput.addEventListener('blur', () => setTimeout(hideResults, 180));

  function renderItems() {
    if (!state.items.length) {
      itemsBox.innerHTML = '<div class="empty-state" style="padding:30px"><div class="icon">🧾</div>Busque un producto para comenzar</div>';
      return;
    }
    itemsBox.innerHTML = `<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Producto</th><th style="width:100px">Cantidad</th><th style="width:130px">P. unitario</th>
      <th style="width:110px">Descuento</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>
        ${state.items
          .map(
            (item) => `<tr data-item-key="${esc(item.key)}">
              <td><div class="mono small muted">${esc(item.code)}</div><div>${esc(item.description)}</div></td>
              <td><input type="number" min="0.01" step="0.01" data-item-field="quantity" value="${esc(String(item.quantity))}" /></td>
              <td><input type="number" min="0" step="0.01" data-item-field="price" value="${lineInputValue(item.unitPriceCents)}" /></td>
              <td><input type="number" min="0" step="0.01" data-item-field="discount" value="${lineInputValue(item.discountCents)}" /></td>
              <td class="num" data-item-total>${money(lineAmounts(item, options).totalCents)}</td>
              <td class="right"><button class="btn ghost sm" type="button" data-remove-item title="Quitar">✕</button></td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table></div>`;
  }

  function updateItemTotal(key) {
    const item = state.items.find((entry) => entry.key === key);
    const row = itemsBox.querySelector(`[data-item-key="${key}"]`);
    if (!item || !row) return;
    const cell = row.querySelector('[data-item-total]');
    if (cell) cell.textContent = money(lineAmounts(item, options).totalCents);
  }

  itemsBox.addEventListener('input', (event) => {
    const input = event.target.closest('[data-item-field]');
    if (!input) return;
    const row = input.closest('[data-item-key]');
    const item = state.items.find((entry) => entry.key === row.dataset.itemKey);
    if (!item) return;
    if (input.dataset.itemField === 'quantity') item.quantity = Math.max(0, Number(input.value) || 0);
    if (input.dataset.itemField === 'price') item.unitPriceCents = centsFromInput(input.value);
    if (input.dataset.itemField === 'discount') item.discountCents = centsFromInput(input.value);
    updateItemTotal(item.key);
    renderTotals();
  });

  itemsBox.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-item]');
    if (!remove) return;
    const row = remove.closest('[data-item-key]');
    state.items = state.items.filter((item) => item.key !== row.dataset.itemKey);
    renderItems();
    renderTotals();
  });

  function renderTotals() {
    const totals = computeTotals(state.items, options);
    totalsBox.innerHTML = `
      <div class="totals-box">
        <div class="totals-row"><span>Subtotal</span><b>${money(totals.subtotalCents)}</b></div>
        ${
          totals.byRate.length
            ? totals.byRate
                .map(
                  (group) =>
                    `<div class="totals-row"><span>IVA ${esc(String(group.tarifa))}%</span><b>${money(group.taxCents)}</b></div>`,
                )
                .join('')
            : `<div class="totals-row muted"><span>IVA</span><span>${money(0)}</span></div>`
        }
        <div class="totals-row grand"><span>Total</span><span>${money(totals.totalCents)}</span></div>
      </div>`;
    updateChange(totals);
  }

  function updateChange(totals) {
    const total = totals ? totals.totalCents : computeTotals(state.items, options).totalCents;
    if (!receivedInput.value.trim()) {
      state.receivedCents = 0;
      changeBox.innerHTML = '<span class="muted small">Pago exacto: no se calcula vuelto.</span>';
      return;
    }
    const received = state.receivedCents;
    const diff = received - total;
    if (diff >= 0) {
      changeBox.innerHTML = `<div class="totals-box"><div class="totals-row"><span>Recibido</span><span>${money(received)}</span></div><div class="totals-row grand"><span>Vuelto</span><span>${money(diff)}</span></div></div>`;
    } else {
      changeBox.innerHTML = `<span class="badge red">Faltan ${money(-diff)} para completar el total</span>`;
    }
  }

  receivedInput.addEventListener('input', () => {
    state.receivedCents = centsFromInput(receivedInput.value);
    updateChange();
  });
  clientSelect.addEventListener('change', () => {
    state.clientId = clientSelect.value;
  });
  methodSelect.addEventListener('change', () => {
    state.paymentMethod = methodSelect.value;
  });

  resetButton.addEventListener('click', () => {
    state.items = [];
    state.receivedCents = 0;
    receivedInput.value = '';
    renderItems();
    renderTotals();
  });

  emitButton.addEventListener('click', async () => {
    if (state.emitting) return;
    if (!state.items.length) {
      toastError('Agregue al menos un producto');
      return;
    }
    for (const item of state.items) {
      if (!(Number(item.quantity) > 0)) {
        toastError(`La cantidad de "${item.description}" debe ser mayor a 0`);
        return;
      }
    }
    const totals = computeTotals(state.items, options);
    if (totals.totalCents <= 0) {
      toastError('El total de la factura debe ser mayor a 0');
      return;
    }
    if (receivedInput.value.trim() && state.receivedCents < totals.totalCents) {
      toastError('El monto recibido es menor al total de la factura');
      return;
    }
    state.emitting = true;
    try {
      const body = {
        items: state.items.map((item) => ({
          productId: item.productId,
          quantity: Number(item.quantity),
          unitPriceCents: Math.round(Number(item.unitPriceCents) || 0),
          discountCents: Math.round(Number(item.discountCents) || 0),
        })),
        clientId: state.clientId || undefined,
        paymentMethod: state.paymentMethod,
        amountCents: state.receivedCents > 0 ? state.receivedCents : undefined,
      };
      const result = await withBusy(emitButton, () => apiPost('/quick-invoices', body));
      const voucher = result.voucher || result;
      const changeCents = Number(result.changeCents) || 0;
      if (voucher.status === 'issued') toast('Factura autorizada por el SRI');
      else toast('La factura no fue autorizada. Revise los mensajes del SRI.', 'warn');
      state.items = [];
      state.receivedCents = 0;
      receivedInput.value = '';
      renderItems();
      renderTotals();
      openQuickResult(voucher, changeCents, ctx);
    } catch (error) {
      toastError(error);
    } finally {
      state.emitting = false;
    }
  });

  renderItems();
  renderTotals();
}
