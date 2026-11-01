/** Comprobantes de retención (comprobante electrónico 07). */

import {
  apiGet,
  apiPost,
  closeModal,
  confirmDialog,
  copyText,
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
} from '../lib.js';

const state = { status: '', q: '', page: 1 };

export async function render(root, ctx) {
  if (ctx.path === '/retentions/new') return renderForm(root, ctx);
  if (ctx.params && ctx.params.id) return renderDetail(root, ctx);
  return renderList(root, ctx);
}

const IVA_CODIGOS = [
  { id: '0', label: '0%' },
  { id: '2', label: '12%' },
  { id: '4', label: '15%' },
  { id: '5', label: '5%' },
  { id: '6', label: 'No objeto' },
  { id: '7', label: 'Exento' },
  { id: '8', label: '8%' },
  { id: '10', label: '13%' },
];

/* ------------------------------------------------------------------ listado */

async function renderList(root) {
  root.innerHTML = `
    ${pageHead('Comprobantes de retención', 'Retenciones de renta, IVA e ISD (SRI 07)', `
      <a class="btn" href="#/invoicing">← Comprobantes</a>
      <a class="btn primary" href="#/retentions/new">＋ Nueva retención</a>`)}
    <div class="card">
      <div class="inline" style="margin-bottom:14px">
        <div class="search grow"><input id="rt-search" type="search" placeholder="Buscar por sujeto retenido, número o clave de acceso" /></div>
        <select id="rt-status" style="width:190px">
          <option value="">Todos los estados</option>
          ${option('issued', 'Autorizado', '')}
          ${option('failed', 'Rechazado', '')}
          ${option('draft', 'Borrador', '')}
          ${option('offline', 'Offline', '')}
          ${option('canceled', 'Anulado', '')}
        </select>
        <button class="btn" id="rt-refresh">Actualizar</button>
      </div>
      <div id="rt-table">${spinnerHtml()}</div>
      <div class="flex between center mt-16">
        <span class="muted small" id="rt-count"></span>
        <div class="inline">
          <button class="btn sm" id="rt-prev">← Anterior</button>
          <button class="btn sm" id="rt-next">Siguiente →</button>
        </div>
      </div>
    </div>`;

  const load = async () => {
    const container = document.getElementById('rt-table');
    container.innerHTML = spinnerHtml();
    try {
      const data = await apiGet('/retentions', { status: state.status, q: state.q, page: state.page, limit: 20 });
      document.getElementById('rt-count').textContent = `${data.total} retención(es) · página ${data.page}`;
      renderTable(container, {
        columns: [
          { label: 'Número', render: (row) => `<a class="mono" href="#/retentions/${esc(row.id)}">${esc(row.number)}</a>` },
          {
            label: 'Sujeto retenido',
            render: (row) =>
              `<b>${esc(row.extra?.sujeto?.razonSocial || row.clientName || '—')}</b><div class="small muted mono">${esc(row.extra?.sujeto?.identificacion || row.clientIdNumber || '')}</div>`,
          },
          { label: 'Período', render: (row) => esc(row.extra?.periodoFiscal || '—'), className: 'nowrap' },
          { label: 'Total retenido', align: 'num', render: (row) => money(row.totalCents) },
          { label: 'Fecha', render: (row) => fmtDate(row.issueDate), className: 'nowrap' },
          { label: 'Estado', render: (row) => statusBadge(row.status) },
          {
            label: 'Clave de acceso',
            render: (row) =>
              row.accessKey
                ? `<span class="mono small">${esc(row.accessKey.slice(0, 20))}…</span>
                   <button class="btn ghost sm" data-copy="${esc(row.accessKey)}">copiar</button>`
                : '—',
          },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `<div class="row-actions">
              <a class="btn sm" href="#/retentions/${esc(row.id)}">Ver</a>
              ${row.accessKey ? `<button class="btn sm" data-pdf="${esc(row.id)}">PDF</button><button class="btn sm" data-xml="${esc(row.id)}">XML</button>` : ''}
            </div>`,
          },
        ],
        rows: data.data,
        empty: 'No hay comprobantes de retención',
      });
      container.querySelectorAll('[data-copy]').forEach((button) =>
        button.addEventListener('click', () => copyText(button.dataset.copy)),
      );
      container.querySelectorAll('[data-pdf]').forEach((button) =>
        button.addEventListener('click', () => download(`/vouchers/${button.dataset.pdf}/pdf`, 'retencion.pdf').catch(toastError)),
      );
      container.querySelectorAll('[data-xml]').forEach((button) =>
        button.addEventListener('click', () => download(`/vouchers/${button.dataset.xml}/xml`, 'retencion.xml').catch(toastError)),
      );
    } catch (error) {
      container.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  document.getElementById('rt-search').addEventListener('input', (event) => {
    state.q = event.target.value.trim();
    state.page = 1;
    load();
  });
  document.getElementById('rt-status').addEventListener('change', (event) => {
    state.status = event.target.value;
    state.page = 1;
    load();
  });
  document.getElementById('rt-prev').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      load();
    }
  });
  document.getElementById('rt-next').addEventListener('click', () => {
    state.page += 1;
    load();
  });
  document.getElementById('rt-refresh').addEventListener('click', load);
  await load();
}

