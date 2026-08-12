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

/**
 * System administrators — outside the business flow. Both may read every entity's
 * data and manage users & settings; they differ in what they may *change*.
 */
export const SYSTEM_ADMIN_ROLES: RoleCode[] = [ROLE.SUPER_ADMIN, ROLE.ADMIN];

/**
 * Who may override the business rules — approve someone else's step, edit a
 * document that has left Draft, delete one that is already in the chain.
 *
 * Super Admin only. Admin is administration, not operations: they see everything
 * so they can support people, but a stuck approval is not theirs to force. Keeping
 * the override on one break-glass account also keeps the activity log meaningful.
 */
export const WRITE_OVERRIDE_ROLES: RoleCode[] = [ROLE.SUPER_ADMIN];

/**
 * Roles that may only read the operational modules (procurement documents,
 * warehouse movements, transactions, pre-finance). Enforced by
 * middleware/readOnly.ts, not by each handler.
 */
export const OPERATIONS_READ_ONLY_ROLES: RoleCode[] = [ROLE.ADMIN];

/** May execute a payment once a PayReq is fully approved (Finance Manager + Finance Staff). */
export const PAYMENT_EXECUTOR_ROLES: RoleCode[] = [ROLE.FINANCE_MANAGER, ROLE.FINANCE_STAFF];
