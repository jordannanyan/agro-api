import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import { seedApprovalSteps } from './documents';
import { ROLE, PAYMENT_EXECUTOR_ROLES } from '../utils/roles';
import { resolveWriteEntity } from '../utils/entityScope';
import { PENDING_STEP_COLUMNS, pendingStepJoin } from '../utils/pendingStep';

export const router = Router();

const SELECT = `
  SELECT pay.*, e.entities_name AS entity_name, bc.code AS budget_code,
         pr.pr_number, po.po_number,
         CASE WHEN pay.purchase_order_id IS NOT NULL THEN 'via_po' ELSE 'direct' END AS route,
${PENDING_STEP_COLUMNS}
  FROM payment_requests pay
  LEFT JOIN entities e            ON e.id = pay.entity_id
  LEFT JOIN budget_codes bc       ON bc.id = pay.budget_code_id
  LEFT JOIN purchase_requests pr  ON pr.id = pay.purchase_request_id
  LEFT JOIN purchase_orders po    ON po.id = pay.purchase_order_id
${pendingStepJoin('PayReq', 'pay')}
`;

// GET /api/payment-requests?entity_id=&status=&route=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.entity_id) { where.push('pay.entity_id = ?'); args.push(req.query.entity_id); }
  if (req.query.status)    { where.push('pay.status = ?'); args.push(req.query.status); }
  if (req.query.route === 'via_po')  where.push('pay.purchase_order_id IS NOT NULL');
  if (req.query.route === 'direct')  where.push('pay.purchase_order_id IS NULL');
  if (req.query.search)    { where.push('pay.payreq_number LIKE ?'); args.push(`%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY pay.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

// GET /api/payment-requests/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE pay.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Payment request not found' });
  const data = list[0];
  const [appr] = await pool.query(
    `SELECT da.*, r.role_code, r.role_name FROM document_approvals da LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type='PayReq' AND da.document_id=? ORDER BY da.step_order`, [req.params.id]);
  data.approvals = appr;
  return res.json({ data });
});

function bodyToCols(b: any) {
  return {
    purchase_request_id: b.purchase_request_id != null && b.purchase_request_id !== '' ? Number(b.purchase_request_id) : null,
    purchase_order_id: b.purchase_order_id != null && b.purchase_order_id !== '' ? Number(b.purchase_order_id) : null,
    entity_id: b.entity_id != null ? Number(b.entity_id) : null,
    budget_code_id: b.budget_code_id != null && b.budget_code_id !== '' ? Number(b.budget_code_id) : null,
    reason: b.reason ?? null,
    person_in_charge: b.person_in_charge ?? null,
    activity_date: b.activity_date || null,
    estimated_pay_date: b.estimated_pay_date || null,
    released_pay_date: b.released_pay_date || null,
    request_type: b.request_type ?? null,
    reference_no: b.reference_no ?? null,
    amount: Number(b.amount || 0),
    bank_name: b.bank_name ?? null,
    bank_account: b.bank_account ?? null,
    beneficiary_name: b.beneficiary_name ?? null,
    status: b.status || 'Draft',
  };
}

// POST /api/payment-requests  (CHECK: PR or PO source required)
router.post('/', authenticate, requireRole(
  ROLE.PROCUREMENT, ROLE.FINANCE_MANAGER, ROLE.DIRECTOR, ROLE.SUPER_ADMIN, ROLE.ADMIN,
), async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    // Entity-bound staff get their own entity; they never pick one.
    const scoped = resolveWriteEntity(req, b.entity_id);
    if ('error' in scoped) return res.status(422).json({ message: scoped.error });
    if (!b.purchase_request_id && !b.purchase_order_id) {
      return res.status(422).json({ message: 'Either purchase_request_id or purchase_order_id is required' });
    }
    // Called "Project Code" on a PayReq and "Budget Code" on a PR/PO, but it is the
    // same budget_codes list. Optional upstream, mandatory here: this is the document
    // that moves cash, so the spend has to land against a code.
    if (b.budget_code_id == null || b.budget_code_id === '') {
      return res.status(422).json({ message: 'budget_code_id (Project Code) is required on a payment request' });
    }
    const c: any = bodyToCols(b);
    c.entity_id = scoped.entityId;
    const payreqNumber = b.payreq_number || await nextDocNumber('payment_requests', 'payreq_number', 'PAY');
    const cols = { payreq_number: payreqNumber, ...c, created_at: new Date(), updated_at: new Date() };
    const keys = Object.keys(cols);
    const [result] = await pool.query(
      `INSERT INTO payment_requests (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => (cols as any)[k])
    );
    const id = (result as any).insertId;
    if ((c.status) !== 'Draft') await seedApprovalSteps('PayReq', id, c.entity_id, c.amount);
    const [rows] = await pool.query(SELECT + ' WHERE pay.id = ? LIMIT 1', [id]);
    return res.status(201).json({ message: 'Payment request created', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/payment-requests/:id
const update = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id FROM payment_requests WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Payment request not found' });
    const b = req.body || {};
    // 'Paid' is reserved for POST /:id/pay, which checks the approval chain first —
    // otherwise the generic update would be a way to walk straight past that gate.
    if (String(b.status || '') === 'Paid') {
      return res.status(422).json({ message: "Use POST /api/payment-requests/:id/pay to mark a payment as paid." });
    }
    // Editing may leave the code alone, but it may not clear it.
    if (b.budget_code_id !== undefined && (b.budget_code_id === null || b.budget_code_id === '')) {
      return res.status(422).json({ message: 'budget_code_id (Project Code) cannot be cleared' });
    }
    const c: any = bodyToCols(b);
    // Only set provided fields.
    const updates: Record<string, any> = {};
    for (const k of Object.keys(c)) if (b[k.replace(/_id$/, '_id')] !== undefined || b[k] !== undefined) updates[k] = c[k];
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE payment_requests SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query(SELECT + ' WHERE pay.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Payment request updated', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
router.put('/:id', authenticate, update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// POST /api/payment-requests/:id/pay — record the actual cash disbursement (step 5).
//
// This is deliberately NOT an approval action: the approval chain ends with the
// Director acknowledging. Finance then executes, and both the Finance Manager and
// the Finance Staff may do it (per the 2026-08 role documentation, the Finance Staff
// is the one who normally keys the payment in).
router.post('/:id/pay', authenticate, requireRole(...PAYMENT_EXECUTOR_ROLES), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const user = req.user!;
    const b = req.body || {};

    const [ex] = await pool.query('SELECT id, status FROM payment_requests WHERE id = ? LIMIT 1', [id]);
    const payreq = (ex as any[])[0];
    if (!payreq) return res.status(404).json({ message: 'Payment request not found' });
    if (payreq.status === 'Paid') return res.status(409).json({ message: 'This payment request is already paid.' });

    // Gate: every approval step must be Approved before cash can move.
    const [steps] = await pool.query(
      `SELECT da.step_order, da.status, r.role_name
       FROM document_approvals da
       LEFT JOIN roles r ON r.id = da.role_id
       WHERE da.document_type = 'PayReq' AND da.document_id = ?
         AND COALESCE(da.step_label, '') <> 'Payment'
       ORDER BY da.step_order ASC`,
      [id]
    );
    const chain = steps as any[];
    if (!chain.length) {
      return res.status(409).json({ message: 'This payment request has no approval chain yet.' });
    }
    const outstanding = chain.find((s) => s.status !== 'Approved');
    if (outstanding) {
      return res.status(409).json({
        message: `Cannot pay yet — step ${outstanding.step_order} (${outstanding.role_name ?? 'unassigned'}) is ${outstanding.status}.`,
      });
    }

    const releasedDate = b.released_pay_date || new Date().toISOString().slice(0, 10);
    await pool.query(
      `UPDATE payment_requests
       SET status = 'Paid', released_pay_date = ?, payment_method_id = ?, paid_by_user_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [releasedDate, b.payment_method_id != null && b.payment_method_id !== '' ? Number(b.payment_method_id) : null,
       user.id, id]
    );

    // Leave a trace on the timeline so the 5-step view in the UI is complete.
    const nextOrder = Math.max(...chain.map((s) => Number(s.step_order))) + 1;
    await pool.query(
      `INSERT INTO document_approvals
         (document_type, document_id, step_order, step_label, role_id, user_id, name, position, action_date, note, status, created_at, updated_at)
       VALUES ('PayReq', ?, ?, 'Payment', ?, ?, ?, ?, ?, ?, 'Approved', NOW(), NOW())`,
      [id, nextOrder, user.roleId ?? null, user.id, user.data?.name ?? null, user.data?.position ?? null,
       releasedDate, b.note ?? null]
    );
    await pool.query(
      `INSERT INTO document_activities (document_type, document_id, action, user_id, note, created_at)
       VALUES ('PayReq', ?, 'Payment released', ?, ?, NOW())`,
      [id, user.id, b.note ?? null]
    );

    const [rows] = await pool.query(SELECT + ' WHERE pay.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Payment recorded', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE /api/payment-requests/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM payment_requests WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Payment request not found' });
  return res.json({ message: 'Payment request deleted' });
});

export default router;