/* -------------------------------------------------------------------- detalle */

async function renderDetail(root, ctx) {
  root.innerHTML = `${pageHead('Comprobante de retención', 'Detalle del comprobante')}<div id="rt-detail">${spinnerHtml()}</div>`;
  try {
    const voucher = await apiGet(`/vouchers/${ctx.params.id}`);
    const extra = voucher.extra || {};
    const docs = extra.docs || [];
    document.getElementById('rt-detail').innerHTML = `
      <div class="card">
        <div class="card-head">
          <h3>${esc(voucher.number)} · ${statusBadge(voucher.status)}</h3>
          <div class="inline">
            <a class="btn sm" href="#/retentions">← Volver</a>
            ${voucher.accessKey ? `<button class="btn sm" id="rt-d-pdf">Descargar PDF</button><button class="btn sm" id="rt-d-xml">Descargar XML</button>` : ''}
            ${voucher.status === 'draft' ? `<button class="btn sm primary" id="rt-d-emit">Emitir</button>` : ''}
            ${['failed', 'offline'].includes(voucher.status) ? `<button class="btn sm primary" id="rt-d-retry">Reintentar</button>` : ''}
            ${voucher.status === 'issued' ? `<button class="btn sm danger" id="rt-d-cancel">Anular</button>` : ''}
          </div>
        </div>
        <dl class="kv">
          <dt>Sujeto retenido</dt><dd><b>${esc(extra.sujeto?.razonSocial || voucher.clientName || '—')}</b></dd>
          <dt>Identificación</dt><dd class="mono">${esc(extra.sujeto?.identificacion || voucher.clientIdNumber || '')}</dd>
          <dt>Período fiscal</dt><dd>${esc(extra.periodoFiscal || '—')}</dd>
          <dt>Fecha de emisión</dt><dd>${fmtDate(voucher.issueDate)}</dd>
          <dt>Clave de acceso</dt><dd class="mono" style="word-break:break-all">${esc(voucher.accessKey || '—')}</dd>
          <dt>Autorización</dt><dd class="mono">${esc(voucher.authorizationNumber || '—')}</dd>
          <dt>Fecha de autorización</dt><dd>${voucher.authorizationDate ? fmtDateTime(voucher.authorizationDate) : '—'}</dd>
          <dt>Total retenido</dt><dd><b>${money(voucher.totalCents)}</b></dd>
        </dl>
      </div>
      ${docs
        .map(
          (doc) => `
        <div class="card">
          <h3>Documento de sustento</h3>
          <dl class="kv">
            <dt>Tipo</dt><dd>${esc(doc.codDocSustento)}</dd>
            <dt>Número</dt><dd class="mono">${esc(doc.numDocSustento)}</dd>
            <dt>Fecha de emisión</dt><dd>${esc(doc.fechaEmisionDocSustento)}</dd>
            <dt>Autorización</dt><dd class="mono small">${esc(doc.numAutDocSustento || '—')}</dd>
            <dt>Base / total</dt><dd>${money(doc.totalSinImpuestosCents)} / ${money(doc.importeTotalCents)}</dd>
          </dl>
          <div class="table-wrap mt-16"><table class="tbl">
            <thead><tr><th>Impuesto</th><th>Código</th><th class="num">Tarifa</th><th class="num">Base imponible</th><th class="num">Valor retenido</th></tr></thead>
            <tbody>${(doc.retenciones || [])
              .map(
                (retencion) => `<tr>
                  <td>${esc(retencion.etiqueta || '')}</td>
                  <td class="mono">${esc(retencion.codigo)}/${esc(retencion.codigoPorcentaje)}</td>
                  <td class="num">${retencion.tarifa}%</td>
                  <td class="num">${money(retencion.baseImponibleCents)}</td>
                  <td class="num"><b>${money(retencion.valorRetenidoCents)}</b></td>
                </tr>`,
              )
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
        toast('Comprobante emitido');
        await renderDetail(root, ctx);
      } catch (error) {
        toastError(error);
      }
    };
    document.getElementById('rt-d-emit')?.addEventListener('click', () => emit('emit'));
    document.getElementById('rt-d-retry')?.addEventListener('click', () => emit('retry'));
    document.getElementById('rt-d-cancel')?.addEventListener('click', async () => {
      const ok = await confirmDialog('¿Anular este comprobante de retención?', { okLabel: 'Anular' });
      if (!ok) return;
      try {
        await apiPost(`/vouchers/${voucher.id}/cancel`, {});
        toast('Comprobante anulado');
        await renderDetail(root, ctx);
      } catch (error) {
        toastError(error);
      }
    });
    document.getElementById('rt-d-pdf')?.addEventListener('click', () =>
      download(`/vouchers/${voucher.id}/pdf`, 'retencion.pdf').catch(toastError),
    );
    document.getElementById('rt-d-xml')?.addEventListener('click', () =>
      download(`/vouchers/${voucher.id}/xml`, 'retencion.xml').catch(toastError),
    );
  } catch (error) {
    document.getElementById('rt-detail').innerHTML = `<div class="card"><h3>No se pudo cargar el comprobante</h3><p class="muted">${esc(error.message)}</p></div>`;
  }
}

