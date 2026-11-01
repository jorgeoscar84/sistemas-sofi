/** Estado y datos de licencias de la plataforma. */

export type LicenseStatus = 'active' | 'trial' | 'suspended' | 'expired';

export interface PlatformCompanyRow {
  id: string;
  ruc: string;
  name: string;
  trade_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  admin_user_id: string | null;
  license_status: string;
  license_plan: string;
  license_expires_at: string | null;
  license_notes: string | null;
  payment_reference: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LicenseState {
  /** Estado efectivo (una licencia vencida se reporta como `expired`). */
  status: LicenseStatus;
  usable: boolean;
  expired: boolean;
  daysLeft: number | null;
  label: string;
}

const STATUS_LABELS: Record<LicenseStatus, string> = {
  active: 'Activa',
  trial: 'Prueba',
  suspended: 'Suspendida',
  expired: 'Vencida',
};

export function licenseState(company: Pick<PlatformCompanyRow, 'license_status' | 'license_expires_at'>): LicenseState {
  const raw = String(company.license_status || 'active') as LicenseStatus;
  const expiresAt = company.license_expires_at ? new Date(company.license_expires_at) : null;
  const expired = Boolean(expiresAt && expiresAt.getTime() < Date.now());
  const status: LicenseStatus = expired && (raw === 'active' || raw === 'trial') ? 'expired' : raw;
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
  return {
    status,
    usable: status === 'active' || status === 'trial',
    expired,
    daysLeft,
    label: STATUS_LABELS[status] ?? status,
  };
}

export function licenseDto(company: PlatformCompanyRow | null | undefined) {
  if (!company) return null;
  const state = licenseState(company);
  return {
    status: state.status,
    statusLabel: state.label,
    usable: state.usable,
    daysLeft: state.daysLeft,
    plan: company.license_plan,
    expiresAt: company.license_expires_at,
    notes: company.license_notes,
    paymentReference: company.payment_reference,
  };
}

export function companySummary(company: PlatformCompanyRow) {
  const state = licenseState(company);
  return {
    id: company.id,
    ruc: company.ruc,
    name: company.name,
    tradeName: company.trade_name,
    email: company.email,
    licenseStatus: state.status,
    licenseLabel: state.label,
    licenseUsable: state.usable,
    licenseExpiresAt: company.license_expires_at,
  };
}
