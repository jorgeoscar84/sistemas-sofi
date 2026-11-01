-- Esquema de la plataforma (multiempresa): usuarios globales, licencias y tokens.
-- Cada empresa tiene su propia base de datos SQLite aislada (data/tenants/<id>.db).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS platform_companies (
  id TEXT PRIMARY KEY,
  ruc TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  trade_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  admin_user_id TEXT,
  license_status TEXT NOT NULL DEFAULT 'active', -- active | trial | suspended | expired
  license_plan TEXT NOT NULL DEFAULT 'basico',
  license_expires_at TEXT,
  license_notes TEXT,
  payment_reference TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES platform_companies(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'admin', -- superadmin | admin | facturador | inventario | contador
  permissions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_users_company ON platform_users(company_id, created_at);

CREATE TABLE IF NOT EXISTS platform_api_tokens (
  id TEXT PRIMARY KEY,
  company_id TEXT REFERENCES platform_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_tokens_company ON platform_api_tokens(company_id);

CREATE TABLE IF NOT EXISTS platform_audit (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  type TEXT NOT NULL,
  note TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
