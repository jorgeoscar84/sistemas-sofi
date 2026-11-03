/** Administración: usuarios y roles, empresa/SRI, integraciones y tokens. */

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  closeModal,
  confirmDialog,
  esc,
  field,
  fmtDate,
  modal,
  option,
  pageHead,
  readForm,
  renderTable,
  spinnerHtml,
  statusBadge,
  toast,
  toastError,
} from '../lib.js';

const ROLES = [
  { id: 'admin', label: 'Administrador' },
  { id: 'facturador', label: 'Facturador' },
  { id: 'inventario', label: 'Inventario' },
  { id: 'contador', label: 'Contador' },
];

export async function render(root, ctx) {
  if (ctx.path.startsWith('/admin/users')) return renderUsers(root, ctx);
  if (ctx.path === '/admin/company') return renderCompany(root, ctx);
  if (ctx.path === '/admin/integration') return renderIntegration(root, ctx);
  root.innerHTML = `<div class="card"><h3>Ruta no encontrada</h3></div>`;
}

/* ------------------------------------------------------------------ usuarios */

async function renderUsers(root, ctx) {
  root.innerHTML = `
    ${pageHead('Usuarios y roles', 'Administre el acceso al sistema y los permisos por rol', '<button class="btn primary" id="new-user">＋ Nuevo usuario</button>')}
    <div class="card"><div id="users-table">${spinnerHtml()}</div></div>`;

  const load = async () => {
    const container = document.getElementById('users-table');
    container.innerHTML = spinnerHtml();
    const data = await apiGet('/users', { limit: 100 });
    renderTable(container, {
      columns: [
        { label: 'Usuario', render: (row) => `<b>${esc(row.username)}</b>` },
        { label: 'Nombre', render: (row) => esc(row.name) },
        { label: 'Correo', render: (row) => esc(row.email || '—') },
        { label: 'Rol', render: (row) => `<span class="badge blue">${esc(row.roleLabel || row.role)}</span>` },
        { label: 'Estado', render: (row) => statusBadge(row.status) },
        { label: 'Creado', render: (row) => fmtDate(row.createdAt) },
        {
          label: 'Acciones',
          align: 'right',
          render: (row) => `<div class="row-actions">
            <button class="btn sm" data-edit="${esc(row.id)}">Editar</button>
            <button class="btn sm danger" data-del="${esc(row.id)}">Desactivar</button>
          </div>`,
        },
      ],
      rows: data.data,
      empty: 'No hay usuarios',
    });
    container.querySelectorAll('[data-edit]').forEach((button) => {
      button.addEventListener('click', () => openForm(data.data.find((user) => user.id === button.dataset.edit)));
    });
    container.querySelectorAll('[data-del]').forEach((button) => {
      button.addEventListener('click', async () => {
        const ok = await confirmDialog('¿Desactivar este usuario? No podrá iniciar sesión.', { okLabel: 'Desactivar' });
        if (!ok) return;
        try {
          await apiDelete(`/users/${button.dataset.del}`);
          toast('Usuario desactivado');
          await load();
        } catch (error) {
          toastError(error);
        }
      });
    });
  };

  const openForm = (user) => {
    const isEdit = Boolean(user);
    const modalEl = modal({
      title: isEdit ? 'Editar usuario' : 'Nuevo usuario',
      body: `<form id="user-form"><div class="form-grid">
        ${field('Nombre de usuario', `<input name="username" ${isEdit ? 'readonly' : ''} value="${esc(user?.username || '')}" required />`)}
        ${field('Nombre completo', `<input name="name" value="${esc(user?.name || '')}" required />`)}
        ${field('Correo electrónico', `<input name="email" type="email" value="${esc(user?.email || '')}" />`)}
        ${field('Rol', `<select name="role">${ROLES.map((role) => option(role.id, role.label, user?.role || 'facturador')).join('')}</select>`)}
        ${field(isEdit ? 'Nueva contraseña (opcional)' : 'Contraseña', `<input name="password" type="password" ${isEdit ? '' : 'required'} placeholder="${isEdit ? 'Dejar vacío para mantener' : 'Mínimo 6 caracteres'}" />`)}
        ${field('Estado', `<select name="status">${option('active', 'Activo', user?.status || 'active')}${option('inactive', 'Inactivo', user?.status)}</select>`)}
      </div></form>`,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: isEdit ? 'Guardar' : 'Crear usuario',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#user-form');
            if (!form.reportValidity()) return;
            const values = readForm(form);
            if (isEdit && !values.password) delete values.password;
            try {
              if (isEdit) await apiPut(`/users/${user.id}`, values);
              else await apiPost('/users', values);
              closeModal();
              toast(isEdit ? 'Usuario actualizado' : 'Usuario creado');
              await load();
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  };

  await load();
  document.getElementById('new-user').addEventListener('click', () => openForm(null));

  // Rutas /admin/users/new y /admin/users/:id/edit abren el formulario automáticamente
  if (ctx.path === '/admin/users/new') openForm(null);
  if (ctx.path.endsWith('/edit')) {
    try {
      const user = await apiGet(`/users/${ctx.params.id}`);
      openForm(user);
    } catch (error) {
      toastError(error);
    }
  }
}

/* ------------------------------------------------------------------- empresa */

async function renderCompany(root) {
  root.innerHTML = spinnerHtml();
  const [company, establishments, certificateStatus] = await Promise.all([
    apiGet('/company'),
    apiGet('/company/establishments'),
    apiGet('/company/certificate/status').catch(() => ({ hasSignature: false, certificate: null })),
  ]);
  root.innerHTML = `
    ${pageHead('Empresa y configuración SRI', 'Datos tributarios, establecimientos, puntos de emisión y certificado digital')}
    <div class="grid cols-2">
      <div class="card">
        <h3>Datos de la empresa</h3>
        <form id="company-form">
          <div class="form-grid">
            ${field('RUC', `<input name="ruc" value="${esc(company.ruc)}" maxlength="13" required />`)}
            ${field('Razón social', `<input name="name" value="${esc(company.name)}" required />`)}
            ${field('Nombre comercial', `<input name="tradeName" value="${esc(company.tradeName || '')}" />`)}
            ${field('Dirección matriz', `<input name="address" value="${esc(company.address || '')}" />`)}
            ${field('Correo electrónico', `<input name="email" type="email" value="${esc(company.email || '')}" />`)}
            ${field('Teléfono', `<input name="phone" value="${esc(company.phone || '')}" />`)}
            ${field('Régimen RIMPE', `<input name="rimpe" value="${esc(company.rimpe || '')}" placeholder="CONTRIBUYENTE RÉGIMEN RIMPE" />`)}
            ${field('Agente de retención', `<input name="agentRetention" value="${esc(company.agentRetention || '')}" placeholder="Nro. resolución (opcional)" />`)}
            ${field('Obligado a llevar contabilidad', `<select name="obligedAccounting">${option('true', 'Sí', String(company.obligedAccounting))}${option('false', 'No', String(company.obligedAccounting))}</select>`)}
            ${field('Ambiente SRI', `<select name="environment">${option('1', '1 · Pruebas', company.environment)}${option('2', '2 · Producción', company.environment)}</select>`)}
            ${field('Modo de emisión', `<select name="sriMode">
              ${option('mock', 'Simulado (sin SRI, para pruebas)', company.sriMode)}
              ${option('direct-sri', 'SRI directo (XML + firma + SOAP)', company.sriMode)}
              ${option('upconta', 'Servicio UpConta (mismo API identificado)', company.sriMode)}
            </select>`, { help: 'En modo simulado los comprobantes se autorizan localmente. En SRI directo se requiere certificado.' })}
            ${field('Algoritmo de firma', `<select name="signatureDigest">
              ${option('sha1', 'RSA-SHA1 (compatibilidad SRI)', company.signatureDigest || 'sha1')}
              ${option('sha256', 'RSA-SHA256 (recomendado)', company.signatureDigest)}
            </select>`, { help: 'El SRI acepta ambos; SHA-256 es el estándar moderno.' })}
          </div>
          <div class="mt-16"><button class="btn primary" type="submit">Guardar configuración</button></div>
        </form>
      </div>

      <div class="card">
        <div class="card-head"><h3>Establecimientos y puntos de emisión</h3><button class="btn sm primary" id="add-establishment">＋ Establecimiento</button></div>
        <div id="establishments-list"></div>
      </div>
    </div>

    <div class="card">
      <h3>Certificado digital</h3>
      <p class="muted small">
        Estado: ${certificateStatus.hasSignature ? '<span class="badge green">Certificado cargado</span>' : '<span class="badge gray">Sin certificado</span>'}
        · Cargue su archivo <b>PKCS#12 (.p12/.pfx)</b> con su contraseña, o exporte el certificado y la clave a PEM.
        El certificado debe haber sido emitido por una entidad de certificación autorizada (BCE, Security Data, ANF, …).
      </p>
      ${certificateStatus.certificate
        ? `<dl class="kv mb-0" style="margin-bottom:14px">
            <dt>Titular</dt><dd>${esc(certificateStatus.certificate.subject.replace(/\n/g, ' · '))}</dd>
            <dt>Emisor</dt><dd>${esc(certificateStatus.certificate.issuer.replace(/\n/g, ' · '))}</dd>
            <dt>Vigencia</dt><dd>${esc(certificateStatus.certificate.validFrom)} → ${esc(certificateStatus.certificate.validTo)}
              ${certificateStatus.certificate.expired ? '<span class="badge red">Vencido</span>' : '<span class="badge green">Vigente</span>'}</dd>
            <dt>N.º de serie</dt><dd class="mono">${esc(certificateStatus.certificate.serialNumber)}</dd>
          </dl>`
        : ''}
      <div class="form-grid">
        ${field('Archivo PKCS#12', '<input type="file" id="cert-file" accept=".p12,.pfx,application/x-pkcs12" /><div id="cert-file-info" class="help"></div>')}
        ${field('Contraseña del certificado', '<input type="password" id="cert-password" autocomplete="off" /><label class="check small mt-8" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cert-show" /> Mostrar contraseña</label>')}
      </div>
      <div class="mt-16 inline">
        <button class="btn primary" id="upload-p12">Cargar certificado .p12</button>
        <button class="btn" id="check-cert">Verificar estado</button>
        <button class="btn" id="test-sri">Probar conexión con el SRI</button>
      </div>
      <div id="cert-error" class="small mt-8" style="color:var(--red);white-space:pre-wrap"></div>
      <details class="mt-16">
        <summary class="small muted" style="cursor:pointer">Cargar manualmente en formato PEM</summary>
        <div class="grid cols-2 mt-16">
          ${field('Certificado (PEM)', `<textarea id="certificatePem" rows="4" placeholder="-----BEGIN CERTIFICATE-----"></textarea>`, { full: true })}
          ${field('Clave privada (PEM)', `<textarea id="privateKeyPem" rows="4" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>`, { full: true })}
        </div>
        <button class="btn mt-8" id="save-cert">Guardar PEM</button>
      </details>
      <div id="sri-test-result" class="mt-16"></div>
    </div>`;

  const companyForm = document.getElementById('company-form');
  companyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = readForm(companyForm);
    values.obligedAccounting = values.obligedAccounting === 'true';
    values.environment = Number(values.environment);
    if (values.environment === 2) {
      const confirmed = await confirmDialog(
        'Está a punto de pasar al ambiente de PRODUCCIÓN del SRI: los comprobantes que emita tendrán valor tributario y no podrán deshacerse. ¿Confirma el cambio?',
        { title: 'Cambiar a producción', okLabel: 'Sí, pasar a producción' },
      );
      if (!confirmed) return;
      values.confirmProduction = true;
    }
    try {
      await apiPut('/company', values);
      toast('Configuración guardada');
      await renderCompany(root);
    } catch (error) {
      toastError(error);
    }
  });

  const renderEstablishments = (list) => {
    const container = document.getElementById('establishments-list');
    container.innerHTML = list.length
      ? list
          .map(
            (establishment) => `
        <div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px">
          <div class="flex between center">
            <div><b>${esc(establishment.code)} · ${esc(establishment.name)}</b><div class="small muted">${esc(establishment.address || 'Sin dirección')}</div></div>
            <div class="inline">
              <button class="btn sm" data-add-point="${esc(establishment.id)}">＋ Punto</button>
            </div>
          </div>
          <div style="margin-top:8px;display:grid;gap:6px">
            ${establishment.emissionPoints
              .map(
                (point) => `
              <div style="border:1px solid #f1f5f9;border-radius:8px;padding:8px">
                <div class="flex between center">
                  <span class="small"><b>${esc(point.code)}</b> ${esc(point.name)}</span>
                  <button class="btn sm ghost" data-seq="${esc(point.id)}">Secuenciales</button>
                </div>
                <div class="small muted mono">Facturas: ${point.sequences.invoice} · NC: ${point.sequences.creditNote} · ND: ${point.sequences.debitNote} · Ret: ${point.sequences.retentionReceipt} · Guía: ${point.sequences.waybill}</div>
              </div>`,
              )
              .join('') || '<div class="small muted">Sin puntos de emisión</div>'}
          </div>
        </div>`,
          )
          .join('')
      : '<div class="empty-state">No hay establecimientos registrados</div>';

    container.querySelectorAll('[data-add-point]').forEach((button) => {
      button.addEventListener('click', () => openPointForm(button.dataset.addPoint));
    });
    container.querySelectorAll('[data-seq]').forEach((button) => {
      button.addEventListener('click', () => openSequencesForm(button.dataset.seq, list));
    });
  };
  renderEstablishments(establishments);

  const openPointForm = (establishmentId) => {
    const modalEl = modal({
      title: 'Nuevo punto de emisión',
      body: `<form id="point-form"><div class="form-grid">
        ${field('Código (3 dígitos)', '<input name="code" maxlength="3" placeholder="001" required />')}
        ${field('Nombre', '<input name="name" placeholder="Caja principal" required />')}
      </div></form>`,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: 'Crear',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#point-form');
            if (!form.reportValidity()) return;
            try {
              const list = await apiPost(`/company/establishments/${establishmentId}/emission-points`, readForm(form));
              closeModal();
              toast('Punto de emisión creado');
              renderEstablishments(list);
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  };

  const openSequencesForm = (pointId, list) => {
    const point = list.flatMap((establishment) => establishment.emissionPoints).find((item) => item.id === pointId);
    if (!point) return;
    const fields = [
      ['invoice', 'Facturas'],
      ['creditNote', 'Notas de crédito'],
      ['debitNote', 'Notas de débito'],
      ['retentionReceipt', 'Retenciones'],
      ['waybill', 'Guías de remisión'],
      ['salesNote', 'Notas de venta'],
    ];
    const modalEl = modal({
      title: `Secuenciales · ${point.code} ${point.name}`,
      body: `<form id="seq-form"><div class="form-grid">${fields
        .map(([key, label]) =>
          field(`Próximo secuencial · ${label}`, `<input name="${key}" type="number" min="1" value="${point.sequences[key] || 1}" />`),
        )
        .join('')}</div></form>`,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: 'Guardar secuenciales',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#seq-form');
            const values = readForm(form);
            const sequences = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)]));
            try {
              const updated = await apiPut(`/company/emission-points/${pointId}`, { sequences });
              closeModal();
              toast('Secuenciales actualizados');
              renderEstablishments(updated);
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  };

  document.getElementById('add-establishment').addEventListener('click', () => {
    const modalEl = modal({
      title: 'Nuevo establecimiento',
      body: `<form id="establishment-form"><div class="form-grid">
        ${field('Código (3 dígitos)', '<input name="code" maxlength="3" placeholder="002" required />')}
        ${field('Nombre', '<input name="name" placeholder="Sucursal Guayaquil" required />')}
        ${field('Dirección', '<input name="address" placeholder="Dirección del establecimiento" />', { full: true })}
      </div></form>`,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: 'Crear establecimiento',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#establishment-form');
            if (!form.reportValidity()) return;
            try {
              await apiPost('/company/establishments', readForm(form));
              closeModal();
              toast('Establecimiento creado');
              renderEstablishments(await apiGet('/company/establishments'));
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  });

  const certFileInput = document.getElementById('cert-file');
  certFileInput?.addEventListener('change', () => {
    const file = certFileInput.files?.[0];
    const info = document.getElementById('cert-file-info');
    if (info) info.textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : '';
    const errorBox = document.getElementById('cert-error');
    if (errorBox) errorBox.textContent = '';
  });
  document.getElementById('cert-show')?.addEventListener('change', (event) => {
    const passwordInput = document.getElementById('cert-password');
    if (passwordInput) passwordInput.type = event.target.checked ? 'text' : 'password';
  });

  document.getElementById('upload-p12').addEventListener('click', async () => {
    const fileInput = document.getElementById('cert-file');
    const password = document.getElementById('cert-password').value;
    const file = fileInput.files?.[0];
    const errorBox = document.getElementById('cert-error');
    if (errorBox) errorBox.textContent = '';
    if (!file) {
      toast('Seleccione el archivo .p12/.pfx', 'warn');
      return;
    }
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
        reader.readAsDataURL(file);
      });
      const result = await apiPost('/company/certificate', { p12Base64: base64, password });
      toast(`Certificado cargado: ${result.certificate.subject.replace(/\n/g, ' · ')}`);
      if (errorBox) errorBox.textContent = '';
      await renderCompany(root);
    } catch (error) {
      toastError(error);
      if (errorBox) errorBox.textContent = error.message;
    }
  });

  document.getElementById('test-sri').addEventListener('click', async () => {
    const result = document.getElementById('sri-test-result');
    result.innerHTML = spinnerHtml('Probando conexión con el SRI…');
    try {
      const data = await apiPost('/integration/sri/test', {});
      result.innerHTML = `
        <div class="card" style="margin-bottom:0">
          <div class="inline" style="margin-bottom:8px">
            <span class="badge ${data.ok ? 'green' : 'red'}">${data.ok ? 'Servicio SRI disponible' : 'Sin conexión'}</span>
            <span class="badge ${data.certificadoValido ? 'green' : 'amber'}">${data.certificadoValido ? 'Certificado válido' : 'Certificado no válido / ausente'}</span>
            <span class="badge blue">Ambiente: ${esc(data.ambienteLabel)}</span>
            <span class="muted small">${data.latencyMs} ms</span>
          </div>
          <div class="small muted mono">${esc(data.servicioRecepcion)}</div>
          ${data.error ? `<div class="small" style="color:var(--red);margin-top:6px">${esc(data.error)}</div>` : ''}
          ${data.recomendacion ? `<div class="small" style="margin-top:6px">${esc(data.recomendacion)}</div>` : ''}
        </div>`;
    } catch (error) {
      result.innerHTML = `<div class="badge red">Error</div><div class="small muted mt-8">${esc(error.message)}</div>`;
    }
  });

  document.getElementById('save-cert').addEventListener('click', async () => {
    const certificatePem = document.getElementById('certificatePem').value.trim();
    const privateKeyPem = document.getElementById('privateKeyPem').value.trim();
    if (!certificatePem || !privateKeyPem) {
      toast('Pegue el certificado y la clave privada en PEM', 'warn');
      return;
    }
    try {
      await apiPost('/company/certificate', { certificatePem, privateKeyPem });
      toast('Certificado guardado');
      await renderCompany(root);
    } catch (error) {
      toastError(error);
    }
  });
  document.getElementById('check-cert').addEventListener('click', async () => {
    try {
      const status = await apiGet('/company/certificate/status');
      toast(status.hasSignature ? 'Certificado cargado correctamente' : 'No hay certificado cargado', status.hasSignature ? 'ok' : 'warn');
    } catch (error) {
      toastError(error);
    }
  });
}

/* --------------------------------------------------------------- integración */

async function renderIntegration(root) {
  root.innerHTML = spinnerHtml();
  const [config, tokens, sri] = await Promise.all([
    apiGet('/integration/upconta'),
    apiGet('/integration/tokens'),
    apiGet('/integration/sri/status').catch(() => null),
  ]);
  root.innerHTML = `
    ${pageHead('Integraciones', 'Servicios de facturación electrónica externos, SRI y tokens para su API')}
    <div class="card">
      <div class="card-head"><h3>Servicio de Impuestos Internos (SRI)</h3>
        <div class="inline">
          <span class="badge ${sri && sri.environment === 2 ? 'red' : 'amber'}">Ambiente ${sri ? esc(sri.environmentLabel) : '—'}</span>
          <span class="badge ${sri && sri.hasSignature ? 'green' : 'gray'}">${sri && sri.hasSignature ? 'Con certificado' : 'Sin certificado'}</span>
        </div>
      </div>
      <p class="muted small">
        Modo de emisión: <b>${esc(sri?.mode || '—')}</b>. ${esc(sri?.note || '')}<br />
        Recepción: <span class="mono">${esc(sri?.endpoints?.recepcion || '')}</span><br />
        Autorización: <span class="mono">${esc(sri?.endpoints?.autorizacion || '')}</span>
      </p>
      <form id="sri-mode-form">
        <div class="form-grid">
          ${field('Ambiente SRI', `<select name="environment">${option('1', '1 · Pruebas (celcer.sri.gob.ec)', String(sri?.environment ?? 1))}${option('2', '2 · Producción (cel.sri.gob.ec)', String(sri?.environment ?? 1))}</select>`)}
          ${field('Modo de emisión', `<select name="sriMode">
            ${option('mock', 'Simulado (sin SRI)', sri?.mode)}
            ${option('direct-sri', 'SRI directo (XML + firma + SOAP)', sri?.mode)}
            ${option('upconta', 'Servicio UpConta', sri?.mode)}
          </select>`)}
        </div>
        <div class="mt-16 inline">
          <button class="btn primary" type="submit">Guardar modo y ambiente</button>
          <button class="btn" type="button" id="test-sri-connection">Probar conexión con el SRI</button>
        </div>
      </form>
      <div id="sri-status-result" class="mt-16"></div>
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h3>Servicio UpConta (API identificada)</h3>
        <p class="muted small">Documentación oficial: <a href="https://docs.upconta.com/api/administrative/vouchers/invoices.html" target="_blank" rel="noreferrer">docs.upconta.com</a>. Use un token de integración (Configuración → Empresa en UpConta).</p>
        <form id="upconta-form">
          <div class="form-grid">
            ${field('Base URL', `<input name="baseUrl" value="${esc(config.baseUrl || 'https://api.upconta.com')}" />`, { full: true })}
            ${field('Token de integración', `<input name="token" type="password" placeholder="${config.token ? '******** (guardado)' : 'Pegue el token'}" />`, { full: true })}
            ${field('RUC de la empresa', `<input name="ruc" value="${esc(config.ruc || '')}" />`)}
            ${field('Establecimiento', `<input name="estab" value="${esc(config.estab || '001')}" maxlength="3" />`)}
            ${field('Punto de emisión', `<input name="ptoEmi" value="${esc(config.ptoEmi || '001')}" maxlength="3" />`)}
          </div>
          <div class="mt-16 inline">
            <button class="btn primary" type="submit">Guardar</button>
            <button class="btn" type="button" id="test-upconta">Probar conexión</button>
          </div>
        </form>
        <div id="upconta-test-result" class="mt-16"></div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Tokens de API (para integraciones)</h3><button class="btn sm primary" id="new-token">＋ Nuevo token</button></div>
        <p class="muted small">Autentique sus integraciones con <span class="mono">Authorization: ApiToken &lt;token&gt;</span> contra <span class="mono">/api/v1/vouchers</span>.</p>
        <div id="tokens-list"></div>
      </div>
    </div>`;

  const renderTokens = (list) => {
    const container = document.getElementById('tokens-list');
    if (!list.length) {
      container.innerHTML = '<div class="empty-state">No hay tokens de integración</div>';
      return;
    }
    container.innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Nombre</th><th>Estado</th><th>Creado</th><th></th></tr></thead><tbody>
      ${list
        .map(
          (token) => `<tr>
            <td><b>${esc(token.name)}</b></td>
            <td>${statusBadge(token.status === 'active' ? 'active' : 'inactive')}</td>
            <td>${fmtDate(token.createdAt)}</td>
            <td class="right"><button class="btn sm danger" data-revoke="${esc(token.id)}">Revocar</button></td>
          </tr>`,
        )
        .join('')}
    </tbody></table></div>`;
    container.querySelectorAll('[data-revoke]').forEach((button) => {
      button.addEventListener('click', async () => {
        const ok = await confirmDialog('¿Revocar este token? Las integraciones que lo usen dejarán de funcionar.', { okLabel: 'Revocar' });
        if (!ok) return;
        try {
          await apiDelete(`/integration/tokens/${button.dataset.revoke}`);
          toast('Token revocado');
          renderTokens(await apiGet('/integration/tokens'));
        } catch (error) {
          toastError(error);
        }
      });
    });
  };
  renderTokens(tokens);

  document.getElementById('sri-mode-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = readForm(event.target);
    try {
      await apiPut('/company', { environment: Number(values.environment), sriMode: values.sriMode });
      toast('Modo de emisión y ambiente actualizados');
      await renderIntegration(root);
    } catch (error) {
      toastError(error);
    }
  });

  document.getElementById('test-sri-connection').addEventListener('click', async () => {
    const result = document.getElementById('sri-status-result');
    result.innerHTML = spinnerHtml('Probando conexión con el SRI…');
    try {
      const data = await apiPost('/integration/sri/test', {});
      result.innerHTML = `
        <div class="inline" style="margin-bottom:6px">
          <span class="badge ${data.ok ? 'green' : 'red'}">${data.ok ? 'Servicio SRI disponible' : 'Sin conexión'}</span>
          <span class="badge ${data.certificadoValido ? 'green' : 'amber'}">${data.certificadoValido ? 'Certificado válido' : 'Certificado no válido / ausente'}</span>
          <span class="muted small">${data.latencyMs} ms · HTTP ${data.httpStatus ?? '—'} · Ambiente ${esc(data.ambienteLabel)}</span>
        </div>
        ${data.certificado ? `<div class="small muted">${esc(data.certificado.subject.replace(/\n/g, ' · '))} · vence ${esc(data.certificado.validTo)}</div>` : ''}
        ${data.error ? `<div class="small" style="color:var(--red)">${esc(data.error)}</div>` : ''}
        ${data.recomendacion ? `<div class="small mt-8">${esc(data.recomendacion)}</div>` : ''}`;
    } catch (error) {
      result.innerHTML = `<div class="badge red">Error</div><div class="small muted mt-8">${esc(error.message)}</div>`;
    }
  });

  document.getElementById('upconta-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await apiPut('/integration/upconta', readForm(event.target));
      toast('Configuración de UpConta guardada');
    } catch (error) {
      toastError(error);
    }
  });
  document.getElementById('test-upconta').addEventListener('click', async () => {
    const result = document.getElementById('upconta-test-result');
    result.innerHTML = spinnerHtml('Probando conexión…');
    try {
      const data = await apiPost('/integration/upconta/test');
      result.innerHTML = `<div class="badge ${data.ok ? 'green' : 'red'}">${data.ok ? 'Conexión OK' : 'Sin conexión'}</div>
        <div class="small muted mt-8">${esc(data.message)} ${data.business ? `· ${esc(data.business)} (${esc(data.ruc || '')})` : ''}</div>`;
    } catch (error) {
      result.innerHTML = `<div class="badge red">Error</div><div class="small muted mt-8">${esc(error.message)}</div>`;
    }
  });
  document.getElementById('new-token').addEventListener('click', () => {
    const modalEl = modal({
      title: 'Nuevo token de integración',
      size: 'sm',
      body: `<form id="token-form">${field('Nombre descriptivo', '<input name="name" placeholder="Mi integración" required />')}</form>`,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: 'Crear token',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#token-form');
            if (!form.reportValidity()) return;
            try {
              const created = await apiPost('/integration/tokens', readForm(form));
              modal({
                title: 'Token creado',
                size: 'sm',
                body: `<p class="small">Guarde este token, no se volverá a mostrar:</p><div class="receipt-preview mono" id="token-value">${esc(created.token)}</div>`,
                actions: [
                  { label: 'Cerrar', className: 'primary', onClick: closeModal },
                ],
              });
              renderTokens(await apiGet('/integration/tokens'));
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  });
}

