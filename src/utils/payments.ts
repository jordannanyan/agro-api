// Settling a payment request — the one place a request becomes Paid.
//
// Two things reach this: the reconciliation import (a matching line was found on
// the bank statement) and the manual override. They must behave identically, or
// the approval chain records a different history depending on which door the
// payment came through, and the timeline stops being evidence of anything.

import pool from '../db/connection';
import { AuthUser } from '../middleware/auth';
import { generatePaymentCode } from './paymentCode';
import { notifyRoles, fmtRp } from './notify';
import { ROLE } from './roles';

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
    'SELECT id, status, payreq_kind FROM payment_requests WHERE id = ? LIMIT 1', [payreqId]);
  const payreq = (ex as any[])[0];
  if (!payreq) return { ok: false, status: 404, message: 'Payment request not found' };
  if (payreq.status === 'Paid') {
    return { ok: false, status: 409, message: 'This payment request is already paid.' };
  }

  // A reimbursement keeps its chain under its own document_type, so the steps this
  // has to check — and the Payment step it appends — belong to that type, not to
  // 'PayReq'. Reading it from the row rather than taking it as an argument means
  // the statement importer, which knows only a payment code, cannot get it wrong.
  const docType = payreq.payreq_kind === 'Reimbursement' ? 'Reimbursement'
    : payreq.payreq_kind === 'Expense' ? 'Expense'
    : 'PayReq';

  const [steps] = await pool.query(
    `SELECT da.step_order, da.status, r.role_name
     FROM document_approvals da
     LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type = ? AND da.document_id = ?
       AND COALESCE(da.step_label, '') <> 'Payment'
     ORDER BY da.step_order ASC`, [docType, payreqId]);
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
     VALUES (?, ?, ?, 'Payment', ?, ?, ?, ?, ?, ?, 'Approved', NOW(), NOW())`,
    [docType, payreqId, nextOrder, user.roleId ?? null, user.id, user.data?.name ?? null,
     user.data?.position ?? null, releasedDate, opts.note ?? null]);
  await pool.query(
    `INSERT INTO document_activities (document_type, document_id, action, user_id, note, created_at)
     VALUES (?, ?, 'Payment released', ?, ?, NOW())`,
    [docType, payreqId, user.id, opts.note ?? null]);

  await announcePaid(user, payreqId);

  return { ok: true };
}

/**
 * Say the money has gone.
 *
 * Everybody with a stake hears once: finance (who executed it), whoever filed the
 * request, procurement (whose order it settles), the Director. Before this the
 * answer to "has it been paid?" lived in one person's head.
 *
 * And when the payment settles a purchase order, the warehouse is told separately —
 * that one is not an accounting fact but a heads-up that goods are now on their way,
 * which is the difference between a delivery that gets received and one that sits on
 * a loading bay because nobody expected it.
 */
async function announcePaid(user: AuthUser, payreqId: number) {
  try {
    const [rows] = await pool.query(
      `SELECT pay.payreq_number, pay.amount, pay.entity_id, pay.purchase_order_id,
              pay.requested_by_user_id, pay.payreq_kind,
              e.entities_name AS entity_name, po.po_number, v.vendor_name
       FROM payment_requests pay
       LEFT JOIN entities e        ON e.id = pay.entity_id
       LEFT JOIN purchase_orders po ON po.id = pay.purchase_order_id
       LEFT JOIN vendors v          ON v.id = po.vendor_id
       WHERE pay.id = ? LIMIT 1`, [payreqId]);
    const pay = (rows as any[])[0];
    if (!pay) return;
    const entity = pay.entity_name ? ` · ${pay.entity_name}` : '';

    await notifyRoles(
      [ROLE.FINANCE_MANAGER, ROLE.FINANCE_STAFF, ROLE.PROCUREMENT, ROLE.DIRECTOR],
      pay.entity_id ?? null,
      {
        kind: 'payreq_paid',
        title: `${pay.payreq_number} sudah dibayar`,
        body: `Pembayaran ${fmtRp(Number(pay.amount))}${entity} sudah dikeluarkan`
          + `${pay.po_number ? ` untuk ${pay.po_number}` : ''}`
          + `${pay.vendor_name ? ` (${pay.vendor_name})` : ''}.`,
        documentType: pay.payreq_kind === 'Reimbursement' ? 'Reimbursement'
          : pay.payreq_kind === 'Expense' ? 'Expense' : 'PayReq',
        documentId: payreqId,
        // Each kind has its own screen, so each notification has to land on the
        // right one — a claim opened on the procurement page would show a document
        // that page does not list.
        link: pay.payreq_kind === 'Reimbursement' ? `/reimbursement/${payreqId}`
          : pay.payreq_kind === 'Expense' ? `/procurement/payreq-reimbursement/${payreqId}`
          : `/procurement/payreq/${payreqId}`,
      },
      // The requester hears about their own request even when they hold none of the
      // roles above — a Field Admin who filed it, say.
      { alsoUserIds: [pay.requested_by_user_id], exceptUserId: user.id },
    );

    if (pay.purchase_order_id) {
      await notifyRoles([ROLE.FIELD_ADMIN], pay.entity_id ?? null, {
        kind: 'goods_in_transit',
        title: `Barang ${pay.po_number} sudah dibayar — siapkan penerimaan`,
        body: `${pay.po_number}${pay.vendor_name ? ` dari ${pay.vendor_name}` : ''}${entity} sudah dilunasi,`
          + ' jadi barangnya dalam perjalanan. Catat lewat Stock In begitu tiba.',
        documentType: 'PO',
        documentId: Number(pay.purchase_order_id),
        link: `/warehouse/stock-in/create`,
      }, { exceptUserId: user.id });
    }
  } catch (err: any) {
    console.error('[notify] announcePaid gagal:', err?.message || err);
  }
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
