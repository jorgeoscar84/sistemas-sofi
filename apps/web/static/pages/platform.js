/** Plataforma (superadministrador): licencias, empresas y sus administradores. */

import {
  apiGet,
  apiPost,
  apiPut,
  closeModal,
  confirmDialog,
  copyText,
  esc,
  field,
  fmtDate,
  modal,
  money,
  option,
  pageHead,
  readForm,
  setTenantId,
  spinnerHtml,
  toast,
  toastError,
} from '../lib.js';

function statusBadge(company) {
  const classes = { active: 'green', trial: 'amber', suspended: 'red', expired: 'red' };
  return `<span class="badge ${classes[company.status] || 'gray'}">${esc(company.statusLabel || company.status)}</span>`;
}

function planLabel(plan) {
  return { basico: 'Básico', profesional: 'Profesional', empresarial: 'Empresarial' }[plan] || plan;
}

export async function render(root, ctx) {
  root.innerHTML = spinnerHtml('Cargando licencias y empresas…');
  let overview;
  let companies;
  try {
    [overview, companies] = await Promise.all([apiGet('/platform/overview'), apiGet('/platform/companies')]);
  } catch (error) {
    root.innerHTML = `<div class="card"><h3>No se pudo cargar la plataforma</h3><p class="muted">${esc(error.message)}</p></div>`;
    return;
  }

  root.innerHTML = `
    ${pageHead(
      'Plataforma · Licencias y empresas',
      'Cree empresas, libere licencias y entre a configurar cualquier empresa. Cada empresa tiene su base de datos aislada.',
      '<button class="btn primary" id="new-company">＋ Nueva empresa / licencia</button>',
    )}
    <div class="grid cols-4">
      <div class="card stat"><div class="muted small">Empresas</div><div class="stat-value">${overview.totalCompanies}</div><div class="small muted">${overview.byStatus.active} activas · ${overview.byStatus.trial} en prueba</div></div>
      <div class="card stat"><div class="muted small">Usuarios</div><div class="stat-value">${overview.users}</div><div class="small muted">de todas las empresas</div></div>
      <div class="card stat"><div class="muted small">Comprobantes emitidos</div><div class="stat-value">${overview.vouchers}</div><div class="small muted">${overview.issued} autorizados</div></div>
      <div class="card stat"><div class="muted small">Suspensas / vencidas</div><div class="stat-value">${overview.byStatus.suspended + overview.byStatus.expired}</div><div class="small muted">${overview.products} productos en total</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Empresas y licencias</h3><span class="muted small">${companies.length} empresa(s)</span></div>
      <div class="table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Empresa</th><th>Licencia</th><th>Configuración SRI</th><th>Uso</th><th>Acciones</th>
          </tr></thead>
          <tbody>
            ${companies
              .map(
                (company) => `
              <tr>
                <td>
                  <div><b>${esc(company.name)}</b></div>
                  <div class="small muted">RUC ${esc(company.ruc)}${company.tradeName ? ` · ${esc(company.tradeName)}` : ''}</div>
                  <div class="small muted">${esc(company.email || 'sin correo')}</div>
                </td>
                <td>
                  ${statusBadge(company)}
                  <div class="small muted">Plan ${esc(planLabel(company.plan))}</div>
                  <div class="small muted">${company.expiresAt ? `Vence ${esc(fmtDate(company.expiresAt))}` : 'Sin vencimiento'}</div>
                </td>
                <td class="small">
                  ${company.config
                    ? `<div>${esc(company.config.sriMode === 'direct-sri' ? 'SRI directo' : company.config.sriMode === 'upconta' ? 'UpConta' : 'Simulado')} · ${company.config.environment === 2 ? 'Producción' : 'Pruebas'}</div>
                       <div class="muted">${company.config.hasSignature ? 'Certificado cargado' : 'Sin certificado'} · firma ${esc((company.config.signatureDigest || 'sha1').toUpperCase())}</div>`
                    : '<span class="muted">Sin configuración</span>'}
                </td>
                <td class="small">
                  <div>${company.metrics.users} usuario(s)</div>
                  <div class="muted">${company.metrics.vouchers} comprobante(s) · ${company.metrics.products} producto(s)</div>
                  <div class="muted">${company.metrics.lastVoucherDate ? `Último: ${esc(fmtDate(company.metrics.lastVoucherDate))}` : 'Sin emisiones'}</div>
                </td>
                <td>
                  <div class="inline" style="flex-wrap:wrap;gap:6px">
                    <button class="btn sm primary" data-action="configure" data-id="${esc(company.id)}">Configurar</button>
                    <button class="btn sm" data-action="activate" data-id="${esc(company.id)}">${company.status === 'active' ? 'Renovar' : 'Activar'}</button>
                    <button class="btn sm" data-action="users" data-id="${esc(company.id)}">Administradores</button>
                    <button class="btn sm" data-action="license" data-id="${esc(company.id)}">Editar licencia</button>
                    ${company.status === 'suspended'
                      ? ''
                      : `<button class="btn sm danger" data-action="suspend" data-id="${esc(company.id)}">Suspender</button>`}
                  </div>
                </td>
              </tr>`,
              )
              .join('') ||
              '<tr><td colspan="5" class="center muted" style="padding:24px">Aún no hay empresas. Cree la primera licencia.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>Cómo funciona</h3>
      <p class="muted small" style="margin:0">
        Cada empresa creada aquí tiene <b>su propia base de datos</b> (aislada) y un <b>usuario administrador</b>.
        El superadministrador puede entrar a configurarla, pero los usuarios de una empresa nunca ven los datos de otra.
        Para liberar una licencia automáticamente desde un pago, use el endpoint <span class="mono">POST /api/platform/companies/:id/activate</span>
        (o el botón “Activar” con la referencia de pago).
      </p>
    </div>`;

  document.getElementById('new-company').addEventListener('click', () => openCreateCompany(root, ctx));
  root.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const company = companies.find((item) => item.id === button.dataset.id);
      if (!company) return;
      const action = button.dataset.action;
      if (action === 'configure') {
        setTenantId(company.id);
        toast(`Configurando ${company.name}`);
        location.hash = '#/admin/company';
        location.reload();
      } else if (action === 'activate') {
        openActivate(company, root, ctx);
      } else if (action === 'suspend') {
        const confirmed = await confirmDialog(
          `¿Suspender la licencia de ${company.name}? Los usuarios de la empresa no podrán ingresar hasta que se reactive.`,
          { title: 'Suspender licencia', okLabel: 'Suspender' },
        );
        if (!confirmed) return;
        try {
          await apiPut(`/platform/companies/${company.id}/license`, { status: 'suspended' });
          toast('Licencia suspendida');
          await ctx.reload ? ctx.reload() : location.reload();
        } catch (error) {
          toastError(error);
        }
      } else if (action === 'license') {
        openEditLicense(company, root, ctx);
      } else if (action === 'users') {
        openAdmins(company);
      }
    });
  });
}

