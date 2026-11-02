/**
 * Utilidades compartidas del frontend (vanilla JS, sin dependencias).
 *
 * Contrato para los módulos de página:
 *   export async function render(root, ctx)
 * donde `ctx = { path, params, query, user, navigate, refresh }`.
 */

const TOKEN_KEY = 'fe_token';
const USER_KEY = 'fe_user';
const TENANT_KEY = 'fe_tenant';

/* --------------------------------------------------------------- sesión */

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}
export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(TENANT_KEY);
}
/** Empresa seleccionada por el superadministrador (multiempresa). */
export function getTenantId() {
  return localStorage.getItem(TENANT_KEY) || '';
}
export function setTenantId(companyId) {
  if (companyId) localStorage.setItem(TENANT_KEY, companyId);
  else localStorage.removeItem(TENANT_KEY);
}

/* ------------------------------------------------------------------ API */

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, { body, params } = {}) {
  let url = `/api${path}`;
  if (params && Object.keys(params).length) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    if (qs) url += `?${qs}`;
  }
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const tenantId = getTenantId();
  if (tenantId) headers['X-Company-Id'] = tenantId;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError('No se pudo conectar con el servidor. Verifique que la API esté en ejecución.', 0, 'NetworkError');
  }
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    if (!response.ok) throw new ApiError(text || `Error HTTP ${response.status}`, response.status, 'HttpError');
    return text;
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/login')) {
      clearSession();
      if (location.hash !== '#/login') location.hash = '#/login';
    }
    throw new ApiError(data.message || `Error HTTP ${response.status}`, response.status, data.error);
  }
  return data;
}

export const apiGet = (path, params) => request('GET', path, { params });
export const apiPost = (path, body, params) => request('POST', path, { body, params });
export const apiPut = (path, body) => request('PUT', path, { body });
export const apiDelete = (path) => request('DELETE', path);

