/** Guías de remisión (comprobante electrónico 06). */

import {
  apiGet,
  apiPost,
  closeModal,
  confirmDialog,
  download,
  esc,
  field,
  fmtDate,
  fmtDateTime,
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
  copyText,
} from '../lib.js';

const state = { status: '', q: '', page: 1 };

export async function render(root, ctx) {
  if (ctx.path === '/waybills/new') return renderForm(root, ctx);
  if (ctx.params && ctx.params.id) return renderDetail(root, ctx);
  return renderList(root, ctx);
}

/* ------------------------------------------------------------------ listado */

async function renderList(root) {
  root.innerHTML = `
    ${pageHead('Guías de remisión', 'Comprobantes electrónicos de traslado de bienes (SRI 06)', `
      <a class="btn" href="#/invoicing">← Comprobantes</a>
      <a class="btn primary" href="#/waybills/new">＋ Nueva guía</a>`)}
    <div class="card">
      <div class="inline" style="margin-bottom:14px">
        <div class="search grow"><input id="wb-search" type="search" placeholder="Buscar por destinatario, número o clave de acceso" /></div>
        <select id="wb-status" style="width:190px">
          <option value="">Todos los estados</option>
          ${option('issued', 'Autorizado', '')}
          ${option('failed', 'Rechazado', '')}
          ${option('draft', 'Borrador', '')}
          ${option('offline', 'Offline', '')}
          ${option('canceled', 'Anulado', '')}
        </select>
        <button class="btn" id="wb-refresh">Actualizar</button>
      </div>
      <div id="wb-table">${spinnerHtml()}</div>
      <div class="flex between center mt-16">
        <span class="muted small" id="wb-count"></span>
        <div class="inline">
          <button class="btn sm" id="wb-prev">← Anterior</button>
          <button class="btn sm" id="wb-next">Siguiente →</button>
        </div>
      </div>
    </div>`;

  const load = async () => {
    const container = document.getElementById('wb-table');
    container.innerHTML = spinnerHtml();
    try {
      const data = await apiGet('/waybills', { status: state.status, q: state.q, page: state.page, limit: 20 });
      document.getElementById('wb-count').textContent = `${data.total} guía(s) · página ${data.page}`;
      renderTable(container, {
        columns: [
          { label: 'Número', render: (row) => `<a class="mono" href="#/waybills/${esc(row.id)}">${esc(row.number)}</a>` },
          {
            label: 'Destinatario',
            render: (row) => {
              const dest = row.extra?.destinatarios?.[0];
              return `<b>${esc(dest?.razonSocial || row.clientName || '—')}</b><div class="small muted">${esc(dest?.identificacion || row.clientIdNumber || '')}</div>`;
            },
          },
          {
            label: 'Transportista',
            render: (row) => `<div>${esc(row.extra?.transportista?.razonSocial || '—')}</div><div class="small muted mono">${esc(row.extra?.transportista?.placa || '')}</div>`,
          },
          { label: 'Fecha', render: (row) => fmtDate(row.issueDate), className: 'nowrap' },
          { label: 'Estado', render: (row) => statusBadge(row.status) },
          {
            label: 'Clave de acceso',
            render: (row) =>
              row.accessKey
                ? `<span class="mono small">${esc(row.accessKey.slice(0, 20))}…</span>
                   <button class="btn ghost sm" data-copy="${esc(row.accessKey)}" title="Copiar clave">copiar</button>`
                : '—',
          },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `<div class="row-actions">
              <a class="btn sm" href="#/waybills/${esc(row.id)}">Ver</a>
              ${row.accessKey ? `<button class="btn sm" data-pdf="${esc(row.id)}">PDF</button><button class="btn sm" data-xml="${esc(row.id)}">XML</button>` : ''}
            </div>`,
          },
        ],
        rows: data.data,
        empty: 'No hay guías de remisión',
      });
      container.querySelectorAll('[data-copy]').forEach((button) =>
        button.addEventListener('click', () => copyText(button.dataset.copy)),
      );
      container.querySelectorAll('[data-pdf]').forEach((button) =>
        button.addEventListener('click', () => download(`/vouchers/${button.dataset.pdf}/pdf`, 'guia-remision.pdf').catch(toastError)),
      );
      container.querySelectorAll('[data-xml]').forEach((button) =>
        button.addEventListener('click', () => download(`/vouchers/${button.dataset.xml}/xml`, 'guia-remision.xml').catch(toastError)),
      );
    } catch (error) {
      container.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  document.getElementById('wb-search').addEventListener('input', (event) => {
    state.q = event.target.value.trim();
    state.page = 1;
    load();
  });
  document.getElementById('wb-status').addEventListener('change', (event) => {
    state.status = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('wb-prev').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  document.getElementById('wb-next').addEventListener('click', () => {
    state.page += 1;
    load();
  });
  document.getElementById('wb-refresh').addEventListener('click', load);
  await load();
}

/* -------------------------------------------------------------------- detalle */

export async function renderDetail(root, ctx) {
  root.innerHTML = `${pageHead('Guía de remisión', 'Detalle del comprobante')}<div id="wb-detail">${spinnerHtml()}</div>`;
  try {
    const voucher = await apiGet(`/vouchers/${ctx.params.id}`);
    const extra = voucher.extra || {};
    const transportista = extra.transportista || {};
    const destinatarios = extra.destinatarios || [];
    document.getElementById('wb-detail').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>${esc(voucher.number)} · ${statusBadge(voucher.status)}</h3>
          <div class="inline">
            <a class="btn sm" href="#/waybills">← Volver</a>
            ${voucher.accessKey ? `<button class="btn sm" id="wb-d-pdf">Descargar PDF</button><button class="btn sm" id="wb-d-xml">Descargar XML</button>` : ''}
            ${voucher.status === 'draft' ? `<button class="btn sm primary" id="wb-d-emit">Emitir</button>` : ''}
            ${['failed', 'offline'].includes(voucher.status) ? `<button class="btn sm primary" id="wb-d-retry">Reintentar</button>` : ''}
            ${['issued'].includes(voucher.status) ? `<button class="btn sm danger" id="wb-d-cancel">Anular</button>` : ''}
          </div>
        </div>
        <dl class="kv">
          <dt>Clave de acceso</dt><dd class="mono">${esc(voucher.accessKey || '—')}</dd>
          <dt>Ambiente</dt><dd>${voucher.environment === 2 ? 'Producción' : 'Pruebas'}</dd>
          <dt>Fecha de emisión</dt><dd>${fmtDate(voucher.issueDate)}</dd>
          <dt>Autorización</dt><dd class="mono">${esc(voucher.authorizationNumber || '—')}</dd>
          <dt>Fecha de autorización</dt><dd>${voucher.authorizationDate ? fmtDateTime(voucher.authorizationDate) : '—'}</dd>
          <dt>Punto de partida</dt><dd>${esc(extra.dirPartida || '—')}</dd>
          <dt>Transportista</dt><dd>${esc(transportista.razonSocial || '—')} · RUC ${esc(transportista.ruc || '')} · Placa <b>${esc(transportista.placa || '')}</b></dd>
          <dt>Transporte</dt><dd>${esc(extra.fechaIniTransporte || '')} → ${esc(extra.fechaFinTransporte || '')}</dd>
        </dl>
      </div>
      ${destinatarios
        .map(
          (dest, index) => `
        <div class="card">
          <h3>Destinatario ${index + 1}: ${esc(dest.razonSocial)}</h3>
          <dl class="kv">
            <dt>Identificación</dt><dd class="mono">${esc(dest.identificacion)}</dd>
            <dt>Dirección</dt><dd>${esc(dest.direccion)}</dd>
            <dt>Motivo de traslado</dt><dd>${esc(dest.motivoTraslado)}</dd>
            ${dest.numDocSustento ? `<dt>Documento sustento</dt><dd class="mono">${esc(dest.codDocSustento || '')} ${esc(dest.numDocSustento)}</dd>` : ''}
          </dl>
          <div class="table-wrap mt-16"><table class="tbl">
            <thead><tr><th>Código</th><th>Descripción</th><th class="num">Cantidad</th></tr></thead>
            <tbody>${(dest.items || [])
              .map((item) => `<tr><td class="mono">${esc(item.codigo)}</td><td>${esc(item.descripcion)}</td><td class="num">${item.cantidad}</td></tr>`)
              .join('')}</tbody>
          </table></div>
        </div>`,
        )
        .join('')}
      ${voucher.sriMessages?.length
        ? `<div class="card"><h3>Mensajes del SRI</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Id</th><th>Mensaje</th><th>Información adicional</th></tr></thead><tbody>
            ${voucher.sriMessages
              .map((message) => `<tr><td class="mono">${esc(message.identificador || '')}</td><td>${esc(message.mensaje || '')}</td><td class="small muted">${esc(message.informacionAdicional || '')}</td></tr>`)
              .join('')}
          </tbody></table></div></div>`
        : ''}`;

    const emit = async (path) => {
      try {
        await apiPost(`/vouchers/${voucher.id}/${path}`, {});
        toast('Guía emitida');
        await renderDetail(root, ctx);
      } catch (error) {
        toastError(error);
      }
    };
    document.getElementById('wb-d-emit')?.addEventListener('click', () => emit('emit'));
    document.getElementById('wb-d-retry')?.addEventListener('click', () => emit('retry'));
    document.getElementById('wb-d-cancel')?.addEventListener('click', async () => {
      const ok = await confirmDialog('¿Anular esta guía de remisión?', { okLabel: 'Anular' });
      if (!ok) return;
      try {
        await apiPost(`/vouchers/${voucher.id}/cancel`, {});
        toast('Guía anulada');
        await renderDetail(root, ctx);
      } catch (error) {
        toastError(error);
      }
    });
    document.getElementById('wb-d-pdf')?.addEventListener('click', () =>
      download(`/vouchers/${voucher.id}/pdf`, 'guia-remision.pdf').catch(toastError),
    );
    document.getElementById('wb-d-xml')?.addEventListener('click', () =>
      download(`/vouchers/${voucher.id}/xml`, 'guia-remision.xml').catch(toastError),
    );
  } catch (error) {
    document.getElementById('wb-detail').innerHTML = `<div class="card"><h3>No se pudo cargar la guía</h3><p class="muted">${esc(error.message)}</p></div>`;
  }
}

/* --------------------------------------------------------------- formulario */

function toSriDate(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

async function renderForm(root, ctx) {
  root.innerHTML = spinnerHtml();
  const options = await apiGet('/waybills/options');
  const establishment = options.establishments[0];
  const point = establishment?.emissionPoints?.[0];
  const dest = (index) => `
    <div class="card" data-dest="${index}">
      <div class="card-head"><h3>Destinatario ${index + 1}</h3><button class="btn sm ghost" type="button" data-remove="${index}">Quitar</button></div>
      <div class="form-grid">
        ${field('Identificación', `<input name="dest_identificacion_${index}" required placeholder="RUC / cédula / pasaporte" />`)}
        ${field('Razón social', `<input name="dest_razonSocial_${index}" required />`)}
        ${field('Dirección', `<input name="dest_direccion_${index}" required />`)}
        ${field('Motivo de traslado', `<select name="dest_motivo_${index}">${options.motivosTraslado.map((motivo) => option(motivo.id, `${motivo.id} · ${motivo.label}`, '03')).join('')}</select>`)}
        ${field('Doc. sustento (opcional)', `<select name="dest_codDocSustento_${index}"><option value="">Sin documento</option>${options.tiposDocSustento.map((tipo) => option(tipo.id, tipo.label, '')).join('')}</select>`)}
        ${field('N.º documento sustento', `<input name="dest_numDocSustento_${index}" placeholder="001-001-000000004" />`)}
        ${field('N.º autorización sustento', `<input name="dest_numAutDocSustento_${index}" placeholder="Clave de acceso 49 dígitos" />`)}
        ${field('Fecha emisión sustento', `<input type="date" name="dest_fechaEmisionDocSustento_${index}" />`)}
      </div>
      <div class="mt-16">
        <div class="flex between center mb-0"><b class="small">Bienes transportados</b>
          <button class="btn sm" type="button" data-add-item="${index}">＋ Bien</button></div>
        <div class="table-wrap mt-8"><table class="tbl">
          <thead><tr><th>Producto / descripción</th><th style="width:240px">Producto del catálogo</th><th style="width:110px">Cantidad</th><th></th></tr></thead>
          <tbody data-items="${index}"></tbody>
        </table></div>
      </div>
    </div>`;

  root.innerHTML = `
    ${pageHead('Nueva guía de remisión', 'Documento electrónico de traslado de bienes (SRI 06)', '<a class="btn" href="#/waybills">← Volver</a>')}
    <form id="wb-form">
      <div class="card">
        <h3>Datos del comprobante</h3>
        <div class="form-grid">
          ${field('Establecimiento', `<select name="establishmentId">${options.establishments.map((item) => option(item.id, `${item.code} · ${item.name}`, establishment?.id)).join('')}</select>`)}
          ${field('Punto de emisión', `<select name="emissionPointId">${(establishment?.emissionPoints || []).map((item) => option(item.id, `${item.code} · ${item.name}`, point?.id)).join('')}</select>`)}
          ${field('Fecha de emisión', `<input type="date" name="issueDate" value="${new Date().toISOString().slice(0, 10)}" />`)}
          ${field('Punto de partida', `<input name="dirPartida" required value="${esc(establishment?.address || '')}" />`)}
        </div>
      </div>
      <div class="card">
        <h3>Transportista</h3>
        <div class="form-grid">
          ${field('Razón social', `<input name="trans_razonSocial" required />`)}
          ${field('RUC', `<input name="trans_ruc" required placeholder="1792456789001" />`)}
          ${field('Tipo de identificación', `<select name="trans_tipoIdentificacion">${options.tiposIdentificacion.map((tipo) => option(tipo.id, tipo.label, '04')).join('')}</select>`)}
          ${field('Placa del vehículo', `<input name="trans_placa" required placeholder="PBX-1234" />`)}
          ${field('Inicio del transporte', `<input type="date" name="fechaIniTransporte" value="${new Date().toISOString().slice(0, 10)}" />`)}
          ${field('Fin del transporte', `<input type="date" name="fechaFinTransporte" value="${new Date().toISOString().slice(0, 10)}" />`)}
        </div>
      </div>
      <div id="destinatarios">${dest(0)}</div>
      <div class="card">
        <div class="inline">
          <button class="btn primary" type="submit">Emitir guía de remisión</button>
          <button class="btn" type="button" id="wb-draft">Guardar como borrador</button>
          <a class="btn ghost" href="#/waybills">Cancelar</a>
        </div>
        <p class="small muted mt-8">La guía se envía al SRI al emitir. El secuencial y la clave de acceso se asignan en ese momento.</p>
      </div>
    </form>`;

  let destinatarioCount = 1;
  const addItem = (destIndex, item = {}) => {
    const body = document.querySelector(`[data-items="${destIndex}"]`);
    if (!body) return;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input data-field="descripcion" value="${esc(item.descripcion || '')}" placeholder="Descripción del bien" ${item.productId ? 'readonly' : ''} /></td>
      <td><select data-field="productId">${option('', '— manual —', item.productId || '')}${options.products
        .map((product) => option(product.id, `${product.code} · ${product.description}`, item.productId))
        .join('')}</select></td>
      <td><input data-field="cantidad" type="number" min="1" step="1" value="${item.cantidad || 1}" /></td>
      <td class="right"><button class="btn ghost sm" type="button" data-remove-item>✕</button></td>`;
    const productSelect = row.querySelector('[data-field="productId"]');
    productSelect.addEventListener('change', () => {
      const product = options.products.find((candidate) => candidate.id === productSelect.value);
      const description = row.querySelector('[data-field="descripcion"]');
      if (product) {
        description.value = product.description;
        description.readOnly = true;
      } else {
        description.readOnly = false;
      }
    });
    row.querySelector('[data-remove-item]').addEventListener('click', () => row.remove());
    body.appendChild(row);
  };
  addItem(0);
  document.querySelector('[data-add-item="0"]').addEventListener('click', () => addItem(0));

  const collect = () => {
    const form = document.getElementById('wb-form');
    const values = readForm(form);
    const destinatarios = Array.from(document.querySelectorAll('[data-dest]'))
      .map((container) => {
        const index = container.dataset.dest;
        const items = Array.from(container.querySelectorAll('[data-items] tr')).map((row) => ({
          productId: row.querySelector('[data-field="productId"]').value || undefined,
          descripcion: row.querySelector('[data-field="descripcion"]').value,
          cantidad: Number(row.querySelector('[data-field="cantidad"]').value || 1),
        }));
        return {
          identificacion: values[`dest_identificacion_${index}`],
          razonSocial: values[`dest_razonSocial_${index}`],
          direccion: values[`dest_direccion_${index}`],
          motivoTraslado: values[`dest_motivo_${index}`],
          codDocSustento: values[`dest_codDocSustento_${index}`] || undefined,
          numDocSustento: values[`dest_numDocSustento_${index}`] || undefined,
          numAutDocSustento: values[`dest_numAutDocSustento_${index}`] || undefined,
          fechaEmisionDocSustento: values[`dest_fechaEmisionDocSustento_${index}`]
            ? toSriDate(values[`dest_fechaEmisionDocSustento_${index}`])
            : undefined,
          items,
        };
      })
      .filter((destinatario) => destinatario.identificacion && destinatario.razonSocial);
    return {
      establishmentId: values.establishmentId,
      emissionPointId: values.emissionPointId,
      issueDate: values.issueDate,
      dirPartida: values.dirPartida,
      transportista: {
        razonSocial: values.trans_razonSocial,
        ruc: values.trans_ruc,
        tipoIdentificacion: values.trans_tipoIdentificacion,
        placa: values.trans_placa,
      },
      fechaIniTransporte: toSriDate(values.fechaIniTransporte),
      fechaFinTransporte: toSriDate(values.fechaFinTransporte),
      destinatarios,
    };
  };

  const submit = async (draft) => {
    try {
      const payload = collect();
      payload.draft = draft;
      const created = await apiPost('/waybills', payload);
      if (draft) {
        toast('Guía guardada como borrador');
        location.hash = `#/waybills/${created.id}`;
        return;
      }
      showResult(created);
    } catch (error) {
      toastError(error);
    }
  };

  document.getElementById('wb-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submit(false);
  });
  document.getElementById('wb-draft').addEventListener('click', () => submit(true));
  void ctx;
}

function showResult(voucher) {
  const messages = voucher.sriMessages || [];
  const modalEl = modal({
    title: `Guía de remisión · ${voucher.number}`,
    size: 'lg',
    body: `
      <div class="flex center gap-12" style="margin-bottom:14px">
        ${statusBadge(voucher.status)}
        <span class="muted small">${voucher.environment === 2 ? 'Producción' : 'Pruebas'}</span>
      </div>
      <dl class="kv">
        <dt>Clave de acceso</dt><dd class="mono" style="word-break:break-all">${esc(voucher.accessKey || '—')}</dd>
        <dt>Autorización</dt><dd class="mono">${esc(voucher.authorizationNumber || '—')}</dd>
      </dl>
      ${
        messages.length
          ? `<div class="card mt-16"><h3>Mensajes del SRI</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Id</th><th>Mensaje</th><th>Detalle</th></tr></thead><tbody>
              ${messages.map((message) => `<tr><td class="mono">${esc(message.identificador || '')}</td><td>${esc(message.mensaje || '')}</td><td class="small muted">${esc(message.informacionAdicional || '')}</td></tr>`).join('')}
            </tbody></table></div></div>`
          : ''
      }`,
    actions: [
      { label: 'Cerrar', onClick: closeModal },
      {
        label: 'Descargar RIDE',
        onClick: () => download(`/vouchers/${voucher.id}/pdf`, 'guia-remision.pdf').catch(toastError),
      },
      {
        label: 'Ver detalle',
        className: 'primary',
        onClick: () => {
          closeModal();
          location.hash = `#/waybills/${voucher.id}`;
        },
      },
    ],
  });
  void modalEl;
}

