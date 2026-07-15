import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';

export const router = Router();

const SELECT = `
  SELECT si.*, w.warehouse_name, po.po_number, u.name AS received_by_name
  FROM stock_in si
  LEFT JOIN warehouse w        ON w.id = si.warehouse_id
  LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id
  LEFT JOIN users u            ON u.id = si.received_by_user_id
`;

async function loadItems(stockInId: number) {
  const [rows] = await pool.query(
    `SELECT sii.*, s.sapropdi_name FROM stock_in_items sii
     LEFT JOIN sapropdi s ON s.id = sii.sapropdi_id
     WHERE sii.stock_in_id = ? ORDER BY sii.id ASC`, [stockInId]);
  return rows;
}

// GET /api/stock-in?warehouse_id=&status=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.warehouse_id) { where.push('si.warehouse_id = ?'); args.push(req.query.warehouse_id); }
  if (req.query.status)       { where.push('si.status = ?'); args.push(req.query.status); }
  if (req.query.search)       { where.push('si.stock_in_number LIKE ?'); args.push(`%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY si.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

// GET /api/stock-in/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE si.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Stock In not found' });
  const data = list[0];
  data.items = await loadItems(Number(req.params.id));
  return res.json({ data });
});

const CONDITIONS = ['Good', 'Damaged', 'Shortage'] as const;

// POST /api/stock-in  body: {..., items:[{po_item_id,sapropdi_id,received_qty,item_condition,remarks}]}
router.post('/', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.warehouse_id || !b.stock_in_date) return res.status(422).json({ message: 'warehouse_id and stock_in_date are required' });

    await conn.beginTransaction();
    const number = b.stock_in_number || await nextDocNumber('stock_in', 'stock_in_number', 'SI');
    const [result] = await conn.query(
      `INSERT INTO stock_in (stock_in_number, purchase_order_id, stock_in_date, warehouse_id, received_by_user_id, delivery_note_no, supplier_delivery_date, vehicle_number, status, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [number,
       b.purchase_order_id != null && b.purchase_order_id !== '' ? Number(b.purchase_order_id) : null,
       b.stock_in_date, Number(b.warehouse_id),
       req.user?.type === 'User' ? req.user.id : (b.received_by_user_id ? Number(b.received_by_user_id) : null),
       b.delivery_note_no || null, b.supplier_delivery_date || null, b.vehicle_number || null,
       b.status || 'Draft', b.notes || null]
    );
    const id = (result as any).insertId;
    for (const it of (Array.isArray(b.items) ? b.items : [])) {
      const cond = CONDITIONS.includes(it.item_condition) ? it.item_condition : 'Good';
      await conn.query(
        `INSERT INTO stock_in_items (stock_in_id, po_item_id, sapropdi_id, received_qty, item_condition, remarks)
         VALUES (?,?,?,?,?,?)`,
        [id, it.po_item_id != null && it.po_item_id !== '' ? Number(it.po_item_id) : null,
         it.sapropdi_id != null && it.sapropdi_id !== '' ? Number(it.sapropdi_id) : null,
         Number(it.received_qty || 0), cond, it.remarks || null]
      );
    }
    await conn.commit();
    const [rows] = await pool.query(SELECT + ' WHERE si.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(id);
    return res.status(201).json({ message: 'Stock In created', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/stock-in/:id
const update = async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    const [ex] = await conn.query('SELECT id FROM stock_in WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) { conn.release(); return res.status(404).json({ message: 'Stock In not found' }); }
    const b = req.body || {};
    await conn.beginTransaction();
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('purchase_order_id', b.purchase_order_id !== undefined ? (b.purchase_order_id === '' || b.purchase_order_id === null ? null : Number(b.purchase_order_id)) : undefined);
    set('stock_in_date', b.stock_in_date);
    set('warehouse_id', b.warehouse_id != null ? Number(b.warehouse_id) : undefined);
    set('delivery_note_no', b.delivery_note_no);
    set('supplier_delivery_date', b.supplier_delivery_date);
    set('vehicle_number', b.vehicle_number);
    set('status', b.status);
    set('notes', b.notes);
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await conn.query(`UPDATE stock_in SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    if (Array.isArray(b.items)) {
      await conn.query('DELETE FROM stock_in_items WHERE stock_in_id = ?', [id]);
      for (const it of b.items) {
        const cond = CONDITIONS.includes(it.item_condition) ? it.item_condition : 'Good';
        await conn.query(
          `INSERT INTO stock_in_items (stock_in_id, po_item_id, sapropdi_id, received_qty, item_condition, remarks) VALUES (?,?,?,?,?,?)`,
          [id, it.po_item_id != null && it.po_item_id !== '' ? Number(it.po_item_id) : null,
           it.sapropdi_id != null && it.sapropdi_id !== '' ? Number(it.sapropdi_id) : null,
           Number(it.received_qty || 0), cond, it.remarks || null]
        );
      }
    }
    await conn.commit();
    const [rows] = await pool.query(SELECT + ' WHERE si.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(Number(id));
    return res.json({ message: 'Stock In updated', data });
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

// DELETE /api/stock-in/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM stock_in WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Stock In not found' });
  return res.json({ message: 'Stock In deleted' });
});

export default router;
