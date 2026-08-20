// Settling a payment request — the one place a request becomes Paid.
//
// Two things reach this: the reconciliation import (a matching line was found on
// the bank statement) and the manual override. They must behave identically, or
// the approval chain records a different history depending on which door the
// payment came through, and the timeline stops being evidence of anything.

import pool from '../db/connection';
import { AuthUser } from '../middleware/auth';
import { generatePaymentCode } from './paymentCode';

export interface SettleOptions {
  /** Date the money actually left the account — from the statement line, not today. */
  released_pay_date?: string | null;
  payment_method_id?: number | null;
  note?: string | null;
  /** Set when the statement showed slightly less than requested (bank charge). */
  fee_amount?: number;
}

export type SettleResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/**
 * Mark a payment request paid, with the trail that goes with it.
 *
 * Refuses anything the approval chain has not finished, whichever door it came
 * through: a statement line quoting the code of a request that is still awaiting
 * the Director does not pay it, it is reported as an exception. That refusal is
 * the point of the control.
 */
export async function settlePaymentRequest(
  user: AuthUser,
  payreqId: number,
  opts: SettleOptions = {},
): Promise<SettleResult> {
  const [ex] = await pool.query(
    'SELECT id, status FROM payment_requests WHERE id = ? LIMIT 1', [payreqId]);
  const payreq = (ex as any[])[0];
  if (!payreq) return { ok: false, status: 404, message: 'Payment request not found' };
  if (payreq.status === 'Paid') {
    return { ok: false, status: 409, message: 'This payment request is already paid.' };
  }

  const [steps] = await pool.query(
    `SELECT da.step_order, da.status, r.role_name
     FROM document_approvals da
     LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type = 'PayReq' AND da.document_id = ?
       AND COALESCE(da.step_label, '') <> 'Payment'
     ORDER BY da.step_order ASC`, [payreqId]);
  const chain = steps as any[];
  if (!chain.length) {
    return { ok: false, status: 409, message: 'This payment request has no approval chain yet.' };
  }
  const outstanding = chain.find((s) => s.status !== 'Approved');
  if (outstanding) {
    return {
      ok: false, status: 409,
      message: `Cannot pay yet — step ${outstanding.step_order} (${outstanding.role_name ?? 'unassigned'}) is ${outstanding.status}.`,
    };
  }

  const releasedDate = opts.released_pay_date || new Date().toISOString().slice(0, 10);
  await pool.query(
    `UPDATE payment_requests
     SET status = 'Paid', released_pay_date = ?, payment_method_id = ?, paid_by_user_id = ?, updated_at = NOW()
     WHERE id = ?`,
    [releasedDate,
     opts.payment_method_id != null && (opts.payment_method_id as any) !== '' ? Number(opts.payment_method_id) : null,
     user.id, payreqId]);

  // Leave a trace on the timeline so the payment step is visible where every other
  // decision on this document is.
  const nextOrder = Math.max(...chain.map((s) => Number(s.step_order))) + 1;
  await pool.query(
    `INSERT INTO document_approvals
       (document_type, document_id, step_order, step_label, role_id, user_id, name, position, action_date, note, status, created_at, updated_at)
     VALUES ('PayReq', ?, ?, 'Payment', ?, ?, ?, ?, ?, ?, 'Approved', NOW(), NOW())`,
    [payreqId, nextOrder, user.roleId ?? null, user.id, user.data?.name ?? null,
     user.data?.position ?? null, releasedDate, opts.note ?? null]);
  await pool.query(
    `INSERT INTO document_activities (document_type, document_id, action, user_id, note, created_at)
     VALUES ('PayReq', ?, 'Payment released', ?, ?, NOW())`,
    [payreqId, user.id, opts.note ?? null]);

  return { ok: true };
}

/**
 * Give an approved payment request the reference that will identify it on the
 * statement, if it has none yet.
 *
 * Issued at approval rather than at creation: before the chain completes there is
 * nothing to pay, and a code in circulation for a request that may still be
 * rejected is a code somebody can quote on a transfer nobody authorised.
 *
 * Returns the code — the existing one if there already is one, so calling this
 * twice never rotates a reference that has already been written on a transfer.
 */
export async function issuePaymentCode(payreqId: number): Promise<string | null> {
  const [rows] = await pool.query(
    'SELECT payment_code FROM payment_requests WHERE id = ? LIMIT 1', [payreqId]);
  const current = (rows as any[])[0];
  if (!current) return null;
  if (current.payment_code) return current.payment_code;

  // The unique index is the arbiter, not a pre-flight check: two approvals landing
  // at the same instant would both find the code free. Draw again on collision.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generatePaymentCode();
    try {
      await pool.query(
        `UPDATE payment_requests SET payment_code = ?, payment_code_issued_at = NOW()
         WHERE id = ? AND (payment_code IS NULL OR payment_code = '')`, [code, payreqId]);
      const [check] = await pool.query(
        'SELECT payment_code FROM payment_requests WHERE id = ? LIMIT 1', [payreqId]);
      const issued = (check as any[])[0]?.payment_code;
      if (issued) return issued;
    } catch (e: any) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  return null;
}
