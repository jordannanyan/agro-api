import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

// scheme derived through processing → purchasing → plot (best-effort: majority scheme of contributions).
const SELECT = `
  SELECT s.*,
         pr.processing_code AS processing__processing_code, pr.commodities_id AS processing__commodities_id,
         o.offtaker_name AS offtaker__offtaker_name,
         w.warehouse_name AS warehouse__warehouse_name,
         c.commodities_name AS commodity__commodities_name
  FROM selling s
  LEFT JOIN processing pr  ON pr.id = s.processing_id
  LEFT JOIN offtaker o     ON o.id = s.offtaker_id
  LEFT JOIN warehouse w    ON w.id = s.warehouse_id
  LEFT JOIN commodities c  ON c.id = pr.commodities_id
`;

function shape(row: any) {
  const out: any = {};
  const rel: Record<string, any> = { processing: {}, offtaker: {}, warehouse: {}, commodity: {} };
  for (const k of Object.keys(row)) {
    const m = k.match(/^(processing|offtaker|warehouse|commodity)__(.+)$/);
    if (m) rel[m[1]][m[2]] = row[k];
    else out[k] = row[k];
  }
  out.processing = row.processing_id ? { id: row.processing_id, ...rel.processing } : null;
  out.offtaker = row.offtaker_id ? { id: row.offtaker_id, ...rel.offtaker } : null;
  out.warehouse = row.warehouse_id ? { id: row.warehouse_id, ...rel.warehouse } : null;
  out.commodity = rel.processing.commodities_id ? { id: rel.processing.commodities_id, ...rel.commodity } : null;
  return out;
}

// GET /api/selling?processing_id=&offtaker_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.processing_id) { where.push('s.processing_id = ?'); args.push(req.query.processing_id); }
  if (req.query.offtaker_id)   { where.push('s.offtaker_id = ?'); args.push(req.query.offtaker_id); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY s.date DESC, s.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: (rows as any[]).map(shape) });
});

// GET /api/selling/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE s.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Selling not found' });
  return res.json({ data: shape(list[0]) });
});

// POST /api/selling
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.processing_id || !b.date) return res.status(422).json({ message: 'processing_id and date are required' });
    const cols: any = {
      processing_id: Number(b.processing_id),
      offtaker_id: b.offtaker_id != null && b.offtaker_id !== '' ? Number(b.offtaker_id) : null,
      warehouse_id: b.warehouse_id != null && b.warehouse_id !== '' ? Number(b.warehouse_id) : null,
      date: b.date,
      delivered_volume: b.delivered_volume != null ? Number(b.delivered_volume) : 0,
      accepted_volume: b.accepted_volume != null ? Number(b.accepted_volume) : 0,
      price_per_unit: b.price_per_unit != null ? Number(b.price_per_unit) : 0,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [result] = await pool.query(
      `INSERT INTO selling (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const [rows] = await pool.query(SELECT + ' WHERE s.id = ? LIMIT 1', [(result as any).insertId]);
    return res.status(201).json({ message: 'Selling created', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/selling/:id
const update = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id FROM selling WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Selling not found' });
    const b = req.body || {};
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('processing_id', b.processing_id != null ? Number(b.processing_id) : undefined);
    set('offtaker_id', b.offtaker_id !== undefined ? (b.offtaker_id === '' || b.offtaker_id === null ? null : Number(b.offtaker_id)) : undefined);
    set('warehouse_id', b.warehouse_id !== undefined ? (b.warehouse_id === '' || b.warehouse_id === null ? null : Number(b.warehouse_id)) : undefined);
    set('date', b.date);
    set('delivered_volume', b.delivered_volume != null ? Number(b.delivered_volume) : undefined);
    set('accepted_volume', b.accepted_volume != null ? Number(b.accepted_volume) : undefined);
    set('price_per_unit', b.price_per_unit != null ? Number(b.price_per_unit) : undefined);
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE selling SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query(SELECT + ' WHERE s.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Selling updated', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
router.put('/:id', authenticate, update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/selling/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM selling WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Selling not found' });
  return res.json({ message: 'Selling deleted' });
});

export default router;
