import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

const STATUSES = ['open', 'processing', 'closed'] as const;

const SELECT = `
  SELECT pr.*, c.commodities_name AS commodity__commodities_name, w.warehouse_name AS warehouse__warehouse_name,
         (pr.volume_input - pr.volume_output) AS loss
  FROM processing pr
  LEFT JOIN commodities c ON c.id = pr.commodities_id
  LEFT JOIN warehouse w   ON w.id = pr.warehouse_id
`;

function shape(row: any) {
  const out: any = {};
  const rel: Record<string, any> = { commodity: {}, warehouse: {} };
  for (const k of Object.keys(row)) {
    const m = k.match(/^(commodity|warehouse)__(.+)$/);
    if (m) rel[m[1]][m[2]] = row[k];
    else out[k] = row[k];
  }
  out.commodity = row.commodities_id ? { id: row.commodities_id, ...rel.commodity } : null;
  out.warehouse = row.warehouse_id ? { id: row.warehouse_id, ...rel.warehouse } : null;
  return out;
}

async function loadContributions(processingId: number) {
  const [rows] = await pool.query(
    `SELECT pp.*, p.receipt_invoice, p.date AS purchasing_date, p.quantity AS purchasing_qty,
            COALESCE(pl.scheme,'BeliPutus') AS scheme
     FROM processing_purchasings pp
     JOIN purchasing p ON p.id = pp.purchasing_id
     LEFT JOIN plot pl ON pl.id = p.plot_id
     WHERE pp.processing_id = ?`, [processingId]);
  return rows;
}

// GET /api/processing?status=&commodities_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.status)         { where.push('pr.status = ?'); args.push(req.query.status); }
  if (req.query.commodities_id) { where.push('pr.commodities_id = ?'); args.push(req.query.commodities_id); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY pr.date DESC, pr.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: (rows as any[]).map(shape) });
});

// GET /api/processing/:id  (with contributing purchasings)
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Processing not found' });
  const data = shape(list[0]);
  data.purchasings = await loadContributions(Number(req.params.id));
  return res.json({ data });
});

// POST /api/processing  body: {..., purchasings:[{purchasing_id, volume_contributed}]}
router.post('/', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.processing_code || !b.date || !b.commodities_id) {
      return res.status(422).json({ message: 'processing_code, date, commodities_id are required' });
    }
    if (b.status && !STATUSES.includes(b.status)) return res.status(422).json({ message: 'Invalid status' });

    await conn.beginTransaction();
    const cols: any = {
      processing_code: b.processing_code,
      date: b.date,
      commodities_id: Number(b.commodities_id),
      warehouse_id: b.warehouse_id != null && b.warehouse_id !== '' ? Number(b.warehouse_id) : null,
      volume_input: b.volume_input != null ? Number(b.volume_input) : 0,
      volume_output: b.volume_output != null ? Number(b.volume_output) : 0,
      total_processing_cost: b.total_processing_cost != null ? Number(b.total_processing_cost) : 0,
      status: b.status || 'open',
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [result] = await conn.query(
      `INSERT INTO processing (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const id = (result as any).insertId;

    const items = Array.isArray(b.purchasings) ? b.purchasings : [];
    for (const it of items) {
      if (!it.purchasing_id) continue;
      await conn.query(
        'INSERT INTO processing_purchasings (processing_id, purchasing_id, volume_contributed) VALUES (?,?,?)',
        [id, Number(it.purchasing_id), Number(it.volume_contributed || 0)]
      );
      await conn.query('UPDATE purchasing SET is_process = 1 WHERE id = ?', [Number(it.purchasing_id)]);
    }
    await conn.commit();

    const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [id]);
    const data = shape((rows as any[])[0]);
    data.purchasings = await loadContributions(id);
    return res.status(201).json({ message: 'Processing created', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/processing/:id  (header only; replace purchasings if provided)
const update = async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    const [ex] = await conn.query('SELECT id FROM processing WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) { conn.release(); return res.status(404).json({ message: 'Processing not found' }); }
    const b = req.body || {};
    if (b.status && !STATUSES.includes(b.status)) { conn.release(); return res.status(422).json({ message: 'Invalid status' }); }

    await conn.beginTransaction();
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('processing_code', b.processing_code);
    set('date', b.date);
    set('commodities_id', b.commodities_id != null ? Number(b.commodities_id) : undefined);
    set('warehouse_id', b.warehouse_id !== undefined ? (b.warehouse_id === '' || b.warehouse_id === null ? null : Number(b.warehouse_id)) : undefined);
    set('volume_input', b.volume_input != null ? Number(b.volume_input) : undefined);
    set('volume_output', b.volume_output != null ? Number(b.volume_output) : undefined);
    set('total_processing_cost', b.total_processing_cost != null ? Number(b.total_processing_cost) : undefined);
    set('status', b.status);
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await conn.query(`UPDATE processing SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    if (Array.isArray(b.purchasings)) {
      await conn.query('DELETE FROM processing_purchasings WHERE processing_id = ?', [id]);
      for (const it of b.purchasings) {
        if (!it.purchasing_id) continue;
        await conn.query(
          'INSERT INTO processing_purchasings (processing_id, purchasing_id, volume_contributed) VALUES (?,?,?)',
          [id, Number(it.purchasing_id), Number(it.volume_contributed || 0)]
        );
        await conn.query('UPDATE purchasing SET is_process = 1 WHERE id = ?', [Number(it.purchasing_id)]);
      }
    }
    await conn.commit();

    const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [id]);
    const data = shape((rows as any[])[0]);
    data.purchasings = await loadContributions(Number(id));
    return res.json({ message: 'Processing updated', data });
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

// DELETE /api/processing/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM processing WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Processing not found' });
  return res.json({ message: 'Processing deleted' });
});

export default router;
