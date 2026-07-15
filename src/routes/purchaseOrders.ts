import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import { seedApprovalSteps } from './documents';

export const router = Router();

const SELECT = `
  SELECT po.*, v.vendor_name, e.entities_name AS entity_name, bc.code AS budget_code,
         pr.pr_number
  FROM purchase_orders po
  LEFT JOIN vendors v          ON v.id = po.vendor_id
  LEFT JOIN entities e         ON e.id = po.entity_id
  LEFT JOIN budget_codes bc    ON bc.id = po.budget_code_id
  LEFT JOIN purchase_requests pr ON pr.id = po.purchase_request_id
`;

async function loadItems(poId: number) {
  const [rows] = await pool.query(
    `SELECT poi.*, pri.description AS pr_item_description
     FROM purchase_order_items poi
     LEFT JOIN purchase_request_items pri ON pri.id = poi.pr_item_id
     WHERE poi.po_id = ? ORDER BY poi.id ASC`, [poId]);
  return rows;
}
async function loadExtras(poId: number) {
  const [rows] = await pool.query('SELECT * FROM purchase_order_extra_costs WHERE po_id = ? ORDER BY id ASC', [poId]);
  return rows;
}

// Compute totals: subtotal(items) + extra costs, then optional PPN.
async function computeTotals(poId: number) {
  const [po] = await pool.query('SELECT is_tax_included, tax_rate FROM purchase_orders WHERE id = ? LIMIT 1', [poId]);
  const head = (po as any[])[0] || { is_tax_included: 0, tax_rate: 0 };
  const [i] = await pool.query('SELECT COALESCE(SUM(total),0) AS s FROM purchase_order_items WHERE po_id = ?', [poId]);
  const [x] = await pool.query('SELECT COALESCE(SUM(amount),0) AS s FROM purchase_order_extra_costs WHERE po_id = ?', [poId]);
  const itemsSubtotal = Number((i as any[])[0].s);
  const extraTotal = Number((x as any[])[0].s);
  const subtotal = itemsSubtotal + extraTotal;
  const taxAmount = head.is_tax_included ? subtotal * (Number(head.tax_rate) / 100) : 0;
  return {
    items_subtotal: itemsSubtotal,
    extra_cost_total: extraTotal,
    subtotal,
    tax_amount: taxAmount,
    grand_total: subtotal + taxAmount,
  };
}

