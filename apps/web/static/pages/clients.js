/** Clientes: listado y CRUD en modal. */

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  closeModal,
  confirmDialog,
  esc,
  field,
  modal,
  option,
  pageHead,
  readForm,
  renderTable,
  spinnerHtml,
  toast,
  toastError,
} from '../lib.js';

const ID_TYPES = [
  { id: '04', label: 'RUC' },
  { id: '05', label: 'Cédula' },
  { id: '06', label: 'Pasaporte' },
  { id: '07', label: 'Consumidor Final' },
  { id: '08', label: 'Identificación del exterior' },
  { id: '09', label: 'Placa' },
];

const state = { page: 1, q: '', idType: '' };

export async function render(root, ctx) {
  root.innerHTML = `
    ${pageHead('Clientes', 'Receptores de comprobantes electrónicos', '<button class="btn primary" id="new-client">＋ Nuevo cliente</button>')}
    <div class="card">
      <div class="inline" style="margin-bottom:14px">
        <div class="search grow"><input id="client-search" type="search" placeholder="Buscar por nombre, identificación o correo" value="${esc(state.q)}" /></div>
        <select id="client-idtype" style="width:220px">
          <option value="">Todos los tipos</option>
          ${ID_TYPES.map((type) => option(type.id, type.label, state.idType)).join('')}
        </select>
      </div>
      <div id="clients-table">${spinnerHtml()}</div>
      <div class="flex between center mt-16">
        <span class="muted small" id="clients-count"></span>
        <div class="inline">
          <button class="btn sm" id="prev-page">← Anterior</button>
          <button class="btn sm" id="next-page">Siguiente →</button>
        </div>
      </div>
    </div>`;

  const load = async () => {
    const table = document.getElementById('clients-table');
    table.innerHTML = spinnerHtml();
    try {
      const data = await apiGet('/clients', { q: state.q, idType: state.idType, page: state.page, limit: 20 });
      document.getElementById('clients-count').textContent = `${data.total} cliente(s) · página ${data.page}`;
      renderTable(table, {
        columns: [
          { label: 'Identificación', render: (row) => `<span class="mono">${esc(row.idNumber)}</span>` },
          { label: 'Tipo', render: (row) => esc(ID_TYPES.find((type) => type.id === row.idType)?.label || row.idType) },
          { label: 'Nombre / Razón social', render: (row) => `<b>${esc(row.name)}</b>` },
          { label: 'Correo', render: (row) => esc(row.email || '—') },
          { label: 'Teléfono', render: (row) => esc(row.phone || '—') },
          { label: 'Dirección', render: (row) => `<span class="truncate">${esc(row.address || '—')}</span>` },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `
              <div class="row-actions">
                <button class="btn sm" data-edit="${esc(row.id)}">Editar</button>
                <button class="btn sm danger" data-delete="${esc(row.id)}">Desactivar</button>
              </div>`,
          },
        ],
        rows: data.data,
        empty: 'No hay clientes registrados',
      });
      table.querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => {
          const client = data.data.find((item) => item.id === button.dataset.edit);
          openForm(client);
        });
      });
      table.querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          const ok = await confirmDialog('¿Desactivar este cliente? No podrá usarse en nuevos comprobantes.', {
            okLabel: 'Desactivar',
          });
          if (!ok) return;
          try {
            await apiDelete(`/clients/${button.dataset.delete}`);
            toast('Cliente desactivado');
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
    } catch (error) {
      table.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  const openForm = (client) => {
    const isEdit = Boolean(client);
    const body = `
      <form id="client-form">
        <div class="form-grid">
          ${field('Tipo de identificación', `<select name="idType">${ID_TYPES.map((type) => option(type.id, type.label, client?.idType || '04')).join('')}</select>`)}
          ${field('Identificación', `<input name="idNumber" type="text" value="${esc(client?.idNumber || '')}" placeholder="1792456789001" required />`, { help: 'RUC 13 dígitos, cédula 10 dígitos, pasaporte alfanumérico' })}
          ${field('Nombre / Razón social', `<input name="name" type="text" value="${esc(client?.name || '')}" required />`, { full: true })}
          ${field('Correo electrónico', `<input name="email" type="email" value="${esc(client?.email || '')}" placeholder="cliente@correo.ec" />`)}
          ${field('Teléfono', `<input name="phone" type="text" value="${esc(client?.phone || '')}" placeholder="0999999999" />`)}
          ${field('Dirección', `<input name="address" type="text" value="${esc(client?.address || '')}" placeholder="Ciudad, calle y número" />`, { full: true })}
          ${field('Tipo de persona', `<select name="subjectType">${option('01', 'Persona natural', client?.subjectType || '01')}${option('02', 'Sociedad', client?.subjectType)}</select>`)}
        </div>
      </form>`;
    const modalEl = modal({
      title: isEdit ? 'Editar cliente' : 'Nuevo cliente',
      body,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: isEdit ? 'Guardar cambios' : 'Crear cliente',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#client-form');
            if (!form.reportValidity()) return;
            const values = readForm(form);
            try {
              if (isEdit) await apiPut(`/clients/${client.id}`, values);
              else await apiPost('/clients', values);
              closeModal();
              toast(isEdit ? 'Cliente actualizado' : 'Cliente creado');
              await load();
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  };

  document.getElementById('new-client').addEventListener('click', () => openForm(null));
  document.getElementById('client-search').addEventListener('input', (event) => {
    state.q = event.target.value.trim();
    state.page = 1;
    load();
  });
  document.getElementById('client-idtype').addEventListener('change', (event) => {
    state.idType = event.target.value;
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
    state.page += 1;
    load();
  });

  await load();
  void ctx;
}
