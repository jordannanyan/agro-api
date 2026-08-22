import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import {
  seedApprovalSteps, syncDocumentStatus, resetRevisionSteps,
  guardEdit, guardRequester, guardDelete, deleteDocumentChildren,
} from './documents';
import { ROLE, PAYMENT_EXECUTOR_ROLES, WRITE_OVERRIDE_ROLES } from '../utils/roles';
import { settlePaymentRequest } from '../utils/payments';
import { inheritEntity, entityScope, canSeeEntity } from '../utils/entityScope';
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
  // Reimbursements live in the same table but are a different document with a
  // different chain and their own screen; mixing them into the procurement queue
  // would put farmer payments in front of people looking for supplier invoices.
  const where: string[] = ["pay.payreq_kind = 'Procurement'"];
  const args: any[] = [];
  // Same rule as PR and PO: entity-bound staff see their own PT only.
  const scope = entityScope(req);
  if (scope != null) { where.push('pay.entity_id = ?'); args.push(scope); }
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
  if (!canSeeEntity(req, data.entity_id)) {
    return res.status(403).json({ message: 'This payment request belongs to another entity.' });
  }
  const [appr] = await pool.query(
    `SELECT da.*, r.role_code, r.role_name FROM document_approvals da LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type='PayReq' AND da.document_id=? ORDER BY da.step_order`, [req.params.id]);
  data.approvals = appr;
  return res.json({ data });
});

/**
 * Read the entity off whichever document this payment descends from.
 *
 * A PayReq always follows a PR or a PO, so the entity is already decided upstream.
 * Taking it from the request body instead let a payment be filed against a PT that
 * never asked for the spend — and Procurement serves every PT, so no role check
 * would have noticed.
 */
