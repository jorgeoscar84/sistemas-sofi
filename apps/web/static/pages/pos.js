/**
 * Punto de venta (caja): búsqueda de productos, carrito, pagos múltiples y vuelto.
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

function openSaleResult(voucher, changeCents, ctx) {
  const messages = Array.isArray(voucher.sriMessages) ? voucher.sriMessages : [];
  const body = `
    <div class="inline center gap-8" style="margin-bottom:14px">
      ${statusBadge(voucher.status)}
      <span class="mono">${esc(voucher.number || '—')}</span>
    </div>
    <div class="totals-box" style="margin-bottom:12px">
      <div class="totals-row"><span>Total cobrado</span><b>${money(voucher.totalCents)}</b></div>
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
        ? `<div class="card" style="margin:0;background:var(--red-soft);border-color:#fecaca"><b>Mensajes del SRI</b>
            ${messages
              .map(
                (message) =>
                  `<div class="small" style="margin-top:6px">${esc(message.mensaje || message.message || '')}</div>`,
              )
              .join('')}
          </div>`
        : ''
    }
    <p class="muted small" style="margin:12px 0 0">Venta registrada. Puede descargar el RIDE o abrir el comprobante.</p>`;
  const modalEl = modal({
    title: voucher.status === 'issued' ? 'Venta cobrada y autorizada' : 'Resultado de la venta',
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
      { label: 'Nueva venta', onClick: () => closeModal() },
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
  root.innerHTML = spinnerHtml('Abriendo caja…');
  let options;
  let initialProducts = [];
  try {
    const [optionsResult, productsResult] = await Promise.allSettled([
      apiGet('/vouchers/options'),
      apiGet('/products/search', { q: '' }),
    ]);
    if (optionsResult.status !== 'fulfilled') throw optionsResult.reason;
    options = optionsResult.value;
    initialProducts = productsResult.status === 'fulfilled' && Array.isArray(productsResult.value) ? productsResult.value : [];
  } catch (error) {
    root.innerHTML = `<div class="card"><h3>No se pudo abrir el punto de venta</h3><p class="muted">${esc(error.message || 'Error desconocido')}</p><a class="btn" href="#/invoicing">← Volver a comprobantes</a></div>`;
    return;
  }

  const state = {
    options,
    products: initialProducts,
    cart: [],
    clientId: '',
    payments: [{ method: 'efectivo', amountCents: 0 }],
    autoPayment: true,
    charging: false,
    searchTerm: '',
  };

  root.innerHTML = `
    ${pageHead(
      'Punto de venta',
      'Caja rápida: busque, agregue al carrito y cobre con una o varias formas de pago',
      `<a class="btn" href="#/invoicing">← Comprobantes</a>
       <a class="btn" href="#/quick-billing">⚡ Facturación rápida</a>`,
    )}
    <div class="pos-grid" id="pos-page">
      <div>
        <div class="card">
          <div class="search">
            <input type="search" id="pos-search" placeholder="Buscar por código o descripción · Enter agrega el primer resultado" autocomplete="off" />
          </div>
          <div class="inline between mt-16">
            <span class="muted small" id="pos-search-hint">Productos disponibles</span>
            <span class="muted small">F2 cobrar · Enter busca/agrega</span>
          </div>
          <div id="pos-products" class="product-grid mt-16"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="card-head"><h3>Carrito</h3><span class="badge gray" id="pos-count">0 ítem(s)</span></div>
          <div id="pos-cart"></div>
          <div id="pos-totals" class="mt-16"></div>
        </div>
        <div class="card">
          <h3>Cliente</h3>
          <select id="pos-client">
            <option value="">CONSUMIDOR FINAL (9999999999999)</option>
            ${(options.clients || [])
              .map((client) => option(client.id, `${client.name} — ${client.idNumber}`, false))
              .join('')}
          </select>
        </div>
        <div class="card">
          <div class="card-head"><h3>Pagos</h3><span class="muted small">Puede combinar formas de pago</span></div>
          <div class="inline mt-8" style="margin-bottom:12px">
            <button class="btn sm" type="button" data-quick-method="efectivo">Efectivo</button>
            <button class="btn sm" type="button" data-quick-method="transferencia">Transferencia</button>
            <button class="btn sm" type="button" data-quick-method="19">Tarjeta</button>
          </div>
          <div id="pos-payments"></div>
          <div id="pos-change" class="mt-8"></div>
          <div class="grid mt-16" style="gap:8px">
            <button class="btn primary block lg" id="pos-charge" type="button">Cobrar y emitir (F2)</button>
            <button class="btn ghost block" id="pos-clear" type="button">Limpiar</button>
          </div>
        </div>
      </div>
    </div>`;

  const searchInput = root.querySelector('#pos-search');
  const searchHint = root.querySelector('#pos-search-hint');
  const productsBox = root.querySelector('#pos-products');
  const cartBox = root.querySelector('#pos-cart');
  const countBadge = root.querySelector('#pos-count');
  const totalsBox = root.querySelector('#pos-totals');
  const clientSelect = root.querySelector('#pos-client');
  const paymentsBox = root.querySelector('#pos-payments');
  const changeBox = root.querySelector('#pos-change');
  const chargeButton = root.querySelector('#pos-charge');
  const clearButton = root.querySelector('#pos-clear');

  /* -------------------------------------------------------------- productos */

  function renderProducts() {
    const products = state.products;
    if (!products.length) {
      productsBox.innerHTML = '<div class="empty-state" style="grid-column:1/-1;padding:30px"><div class="icon">🔍</div>Sin productos para la búsqueda</div>';
      return;
    }
    productsBox.innerHTML = products
      .map(
        (product) => `<button class="product-tile" type="button" data-add-product="${esc(product.id)}">
          <div class="code">${esc(product.code)}</div>
          <div class="name">${esc(product.description)}</div>
          <div class="inline between">
            <span class="price">${money(product.priceCents)}</span>
            ${product.trackStock && product.totalStock !== undefined ? `<span class="muted small">Stock ${fmtQty(product.totalStock)}</span>` : ''}
          </div>
        </button>`,
      )
      .join('');
    productsBox.querySelectorAll('[data-add-product]').forEach((tile) => {
      tile.addEventListener('click', () => {
        const product = state.products.find((item) => item.id === tile.dataset.addProduct);
        if (product) addToCart(product);
      });
    });
  }

  async function loadProducts(term) {
    try {
      const products = await apiGet('/products/search', { q: term });
      state.products = Array.isArray(products) ? products : [];
      searchHint.textContent = term
        ? `${state.products.length} resultado(s) para “${term}”`
        : 'Productos disponibles';
      renderProducts();
    } catch (error) {
      toastError(error);
    }
  }

  const debouncedLoad = debounce((term) => loadProducts(term), 300);
  searchInput.addEventListener('input', () => {
    state.searchTerm = searchInput.value.trim();
    debouncedLoad(state.searchTerm);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = state.products[0];
    if (!first) {
      toast('No hay resultados para agregar', 'warn');
      return;
    }
    addToCart(first);
    searchInput.select();
  });

  /* --------------------------------------------------------------- carrito */

  function findCartLine(productId) {
    return state.cart.find((line) => line.productId === productId);
  }

  function addToCart(product) {
    const existing = findCartLine(product.id);
    if (existing) existing.quantity = Number(existing.quantity) + 1;
    else {
      state.cart.push({
        productId: product.id,
        code: product.code,
        description: product.description,
        quantity: 1,
        unitPriceCents: Math.round(Number(product.priceCents) || 0),
        discountCents: 0,
        ivaCode: String(product.ivaCode || '4'),
      });
    }
    renderCart();
    renderPayments();
    renderTotals();
    toast(`${product.description} agregado`, 'ok');
  }

  function renderCart() {
    if (!state.cart.length) {
      cartBox.innerHTML = '<div class="empty-state" style="padding:24px"><div class="icon">🛒</div>Carrito vacío: agregue productos del panel izquierdo</div>';
    } else {
      cartBox.innerHTML = state.cart
        .map(
          (line) => `<div class="cart-line" data-cart-id="${esc(line.productId)}">
            <div>
              <div class="small"><b>${esc(line.description)}</b></div>
              <div class="muted small">${esc(line.code)} · ${money(line.unitPriceCents)} c/u</div>
            </div>
            <div class="qty-controls">
              <button type="button" data-cart-minus title="Quitar uno">−</button>
              <span>${fmtQty(line.quantity)}</span>
              <button type="button" data-cart-plus title="Agregar uno">+</button>
            </div>
            <div class="right">
              <div><b>${money(lineAmounts(line, options).totalCents)}</b></div>
              <button class="btn ghost sm" type="button" data-cart-remove title="Quitar del carrito">✕</button>
            </div>
          </div>`,
        )
        .join('');
    }
    const count = state.cart.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
    countBadge.textContent = `${fmtQty(count)} ítem(s)`;
  }

  cartBox.addEventListener('click', (event) => {
    const lineElement = event.target.closest('[data-cart-id]');
    if (!lineElement) return;
    const line = findCartLine(lineElement.dataset.cartId);
    if (!line) return;
    if (event.target.closest('[data-cart-plus]')) {
      line.quantity = Number(line.quantity) + 1;
    } else if (event.target.closest('[data-cart-minus]')) {
      line.quantity = Number(line.quantity) - 1;
      if (line.quantity <= 0) state.cart = state.cart.filter((item) => item !== line);
    } else if (event.target.closest('[data-cart-remove]')) {
      state.cart = state.cart.filter((item) => item !== line);
    } else {
      return;
    }
    renderCart();
    renderPayments();
    renderTotals();
  });

  /* --------------------------------------------------------------- totales */

  function renderTotals() {
    const totals = computeTotals(state.cart, options);
    totalsBox.innerHTML = `<div class="totals-box">
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

  /* ---------------------------------------------------------------- pagos */

  function paidCents() {
    return state.payments.reduce((sum, payment) => sum + (Number(payment.amountCents) || 0), 0);
  }

  function renderPayments() {
    paymentsBox.innerHTML = `${state.payments
      .map(
        (payment, index) => `<div class="inline" data-payment-index="${index}" style="margin-bottom:8px">
          <select class="grow" data-payment-field="method">${paymentMethods(options)
            .map((method) => option(method.id, method.description, method.id === payment.method))
            .join('')}</select>
          <input type="number" min="0" step="0.01" style="max-width:140px" data-payment-field="amount" value="${lineInputValue(payment.amountCents)}" />
          <button class="btn ghost sm" type="button" data-remove-payment title="Quitar pago">✕</button>
        </div>`,
      )
      .join('')}
      <div class="inline mt-8">
        <button class="btn sm" id="pos-add-payment" type="button">+ Agregar pago</button>
        <button class="btn sm" id="pos-exact" type="button">Pago exacto</button>
      </div>`;
  }

  function syncAutoPayment(totals) {
    if (state.autoPayment && state.payments.length === 1) {
      state.payments[0].amountCents = totals.totalCents;
      const amountInput = paymentsBox.querySelector('input[data-payment-field="amount"]');
      if (amountInput) amountInput.value = lineInputValue(totals.totalCents);
    }
  }

  function updateChange(totalsArg) {
    const totals = totalsArg || computeTotals(state.cart, options);
    syncAutoPayment(totals);
    if (!state.cart.length) {
      changeBox.innerHTML = '<span class="muted small">Agregue productos para cobrar.</span>';
      return;
    }
    const paid = paidCents();
    const diff = paid - totals.totalCents;
    if (diff > 0) {
      changeBox.innerHTML = `<div class="totals-box"><div class="totals-row"><span>Recibido</span><span>${money(paid)}</span></div><div class="totals-row grand"><span>Vuelto</span><span>${money(diff)}</span></div></div>`;
    } else if (diff === 0) {
      changeBox.innerHTML = '<span class="badge green">Pago completo</span>';
    } else {
      changeBox.innerHTML = `<span class="badge red">Faltan ${money(-diff)}</span>`;
    }
  }

  paymentsBox.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-payment-field="method"]');
    if (!select) return;
    const row = select.closest('[data-payment-index]');
    const payment = state.payments[Number(row.dataset.paymentIndex)];
    if (!payment) return;
    payment.method = select.value;
    state.autoPayment = false;
  });

  paymentsBox.addEventListener('input', (event) => {
    const input = event.target.closest('input[data-payment-field="amount"]');
    if (!input) return;
    const row = input.closest('[data-payment-index]');
    const payment = state.payments[Number(row.dataset.paymentIndex)];
    if (!payment) return;
    payment.amountCents = centsFromInput(input.value);
    state.autoPayment = false;
    updateChange();
  });

  paymentsBox.addEventListener('click', (event) => {
    if (event.target.closest('#pos-add-payment')) {
      state.payments.push({ method: 'efectivo', amountCents: 0 });
      state.autoPayment = false;
      renderPayments();
      updateChange();
      return;
    }
    if (event.target.closest('#pos-exact')) {
      const totals = computeTotals(state.cart, options);
      state.payments = [{ method: state.payments[0] ? state.payments[0].method : 'efectivo', amountCents: totals.totalCents }];
      state.autoPayment = true;
      renderPayments();
      updateChange();
      return;
    }
    const remove = event.target.closest('[data-remove-payment]');
    if (remove) {
      const row = remove.closest('[data-payment-index]');
      state.payments.splice(Number(row.dataset.paymentIndex), 1);
      if (!state.payments.length) state.payments.push({ method: 'efectivo', amountCents: 0 });
      state.autoPayment = false;
      renderPayments();
      updateChange();
    }
  });

  root.querySelectorAll('[data-quick-method]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.payments.length) state.payments.push({ method: 'efectivo', amountCents: 0 });
      state.payments[0].method = button.dataset.quickMethod;
      renderPayments();
      updateChange();
    });
  });

  clientSelect.addEventListener('change', () => {
    state.clientId = clientSelect.value;
  });

  clearButton.addEventListener('click', () => {
    state.cart = [];
    state.clientId = '';
    clientSelect.value = '';
    state.payments = [{ method: 'efectivo', amountCents: 0 }];
    state.autoPayment = true;
    renderCart();
    renderPayments();
    renderTotals();
  });

  /* --------------------------------------------------------------- cobrar */

  async function charge() {
    if (state.charging) return;
    if (!state.cart.length) {
      toastError('El carrito está vacío');
      return;
    }
    for (const line of state.cart) {
      if (!(Number(line.quantity) > 0)) {
        toastError('Las cantidades deben ser mayores a 0');
        return;
      }
    }
    const totals = computeTotals(state.cart, options);
    if (totals.totalCents <= 0) {
      toastError('El total de la venta debe ser mayor a 0');
      return;
    }
    let payments = state.payments
      .map((payment) => ({ method: payment.method, amountCents: Math.round(Number(payment.amountCents) || 0), term: 0 }))
      .filter((payment) => payment.amountCents > 0);
    if (!payments.length) payments = [{ method: 'efectivo', amountCents: totals.totalCents, term: 0 }];
    const paid = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    if (paid < totals.totalCents) {
      toastError(`Los pagos no cubren el total. Faltan ${money(totals.totalCents - paid)}`);
      return;
    }
    state.charging = true;
    try {
      const body = {
        items: state.cart.map((line) => ({
          productId: line.productId,
          quantity: Number(line.quantity),
          unitPriceCents: Math.round(Number(line.unitPriceCents) || 0),
          discountCents: Math.round(Number(line.discountCents) || 0),
        })),
        payments,
        clientId: state.clientId || undefined,
      };
      const result = await withBusy(chargeButton, () => apiPost('/pos/sales', body));
      const voucher = result.voucher || result;
      const changeCents = Number(result.changeCents) || 0;
      if (voucher.status === 'issued') toast('Venta autorizada por el SRI');
      else toast('La venta no fue autorizada. Revise los mensajes del SRI.', 'warn');
      state.cart = [];
      state.payments = [{ method: 'efectivo', amountCents: 0 }];
      state.autoPayment = true;
      renderCart();
      renderPayments();
      renderTotals();
      openSaleResult(voucher, changeCents, ctx);
      loadProducts(state.searchTerm);
    } catch (error) {
      toastError(error);
    } finally {
      state.charging = false;
    }
  }

  chargeButton.addEventListener('click', () => charge());

  /* -------------------------------------------------------------- atajos */

  if (window.__posKeyHandler) {
    document.removeEventListener('keydown', window.__posKeyHandler);
    window.__posKeyHandler = null;
  }
  const keyHandler = (event) => {
    if (!document.getElementById('pos-page')) {
      document.removeEventListener('keydown', keyHandler);
      if (window.__posKeyHandler === keyHandler) window.__posKeyHandler = null;
      return;
    }
    if (event.key === 'F2') {
      event.preventDefault();
      charge();
    }
  };
  window.__posKeyHandler = keyHandler;
  document.addEventListener('keydown', keyHandler);

  /* ------------------------------------------------------------- arranque */

  renderProducts();
  renderCart();
  renderPayments();
  renderTotals();
  searchInput.focus();
}

function withBusy(button, fn) {
  const original = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
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
