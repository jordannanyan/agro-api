import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import { seedApprovalSteps } from './documents';

export const router = Router();

const SELECT = `
  SELECT pay.*, e.entities_name AS entity_name, bc.code AS budget_code,
         pr.pr_number, po.po_number,
         CASE WHEN pay.purchase_order_id IS NOT NULL THEN 'via_po' ELSE 'direct' END AS route
  FROM payment_requests pay
  LEFT JOIN entities e            ON e.id = pay.entity_id
  LEFT JOIN budget_codes bc       ON bc.id = pay.budget_code_id
  LEFT JOIN purchase_requests pr  ON pr.id = pay.purchase_request_id
  LEFT JOIN purchase_orders po    ON po.id = pay.purchase_order_id
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
    `SELECT da.*, r.role_name FROM document_approvals da LEFT JOIN roles r ON r.id = da.role_id
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
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.entity_id) return res.status(422).json({ message: 'entity_id is required' });
    if (!b.purchase_request_id && !b.purchase_order_id) {
      return res.status(422).json({ message: 'Either purchase_request_id or purchase_order_id is required' });
    }
    const c: any = bodyToCols(b);
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

// DELETE /api/payment-requests/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM payment_requests WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Payment request not found' });
  return res.json({ message: 'Payment request deleted' });
});

export default router;
