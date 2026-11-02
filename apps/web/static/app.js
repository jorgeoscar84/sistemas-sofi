/**
 * Shell de la aplicación: login, layout, router hash y carga de módulos de página.
 * Multiempresa: el superadministrador elige la empresa activa; cada empresa ve
 * únicamente su propio panel.
 */

import {
  apiGet,
  apiPost,
  clearSession,
  closeModal,
  esc,
  field,
  getTenantId,
  getToken,
  getUser,
  modal,
  readForm,
  setTenantId,
  setToken,
  setUser,
  toast,
  toastError,
} from './lib.js';

const TENANT_NAV_GROUPS = [
  {
    title: 'General',
    items: [{ path: '/', label: 'Inicio', icon: '◧' }],
  },
  {
    title: 'Facturación',
    items: [
      { path: '/invoicing', label: 'Comprobantes', icon: '▤' },
      { path: '/invoicing/new', label: 'Nueva factura', icon: '＋' },
      { path: '/quick-billing', label: 'Facturación rápida', icon: '⚡' },
      { path: '/pos', label: 'Punto de venta', icon: '🛒' },
      { path: '/waybills', label: 'Guías de remisión', icon: '🚚' },
      { path: '/retentions', label: 'Retenciones', icon: '📌' },
    ],
  },
  {
    title: 'Catálogo',
    items: [
      { path: '/products', label: 'Productos', icon: '▦' },
      { path: '/services', label: 'Servicios', icon: '◇' },
      { path: '/categories', label: 'Categorías', icon: '❏' },
      { path: '/units', label: 'Unidades de medida', icon: '⚖' },
    ],
  },
  {
    title: 'Inventario',
    items: [
      { path: '/inventory/stocks', label: 'Stock', icon: '▣' },
      { path: '/inventory/movements', label: 'Comprobantes de stock', icon: '⇄' },
      { path: '/inventory/kardex', label: 'Kardex', icon: '📈' },
      { path: '/inventory/warehouses', label: 'Bodegas', icon: '⌂' },
    ],
  },
  {
    title: 'Personas',
    items: [{ path: '/clients', label: 'Clientes', icon: '👥' }],
  },
  {
    title: 'Administración',
    items: [
      { path: '/admin/users', label: 'Usuarios y roles', icon: '👤' },
      { path: '/admin/company', label: 'Empresa y SRI', icon: '⚙' },
      { path: '/admin/integration', label: 'Integraciones', icon: '🔌' },
    ],
  },
];

const PLATFORM_NAV_GROUPS = [
  {
    title: 'Plataforma',
    items: [
      { path: '/platform', label: 'Licencias y empresas', icon: '🏢' },
    ],
  },
];

/** Rutas: patrón + módulo (import dinámico). El módulo exporta `render(root, ctx)`. */
const ROUTES = [
  { pattern: '/platform', load: () => import('./pages/platform.js') },
  { pattern: '/', load: () => import('./pages/dashboard.js') },
  { pattern: '/invoicing', load: () => import('./pages/invoicing.js') },
  { pattern: '/invoicing/new', load: () => import('./pages/invoicing.js') },
  { pattern: '/invoicing/notes/new', load: () => import('./pages/invoicing.js') },
  { pattern: '/invoicing/:id', load: () => import('./pages/invoicing.js') },
  { pattern: '/waybills', load: () => import('./pages/waybills.js') },
  { pattern: '/waybills/new', load: () => import('./pages/waybills.js') },
  { pattern: '/waybills/:id', load: () => import('./pages/waybills.js') },
  { pattern: '/retentions', load: () => import('./pages/retentions.js') },
  { pattern: '/retentions/new', load: () => import('./pages/retentions.js') },
  { pattern: '/retentions/:id', load: () => import('./pages/retentions.js') },
  { pattern: '/quick-billing', load: () => import('./pages/quick.js') },
  { pattern: '/pos', load: () => import('./pages/pos.js') },
  { pattern: '/clients', load: () => import('./pages/clients.js') },
  { pattern: '/products', load: () => import('./pages/catalog.js') },
  { pattern: '/products/new', load: () => import('./pages/catalog.js') },
  { pattern: '/products/:id/edit', load: () => import('./pages/catalog.js') },
  { pattern: '/services', load: () => import('./pages/catalog.js') },
  { pattern: '/services/new', load: () => import('./pages/catalog.js') },
  { pattern: '/services/:id/edit', load: () => import('./pages/catalog.js') },
  { pattern: '/categories', load: () => import('./pages/catalog.js') },
  { pattern: '/units', load: () => import('./pages/catalog.js') },
  { pattern: '/inventory/stocks', load: () => import('./pages/inventory.js') },
  { pattern: '/inventory/movements', load: () => import('./pages/inventory.js') },
  { pattern: '/inventory/movements/new', load: () => import('./pages/inventory.js') },
  { pattern: '/inventory/adjust', load: () => import('./pages/inventory.js') },
  { pattern: '/inventory/kardex', load: () => import('./pages/inventory.js') },
  { pattern: '/inventory/warehouses', load: () => import('./pages/inventory.js') },
  { pattern: '/admin/users', load: () => import('./pages/admin.js') },
  { pattern: '/admin/users/new', load: () => import('./pages/admin.js') },
  { pattern: '/admin/users/:id/edit', load: () => import('./pages/admin.js') },
  { pattern: '/admin/company', load: () => import('./pages/admin.js') },
  { pattern: '/admin/integration', load: () => import('./pages/admin.js') },
];