function openCreateCompany(root, ctx) {
  modal({
    title: 'Nueva empresa / licencia',
    size: 'lg',
    body: `
      <form id="company-form">
        <h4>Datos de la empresa</h4>
        <div class="form-grid">
          ${field('RUC', '<input name="ruc" maxlength="13" placeholder="13 dígitos" required />')}
          ${field('Razón social', '<input name="name" placeholder="EMPRESA S.A." required />')}
          ${field('Nombre comercial', '<input name="tradeName" placeholder="Opcional" />')}
          ${field('Correo', '<input name="email" type="email" placeholder="facturacion@empresa.ec" />')}
          ${field('Teléfono', '<input name="phone" placeholder="Opcional" />')}
          ${field('Dirección', '<input name="address" placeholder="Matriz" />')}
        </div>
        <h4 class="mt-16">Administrador de la empresa</h4>
        <div class="form-grid">
          ${field('Nombre', '<input name="adminName" value="Administrador" required />')}
          ${field('Usuario', '<input name="adminUsername" placeholder="admin_empresa" required />')}
          ${field('Contraseña', '<input name="adminPassword" type="password" minlength="6" required />')}
          ${field('Correo del administrador', '<input name="adminEmail" type="email" placeholder="Opcional" />')}
        </div>
        <h4 class="mt-16">Licencia</h4>
        <div class="form-grid">
          ${field('Plan', `<select name="plan">${option('basico', 'Básico', 'basico')}${option('profesional', 'Profesional', 'basico')}${option('empresarial', 'Empresarial', 'basico')}</select>`)}
          ${field('Tipo de licencia', `<select name="licenseStatus">${option('trial', 'Prueba', 'trial')}${option('active', 'Activa', 'trial')}</select>`)}
          ${field('Días de vigencia', '<input name="trialDays" type="number" min="1" value="15" />', { help: 'Para pruebas o primera activación' })}
          ${field('Referencia de pago', '<input name="paymentReference" placeholder="Opcional (factura, transferencia…)" />')}
        </div>
      </form>`,
    actions: [
      { label: 'Cancelar', className: 'ghost', onClick: () => closeModal() },
      {
        label: 'Crear empresa y licencia',
        className: 'primary',
        onClick: async () => {
          const form = document.getElementById('company-form');
          const values = readForm(form);
          try {
            const result = await apiPost('/platform/companies', values);
            closeModal();
            modal({
              title: 'Empresa creada correctamente',
              body: `
                <p>La empresa <b>${esc(result.company.name)}</b> (RUC ${esc(result.company.ruc)}) ya tiene su licencia
                <b>${esc(result.company.statusLabel)}</b> y su base de datos aislada.</p>
                <div class="card" style="margin:12px 0">
                  <div class="small muted">Credenciales del administrador (guárdelas y entréguelas al cliente):</div>
                  <p class="mono" style="font-size:14px;margin:8px 0">
                    Usuario: <b>${esc(result.admin.username)}</b><br />
                    Contraseña: <b>${esc(result.admin.password)}</b>
                  </p>
                  <button class="btn sm" id="copy-creds">Copiar credenciales</button>
                </div>
                <p class="muted small">Puede entrar a configurarla ahora mismo (empresa, certificado, SRI) o dejarla lista para que el cliente la configure.</p>`,
              actions: [
                { label: 'Cerrar', className: 'ghost', onClick: () => closeModal() },
                {
                  label: 'Configurar esta empresa',
                  className: 'primary',
                  onClick: () => {
                    closeModal();
                    setTenantId(result.company.id);
                    location.hash = '#/admin/company';
                    location.reload();
                  },
                },
              ],
            });
            document.getElementById('copy-creds')?.addEventListener('click', () =>
              copyText(`Usuario: ${result.admin.username}\nContraseña: ${result.admin.password}\nRUC: ${result.company.ruc}`),
            );
            void root;
            void ctx;
          } catch (error) {
            toastError(error);
          }
        },
      },
    ],
  });
}