/** Descarga un recurso binario autenticado (PDF/XML/CSV). */
export async function download(path, fallbackName = 'archivo') {
  const token = getToken();
  const tenantId = getTenantId();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (tenantId) headers['X-Company-Id'] = tenantId;
  const response = await fetch(`/api${path}`, { headers });
  if (!response.ok) {
    let message = `No se pudo descargar (HTTP ${response.status})`;
    try {
      const data = await response.json();
      message = data.message || message;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, response.status, 'DownloadError');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const filename = match ? match[1] : fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}

/* -------------------------------------------------------------- formato */

export function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const moneyFormatter = new Intl.NumberFormat('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(centsValue, symbol = true) {
  const value = Number(centsValue || 0) / 100;
  return `${symbol ? '$ ' : ''}${moneyFormatter.format(value)}`;
}

export function centsFromInput(value) {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value).replace(/,/g, '').trim();
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

export function decimalFromCents(centsValue) {
  return (Number(centsValue || 0) / 100).toFixed(2);
}

export function fmtQty(value, digits = 2) {
  const number = Number(value || 0);
  return number.toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('es-EC', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function todayInput() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60000).toISOString().slice(0, 10);
}

export const STATUS = {
  draft: { label: 'Borrador', tone: 'gray' },
  sent: { label: 'Enviado al SRI', tone: 'blue' },
  issued: { label: 'Autorizado', tone: 'green' },
  failed: { label: 'Rechazado', tone: 'red' },
  canceled: { label: 'Anulado', tone: 'amber' },
  offline: { label: 'Offline', tone: 'amber' },
  applied: { label: 'Aplicado', tone: 'green' },
  active: { label: 'Activo', tone: 'green' },
  inactive: { label: 'Inactivo', tone: 'gray' },
};

export function statusBadge(status) {
  const meta = STATUS[status] || { label: status, tone: 'gray' };
  return `<span class="badge ${meta.tone}">${esc(meta.label)}</span>`;
}

export const DOC_TYPES = {
  '01': 'Factura',
  '02': 'Nota de venta',
  '03': 'Liquidación de compra',
  '04': 'Nota de Crédito',
  '05': 'Nota de Débito',
  '06': 'Guía de Remisión',
  '07': 'Comprobante de Retención',
  '11': 'Ticket de Aéreo',
};

export function docTypeName(code) {
  return DOC_TYPES[code] || code;
}

/* ----------------------------------------------------------- UI: toasts */

export function toast(message, type = 'ok') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'err' : type}`;
  node.textContent = message;
  container.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .25s';
    setTimeout(() => node.remove(), 260);
  }, 4200);
}

export function toastError(error) {
  toast(error && error.message ? error.message : String(error), 'error');
}

/* ------------------------------------------------------------ UI: modal */

let activeModal = null;

export function closeModal() {
  if (activeModal) {
    activeModal.remove();
    activeModal = null;
  }
}

/**
 * Abre un modal.
 * @param {{title?: string, body: string, size?: 'sm'|'lg', actions?: {label: string, className?: string, onClick?: (modal: HTMLElement) => void}[]}} options
 */
export function modal({ title = '', body = '', size = '', actions = [] }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${size}">
      ${title ? `<div class="modal-head"><h3>${esc(title)}</h3><button class="btn ghost" data-close>✕</button></div>` : ''}
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-foot"></div>` : ''}
    </div>`;
  const modalEl = backdrop.querySelector('.modal');
  const foot = backdrop.querySelector('.modal-foot');
  if (foot) {
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = `btn ${action.className || ''}`;
      button.textContent = action.label;
      button.addEventListener('click', () => {
        if (action.onClick) action.onClick(modalEl);
        else closeModal();
      });
      foot.appendChild(button);
    }
  }
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || event.target.hasAttribute('data-close')) closeModal();
  });
  // Evita que presionar Enter en un campo recargue la página y pierda el formulario.
  modalEl.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', (event) => event.preventDefault());
  });
  document.getElementById('modal-root').appendChild(backdrop);
  activeModal = backdrop;
  return modalEl;
}

export function confirmDialog(message, { title = 'Confirmar', okLabel = 'Confirmar', danger = true } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: `<p style="margin:0">${esc(message)}</p>`,
      size: 'sm',
      actions: [
        { label: 'Cancelar', className: '', onClick: () => { closeModal(); resolve(false); } },
        {
          label: okLabel,
          className: danger ? 'danger' : 'primary',
          onClick: () => {
            closeModal();
            resolve(true);
          },
        },
      ],
    });
  });
}

/* -------------------------------------------------------------- UI: table */

/**
 * Renderiza una tabla.
 * columns: [{ key, label, align='left', render?(row) => html, className? }]
 */
export function renderTable(container, { columns, rows, empty = 'Sin registros', loading = false }) {
  if (loading) {
    container.innerHTML = `<div class="loading"><span class="spinner"></span> Cargando…</div>`;
    return;
  }
  if (!rows || rows.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="icon">📄</div>${esc(empty)}</div>`;
    return;
  }
  const head = columns.map((column) => `<th class="${column.align || ''}">${esc(column.label)}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = columns
        .map((column) => {
          const value = column.render ? column.render(row) : esc(row[column.key] ?? '');
          return `<td class="${column.align || ''} ${column.className || ''}">${value}</td>`;
        })
        .join('');
      return `<tr data-id="${esc(row.id || '')}">${cells}</tr>`;
    })
    .join('');
  container.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ------------------------------------------------------------ UI: helpers */

export function pageHead(title, subtitle, actionsHtml = '') {
  return `
    <div class="page-head">
      <div>
        <h1>${esc(title)}</h1>
        ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
      </div>
      ${actionsHtml ? `<div class="page-actions">${actionsHtml}</div>` : ''}
    </div>`;
}

export function field(label, inputHtml, { full = false, help = '' } = {}) {
  return `<div class="field ${full ? 'full' : ''}"><label>${esc(label)}</label>${inputHtml}${help ? `<div class="help">${esc(help)}</div>` : ''}</div>`;
}

export function readForm(scope) {
  const data = {};
  scope.querySelectorAll('[name]').forEach((input) => {
    if (input.type === 'checkbox') data[input.name] = input.checked;
    else data[input.name] = input.value;
  });
  return data;
}

export function option(value, label, selected, extra = '') {
  return `<option value="${esc(value)}" ${String(selected) === String(value) ? 'selected' : ''} ${extra}>${esc(label)}</option>`;
}

export function spinnerHtml(label = 'Cargando…') {
  return `<div class="loading"><span class="spinner"></span> ${esc(label)}</div>`;
}

export function debounce(fn, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado al portapapeles');
  } catch {
    toast('No se pudo copiar', 'warn');
  }
}

/** Convierte un objeto de filtros en query params (omite vacíos). */
export function paramsOf(filters) {
  const out = {};
  for (const [key, value] of Object.entries(filters || {})) {
    if (value !== '' && value !== null && value !== undefined) out[key] = value;
  }
  return out;
}