async function entityFromSource(b: any): Promise<{ entityId: number } | { error: string }> {
  const prId = b.purchase_request_id != null && b.purchase_request_id !== '' ? Number(b.purchase_request_id) : null;
  const poId = b.purchase_order_id != null && b.purchase_order_id !== '' ? Number(b.purchase_order_id) : null;

  let prEntity: number | null = null;
  let poEntity: number | null = null;
  if (prId != null) {
    const [r] = await pool.query('SELECT entity_id FROM purchase_requests WHERE id = ? LIMIT 1', [prId]);
    if (!(r as any[]).length) return { error: 'Purchase request not found' };
    prEntity = Number((r as any[])[0].entity_id);
  }
  if (poId != null) {
    const [r] = await pool.query('SELECT entity_id FROM purchase_orders WHERE id = ? LIMIT 1', [poId]);
    if (!(r as any[]).length) return { error: 'Purchase order not found' };
    poEntity = Number((r as any[])[0].entity_id);
  }
  // Older POs predate entity inheritance, so a PR and PO named together can still
  // disagree. That is a contradiction about who is paying, not something to resolve
  // by preferring one of them.
  if (prEntity != null && poEntity != null && prEntity !== poEntity) {
    return { error: 'The purchase request and purchase order belong to different entities.' };
  }
  const entityId = poEntity ?? prEntity;
  if (entityId == null) return { error: 'Either purchase_request_id or purchase_order_id is required' };
  return { entityId };
}

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
  ROLE.PROCUREMENT, ROLE.FINANCE_MANAGER, ROLE.DIRECTOR, ROLE.SUPER_ADMIN,
), async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.purchase_request_id && !b.purchase_order_id) {
      return res.status(422).json({ message: 'Either purchase_request_id or purchase_order_id is required' });
    }
    // The source document decides the entity; entity_id in the body is ignored.
    const source = await entityFromSource(b);
    if ('error' in source) return res.status(422).json({ message: source.error });
    const scoped = inheritEntity(req, source.entityId);
    if ('error' in scoped) return res.status(422).json({ message: scoped.error });
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
    const [ex] = await pool.query('SELECT * FROM payment_requests WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Payment request not found' });
    const prev = (ex as any[])[0];
    const b = req.body || {};
    // 'Paid' is reserved for POST /:id/pay, which checks the approval chain first —
    // otherwise the generic update would be a way to walk straight past that gate.
    if (String(b.status || '') === 'Paid') {
      return res.status(422).json({ message: "Use POST /api/payment-requests/:id/pay to mark a payment as paid." });
    }

    const denied = guardEdit(req.user, prev, b.status);
    if (denied) return res.status(403).json({ message: denied });

    const resubmitting = b.status === 'Pending' && prev.status === 'Revision';
    if (resubmitting) {
      const noRight = await guardRequester(req.user!, 'PayReq', Number(id), prev);
      if (noRight) return res.status(403).json({ message: noRight });
    }
    // Editing may leave the code alone, but it may not clear it.
    if (b.budget_code_id !== undefined && (b.budget_code_id === null || b.budget_code_id === '')) {
      return res.status(422).json({ message: 'budget_code_id (Project Code) cannot be cleared' });
    }
    const c: any = bodyToCols(b);
    // Only set provided fields.
    const updates: Record<string, any> = {};
    for (const k of Object.keys(c)) if (b[k.replace(/_id$/, '_id')] !== undefined || b[k] !== undefined) updates[k] = c[k];

    // Entity follows the source document, never the body. Moving a payment onto a
    // different PR or PO moves it to that document's entity as well.
    delete updates.entity_id;
    if (b.purchase_request_id !== undefined || b.purchase_order_id !== undefined) {
      const [cur] = await pool.query(
        'SELECT purchase_request_id, purchase_order_id FROM payment_requests WHERE id = ? LIMIT 1', [id]);
      const prev = (cur as any[])[0] ?? {};
      const source = await entityFromSource({
        purchase_request_id: b.purchase_request_id !== undefined ? b.purchase_request_id : prev.purchase_request_id,
        purchase_order_id: b.purchase_order_id !== undefined ? b.purchase_order_id : prev.purchase_order_id,
      });
      if ('error' in source) return res.status(422).json({ message: source.error });
      const scoped = inheritEntity(req, source.entityId);
      if ('error' in scoped) return res.status(422).json({ message: scoped.error });
      updates.entity_id = scoped.entityId;
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE payment_requests SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }

    // Submitting a saved draft seeds the approval chain, as creating one already
    // Pending does — otherwise the request left Draft with nobody assigned to it.
    if (b.status && b.status !== 'Draft' && prev.status === 'Draft') {
      const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM document_approvals WHERE document_type=? AND document_id=?', ['PayReq', id]);
      if (!Number((cnt as any[])[0].n)) {
        await seedApprovalSteps('PayReq', Number(id),
          Number(updates.entity_id ?? prev.entity_id),
          Number(updates.amount ?? prev.amount));
      }
    }
    if (resubmitting) await resetRevisionSteps('PayReq', Number(id), req.user!);
    if (b.status && b.status !== 'Draft') await syncDocumentStatus('PayReq', Number(id));

    const [rows] = await pool.query(SELECT + ' WHERE pay.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Payment request updated', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
// Editing a payment request is bounded by the same roles that may raise one.
const PAYREQ_WRITERS = [ROLE.PROCUREMENT, ROLE.FINANCE_MANAGER, ROLE.DIRECTOR, ROLE.SUPER_ADMIN];
router.put('/:id', authenticate, requireRole(...PAYREQ_WRITERS), update);
router.post('/:id', authenticate, requireRole(...PAYREQ_WRITERS), (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// POST /api/payment-requests/:id/pay — record the actual cash disbursement (step 5).
//
// This is deliberately NOT an approval action: the approval chain ends with the
// Director acknowledging. Finance then executes, and both the Finance Manager and
// the Finance Staff may do it (per the 2026-08 role documentation, the Finance Staff
// is the one who normally keys the payment in).
// The role gate lets finance in so they meet the explanation below rather than a
// bare "requires role"; the override account is the only one that gets past it.
router.post('/:id/pay', authenticate, requireRole(...PAYMENT_EXECUTOR_ROLES, ...WRITE_OVERRIDE_ROLES), async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};

    // Kept as a manual override, not the normal way to settle a payment. The flow
    // is: finance transfers the money quoting the request's payment code, then
    // uploads the bank statement, and the matching line is what marks it Paid —
    // see routes/bankStatements.ts. Pressing a button here asserts that a transfer
    // happened with nothing to show for it, so the reason is recorded and only the
    // break-glass account may do it.
    if (!WRITE_OVERRIDE_ROLES.includes(req.user?.roleCode as any)) {
      return res.status(403).json({
        message: 'Pembayaran diverifikasi dengan mengunggah rekening koran, bukan ditandai manual. '
          + 'Unggah file mutasi di menu Rekonsiliasi Pembayaran; baris yang kodenya cocok akan otomatis menjadi Paid.',
      });
    }
    if (!String(b.note || '').trim()) {
      return res.status(422).json({ message: 'Alasan wajib diisi untuk pelunasan manual (tanpa bukti rekening koran).' });
    }

    const result = await settlePaymentRequest(req.user!, id, {
      released_pay_date: b.released_pay_date,
      payment_method_id: b.payment_method_id,
      note: `[MANUAL] ${String(b.note).trim()}`,
    });
    if (!result.ok) return res.status(result.status).json({ message: result.message });

    const [rows] = await pool.query(SELECT + ' WHERE pay.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Payment recorded', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE /api/payment-requests/:id
router.delete('/:id', authenticate, requireRole(...PAYREQ_WRITERS), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [ex] = await pool.query('SELECT * FROM payment_requests WHERE id = ? LIMIT 1', [id]);
  const prev = (ex as any[])[0];
  if (!prev) return res.status(404).json({ message: 'Payment request not found' });

  // guardDelete refuses a paid request outright — see its comment.
  const denied = await guardDelete(req.user, 'PayReq', id, prev);
  if (denied) return res.status(403).json({ message: denied });

  await pool.query('DELETE FROM payment_requests WHERE id = ?', [id]);
  await deleteDocumentChildren('PayReq', id);
  return res.json({ message: 'Payment request deleted' });
});

export default router;