function openActivate(company, root, ctx) {
  modal({
    title: `Liberar / renovar licencia · ${company.name}`,
    body: `
      <p class="muted small">La activación extiende la licencia y deja a la empresa operativa de inmediato.</p>
      <form id="activate-form">
        <div class="form-grid">
          ${field('Meses a liberar', '<input name="months" type="number" min="1" value="12" />')}
          ${field('Referencia de pago', '<input name="paymentReference" placeholder="Nro. de factura o transferencia" />')}
        </div>
      </form>`,
    actions: [
      { label: 'Cancelar', className: 'ghost', onClick: () => closeModal() },
      {
        label: 'Activar licencia',
        className: 'primary',
        onClick: async () => {
          const values = readForm(document.getElementById('activate-form'));
          try {
            await apiPost(`/platform/companies/${company.id}/activate`, {
              months: Number(values.months),
              paymentReference: values.paymentReference,
            });
            closeModal();
            toast('Licencia activada');
            await (ctx.reload ? ctx.reload() : location.reload());
            void root;
          } catch (error) {
            toastError(error);
          }
        },
      },
    ],
  });
}

function openEditLicense(company, root, ctx) {
  modal({
    title: `Editar licencia · ${company.name}`,
    body: `
      <form id="license-form">
        <div class="form-grid">
          ${field('Estado', `<select name="status">
            ${option('active', 'Activa', company.status === 'active' ? 'active' : '')}
            ${option('trial', 'Prueba', company.status === 'trial' ? 'trial' : '')}
            ${option('suspended', 'Suspendida', company.status === 'suspended' ? 'suspended' : '')}
            ${option('expired', 'Vencida', company.status === 'expired' ? 'expired' : '')}
          </select>`)}
          ${field('Plan', `<select name="plan">
            ${option('basico', 'Básico', company.plan)}
            ${option('profesional', 'Profesional', company.plan)}
            ${option('empresarial', 'Empresarial', company.plan)}
          </select>`)}
          ${field('Vence el', `<input name="expiresAt" type="date" value="${company.expiresAt ? esc(String(company.expiresAt).slice(0, 10)) : ''}" />`)}
          ${field('Referencia de pago', `<input name="paymentReference" value="${esc(company.paymentReference || '')}" />`)}
          ${field('Notas', `<textarea name="notes" rows="2">${esc(company.notes || '')}</textarea>`, { full: true })}
        </div>
      </form>`,
    actions: [
      { label: 'Cancelar', className: 'ghost', onClick: () => closeModal() },
      {
        label: 'Guardar licencia',
        className: 'primary',
        onClick: async () => {
          const values = readForm(document.getElementById('license-form'));
          try {
            await apiPut(`/platform/companies/${company.id}/license`, {
              status: values.status,
              plan: values.plan,
              expiresAt: values.expiresAt || null,
              notes: values.notes,
              paymentReference: values.paymentReference,
            });
            closeModal();
            toast('Licencia actualizada');
            await (ctx.reload ? ctx.reload() : location.reload());
            void root;
          } catch (error) {
            toastError(error);
          }
        },
      },
    ],
  });
}

