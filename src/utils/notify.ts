// Telling people what already happened.
//
// The approval inbox (utils/pendingStep, GET /documents/inbox) counts what is
// waiting for *you to act*. This is the other half: a request you filed came out
// approved, an order you have to pay for cleared its chain, goods you will have to
// receive have been paid for. Nobody has to do anything about these in the system —
// they have to know, and before this they found out by asking somebody.
//
// Delivery is in-app only. There is no mail transport in this project, and a
// notification that fails to send with nothing to show for it is worse than one
// that waits in a list: the list can be checked.
//
// Nothing here may break the thing that triggered it. A payment that settles
// correctly must not fail because a notification could not be written, so every
// entry point swallows its own errors and says so in the log.

import pool from '../db/connection';
import { RoleCode } from './roles';

export type NotificationKind =
  | 'pr_approved'       // a purchase request cleared its chain
  | 'po_approved'       // a purchase order cleared its chain
  | 'payreq_approved'   // a payment request cleared its chain — the transfer may go
  | 'payreq_paid'       // finance settled a payment request
  | 'goods_in_transit'  // that payment was for an order, so the goods are coming
  | 'stock_shortage';   // what arrived did not match what was ordered

export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string | null;
  documentType?: string | null;
  documentId?: number | null;
  /** Where clicking it should land, as a route in agro-web. */
  link?: string | null;
}

/**
 * Who holds these roles, for this document's PT.
 *
 * Entity-bound roles (Field Admin, Project Manager) only hear about their own PT's
 * documents — a JNBS field admin has no use for an SNBS delivery. The cross-entity
 * roles (Procurement, Finance, Director) serve every PT and always qualify, which
 * is the same rule the approval routing uses.
 *
 * `entityId` null means "do not scope" — every holder of the role is included.
 */
async function usersInRoles(roleCodes: RoleCode[], entityId: number | null): Promise<number[]> {
  if (!roleCodes.length) return [];
  const [rows] = await pool.query(
    `SELECT u.id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = 1
       AND r.role_code IN (?)
       AND (? IS NULL OR r.is_cross_entity = 1 OR u.entity_id = ?)`,
    [roleCodes, entityId, entityId]);
  return (rows as any[]).map((r) => Number(r.id));
}

/**
 * Write one notification per recipient.
 *
 * `exceptUserId` drops the person who caused the event: being told about your own
 * click is noise, and noise is how a notification list stops being read. Duplicate
 * ids collapse, so a Finance Manager who is also the requester gets one row rather
 * than two.
 */
export async function notifyUsers(
  userIds: number[],
  input: NotificationInput,
  exceptUserId?: number | null,
): Promise<number> {
  const targets = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0 && id !== exceptUserId))];
  if (!targets.length) return 0;
  const values = targets.map(() => '(?,?,?,?,?,?,?,NOW())').join(',');
  const args: any[] = [];
  for (const id of targets) {
    args.push(id, input.kind, input.title, input.body ?? null,
      input.documentType ?? null, input.documentId ?? null, input.link ?? null);
  }
  await pool.query(
    `INSERT INTO notifications (user_id, kind, title, body, document_type, document_id, link, created_at)
     VALUES ${values}`, args);
  return targets.length;
}

/** The same, addressed by role. Extra user ids (the requester, say) are merged in. */
export async function notifyRoles(
  roleCodes: RoleCode[],
  entityId: number | null,
  input: NotificationInput,
  opts: { alsoUserIds?: (number | null | undefined)[]; exceptUserId?: number | null } = {},
): Promise<number> {
  try {
    const byRole = await usersInRoles(roleCodes, entityId);
    const extra = (opts.alsoUserIds || []).filter((v): v is number => Number.isInteger(v as number));
    return await notifyUsers([...byRole, ...extra], input, opts.exceptUserId);
  } catch (err: any) {
    // Never let this take down the action that caused it.
    console.error('[notify] gagal menulis notifikasi:', err?.message || err);
    return 0;
  }
}

export const fmtRp = (n: number) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
