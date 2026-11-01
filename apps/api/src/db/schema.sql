-- Esquema de la base de datos (SQLite vía node:sqlite).
-- Dinero: montos en centavos enteros. Fechas: ISO-8601 UTC en TEXT.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;


CREATE TABLE IF NOT EXISTS company (
  id TEXT PRIMARY KEY,
  ruc TEXT NOT NULL,
  name TEXT NOT NULL,
  trade_name TEXT,
  address TEXT,
  email TEXT,
  phone TEXT,
  obliged_accounting INTEGER NOT NULL DEFAULT 0,
  rimpe TEXT,
  agent_retention TEXT,
  environment INTEGER NOT NULL DEFAULT 1,
  sri_mode TEXT NOT NULL DEFAULT 'mock',
  signature_digest TEXT NOT NULL DEFAULT 'sha1',
  certificate_path TEXT,
  certificate_password_enc TEXT,
  upconta_base_url TEXT,
  upconta_token TEXT,
  upconta_ruc TEXT,
  upconta_estab TEXT,
  upconta_pto_emi TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS establishments (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emission_points (
  id TEXT PRIMARY KEY,
  establishment_id TEXT NOT NULL REFERENCES establishments(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  seq_invoice INTEGER NOT NULL DEFAULT 1,
  seq_credit_note INTEGER NOT NULL DEFAULT 1,
  seq_debit_note INTEGER NOT NULL DEFAULT 1,
  seq_retention INTEGER NOT NULL DEFAULT 1,
  seq_waybill INTEGER NOT NULL DEFAULT 1,
  seq_sales_note INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (establishment_id, code)
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  id_type TEXT NOT NULL,
  id_number TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  subject_type TEXT NOT NULL DEFAULT '01',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id_type, id_number)
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  abbr TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'product',
  code TEXT NOT NULL,
  aux_code TEXT,
  description TEXT NOT NULL,
  category_id TEXT,
  unit_id TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  iva_code TEXT NOT NULL DEFAULT '4',
  ice_code TEXT,
  irbpnr_code TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  track_stock INTEGER NOT NULL DEFAULT 1,
  min_stock REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (type, code)
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stocks (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  amount REAL NOT NULL DEFAULT 0,
  avg_cost_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS stock_vouchers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  to_warehouse_id TEXT REFERENCES warehouses(id),
  provider TEXT,
  observation TEXT,
  total_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'applied',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_voucher_items (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL REFERENCES stock_vouchers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  lot TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  voucher_id TEXT,
  voucher_code TEXT,
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  quantity_in REAL NOT NULL DEFAULT 0,
  quantity_out REAL NOT NULL DEFAULT 0,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  balance_qty REAL NOT NULL DEFAULT 0,
  balance_cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, warehouse_id, date);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  environment INTEGER NOT NULL DEFAULT 1,
  establishment_id TEXT REFERENCES establishments(id),
  establishment_code TEXT NOT NULL,
  emission_point_id TEXT REFERENCES emission_points(id),
  emission_point_code TEXT NOT NULL,
  sequential TEXT NOT NULL,
  access_key TEXT,
  authorization_number TEXT,
  authorization_date TEXT,
  issue_date TEXT NOT NULL,
  client_id TEXT REFERENCES clients(id),
  client_id_type TEXT,
  client_id_number TEXT,
  client_name TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'DOLAR',
  source TEXT NOT NULL DEFAULT 'standard',
  info_adicional TEXT NOT NULL DEFAULT '[]',
  sri_messages TEXT NOT NULL DEFAULT '[]',
  xml_signed TEXT,
  xml_authorized TEXT,
  related_voucher_id TEXT REFERENCES vouchers(id),
  reason TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vouchers_doc_type ON vouchers(doc_type, status, issue_date);

CREATE TABLE IF NOT EXISTS voucher_items (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  product_id TEXT,
  code TEXT NOT NULL,
  aux_code TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  iva_code TEXT NOT NULL DEFAULT '4',
  taxes TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS voucher_payments (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  term INTEGER NOT NULL DEFAULT 0
);


CREATE TABLE IF NOT EXISTS audit_movements (
  id TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_movements(entity, entity_id, created_at);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);



CREATE TABLE IF NOT EXISTS sri_transactions (
  id TEXT PRIMARY KEY,
  voucher_id TEXT,
  stage TEXT NOT NULL,
  environment INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  request_summary TEXT,
  response_xml TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sri_transactions_voucher ON sri_transactions(voucher_id, created_at);