async function openAdmins(company) {
  let detail;
  try {
    detail = await apiGet(`/platform/companies/${company.id}`);
  } catch (error) {
    toastError(error);
    return;
  }
  const rows = (detail.users || [])
    .map(
      (user) => `<tr>
        <td class="mono small">${esc(user.username)}</td>
        <td>${esc(user.name)}</td>
        <td>${esc(user.role === 'admin' ? 'Administrador' : user.role)}</td>
        <td>${user.status === 'active' ? '<span class="badge green">Activo</span>' : '<span class="badge gray">Inactivo</span>'}</td>
      </tr>`,
    )
    .join('');
  modal({
    title: `Usuarios de ${company.name}`,
    size: 'lg',
    body: `
      <div class="table-wrap" style="margin-bottom:16px">
        <table class="tbl"><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="center muted">Sin usuarios</td></tr>'}</tbody></table>
      </div>
      <h4>Agregar administrador</h4>
      <form id="add-admin-form">
        <div class="form-grid">
          ${field('Usuario', '<input name="username" required />')}
          ${field('Nombre', '<input name="name" required />')}
          ${field('Contraseña', '<input name="password" type="password" minlength="6" required />')}
          ${field('Correo', '<input name="email" type="email" />')}
        </div>
      </form>
      <h4 class="mt-16">Restablecer contraseña</h4>
      <form id="reset-form">
        <div class="form-grid">
          ${field('Usuario', `<select name="userId">${(detail.users || [])
            .map((user) => `<option value="${esc(user.id)}">${esc(user.username)} · ${esc(user.name)}</option>`)
            .join('')}</select>`)}
          ${field('Nueva contraseña', '<input name="password" type="password" minlength="6" />')}
        </div>
      </form>`,
    actions: [
      { label: 'Cerrar', className: 'ghost', onClick: () => closeModal() },
      {
        label: 'Crear administrador',
        className: 'primary',
        onClick: async () => {
          const values = readForm(document.getElementById('add-admin-form'));
          try {
            await apiPost(`/platform/companies/${company.id}/users`, { ...values, role: 'admin' });
            toast('Administrador creado');
            closeModal();
            await openAdmins(company);
          } catch (error) {
            toastError(error);
          }
        },
      },
      {
        label: 'Restablecer',
        className: 'ghost',
        onClick: async () => {
          const values = readForm(document.getElementById('reset-form'));
          if (!values.password) {
            toast('Escriba la nueva contraseña', 'warn');
            return;
          }
          try {
            await apiPost(`/platform/companies/${company.id}/reset-admin-password`, values);
            toast('Contraseña restablecida');
          } catch (error) {
            toastError(error);
          }
        },
      },
    ],
  });
}

void money;