const state = {
  user: null,
  company: null,
  companyConfig: null,
  license: null,
  companies: [],
  isSuperadmin: false,
};

function activeTenantId() {
  return getTenantId();
}

/* ------------------------------------------------------------------ login */

function renderLogin(message = '') {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap">
      <section class="login-hero">
        <div class="login-brand" style="color:#fff;font-size:20px">
          <span class="mark">FE</span><span>Facturación Electrónica EC</span>
        </div>
        <h1>Una plataforma, todas tus empresas.</h1>
        <p>Comprobantes electrónicos autorizados, catálogo, Kardex y administración de usuarios. Cada empresa opera con su RUC y su información completamente aislada.</p>
        <ul>
          <li><span class="dot">1</span><span>Multiempresa: licencias liberadas por el superadministrador.</span></li>
          <li><span class="dot">2</span><span>Factura, notas de crédito/débito, guías de remisión y retenciones.</span></li>
          <li><span class="dot">3</span><span>Firma electrónica XAdES e integración directa con el SRI.</span></li>
          <li><span class="dot">4</span><span>Usuarios con roles: administrador, facturador, inventario y contador.</span></li>
        </ul>
      </section>
      <section class="login-side">
        <div class="login-card">
          <div class="login-brand"><span class="mark">FE</span><span>Facturación EC</span></div>
          <h2>Bienvenido de nuevo</h2>
          <div class="sub">Ingresa para emitir y administrar tus comprobantes electrónicos.</div>
          ${message ? `<div class="login-error">${esc(message)}</div>` : ''}
          <form id="login-form">
            <div class="field" style="margin-bottom:14px">
              <label>Usuario</label>
              <input name="username" type="text" autocomplete="username" placeholder="usuario" required />
            </div>
            <div class="field" style="margin-bottom:20px">
              <label>Contraseña</label>
              <input name="password" type="password" autocomplete="current-password" placeholder="contraseña" required />
            </div>
            <button class="btn primary block lg" type="submit">Iniciar sesión</button>
          </form>
          <div class="hint">
            Acceso inicial de la plataforma: usuario <b>superadmin</b>.<br />
            La contraseña inicial la define el administrador del sistema (variable
            <span class="mono">SUPERADMIN_PASSWORD</span>). Cámbiela después del primer ingreso.
          </div>
        </div>
      </section>
    </div>`;

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    button.textContent = 'Ingresando…';
    try {
      const data = await apiPost('/auth/login', {
        username: form.username.value.trim(),
        password: form.password.value,
      });
      setToken(data.token);
      setUser(data.user);
      setTenantId('');
      state.user = data.user;
      location.hash = data.user.isSuperadmin ? '#/platform' : '#/';
      await boot();
    } catch (error) {
      renderLogin(error.message);
    }
  });
}

/* ------------------------------------------------------------- navegación */

function parseRoute(hash) {
  const clean = (hash || '').replace(/^#/, '') || '/';
  const [path, queryString] = clean.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString || ''));
  for (const route of ROUTES) {
    const patternParts = route.pattern.split('/');
    const pathParts = path.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i++) {
      const pattern = patternParts[i];
      if (pattern.startsWith(':')) params[pattern.slice(1)] = decodeURIComponent(pathParts[i]);
      else if (pattern !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, path, params, query };
  }
  return { route: null, path, params: {}, query };
}

export function navigate(path) {
  location.hash = `#${path}`;
}

function sidebarHtml() {
  const platformMode = state.isSuperadmin && !activeTenantId();
  const groups = platformMode ? PLATFORM_NAV_GROUPS : TENANT_NAV_GROUPS;
  const extra = state.isSuperadmin && !platformMode
    ? `<div class="nav-group-title">Plataforma</div>
       <a class="nav-item" href="#/platform"><span class="ico">🏢</span><span>Licencias y empresas</span></a>`
    : '';
  return (
    groups
      .map(
        (group) => `
      <div class="nav-group-title">${esc(group.title)}</div>
      ${group.items
        .map(
          (item) =>
            `<a class="nav-item" data-path="${esc(item.path)}" href="#${esc(item.path)}">
               <span class="ico">${item.icon}</span><span>${esc(item.label)}</span>
             </a>`,
        )
        .join('')}`,
      )
      .join('') + extra
  );
}

