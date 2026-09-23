import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import { requireAttachment } from './documents';
import { notifyRoles } from '../utils/notify';
import { ROLE } from '../utils/roles';
import { entityScope } from '../utils/entityScope';
import { warehouseEntityPredicate } from '../utils/farmScope';
import { respondList } from '../utils/pagination';

export const router = Router();

const SELECT = `
  SELECT si.*, w.warehouse_name, po.po_number, u.name AS received_by_name,
         ent.id AS entity_id, ent.entities_name AS entity_name
  FROM stock_in si
  LEFT JOIN warehouse w        ON w.id = si.warehouse_id
  LEFT JOIN kth wk             ON wk.id = w.kth_id
  LEFT JOIN entities ent       ON ent.id = wk.entities_id
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
  // Same rule as stock out — goods received into a warehouse belong to its PT.
  const scope = entityScope(req);
  if (scope != null) { where.push(warehouseEntityPredicate('si.warehouse_id')); args.push(scope); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY si.id DESC';
  return respondList(req, res, sql, args);
});

// GET /api/stock-in/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const scope = entityScope(req);
  const sql = SELECT + ` WHERE si.id = ?${scope != null ? ` AND ${warehouseEntityPredicate('si.warehouse_id')}` : ''} LIMIT 1`;
  const [rows] = await pool.query(sql, scope != null ? [req.params.id, scope] : [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Stock In not found' });
  const data = list[0];
  data.items = await loadItems(Number(req.params.id));
  return res.json({ data });
});

const CONDITIONS = ['Good', 'Damaged', 'Shortage'] as const;

// POST /api/stock-in  body: {..., items:[{po_item_id,sapropdi_id,received_qty,item_condition,remarks}]}
/**
 * Tell Procurement and the Project Manager when a delivery did not match the order.
 *
 * A short or damaged delivery is somebody's to answer for — the vendor's, usually —
 * and the person who has to raise it is Procurement, who placed the order. Before
 * this the shortage was written on the receiving note and discovered weeks later,
 * when the stock did not add up.
 *
 * Two things count as a shortage, and both are worth saying:
 *   * less arrived than the order asked for, per line
 *   * a line was marked Damaged or Shortage on arrival
 *
 * A stock-in with no purchase order behind it is skipped: there is no ordered
 * quantity to fall short of, and nobody to hold to account.
 */
async function announceShortage(stockInId: number) {
  try {
    const [rows] = await pool.query(
      `SELECT si.stock_in_number, si.purchase_order_id, si.warehouse_id,
              w.warehouse_name, po.po_number, v.vendor_name, ent.id AS entity_id
       FROM stock_in si
       LEFT JOIN warehouse w      ON w.id = si.warehouse_id
       LEFT JOIN kth wk           ON wk.id = w.kth_id
       LEFT JOIN entities ent     ON ent.id = wk.entities_id
       LEFT JOIN purchase_orders po ON po.id = si.purchase_order_id
       LEFT JOIN vendors v        ON v.id = po.vendor_id
       WHERE si.id = ? LIMIT 1`, [stockInId]);
    const head = (rows as any[])[0];
    if (!head || !head.purchase_order_id) return;

    const [lines] = await pool.query(
      `SELECT sii.received_qty, sii.item_condition, sii.remarks,
              poi.order_qty, s.sapropdi_name, pri.description AS pr_item_description
       FROM stock_in_items sii
       LEFT JOIN purchase_order_items poi ON poi.id = sii.po_item_id
       LEFT JOIN purchase_request_items pri ON pri.id = poi.pr_item_id
       LEFT JOIN sapropdi s ON s.id = sii.sapropdi_id
       WHERE sii.stock_in_id = ?`, [stockInId]);

    const problems = (lines as any[])
      .map((l) => {
        const name = l.sapropdi_name || l.pr_item_description || 'Item';
        const ordered = l.order_qty != null ? Number(l.order_qty) : null;
        const got = Number(l.received_qty || 0);
        const short = ordered != null && got < ordered ? ordered - got : 0;
        const bad = l.item_condition === 'Damaged' || l.item_condition === 'Shortage';
        if (!short && !bad) return null;
        const parts: string[] = [];
        if (short) parts.push(`kurang ${short} dari ${ordered}`);
        if (bad) parts.push(l.item_condition === 'Damaged' ? 'rusak' : 'shortage');
        return `${name} (${parts.join(', ')})`;
      })
      .filter((x): x is string => !!x);

    if (!problems.length) return;

    const shown = problems.slice(0, 4).join('; ');
    const more = problems.length > 4 ? ` dan ${problems.length - 4} item lain` : '';
    await notifyRoles([ROLE.PROCUREMENT, ROLE.PROJECT_MANAGER], head.entity_id ?? null, {
      kind: 'stock_shortage',
      title: `Selisih penerimaan ${head.po_number} — perlu ditindaklanjuti`,
      body: `${head.stock_in_number} di ${head.warehouse_name || 'gudang'} tidak sesuai pesanan`
        + `${head.vendor_name ? ` dari ${head.vendor_name}` : ''}: ${shown}${more}.`,
      documentType: 'StockIn',
      documentId: stockInId,
      link: `/warehouse/stockin/${stockInId}`,
    });
  } catch (err: any) {
    console.error('[notify] announceShortage gagal:', err?.message || err);
  }
}

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
    // A receipt may not be posted with nothing attached — the surat jalan is what
    // says the delivery arrived, and a posted receipt without one is a stock figure
    // nobody can check against a supplier. Unlike a stock out, this document does
    // have a Draft to fall back to, so it is left there rather than refused
    // outright: the form saves a Draft, uploads, then posts.
    if ((b.status || 'Draft') !== 'Draft') {
      const missing = await requireAttachment('StockIn', id);
      if (missing) {
        await conn.query("UPDATE stock_in SET status = 'Draft' WHERE id = ?", [id]);
        await conn.commit();
        return res.status(422).json({ message: missing, data: { id, status: 'Draft' } });
      }
    }
    await conn.commit();
    // After the commit: the notification reads the rows back, and it must not be
    // able to hold up a receipt that is already recorded.
    await announceShortage(id);
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
    // The same gate on the other way in. Read before the UPDATE so the document's
    // status here is still the one it had when the request arrived.
    if (b.status !== undefined && b.status !== 'Draft') {
      const [cur] = await conn.query('SELECT status FROM stock_in WHERE id = ? LIMIT 1', [id]);
      const was = (cur as any[])[0]?.status;
      if (was === 'Draft') {
        const missing = await requireAttachment('StockIn', Number(id));
        if (missing) {
          await conn.rollback();
          return res.status(422).json({ message: missing });
        }
      }
    }
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
  const id = Number(req.params.id);
  // The lines cascade with the header, but attachments do not: they are addressed
  // by (type, id) with no foreign key, by design — a record of what was attached
  // has to outlive a document that is merely edited. On a real delete they would
  // otherwise linger, pointing at an id that a later stock-in will reuse.
  const [items] = await pool.query('SELECT id FROM stock_in_items WHERE stock_in_id = ?', [id]);
  const itemIds = (items as any[]).map((r) => Number(r.id));
  if (itemIds.length) {
    await pool.query(
      "DELETE FROM document_attachments WHERE document_type = 'StockInItem' AND document_id IN (?)",
      [itemIds]);
  }
  await pool.query(
    "DELETE FROM document_attachments WHERE document_type = 'StockIn' AND document_id = ?", [id]);

  const [result] = await pool.query('DELETE FROM stock_in WHERE id = ?', [id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Stock In not found' });
  return res.json({ message: 'Stock In deleted' });
});

export default router;
