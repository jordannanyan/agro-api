import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import { seedApprovalSteps } from './documents';

export const router = Router();

const STATUSES = ['Draft', 'Pending', 'Approved', 'Rejected', 'Revision'] as const;

async function loadItems(prId: number) {
  const [rows] = await pool.query(
    `SELECT pri.*, bc.code AS budget_code, u.unit_name, s.sapropdi_name
     FROM purchase_request_items pri
     LEFT JOIN budget_codes bc ON bc.id = pri.budget_code_id
     LEFT JOIN units u         ON u.id = pri.unit_id
     LEFT JOIN sapropdi s      ON s.id = pri.sapropdi_id
     WHERE pri.pr_id = ? ORDER BY pri.id ASC`, [prId]);
  return rows;
}

const SELECT = `
  SELECT pr.*, e.entities_name AS entity_name, u.name AS requested_by_name
  FROM purchase_requests pr
  LEFT JOIN entities e ON e.id = pr.entity_id
  LEFT JOIN users u    ON u.id = pr.requested_by_user_id
`;

// GET /api/purchase-requests?entity_id=&status=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.entity_id) { where.push('pr.entity_id = ?'); args.push(req.query.entity_id); }
  if (req.query.status)    { where.push('pr.status = ?'); args.push(req.query.status); }
  if (req.query.search)    { where.push('pr.pr_number LIKE ?'); args.push(`%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY pr.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

// GET /api/purchase-requests/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'PR not found' });
  const data = list[0];
  data.items = await loadItems(Number(req.params.id));
  const [appr] = await pool.query(
    `SELECT da.*, r.role_name FROM document_approvals da LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type='PR' AND da.document_id=? ORDER BY da.step_order`, [req.params.id]);
  data.approvals = appr;
  return res.json({ data });
});

function itemCols(it: any) {
  return {
    budget_code_id: it.budget_code_id != null && it.budget_code_id !== '' ? Number(it.budget_code_id) : null,
    sapropdi_id: it.sapropdi_id != null && it.sapropdi_id !== '' ? Number(it.sapropdi_id) : null,
    description: it.description ?? '',
    unit_id: it.unit_id != null && it.unit_id !== '' ? Number(it.unit_id) : null,
    quantity: Number(it.quantity || 0),
    unit_cost: Number(it.unit_cost || 0),
  };
}

// POST /api/purchase-requests  body: {entity_id, request_date, date_required, status, items:[...]}
router.post('/', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.entity_id || !b.request_date) return res.status(422).json({ message: 'entity_id and request_date are required' });
    if (b.status && !STATUSES.includes(b.status)) return res.status(422).json({ message: 'Invalid status' });
    const items = Array.isArray(b.items) ? b.items : [];
    const grandTotal = items.reduce((s: number, it: any) => s + Number(it.quantity || 0) * Number(it.unit_cost || 0), 0);

    await conn.beginTransaction();
    const prNumber = b.pr_number || await nextDocNumber('purchase_requests', 'pr_number', 'PR');
    const [result] = await conn.query(
      `INSERT INTO purchase_requests (pr_number, entity_id, requested_by_user_id, request_date, date_required, status, grand_total, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
      [prNumber, Number(b.entity_id), req.user?.type === 'User' ? req.user.id : null,
       b.request_date, b.date_required || null, b.status || 'Draft', grandTotal]
    );
    const id = (result as any).insertId;
    for (const it of items) {
      const c = itemCols(it);
      await conn.query(
        `INSERT INTO purchase_request_items (pr_id, budget_code_id, sapropdi_id, description, unit_id, quantity, unit_cost)
         VALUES (?,?,?,?,?,?,?)`,
        [id, c.budget_code_id, c.sapropdi_id, c.description, c.unit_id, c.quantity, c.unit_cost]
      );
    }
    await conn.commit();

    // Seed approval workflow when submitted (not Draft).
    if ((b.status || 'Draft') !== 'Draft') {
      await seedApprovalSteps('PR', id, Number(b.entity_id), grandTotal);
    }

    const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(id);
    return res.status(201).json({ message: 'PR created', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/purchase-requests/:id
const update = async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    const [ex] = await conn.query('SELECT * FROM purchase_requests WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) { conn.release(); return res.status(404).json({ message: 'PR not found' }); }
    const prev = (ex as any[])[0];
    const b = req.body || {};
    if (b.status && !STATUSES.includes(b.status)) { conn.release(); return res.status(422).json({ message: 'Invalid status' }); }

    await conn.beginTransaction();
    let grandTotal: number | undefined;
    if (Array.isArray(b.items)) {
      await conn.query('DELETE FROM purchase_request_items WHERE pr_id = ?', [id]);
      grandTotal = 0;
      for (const it of b.items) {
        const c = itemCols(it);
        grandTotal += c.quantity * c.unit_cost;
        await conn.query(
          `INSERT INTO purchase_request_items (pr_id, budget_code_id, sapropdi_id, description, unit_id, quantity, unit_cost)
           VALUES (?,?,?,?,?,?,?)`,
          [id, c.budget_code_id, c.sapropdi_id, c.description, c.unit_id, c.quantity, c.unit_cost]
        );
      }
    }
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('entity_id', b.entity_id != null ? Number(b.entity_id) : undefined);
    set('request_date', b.request_date);
    set('date_required', b.date_required);
    set('status', b.status);
    if (grandTotal !== undefined) updates.grand_total = grandTotal;
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await conn.query(`UPDATE purchase_requests SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    await conn.commit();

    // If transitioning out of Draft and no approvals exist yet, seed them.
    if (b.status && b.status !== 'Draft' && prev.status === 'Draft') {
      const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM document_approvals WHERE document_type=? AND document_id=?', ['PR', id]);
      if (!Number((cnt as any[])[0].n)) {
        await seedApprovalSteps('PR', Number(id), Number(updates.entity_id ?? prev.entity_id), Number(grandTotal ?? prev.grand_total));
      }
    }

    const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(Number(id));
    return res.json({ message: 'PR updated', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};
router.put('/:id', authenticate, update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/purchase-requests/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM purchase_requests WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'PR not found' });
  return res.json({ message: 'PR deleted' });
});

export default router;