/* --------------------------------------------------------------- formulario */

function toSriDate(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function monthToPeriodo(value) {
  if (!value) return '';
  const [year, month] = value.split('-');
  return `${month}/${year}`;
}

async function renderForm(root) {
  root.innerHTML = spinnerHtml();
  const options = await apiGet('/retentions/options');
  const establishment = options.establishments[0];
  const point = establishment?.emissionPoints?.[0];
  const retencionSugerencias = [...options.retencionesIVA, ...options.retencionesRentaSugeridas];
  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);

  root.innerHTML = `
    ${pageHead('Nueva retención', 'Comprobante electrónico de retención (SRI 07)', '<a class="btn" href="#/retentions">← Volver</a>')}
    <form id="rt-form">
      <div class="card">
        <h3>Datos del comprobante</h3>
        <div class="form-grid">
          ${field('Establecimiento', `<select name="establishmentId">${options.establishments.map((item) => option(item.id, `${item.code} · ${item.name}`, establishment?.id)).join('')}</select>`)}
          ${field('Punto de emisión', `<select name="emissionPointId">${(establishment?.emissionPoints || []).map((item) => option(item.id, `${item.code} · ${item.name}`, point?.id)).join('')}</select>`)}
          ${field('Fecha de emisión', `<input type="date" name="issueDate" value="${today}" />`)}
          ${field('Período fiscal', `<input type="month" name="periodoFiscal" value="${currentMonth}" />`)}
        </div>
      </div>
      <div class="card">
        <h3>Sujeto retenido</h3>
        <div class="form-grid">
          ${field('Tipo de identificación', `<select name="sujeto_tipo">${options.tiposIdentificacion.map((tipo) => option(tipo.id, tipo.label, '04')).join('')}</select>`)}
          ${field('Identificación', `<input name="sujeto_identificacion" required placeholder="RUC del proveedor" />`)}
          ${field('Razón social', `<input name="sujeto_razonSocial" required />`, { full: true })}
        </div>
      </div>

      <div class="card">
        <h3>Documento de sustento</h3>
        <div class="form-grid">
          ${field('Tipo de documento', `<select name="codDocSustento">${options.tiposDocSustento.map((tipo) => option(tipo.id, tipo.label, '01')).join('')}</select>`)}
          ${field('Código de sustento', `<select name="codSustento">${options.codigosSustento.map((codigo) => option(codigo.id, `${codigo.id} · ${codigo.label}`, '01')).join('')}</select>`)}
          ${field('Número del documento', `<input name="numDocSustento" required placeholder="001-001-000000007" />`)}
          ${field('Fecha de emisión', `<input type="date" name="fechaEmisionDocSustento" value="${today}" />`)}
          ${field('N.º de autorización', `<input name="numAutDocSustento" placeholder="Clave de acceso 49 dígitos" />`, { full: true })}
          ${field('Total sin impuestos (USD)', `<input name="totalSinImpuestos" type="number" step="0.01" min="0" value="0.00" />`)}
          ${field('Importe total (USD)', `<input name="importeTotal" type="number" step="0.01" min="0" value="0.00" />`)}
          ${field('IVA del documento (USD)', `<input name="ivaDocumento" type="number" step="0.01" min="0" value="0.00" />`, { help: 'Base para retenciones de IVA' })}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Retenciones</h3><button class="btn sm" type="button" id="add-retention">＋ Retención</button></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr>
            <th style="width:150px">Impuesto</th>
            <th style="width:130px">Código porcentaje</th>
            <th style="width:110px">Tarifa %</th>
            <th style="width:150px">Base imponible</th>
            <th style="width:150px">Valor retenido</th>
            <th></th>
          </tr></thead>
          <tbody id="retention-rows"></tbody>
        </table></div>
        <div class="totals-box mt-16" style="max-width:320px;margin-left:auto">
          <div class="totals-row grand"><span>Total retenido</span><span id="retention-total">$ 0,00</span></div>
        </div>
      </div>

      <div class="card">
        <div class="inline">
          <button class="btn primary" type="submit">Emitir comprobante de retención</button>
          <button class="btn" type="button" id="rt-draft">Guardar como borrador</button>
          <a class="btn ghost" href="#/retentions">Cancelar</a>
        </div>
        <p class="small muted mt-8">Revise el código de porcentaje de renta/IVA según el catálogo del SRI. La retención no genera stock.</p>
      </div>
    </form>`;

  const rowsContainer = document.getElementById('retention-rows');

  const recalc = () => {
    let total = 0;
    rowsContainer.querySelectorAll('tr').forEach((row) => {
      const tarifa = Number(row.querySelector('[data-field="tarifa"]').value || 0);
      const base = Number(row.querySelector('[data-field="baseImponible"]').value || 0);
      const valueInput = row.querySelector('[data-field="valor"]');
      if (!valueInput.dataset.manual) valueInput.value = ((base * tarifa) / 100).toFixed(2);
      total += Number(valueInput.value || 0);
    });
    document.getElementById('retention-total').textContent = `$ ${total.toFixed(2)}`;
  };

  const addRetention = (preset = {}) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><select data-field="codigo">${option('1', '1 · Renta', preset.codigo || '1')}${option('2', '2 · IVA', preset.codigo)}${option('6', '6 · ISD', preset.codigo)}</select></td>
      <td><input data-field="codigoPorcentaje" list="ret-suggestions" value="${esc(preset.codigoPorcentaje || '303')}" /></td>
      <td><input data-field="tarifa" type="number" step="0.01" value="${preset.tarifa ?? 10}" /></td>
      <td><input data-field="baseImponible" type="number" step="0.01" min="0" value="0.00" /></td>
      <td><input data-field="valor" type="number" step="0.01" min="0" value="0.00" /></td>
      <td class="right"><button class="btn ghost sm" type="button" data-remove>✕</button></td>`;
    row.querySelector('[data-remove]').addEventListener('click', () => {
      row.remove();
      recalc();
    });
    row.querySelectorAll('[data-field="tarifa"], [data-field="baseImponible"]').forEach((input) =>
      input.addEventListener('input', () => {
        row.querySelector('[data-field="valor"]').dataset.manual = '';
        recalc();
      }),
    );
    row.querySelector('[data-field="valor"]').addEventListener('input', (event) => {
      event.target.dataset.manual = '1';
      recalc();
    });
    row.querySelector('[data-field="codigoPorcentaje"]').addEventListener('change', (event) => {
      const suggestion = retencionSugerencias.find((item) => item.codigoPorcentaje === event.target.value);
      if (suggestion) {
        row.querySelector('[data-field="codigo"]').value = suggestion.codigo;
        row.querySelector('[data-field="tarifa"]').value = suggestion.tarifa;
        recalc();
      }
    });
    rowsContainer.appendChild(row);
    recalc();
  };
  addRetention({ codigo: '1', codigoPorcentaje: '303', tarifa: 10 });
  document.getElementById('add-retention').addEventListener('click', () => addRetention());

  const datalist = document.createElement('datalist');
  datalist.id = 'ret-suggestions';
  datalist.innerHTML = retencionSugerencias
    .map((item) => `<option value="${esc(item.codigoPorcentaje)}">${esc(item.label || item.codigoPorcentaje)}</option>`)
    .join('');
  document.body.appendChild(datalist);

  const submit = async (draft) => {
    const form = document.getElementById('rt-form');
    const values = readForm(form);
    const retenciones = Array.from(rowsContainer.querySelectorAll('tr')).map((row) => {
      const codigo = row.querySelector('[data-field="codigo"]').value;
      const codigoPorcentaje = row.querySelector('[data-field="codigoPorcentaje"]').value;
      const suggestion = retencionSugerencias.find(
        (item) => item.codigoPorcentaje === codigoPorcentaje && item.codigo === codigo,
      );
      return {
        codigo,
        etiqueta: codigo === '2' ? 'IVA' : codigo === '6' ? 'ISD' : 'Renta',
        codigoPorcentaje,
        tarifa: Number(row.querySelector('[data-field="tarifa"]').value || 0),
        baseImponibleCents: Math.round(Number(row.querySelector('[data-field="baseImponible"]').value || 0) * 100),
        valorRetenidoCents: Math.round(Number(row.querySelector('[data-field="valor"]').value || 0) * 100),
        _label: suggestion?.label,
      };
    });
    if (!retenciones.length) {
      toast('Agregue al menos una retención', 'warn');
      return;
    }
    const ivaCents = Math.round(Number(values.ivaDocumento || 0) * 100);
    const payload = {
      establishmentId: values.establishmentId,
      emissionPointId: values.emissionPointId,
      issueDate: values.issueDate,
      draft,
      sujeto: {
        tipoIdentificacion: values.sujeto_tipo,
        identificacion: values.sujeto_identificacion,
        razonSocial: values.sujeto_razonSocial,
      },
      periodoFiscal: monthToPeriodo(values.periodoFiscal),
      docs: [
        {
          codSustento: values.codSustento,
          codDocSustento: values.codDocSustento,
          numDocSustento: values.numDocSustento,
          fechaEmisionDocSustento: toSriDate(values.fechaEmisionDocSustento),
          numAutDocSustento: values.numAutDocSustento,
          pagoLocExt: '01',
          totalSinImpuestosCents: Math.round(Number(values.totalSinImpuestos || 0) * 100),
          importeTotalCents: Math.round(Number(values.importeTotal || 0) * 100),
          impuestos: [{ codImpuestoDocSustento: '2', codigoPorcentaje: '4', baseImponibleCents: 0, tarifa: 0, valorImpuestoCents: ivaCents }],
          retenciones,
        },
      ],
    };
    try {
      const created = await apiPost('/retentions', payload);
      if (draft) {
        toast('Retención guardada como borrador');
        location.hash = `#/retentions/${created.id}`;
        return;
      }
      showResult(created);
    } catch (error) {
      toastError(error);
    }
  };

  document.getElementById('rt-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submit(false);
  });
  document.getElementById('rt-draft').addEventListener('click', () => submit(true));
}

function showResult(voucher) {
  const messages = voucher.sriMessages || [];
  modal({
    title: `Retención · ${voucher.number}`,
    size: 'lg',
    body: `
      <div class="flex center gap-12" style="margin-bottom:14px">
        ${statusBadge(voucher.status)}
        <span class="muted small">Total retenido: ${money(voucher.totalCents)}</span>
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
      { label: 'Descargar RIDE', onClick: () => download(`/vouchers/${voucher.id}/pdf`, 'retencion.pdf').catch(toastError) },
      {
        label: 'Ver detalle',
        className: 'primary',
        onClick: () => {
          closeModal();
          location.hash = `#/retentions/${voucher.id}`;
        },
      },
    ],
  });
}
