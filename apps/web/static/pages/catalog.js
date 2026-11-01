/**
 * Catálogo: productos, servicios, categorías y unidades de medida.
 * Contrato de página: `export async function render(root, ctx)`.
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  centsFromInput,
  closeModal,
  confirmDialog,
  debounce,
  decimalFromCents,
  esc,
  field,
  fmtQty,
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

const PAGE_SIZE = 25;

/* ------------------------------------------------------------------ utils */

function errorCard(message, backHref = '#/') {
  return `<div class="card">
    <h3>No se pudo cargar la pantalla</h3>
    <p class="muted">${esc(message)}</p>
    <a class="btn" href="${esc(backHref)}">Volver</a>
  </div>`;
}

function footerHtml() {
  return `<div class="flex between center mt-16">
    <span class="muted small" id="list-count"></span>
    <div class="inline">
      <button class="btn sm" id="prev-page" type="button">← Anterior</button>
      <button class="btn sm" id="next-page" type="button">Siguiente →</button>
    </div>
  </div>`;
}

function syncPager(page, limit, total) {
  const prev = document.getElementById('prev-page');
  const next = document.getElementById('next-page');
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page * limit >= total;
}

/* ----------------------------------------------------------- productos/servicios */

async function renderProductList(root, ctx, type) {
  const isService = type === 'service';
  const base = isService ? '/services' : '/products';
  const noun = isService ? 'servicio' : 'producto';
  const state = { page: 1, q: '', status: '', categoryId: '' };
  let categories = [];
  let total = 0;

  root.innerHTML = `
    ${pageHead(
      isService ? 'Servicios' : 'Productos',
      isService ? 'Servicios facturables del catálogo' : 'Bienes facturables y su inventario',
      `<a class="btn" href="#/categories">Categorías</a>
       <a class="btn" href="#/units">Unidades</a>
       <a class="btn primary" href="#${base}/new">＋ Nuevo ${noun}</a>`,
    )}
    <div class="card">
      <div class="inline" style="margin-bottom:14px">
        <div class="search grow"><input id="product-search" type="search" placeholder="Buscar por código o descripción" /></div>
        <select id="product-status" style="width:170px">
          <option value="">Todos los estados</option>
          ${option('active', 'Activos')}${option('inactive', 'Inactivos')}
        </select>
        <select id="product-category" style="width:230px"><option value="">Todas las categorías</option></select>
      </div>
      <div id="products-table">${spinnerHtml()}</div>
      ${footerHtml()}
    </div>`;

  try {
    const catalogs = await apiGet('/catalogs');
    categories = Array.isArray(catalogs.categories) ? catalogs.categories : [];
  } catch {
    categories = [];
  }
  const categoryName = (id) => categories.find((category) => category.id === id)?.name || '—';
  const categorySelect = document.getElementById('product-category');
  categorySelect.innerHTML =
    '<option value="">Todas las categorías</option>' +
    categories.map((category) => option(category.id, category.name, state.categoryId)).join('');

  const load = async () => {
    const table = document.getElementById('products-table');
    renderTable(table, { columns: [], rows: [], loading: true });
    try {
      const data = await apiGet('/products', {
        type,
        q: state.q,
        status: state.status,
        categoryId: state.categoryId,
        page: state.page,
        limit: PAGE_SIZE,
      });
      const rows = Array.isArray(data.data) ? data.data : [];
      total = Number(data.total || 0);
      const count = document.getElementById('list-count');
      if (count) count.textContent = `${total} ${noun}(s) · página ${data.page || state.page}`;

      renderTable(table, {
        columns: [
          {
            label: 'Código',
            render: (row) =>
              `<span class="mono">${esc(row.code)}</span>${
                row.auxCode && row.auxCode !== row.code ? `<div class="muted small">${esc(row.auxCode)}</div>` : ''
              }`,
          },
          { label: 'Descripción', render: (row) => `<b>${esc(row.description)}</b>` },
          { label: 'Categoría', render: (row) => esc(categoryName(row.categoryId)) },
          { label: 'Precio', align: 'num', render: (row) => money(row.priceCents) },
          { label: 'Costo', align: 'num', render: (row) => money(row.costCents) },
          {
            label: 'Stock total',
            align: 'num',
            render: (row) => {
              if (isService) return '<span class="muted">—</span>';
              const low = Number(row.minStock) > 0 && Number(row.totalStock) <= Number(row.minStock);
              return `${fmtQty(row.totalStock)}${low ? ' <span class="badge red">bajo</span>' : ''}`;
            },
          },
          { label: 'Estado', render: (row) => statusBadge(row.status) },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `<div class="row-actions">
              <a class="btn sm" href="#${base}/${esc(row.id)}/edit">Editar</a>
              ${
                row.status === 'active'
                  ? `<button class="btn sm danger" type="button" data-delete="${esc(row.id)}">Desactivar</button>`
                  : `<button class="btn sm" type="button" data-activate="${esc(row.id)}">Activar</button>`
              }
            </div>`,
          },
        ],
        rows,
        empty: isService ? 'No hay servicios registrados' : 'No hay productos registrados',
      });

      table.querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          const ok = await confirmDialog(
            `¿Desactivar este ${noun}? No se borra del histórico, pero no podrá elegirse en nuevos comprobantes.`,
            { okLabel: 'Desactivar' },
          );
          if (!ok) return;
          try {
            await apiDelete(`/products/${button.dataset.delete}`);
            toast(`${isService ? 'Servicio' : 'Producto'} desactivado`);
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
      table.querySelectorAll('[data-activate]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            await apiPut(`/products/${button.dataset.activate}`, { status: 'active' });
            toast(`${isService ? 'Servicio' : 'Producto'} activado`);
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
      syncPager(state.page, PAGE_SIZE, total);
    } catch (error) {
      table.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  document.getElementById('product-search').addEventListener(
    'input',
    debounce((event) => {
      state.q = event.target.value.trim();
      state.page = 1;
      load();
    }, 300),
  );
  document.getElementById('product-status').addEventListener('change', (event) => {
    state.status = event.target.value;
    state.page = 1;
    load();
  });
  categorySelect.addEventListener('change', (event) => {
    state.categoryId = event.target.value;
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
    if (state.page * PAGE_SIZE < total) {
      state.page += 1;
      load();
    }
  });

  await load();
  void ctx;
}

/* ---------------------------------------------------------- formulario producto */

async function renderProductForm(root, ctx, type, id) {
  const isService = type === 'service';
  const base = isService ? '/services' : '/products';
  const isEdit = Boolean(id);
  root.innerHTML = spinnerHtml();

  let catalogs = {};
  let product = null;
  try {
    const [catalogsData, productData] = await Promise.all([
      apiGet('/catalogs'),
      isEdit ? apiGet(`/products/${id}`) : Promise.resolve(null),
    ]);
    catalogs = catalogsData || {};
    product = productData;
  } catch (error) {
    root.innerHTML = errorCard(error.message, base);
    toastError(error);
    return;
  }

  if (isEdit && product?.type && product.type !== type) {
    toast(`El registro es de tipo ${product.type === 'service' ? 'servicio' : 'producto'}`, 'warn');
  }

  const categories = Array.isArray(catalogs.categories) ? catalogs.categories : [];
  const units = Array.isArray(catalogs.units) ? catalogs.units : [];
  const ivaList = Array.isArray(catalogs.porcentajesDeIVA) ? catalogs.porcentajesDeIVA : [];
  const iceList = Array.isArray(catalogs.porcentajesDeICE) ? catalogs.porcentajesDeICE : [];
  const selectedIva = product?.ivaCode || '4';
  const selectedIce = product?.iceCode || '';

  root.innerHTML = `
    ${pageHead(
      isEdit ? `Editar ${isService ? 'servicio' : 'producto'}` : `Nuevo ${isService ? 'servicio' : 'producto'}`,
      isEdit ? `${product?.code || ''} · ${product?.description || ''}` : 'Complete los datos del catálogo',
      `<a class="btn" href="#${base}">← Volver</a>`,
    )}
    <div class="card">
      <form id="product-form" novalidate>
        <div class="form-grid">
          ${field(
            'Código',
            `<input name="code" required maxlength="60" value="${esc(product?.code || '')}" ${
              isEdit ? 'readonly' : ''
            } placeholder="P001" />`,
            { help: isEdit ? 'El código no se puede modificar' : 'Único por tipo (producto/servicio)' },
          )}
          ${field('Código auxiliar', `<input name="auxCode" maxlength="60" value="${esc(product?.auxCode || '')}" placeholder="Opcional" />`)}
          ${field(
            'Descripción',
            `<input name="description" required maxlength="300" value="${esc(product?.description || '')}" placeholder="Nombre del ${isService ? 'servicio' : 'producto'}" />`,
            { full: true },
          )}
          ${field(
            'Categoría',
            `<select name="categoryId"><option value="">— Sin categoría —</option>${categories
              .map((category) => option(category.id, category.name, product?.categoryId))
              .join('')}</select>`,
          )}
          ${field(
            'Unidad de medida',
            `<select name="unitId"><option value="">— Sin unidad —</option>${units
              .map((unit) => option(unit.id, `${unit.name} (${unit.code})`, product?.unitId))
              .join('')}</select>`,
          )}
          ${field(
            'Precio de venta (USD)',
            `<input name="price" type="number" min="0" step="0.01" required value="${
              product ? decimalFromCents(product.priceCents) : '0.00'
            }" />`,
          )}
          ${field(
            'Costo (USD)',
            `<input name="cost" type="number" min="0" step="0.01" value="${
              product ? decimalFromCents(product.costCents) : '0.00'
            }" />`,
            { help: 'Costo de compra; base del costo promedio en ingresos' },
          )}
          ${field(
            'IVA',
            `<select name="ivaCode" required>${ivaList
              .map((iva) => option(iva.id, iva.description, selectedIva))
              .join('')}</select>`,
          )}
          ${field(
            'ICE (opcional)',
            `<select name="iceCode"><option value="">— Sin ICE —</option>${iceList
              .map((ice) => option(ice.id, ice.description, selectedIce))
              .join('')}</select>`,
          )}
          ${field(
            'Stock mínimo',
            `<input name="minStock" type="number" min="0" step="0.01" value="${
              product ? Number(product.minStock) : 0
            }" />`,
            { help: 'Alerta de stock bajo en inventario' },
          )}
          ${field(
            'Estado',
            `<select name="status">${option('active', 'Activo', product?.status || 'active')}${option(
              'inactive',
              'Inactivo',
              product?.status,
            )}</select>`,
          )}
          ${field(
            'Control de stock',
            `<label class="check"><input type="checkbox" name="trackStock" ${
              product ? (product.trackStock ? 'checked' : '') : isService ? '' : 'checked'
            } /> Llevar inventario (Kardex)</label>`,
            {
              full: true,
              help: isService
                ? 'Los servicios normalmente no manejan stock'
                : 'Solo los productos con stock generan movimientos de Kardex',
            },
          )}
        </div>
        <div class="flex gap-8 mt-16">
          <button class="btn primary" type="submit">${isEdit ? 'Guardar cambios' : `Crear ${isService ? 'servicio' : 'producto'}`}</button>
          <a class="btn" href="#${base}">Cancelar</a>
        </div>
      </form>
    </div>`;

  const form = document.getElementById('product-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const values = readForm(form);
    const body = {
      type,
      code: String(values.code || '').trim(),
      auxCode: String(values.auxCode || '').trim() || null,
      description: String(values.description || '').trim(),
      categoryId: values.categoryId || null,
      unitId: values.unitId || null,
      priceCents: centsFromInput(values.price),
      costCents: centsFromInput(values.cost),
      ivaCode: values.ivaCode,
      iceCode: values.iceCode || null,
      trackStock: Boolean(values.trackStock),
      minStock: Number(values.minStock || 0),
      status: values.status,
    };
    const submitButton = form.querySelector('button[type=submit]');
    submitButton.disabled = true;
    const label = submitButton.textContent;
    submitButton.textContent = 'Guardando…';
    try {
      if (isEdit) await apiPut(`/products/${id}`, body);
      else await apiPost('/products', body);
      toast(isEdit ? 'Cambios guardados' : `${isService ? 'Servicio' : 'Producto'} creado`);
      ctx.navigate(base);
    } catch (error) {
      toastError(error);
      submitButton.disabled = false;
      submitButton.textContent = label;
    }
  });
}

/* --------------------------------------------------------------- categorías */

async function renderCategories(root, ctx) {
  root.innerHTML = `
    ${pageHead(
      'Categorías',
      'Agrupación del catálogo de productos y servicios',
      '<button class="btn primary" type="button" id="new-category">＋ Nueva categoría</button>',
    )}
    <div class="card"><div id="categories-table">${spinnerHtml()}</div></div>`;

  let items = [];

  const openForm = (category) => {
    const isEdit = Boolean(category);
    const body = `<form id="category-form">
      <div class="form-grid">
        ${field('Nombre', `<input name="name" required maxlength="200" value="${esc(category?.name || '')}" placeholder="Ej. Alimentos y bebidas" />`, { full: true })}
        ${field(
          'Categoría padre (opcional)',
          `<select name="parentId"><option value="">— Ninguna —</option>${items
            .filter((item) => item.id !== category?.id)
            .map((item) => option(item.id, item.name, category?.parentId))
            .join('')}</select>`,
          { full: true, help: 'Permite organizar el catálogo en jerarquía' },
        )}
      </div>
    </form>`;
    const modalEl = modal({
      title: isEdit ? 'Editar categoría' : 'Nueva categoría',
      body,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: isEdit ? 'Guardar cambios' : 'Crear categoría',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#category-form');
            if (!form.reportValidity()) return;
            const values = readForm(form);
            try {
              const payload = { name: String(values.name).trim(), parentId: values.parentId || null };
              if (isEdit) await apiPut(`/categories/${category.id}`, payload);
              else await apiPost('/categories', payload);
              closeModal();
              toast(isEdit ? 'Categoría actualizada' : 'Categoría creada');
              await load();
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  };

  const load = async () => {
    const container = document.getElementById('categories-table');
    renderTable(container, { columns: [], rows: [], loading: true });
    try {
      const data = await apiGet('/categories');
      items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      const nameById = new Map(items.map((category) => [category.id, category.name]));
      renderTable(container, {
        columns: [
          { label: 'Nombre', render: (row) => `<b>${esc(row.name)}</b>` },
          {
            label: 'Categoría padre',
            render: (row) => (row.parentId ? esc(nameById.get(row.parentId) || '—') : '<span class="muted">—</span>'),
          },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `<div class="row-actions">
              <button class="btn sm" type="button" data-edit="${esc(row.id)}">Editar</button>
              <button class="btn sm danger" type="button" data-delete="${esc(row.id)}">Eliminar</button>
            </div>`,
          },
        ],
        rows: items,
        empty: 'No hay categorías registradas',
      });
      container.querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => {
          const category = items.find((item) => item.id === button.dataset.edit);
          openForm(category || null);
        });
      });
      container.querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          const category = items.find((item) => item.id === button.dataset.delete);
          const ok = await confirmDialog(
            `¿Eliminar la categoría "${category?.name || ''}"? Los productos quedarán sin categoría.`,
            { okLabel: 'Eliminar' },
          );
          if (!ok) return;
          try {
            await apiDelete(`/categories/${button.dataset.delete}`);
            toast('Categoría eliminada');
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  document.getElementById('new-category').addEventListener('click', () => openForm(null));
  await load();
  void ctx;
}

/* ---------------------------------------------------------------- unidades */

async function renderUnits(root, ctx) {
  root.innerHTML = `
    ${pageHead(
      'Unidades de medida',
      'Unidades usadas en los ítems de comprobantes',
      '<button class="btn primary" type="button" id="new-unit">＋ Nueva unidad</button>',
    )}
    <div class="card"><div id="units-table">${spinnerHtml()}</div></div>`;

  let items = [];

  const openForm = (unit) => {
    const isEdit = Boolean(unit);
    const body = `<form id="unit-form">
      <div class="form-grid">
        ${field('Código', `<input name="code" required maxlength="10" value="${esc(unit?.code || '')}" placeholder="UNI" ${isEdit ? '' : 'style="text-transform:uppercase"'} />`, { help: 'Código del SRI (UNI, KG, LT…)' })}
        ${field('Nombre', `<input name="name" required maxlength="120" value="${esc(unit?.name || '')}" placeholder="Unidad" />`)}
        ${field('Abreviatura', `<input name="abbr" maxlength="20" value="${esc(unit?.abbr || '')}" placeholder="U" />`, { full: true })}
      </div>
    </form>`;
    const modalEl = modal({
      title: isEdit ? 'Editar unidad' : 'Nueva unidad',
      body,
      actions: [
        { label: 'Cancelar', onClick: closeModal },
        {
          label: isEdit ? 'Guardar cambios' : 'Crear unidad',
          className: 'primary',
          onClick: async () => {
            const form = modalEl.querySelector('#unit-form');
            if (!form.reportValidity()) return;
            const values = readForm(form);
            try {
              const payload = {
                code: String(values.code).trim().toUpperCase(),
                name: String(values.name).trim(),
                abbr: String(values.abbr || '').trim() || null,
              };
              if (isEdit) await apiPut(`/units/${unit.id}`, payload);
              else await apiPost('/units', payload);
              closeModal();
              toast(isEdit ? 'Unidad actualizada' : 'Unidad creada');
              await load();
            } catch (error) {
              toastError(error);
            }
          },
        },
      ],
    });
  };

  const load = async () => {
    const container = document.getElementById('units-table');
    renderTable(container, { columns: [], rows: [], loading: true });
    try {
      const data = await apiGet('/units');
      items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      renderTable(container, {
        columns: [
          { label: 'Código', render: (row) => `<span class="mono">${esc(row.code)}</span>` },
          { label: 'Nombre', render: (row) => `<b>${esc(row.name)}</b>` },
          { label: 'Abreviatura', render: (row) => esc(row.abbr || '—') },
          {
            label: 'Acciones',
            align: 'right',
            render: (row) => `<div class="row-actions">
              <button class="btn sm" type="button" data-edit="${esc(row.id)}">Editar</button>
              <button class="btn sm danger" type="button" data-delete="${esc(row.id)}">Eliminar</button>
            </div>`,
          },
        ],
        rows: items,
        empty: 'No hay unidades de medida registradas',
      });
      container.querySelectorAll('[data-edit]').forEach((button) => {
        button.addEventListener('click', () => {
          const unit = items.find((item) => item.id === button.dataset.edit);
          openForm(unit || null);
        });
      });
      container.querySelectorAll('[data-delete]').forEach((button) => {
        button.addEventListener('click', async () => {
          const unit = items.find((item) => item.id === button.dataset.delete);
          const ok = await confirmDialog(
            `¿Eliminar la unidad "${unit?.name || ''}"? Los productos quedarán sin unidad.`,
            { okLabel: 'Eliminar' },
          );
          if (!ok) return;
          try {
            await apiDelete(`/units/${button.dataset.delete}`);
            toast('Unidad eliminada');
            await load();
          } catch (error) {
            toastError(error);
          }
        });
      });
    } catch (error) {
      container.innerHTML = `<div class="empty-state"><div class="icon">⚠</div>${esc(error.message)}</div>`;
      toastError(error);
    }
  };

  document.getElementById('new-unit').addEventListener('click', () => openForm(null));
  await load();
  void ctx;
}

/* ------------------------------------------------------------------ router */

export async function render(root, ctx) {
  const path = ctx.path;

  if (path === '/categories') return renderCategories(root, ctx);
  if (path === '/units') return renderUnits(root, ctx);

  const isService = path.startsWith('/services');
  const type = isService ? 'service' : 'product';
  if (ctx.params && ctx.params.id) return renderProductForm(root, ctx, type, ctx.params.id);
  if (path.endsWith('/new')) return renderProductForm(root, ctx, type, null);
  return renderProductList(root, ctx, type);
}
