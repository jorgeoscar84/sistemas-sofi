/**
 * Datos iniciales de la plataforma multiempresa:
 *  - superadministrador de la plataforma,
 *  - empresa demo (licencia activa) con su administrador y usuarios de roles,
 *  - catálogo, clientes, inventario y comprobantes de ejemplo.
 *
 * Uso:
 *   node apps/api/src/seed.ts            (crea la plataforma si está vacía)
 *   node apps/api/src/seed.ts --force    (elimina bases de datos y vuelve a sembrar)
 */

import { hashPassword } from './http.ts';
import {
  audit,
  execute,
  initPlatformDb,
  nowIso,
  pOne,
  pExec,
  removeAllDatabases,
  runWithTenant,
  queryOne,
} from './db.ts';
import { newId } from './ids.ts';
import { getCompany } from './modules/company.ts';
import { ensureConsumidorFinal } from './modules/clients.ts';
import { createStockVoucher } from './modules/inventory.ts';
import { createVoucher } from './modules/invoicing.ts';
import { config } from './config.ts';
import { addCompanyUser, provisionCompany } from './provisioning.ts';

function sriDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

function createPlatformUser(input: {
  username: string;
  password: string;
  name: string;
  email?: string;
  role: string;
  companyId?: string | null;
}): string {
  const id = newId();
  const now = nowIso();
  pExec(
    `INSERT INTO platform_users (id, company_id, username, password_hash, name, email, role, permissions, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.companyId ?? null,
      input.username,
      hashPassword(input.password),
      input.name,
      input.email ?? null,
      input.role,
      '[]',
      'active',
      now,
      now,
    ],
  );
  return id;
}

function seedTenantData(adminId: string): void {
  const company = getCompany();

  /* ---------------------------------------------------------- bodegas */
  let warehouse = queryOne<Record<string, unknown>>('SELECT * FROM warehouses ORDER BY code ASC LIMIT 1');
  if (!warehouse) {
    const id = newId();
    execute('INSERT INTO warehouses (id, code, name, description, color, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [
      id,
      'BOD01',
      'Bodega principal',
      'Bodega de la matriz',
      '#ff5a1f',
      'active',
      nowIso(),
      nowIso(),
    ]);
    warehouse = queryOne<Record<string, unknown>>('SELECT * FROM warehouses WHERE id = ?', [id])!;
  }
  let secondWarehouse = queryOne<Record<string, unknown>>("SELECT * FROM warehouses WHERE code = 'BOD02'");
  if (!secondWarehouse) {
    const id = newId();
    execute('INSERT INTO warehouses (id, code, name, description, color, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [
      id,
      'BOD02',
      'Bodega secundaria',
      'Bodega de sucursal',
      '#2563eb',
      'active',
      nowIso(),
      nowIso(),
    ]);
    secondWarehouse = queryOne<Record<string, unknown>>('SELECT * FROM warehouses WHERE id = ?', [id])!;
  }

  /* --------------------------------------------- unidades y categorías */
  const unitRow = queryOne<Record<string, unknown>>('SELECT * FROM units ORDER BY code ASC LIMIT 1');
  const categoryRow = queryOne<Record<string, unknown>>('SELECT * FROM categories ORDER BY name ASC LIMIT 1');
  const unitId = unitRow ? String(unitRow.id) : null;
  const categoryId = categoryRow ? String(categoryRow.id) : null;

  /* -------------------------------------------------- productos/servicios */
  const products: {
    type: string;
    code: string;
    description: string;
    priceCents: number;
    costCents: number;
    ivaCode: string;
    trackStock: boolean;
    minStock: number;
  }[] = [
    { type: 'product', code: 'P001', description: 'Laptop Lenovo ThinkPad E14', priceCents: 89900, costCents: 72000, ivaCode: '4', trackStock: true, minStock: 3 },
    { type: 'product', code: 'P002', description: 'Monitor LG 24" Full HD', priceCents: 18900, costCents: 14500, ivaCode: '4', trackStock: true, minStock: 5 },
    { type: 'product', code: 'P003', description: 'Teclado mecánico USB', priceCents: 4550, costCents: 3100, ivaCode: '4', trackStock: true, minStock: 10 },
    { type: 'product', code: 'P004', description: 'Mouse inalámbrico Logitech', priceCents: 2900, costCents: 2000, ivaCode: '4', trackStock: true, minStock: 10 },
    { type: 'product', code: 'P005', description: 'Café molido 500g', priceCents: 950, costCents: 600, ivaCode: '4', trackStock: true, minStock: 20 },
    { type: 'product', code: 'P006', description: 'Agua mineral 1L', priceCents: 120, costCents: 60, ivaCode: '0', trackStock: true, minStock: 50 },
    { type: 'service', code: 'S001', description: 'Soporte técnico mensual', priceCents: 15000, costCents: 0, ivaCode: '4', trackStock: false, minStock: 0 },
    { type: 'service', code: 'S002', description: 'Instalación de red y configuración', priceCents: 25000, costCents: 0, ivaCode: '4', trackStock: false, minStock: 0 },
    { type: 'service', code: 'S003', description: 'Mantenimiento preventivo de equipos', priceCents: 8000, costCents: 0, ivaCode: '4', trackStock: false, minStock: 0 },
  ];
  for (const product of products) {
    if (queryOne('SELECT id FROM products WHERE type = ? AND code = ?', [product.type, product.code])) continue;
    execute(
      `INSERT INTO products (id, type, code, aux_code, description, category_id, unit_id, price_cents, cost_cents,
        iva_code, ice_code, irbpnr_code, status, track_stock, min_stock, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId(),
        product.type,
        product.code,
        product.code,
        product.description,
        categoryId,
        unitId,
        product.priceCents,
        product.costCents,
        product.ivaCode,
        null,
        null,
        'active',
        product.trackStock ? 1 : 0,
        product.minStock,
        nowIso(),
        nowIso(),
      ],
    );
  }

  /* ------------------------------------------------------------ clientes */
  const clients = [
    { idType: '04', idNumber: '1752048122001', name: 'ALEJANDRO TES', email: 'alejandro@correo.ec', address: 'Quito' },
    { idType: '04', idNumber: '1792146141001', name: 'DISTRIBUIDORA ANDINA S.A.', email: 'compras@andina.ec', address: 'Guayaquil' },
    { idType: '05', idNumber: '1710034065', name: 'María Fernanda López', email: 'maria.lopez@correo.ec', address: 'Quito' },
    { idType: '05', idNumber: '0926687856', name: 'Carlos Andrés Vera', email: 'carlos.vera@correo.ec', address: 'Guayaquil' },
  ];
  for (const client of clients) {
    if (queryOne('SELECT id FROM clients WHERE id_type = ? AND id_number = ?', [client.idType, client.idNumber])) continue;
    execute(
      'INSERT INTO clients (id, id_type, id_number, name, email, phone, address, subject_type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [newId(), client.idType, client.idNumber, client.name, client.email, null, client.address, '01', 'active', nowIso(), nowIso()],
    );
  }
  const consumidorFinal = ensureConsumidorFinal();

  /* ----------------------------------------------------------- inventario */
  const productRows = ['P001', 'P002', 'P003', 'P004', 'P005', 'P006'].map((code) =>
    queryOne<{ id: string; cost_cents: number }>('SELECT id, cost_cents FROM products WHERE code = ?', [code])!,
  );
  const stockExists = queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM stock_vouchers WHERE type = 'income'");
  if ((stockExists?.total ?? 0) === 0) {
    createStockVoucher(
      {
        type: 'income',
        warehouseId: String(warehouse.id),
        provider: 'PROVEEDOR INICIAL S.A.',
        observation: 'Carga inicial de inventario',
        items: productRows.map((product) => ({
          productId: product.id,
          quantity: 25,
          unitCostCents: product.cost_cents,
        })),
      },
      null,
    );
    createStockVoucher(
      {
        type: 'transfer',
        warehouseId: String(warehouse.id),
        toWarehouseId: String(secondWarehouse.id),
        observation: 'Transferencia a bodega secundaria',
        items: [{ productId: productRows[0]!.id, quantity: 5, unitCostCents: productRows[0]!.cost_cents }],
      },
      null,
    );
  }

  /* -------------------------------------------------- comprobantes demo */
  const voucherCount = queryOne<{ total: number }>('SELECT COUNT(*) AS total FROM vouchers');
  if ((voucherCount?.total ?? 0) > 0) return;

  const clientRows = ['1752048122001', '1792146141001', '1710034065'].map((idNumber) =>
    queryOne<{ id: string; name: string }>('SELECT id, name FROM clients WHERE id_number = ?', [idNumber])!,
  );
  const run = async () => {
    await createVoucher(
      {
        docType: '01',
        clientId: clientRows[0]!.id,
        source: 'standard',
        items: [
          { productId: productRows[0]!.id, quantity: 1 },
          { productId: productRows[1]!.id, quantity: 2 },
        ],
        infoAdicional: [{ nombre: 'Orden de compra', valor: 'OC-2026-001' }],
      },
      adminId,
    );
    await createVoucher(
      { docType: '01', clientId: clientRows[1]!.id, source: 'standard', items: [{ productId: productRows[3]!.id, quantity: 10 }] },
      adminId,
    );
    await createVoucher(
      { docType: '01', clientId: consumidorFinal.id, source: 'quick', items: [{ productId: productRows[4]!.id, quantity: 3 }] },
      adminId,
    );
    await createVoucher(
      { docType: '01', clientId: clientRows[2]!.id, source: 'standard', draft: true, items: [{ productId: productRows[2]!.id, quantity: 2 }] },
      adminId,
    );

    // Guía de remisión de ejemplo
    await createVoucher(
      {
        docType: '06',
        clientId: clientRows[0]!.id,
        source: 'waybill',
        items: [{ productId: productRows[0]!.id, quantity: 2, unitPriceCents: 0, ivaCode: '0' }],
        extra: {
          dirPartida: 'Av. Amazonas N34-120 y Naciones Unidas, Quito (Bodega principal)',
          transportista: {
            razonSocial: 'TRANSPORTES ANDINOS S.A.',
            ruc: company.ruc,
            tipoIdentificacion: '04',
            placa: 'PBX-1234',
          },
          fechaIniTransporte: sriDate(new Date()),
          fechaFinTransporte: sriDate(new Date()),
          destinatarios: [
            {
              identificacion: '1752048122001',
              razonSocial: 'ALEJANDRO TES',
              direccion: 'Av. 6 de Diciembre N24-56, Quito',
              motivoTraslado: '03',
              codDocSustento: '01',
              numDocSustento: '001-001-000000001',
              fechaEmisionDocSustento: sriDate(new Date()),
              items: [{ codigo: 'P001', descripcion: 'Laptop Lenovo ThinkPad E14', cantidad: 2 }],
            },
          ],
        },
      },
      adminId,
    );

    // Comprobante de retención de ejemplo
    await createVoucher(
      {
        docType: '07',
        clientId: clientRows[1]!.id,
        source: 'retention',
        items: [],
        extra: {
          sujeto: {
            tipoIdentificacion: '04',
            identificacion: '1792146141001',
            razonSocial: 'DISTRIBUIDORA ANDINA S.A.',
          },
          periodoFiscal: '10/2026',
          docs: [
            {
              codSustento: '01',
              codDocSustento: '01',
              numDocSustento: '001-001-000000007',
              fechaEmisionDocSustento: '20/10/2026',
              numAutDocSustento: '2010202601179214614100120010010000000071234567810',
              pagoLocExt: '01',
              totalSinImpuestosCents: 45000,
              importeTotalCents: 51750,
              impuestos: [
                {
                  codImpuestoDocSustento: '2',
                  codigoPorcentaje: '4',
                  baseImponibleCents: 45000,
                  tarifa: 15,
                  valorImpuestoCents: 6750,
                },
              ],
              retenciones: [
                { codigo: '1', etiqueta: 'Renta', codigoPorcentaje: '303', tarifa: 10, baseImponibleCents: 45000, valorRetenidoCents: 4500 },
                { codigo: '2', etiqueta: 'IVA', codigoPorcentaje: '1', tarifa: 10, baseImponibleCents: 6750, valorRetenidoCents: 675 },
              ],
            },
          ],
        },
      },
      adminId,
    );
    audit('seed', 'demo', 'created', 'Datos de demostración creados', adminId);
  };
  // createVoucher es async; el caller principal lo espera.
  return run();
}

