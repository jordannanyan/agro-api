// Stable role slugs. These are what the code compares against — never `roles.role_name`,
// which is a display label admins may rename freely from Settings.
//
// Source of truth: Dokumentasi_Role_Approval_Procurement.pdf (2026-08-01).
export const ROLE = {
  FIELD_ADMIN: 'FIELD_ADMIN',
  PROCUREMENT: 'PROCUREMENT',
  PROJECT_MANAGER: 'PROJECT_MANAGER',
  FINANCE_MANAGER: 'FINANCE_MANAGER',
  FINANCE_STAFF: 'FINANCE_STAFF',
  DIRECTOR: 'DIRECTOR',
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
} as const;

export type RoleCode = (typeof ROLE)[keyof typeof ROLE];

/** System administrators — outside the business flow, may manage users & settings. */
export const SYSTEM_ADMIN_ROLES: RoleCode[] = [ROLE.SUPER_ADMIN, ROLE.ADMIN];

/** May execute a payment once a PayReq is fully approved (Finance Manager + Finance Staff). */
export const PAYMENT_EXECUTOR_ROLES: RoleCode[] = [ROLE.FINANCE_MANAGER, ROLE.FINANCE_STAFF];
