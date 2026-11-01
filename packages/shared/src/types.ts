/** Tipos compartidos entre API y web (contrato REST). */

export type UserRole = 'admin' | 'facturador' | 'inventario' | 'contador';
export type UserStatus = 'active' | 'inactive';

export const ROLES: Record<UserRole, { label: string; permissions: string[] }> = {
  admin: {
    label: 'Administrador',
    permissions: ['*'],
  },
  facturador: {
    label: 'Facturador',
    permissions: [
      'invoicing:read',
      'invoicing:create',
      'invoicing:send',
      'clients:read',
      'clients:write',
      'catalog:read',
      'dashboard:read',
    ],
  },
  inventario: {
    label: 'Inventario',
    permissions: [
      'catalog:read',
      'catalog:write',
      'inventory:read',
      'inventory:write',
      'dashboard:read',
    ],
  },
  contador: {
    label: 'Contador',
    permissions: ['invoicing:read', 'catalog:read', 'inventory:read', 'dashboard:read', 'reports:read'],
  },
};

export type Environment = 1 | 2;

export interface UserDto {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyDto {
  id: string;
  ruc: string;
  name: string;
  tradeName: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  obligedAccounting: boolean;
  rimpe: string | null;
  agentRetention: string | null;
  environment: Environment;
  sriMode: 'mock' | 'direct-sri' | 'upconta';
  hasSignature: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EstablishmentDto {
  id: string;
  code: string;
  name: string;
  address: string | null;
  status: 'active' | 'inactive';
}

export interface EmissionPointDto {
  id: string;
  establishmentId: string;
  code: string;
  name: string;
  status: 'active' | 'inactive';
  sequences: Record<string, number>;
}

export interface ClientDto {
  id: string;
  idType: string;
  idNumber: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  subjectType: string;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface ProductDto {
  id: string;
  type: 'product' | 'service';
  code: string;
  auxCode: string | null;
  description: string;
  categoryId: string | null;
  unitId: string | null;
  priceCents: number;
  costCents: number;
  ivaCode: string;
  iceCode: string | null;
  irbpnrCode: string | null;
  status: 'active' | 'inactive';
  trackStock: boolean;
  minStock: number;
  stocks: { warehouseId: string; warehouseName: string; amount: number }[];
  totalStock: number;
  createdAt: string;
}

export interface WarehouseDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  color: string | null;
  status: 'active' | 'inactive';
}

export type StockVoucherType = 'income' | 'outgoes' | 'transfer' | 'adjust';
export type StockVoucherStatus = 'draft' | 'applied' | 'canceled';

export interface StockVoucherItemDto {
  id: string;
  productId: string;
  productCode: string;
  productDescription: string;
  quantity: number;
  unitCostCents: number;
  lot: string | null;
  expiresAt: string | null;
}

export interface StockVoucherDto {
  id: string;
  code: string;
  type: StockVoucherType;
  date: string;
  warehouseId: string;
  toWarehouseId: string | null;
  provider: string | null;
  observation: string | null;
  totalCents: number;
  status: StockVoucherStatus;
  items: StockVoucherItemDto[];
  createdBy: string | null;
  createdAt: string;
}

export interface KardexRowDto {
  date: string;
  voucherId: string | null;
  voucherCode: string | null;
  type: string;
  description: string;
  quantityIn: number;
  quantityOut: number;
  unitCostCents: number;
  balanceQty: number;
  avgCostCents: number;
  balanceCostCents: number;
}

export type VoucherStatus = 'draft' | 'sent' | 'issued' | 'failed' | 'canceled' | 'offline';
export type DocTypeCode = '01' | '02' | '03' | '04' | '05' | '06' | '07' | '11';

export interface VoucherItemInput {
  productId: string;
  quantity: number;
  unitPriceCents: number;
  discountCents?: number;
  warehouseId?: string;
  description?: string;
  taxes?: { codigo: string; codigoPorcentaje: string; tarifa: number; baseImponibleCents: number; valorCents: number }[];
}

export interface VoucherPaymentInput {
  method: string;
  amountCents: number;
  term?: number;
}

export interface VoucherDto {
  id: string;
  docType: DocTypeCode;
  docTypeName: string;
  status: VoucherStatus;
  environment: Environment;
  establishmentCode: string;
  emissionPointCode: string;
  sequential: string;
  accessKey: string | null;
  authorizationNumber: string | null;
  authorizationDate: string | null;
  issueDate: string;
  clientId: string | null;
  clientName: string | null;
  clientIdNumber: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  source: string;
  sriMessages: { code?: string; message: string; type?: string; info?: string }[];
  relatedVoucherId: string | null;
  createdBy: string | null;
  createdAt: string;
  items: VoucherItemDto[];
  payments: { method: string; amountCents: number; term: number }[];
  infoAdicional: { nombre: string; valor: string }[];
}

export interface VoucherItemDto {
  id: string;
  productId: string | null;
  code: string;
  auxCode: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  ivaCode: string;
  taxes: { codigo: string; codigoPorcentaje: string; tarifa: number; baseImponibleCents: number; valorCents: number }[];
}

export interface DashboardDto {
  invoicesThisMonth: number;
  totalBilledThisMonthCents: number;
  drafts: number;
  failed: number;
  products: number;
  lowStock: number;
  stockValueCents: number;
  clients: number;
  recentVouchers: VoucherDto[];
  monthlySeries: { month: string; totalCents: number; count: number }[];
}

export interface Paginated<T> {
  page: number;
  limit: number;
  total: number;
  data: T[];
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}