function tenantSelectorHtml() {
  if (!state.isSuperadmin) return '';
  const current = activeTenantId();
  const options = [
    `<option value="" ${current ? '' : 'selected'}>— Plataforma (licencias) —</option>`,
    ...state.companies.map(
      (company) =>
        `<option value="${esc(company.id)}" ${company.id === current ? 'selected' : ''}>${esc(company.name)} · ${esc(company.ruc)} · ${esc(company.licenseLabel)}</option>`,
    ),
  ];
  return `<select class="tenant-select" id="tenant-select" title="Empresa activa">${options.join('')}</select>`;
}

function renderLayout() {
  const user = state.user || getUser() || { name: 'Usuario', role: 'admin', roleLabel: 'Administrador' };
  const initials = (user.name || 'U')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const tenant = activeTenantId();
  const companyName = state.company?.name || (state.isSuperadmin && !tenant ? 'Plataforma' : 'Sin empresa');
  const license = state.license;
  const licenseBadge =
    license && tenant
      ? `<span class="badge ${license.status === 'active' ? 'green' : license.status === 'trial' ? 'amber' : 'red'}">${esc(license.statusLabel)}${license.daysLeft !== null ? ` · ${license.daysLeft} días` : ''}</span>`
      : '';
  document.getElementById('app').innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand"><span class="mark">FE</span><span>Facturación EC</span></div>
        ${state.isSuperadmin ? `<div class="tenant-box">${tenantSelectorHtml()}</div>` : ''}
        <nav class="nav">${sidebarHtml()}</nav>
        <div class="sidebar-footer">
          ${state.isSuperadmin ? 'Superadministrador de la plataforma' : esc(companyName)}<br />SRI · Pruebas y producción
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="title">
            ${esc(state.isSuperadmin && !tenant ? 'Panel de plataforma' : 'Panel de facturación')}
            <span class="muted small" style="font-weight:500;margin-left:8px">${esc(companyName)}</span>
            ${licenseBadge}
            <span class="env-pill" id="env-pill" style="display:none"></span>
          </div>
          <div class="user-menu">
            <div class="avatar">${esc(initials)}</div>
            <div class="user-meta"><div class="name">${esc(user.name)}</div><div class="role">${esc(user.roleLabel || user.role)}</div></div>
            <div class="user-drop" id="user-drop">
              <button class="btn ghost block" id="change-password-btn">Cambiar contraseña</button>
              <button class="btn ghost block" id="logout-btn">Cerrar sesión</button>
            </div>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>`;

  const selector = document.getElementById('tenant-select');
  if (selector) {
    selector.addEventListener('change', () => {
      setTenantId(selector.value);
      location.hash = selector.value ? '#/' : '#/platform';
      location.reload();
    });
  }
  document.querySelector('.user-menu').addEventListener('click', (event) => {
    if (event.target.closest('#logout-btn') || event.target.closest('#change-password-btn')) return;
    document.getElementById('user-drop').classList.toggle('open');
  });
  document.getElementById('change-password-btn').addEventListener('click', (event) => {
    event.stopPropagation();
    document.getElementById('user-drop').classList.remove('open');
    openChangePassword();
  });
  document.getElementById('logout-btn').addEventListener('click', () => {
    clearSession();
    state.user = null;
    setTenantId('');
    location.hash = '#/login';
    renderLogin();
  });
}

/** Modal para que cualquier usuario cambie su propia contraseña. */
function openChangePassword() {
  modal({
    title: 'Cambiar contraseña',
    size: 'sm',
    body: `
      <form id="change-password-form">
        ${field('Contraseña actual', '<input name="currentPassword" type="password" autocomplete="current-password" required />')}
        ${field('Nueva contraseña', '<input name="newPassword" type="password" autocomplete="new-password" minlength="6" required />', { help: 'Mínimo 6 caracteres' })}
        ${field('Confirmar nueva contraseña', '<input name="confirmPassword" type="password" autocomplete="new-password" minlength="6" required />')}
      </form>`,
    actions: [
      { label: 'Cancelar', className: 'ghost', onClick: () => closeModal() },
      {
        label: 'Guardar contraseña',
        className: 'primary',
        onClick: async () => {
          const values = readForm(document.getElementById('change-password-form'));
          if (!values.newPassword || values.newPassword !== values.confirmPassword) {
            toast('Las contraseñas nuevas no coinciden', 'warn');
            return;
          }
          try {
            await apiPost('/auth/change-password', {
              currentPassword: values.currentPassword,
              newPassword: values.newPassword,
            });
            closeModal();
            toast('Contraseña actualizada correctamente');
          } catch (error) {
            toastError(error);
          }
        },
      },
    ],
  });
}

function markActiveNav(path) {
  const best = [...document.querySelectorAll('.nav-item')]
    .map((item) => item.dataset.path)
    .filter((candidate) => (candidate === '/' ? path === '/' : path.startsWith(candidate)))
    .sort((a, b) => b.length - a.length)[0];
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.path === best);
  });
}

let renderToken = 0;

async function renderRoute() {
  for (const backdrop of document.querySelectorAll('.modal-backdrop')) backdrop.remove();
  const parsed = parseRoute(location.hash);
  if (!parsed.route) {
    const content = document.getElementById('content');
    if (content) {
      content.innerHTML = `<div class="card"><h3>Página no encontrada</h3><p class="muted">La ruta <code>${esc(parsed.path)}</code> no existe.</p><a class="btn" href="#/">Volver al inicio</a></div>`;
    }
    return;
  }
  const content = document.getElementById('content');
  if (!content) return;
  markActiveNav(parsed.path);
  const token = ++renderToken;
  content.innerHTML = `<div class="loading"><span class="spinner"></span> Cargando…</div>`;
  try {
    const module = await parsed.route.load();
    if (token !== renderToken) return;
    content.innerHTML = '';
    await module.render(content, {
      path: parsed.path,
      params: parsed.params,
      query: parsed.query,
      user: state.user,
      company: state.company,
      license: state.license,
      isSuperadmin: state.isSuperadmin,
      navigate,
      refresh: renderRoute,
      reload: boot,
    });
  } catch (error) {
    console.error(error);
    if (token !== renderToken) return;
    content.innerHTML = `<div class="card"><h3>No se pudo cargar la pantalla</h3><p class="muted">${esc(error.message || error)}</p><button class="btn" onclick="location.reload()">Recargar</button></div>`;
    toastError(error);
  }
  if (token === renderToken) window.scrollTo({ top: 0 });
}

/* ------------------------------------------------------------------- boot */

async function loadContext() {
  try {
    const me = await apiGet('/auth/me');
    state.user = me.user;
    state.company = me.company;
    state.license = me.license;
    state.companies = Array.isArray(me.companies) ? me.companies : [];
    state.isSuperadmin = Boolean(me.isSuperadmin);
    setUser(me.user);
  } catch {
    clearSession();
    return false;
  }
  const tenant = activeTenantId();
  if (state.isSuperadmin && tenant && !state.companies.some((company) => company.id === tenant)) {
    setTenantId('');
  }
  const effectiveTenant = activeTenantId();
  if (effectiveTenant || !state.isSuperadmin) {
    try {
      state.companyConfig = await apiGet('/company');
    } catch {
      state.companyConfig = null;
    }
  } else {
    state.companyConfig = null;
  }
  return true;
}

async function boot() {
  let hash = location.hash || '#/';
  if (!getToken()) {
    if (hash !== '#/login') history.replaceState(null, '', '#/login');
    renderLogin();
    return;
  }
  const ok = await loadContext();
  if (!ok) {
    renderLogin('La sesión expiró. Ingrese nuevamente.');
    return;
  }
  // Redirecciones según el tipo de usuario.
  if (state.isSuperadmin && !activeTenantId() && !hash.startsWith('#/platform')) {
    location.hash = '#/platform';
    hash = '#/platform';
  }
  if (!state.isSuperadmin && hash.startsWith('#/platform')) {
    location.hash = '#/';
    hash = '#/';
  }
  renderLayout();
  const pill = document.getElementById('env-pill');
  if (pill && state.companyConfig) {
    const modeLabel = { mock: 'Simulado', 'direct-sri': 'SRI directo', upconta: 'UpConta' }[state.companyConfig.sriMode] ||
      state.companyConfig.sriMode;
    pill.textContent = `SRI · ${state.companyConfig.environment === 2 ? 'Producción' : 'Pruebas'} · ${modeLabel}`;
    pill.className = `env-pill ${state.companyConfig.environment === 2 ? 'badge red' : ''}`;
    pill.style.display = '';
  }
  await renderRoute();
}

window.addEventListener('hashchange', async () => {
  if (!getToken()) {
    renderLogin();
    return;
  }
  if (!document.getElementById('content')) {
    await boot();
    return;
  }
  await renderRoute();
});

window.addEventListener('error', (event) => {
  if (event.error && event.error.message) toastError(event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && event.reason.message) toastError(event.reason);
});

boot();