async function seed(): Promise<void> {
  const force = process.argv.includes('--force');
  if (force) {
    removeAllDatabases();
    console.log('Bases de datos eliminadas para volver a sembrar.');
  }
  initPlatformDb();
  const existing = pOne<{ total: number }>('SELECT COUNT(*) AS total FROM platform_users');
  if ((existing?.total ?? 0) > 0 && !force) {
    console.log('La plataforma ya está inicializada. Use --force para reiniciar todo (borra datos).');
    return;
  }
  console.log(`Sembrando plataforma en ${config.platformDbPath}`);
  console.log(`Bases de empresas en ${config.tenantsDir}`);

  const seedDemo = process.env.SEED_DEMO !== 'false';
  const superUsername = (process.env.SUPERADMIN_USERNAME || 'superadmin').trim() || 'superadmin';
  const superPassword = process.env.SUPERADMIN_PASSWORD || (seedDemo ? 'superadmin123' : '');
  if (!superPassword) {
    throw new Error(
      'Defina SUPERADMIN_PASSWORD para crear el superadministrador (obligatorio en producción, por ejemplo con SEED_DEMO=false).',
    );
  }
  if (superPassword.length < 10) {
    throw new Error('SUPERADMIN_PASSWORD debe tener al menos 10 caracteres');
  }

  /* ------------------------------------------------- superadministrador */
  createPlatformUser({
    username: superUsername,
    password: superPassword,
    name: 'Superadministrador de la plataforma',
    email: process.env.SUPERADMIN_EMAIL || 'superadmin@plataforma.local',
    role: 'superadmin',
  });

  if (seedDemo) {
    /* ----------------------------------------------------- empresa demo */
    const demo = provisionCompany({
      ruc: '1792456789001',
      name: 'COMERCIAL DEMO S.A.',
      tradeName: 'COMERCIAL DEMO',
      email: 'facturacion@demo.ec',
      phone: '02-394-5678',
      address: 'Av. Amazonas N34-120 y Av. Naciones Unidas, Quito',
      plan: 'empresarial',
      licenseStatus: 'active',
      licenseExpiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      createdBy: null,
      adminUsername: 'admin',
      adminPassword: 'admin123',
      adminName: 'Administrador',
      adminEmail: 'admin@demo.ec',
    });
    const companyId = demo.company.id;

    addCompanyUser(companyId, { username: 'facturador', password: 'facturador123', name: 'Ana Facturadora', email: 'facturador@demo.ec', role: 'facturador' });
    addCompanyUser(companyId, { username: 'inventario', password: 'inventario123', name: 'Iván Inventario', email: 'inventario@demo.ec', role: 'inventario' });
    addCompanyUser(companyId, { username: 'contador', password: 'contador123', name: 'Carla Contadora', email: 'contador@demo.ec', role: 'contador' });

    await runWithTenant(companyId, () => seedTenantData(demo.admin.id));

    /* ------------------------------------------------- segunda empresa demo */
    const second = provisionCompany({
      ruc: '0999999999001',
      name: 'DISTRIBUIDORA DEL PACÍFICO S.A.',
      tradeName: 'DISPA',
      email: 'contacto@dispa.ec',
      phone: '04-222-3344',
      address: 'Av. 9 de Octubre 1234, Guayaquil',
      plan: 'basico',
      licenseStatus: 'trial',
      licenseExpiresAt: new Date(Date.now() + 15 * 86_400_000).toISOString(),
      createdBy: null,
      adminUsername: 'dispa',
      adminPassword: 'dispa123',
      adminName: 'Administrador DISPA',
      adminEmail: 'admin@dispa.ec',
    });

    console.log('\nPlataforma lista (modo demo):');
    console.log(`  Superadministrador: ${superUsername} / (definida por SUPERADMIN_PASSWORD)`);
    console.log('  Empresa demo 1:      admin / admin123       (COMERCIAL DEMO S.A. · licencia activa)');
    console.log('  Empresa demo 2:      dispa / dispa123       (DISTRIBUIDORA DEL PACÍFICO S.A. · licencia de prueba)');
    console.log('  Roles demo 1:        facturador / inventario / contador\n');
    console.log(`  Empresa 2 creada (id ${second.company.id}) totalmente aislada y en modo simulado.`);
    console.log('  Use el superadministrador para crear más empresas/licencias.\n');
  } else {
    console.log('\nPlataforma lista (modo producción, sin empresas demo):');
    console.log(`  Superadministrador: ${superUsername} (contraseña definida en SUPERADMIN_PASSWORD)`);
    console.log('  Cree la primera empresa/licencia desde /api/platform/companies o desde el panel.\n');
  }
}

await seed();