// GET /api/purchase-orders?entity_id=&vendor_id=&status=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.entity_id) { where.push('po.entity_id = ?'); args.push(req.query.entity_id); }
  if (req.query.vendor_id) { where.push('po.vendor_id = ?'); args.push(req.query.vendor_id); }
  if (req.query.status)    { where.push('po.status = ?'); args.push(req.query.status); }
  if (req.query.search)    { where.push('po.po_number LIKE ?'); args.push(`%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY po.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

// GET /api/purchase-orders/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE po.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'PO not found' });
  const data = list[0];
  data.items = await loadItems(Number(req.params.id));
  data.extra_costs = await loadExtras(Number(req.params.id));
  data.totals = await computeTotals(Number(req.params.id));
  return res.json({ data });
});

// POST /api/purchase-orders  body: {..., items:[{pr_item_id,order_qty,unit_price}], extra_costs:[{description,amount}]}
router.post('/', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.vendor_id || !b.entity_id || !b.order_date) return res.status(422).json({ message: 'vendor_id, entity_id, order_date are required' });

    await conn.beginTransaction();
    const poNumber = b.po_number || await nextDocNumber('purchase_orders', 'po_number', 'PO');
    const [result] = await conn.query(
      `INSERT INTO purchase_orders (po_number, purchase_request_id, vendor_id, entity_id, budget_code_id, order_date, due_date, payment_terms, delivery_address, is_tax_included, tax_rate, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [poNumber,
       b.purchase_request_id != null && b.purchase_request_id !== '' ? Number(b.purchase_request_id) : null,
       Number(b.vendor_id), Number(b.entity_id),
       b.budget_code_id != null && b.budget_code_id !== '' ? Number(b.budget_code_id) : null,
       b.order_date, b.due_date || null, b.payment_terms || null, b.delivery_address || null,
       b.is_tax_included ? 1 : 0, b.tax_rate != null ? Number(b.tax_rate) : 11, b.status || 'Draft']
    );
    const id = (result as any).insertId;
    for (const it of (Array.isArray(b.items) ? b.items : [])) {
      await conn.query(
        `INSERT INTO purchase_order_items (po_id, pr_item_id, order_qty, unit_price) VALUES (?,?,?,?)`,
        [id, it.pr_item_id != null && it.pr_item_id !== '' ? Number(it.pr_item_id) : null,
         Number(it.order_qty || 0), Number(it.unit_price || 0)]
      );
    }
    for (const x of (Array.isArray(b.extra_costs) ? b.extra_costs : [])) {
      if (!x.description && !x.amount) continue;
      await conn.query('INSERT INTO purchase_order_extra_costs (po_id, description, amount) VALUES (?,?,?)',
        [id, x.description ?? '', Number(x.amount || 0)]);
    }
    await conn.commit();

    if ((b.status || 'Draft') !== 'Draft') {
      const totals = await computeTotals(id);
      await seedApprovalSteps('PO', id, Number(b.entity_id), totals.grand_total);
    }

    const [rows] = await pool.query(SELECT + ' WHERE po.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(id);
    data.extra_costs = await loadExtras(id);
    data.totals = await computeTotals(id);
    return res.status(201).json({ message: 'PO created', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/purchase-orders/:id
const update = async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    const [ex] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) { conn.release(); return res.status(404).json({ message: 'PO not found' }); }
    const b = req.body || {};

    await conn.beginTransaction();
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('purchase_request_id', b.purchase_request_id !== undefined ? (b.purchase_request_id === '' || b.purchase_request_id === null ? null : Number(b.purchase_request_id)) : undefined);
    set('vendor_id', b.vendor_id != null ? Number(b.vendor_id) : undefined);
    set('entity_id', b.entity_id != null ? Number(b.entity_id) : undefined);
    set('budget_code_id', b.budget_code_id !== undefined ? (b.budget_code_id === '' || b.budget_code_id === null ? null : Number(b.budget_code_id)) : undefined);
    set('order_date', b.order_date);
    set('due_date', b.due_date);
    set('payment_terms', b.payment_terms);
    set('delivery_address', b.delivery_address);
    if (b.is_tax_included !== undefined) updates.is_tax_included = b.is_tax_included ? 1 : 0;
    set('tax_rate', b.tax_rate != null ? Number(b.tax_rate) : undefined);
    set('status', b.status);
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await conn.query(`UPDATE purchase_orders SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    if (Array.isArray(b.items)) {
      await conn.query('DELETE FROM purchase_order_items WHERE po_id = ?', [id]);
      for (const it of b.items) {
        await conn.query('INSERT INTO purchase_order_items (po_id, pr_item_id, order_qty, unit_price) VALUES (?,?,?,?)',
          [id, it.pr_item_id != null && it.pr_item_id !== '' ? Number(it.pr_item_id) : null, Number(it.order_qty || 0), Number(it.unit_price || 0)]);
      }
    }
    if (Array.isArray(b.extra_costs)) {
      await conn.query('DELETE FROM purchase_order_extra_costs WHERE po_id = ?', [id]);
      for (const x of b.extra_costs) {
        if (!x.description && !x.amount) continue;
        await conn.query('INSERT INTO purchase_order_extra_costs (po_id, description, amount) VALUES (?,?,?)', [id, x.description ?? '', Number(x.amount || 0)]);
      }
    }
    await conn.commit();

    const [rows] = await pool.query(SELECT + ' WHERE po.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(Number(id));
    data.extra_costs = await loadExtras(Number(id));
    data.totals = await computeTotals(Number(id));
    return res.json({ message: 'PO updated', data });
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

// DELETE /api/purchase-orders/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM purchase_orders WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'PO not found' });
  return res.json({ message: 'PO deleted' });
});

export default router;
