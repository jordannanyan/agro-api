import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

const SCHEMES = ['BeliPutus', 'PreFinance', 'ProfitSharing'] as const;

const SELECT = `
  SELECT p.*, f.farmer_name AS farmer__farmer_name, f.kth_id AS farmer__kth_id
  FROM plot p
  LEFT JOIN farmers f ON f.id = p.farmer_id
`;

function shape(row: any) {
  const out: any = {};
  const farmer: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('farmer__')) farmer[k.slice(8)] = row[k];
    else out[k] = row[k];
  }
  out.farmer = row.farmer_id ? { id: row.farmer_id, ...farmer } : null;
  return out;
}

// GET /api/plots?farmer_id=&scheme=&kth_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.farmer_id) { where.push('p.farmer_id = ?'); args.push(req.query.farmer_id); }
  if (req.query.scheme)    { where.push('p.scheme = ?'); args.push(req.query.scheme); }
  if (req.query.kth_id)    { where.push('f.kth_id = ?'); args.push(req.query.kth_id); }
  if (req.query.search)    { where.push('p.plot_name LIKE ?'); args.push(`%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY p.plot_name ASC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: (rows as any[]).map(shape) });
});

// GET /api/plots/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Plot not found' });
  return res.json({ data: shape(list[0]) });
});

function validScheme(s: any) { return s === undefined || SCHEMES.includes(s); }

// POST /api/plots
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.plot_name || !b.farmer_id) return res.status(422).json({ message: 'plot_name and farmer_id are required' });
    if (!validScheme(b.scheme)) return res.status(422).json({ message: `Invalid scheme. Allowed: ${SCHEMES.join(', ')}` });
    const cols: any = {
      plot_name: b.plot_name,
      farmer_id: Number(b.farmer_id),
      scheme: b.scheme || 'BeliPutus',
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [result] = await pool.query(
      `INSERT INTO plot (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [(result as any).insertId]);
    return res.status(201).json({ message: 'Plot created', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/plots/:id
const update = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    if (!validScheme(b.scheme)) return res.status(422).json({ message: `Invalid scheme. Allowed: ${SCHEMES.join(', ')}` });
    const [ex] = await pool.query('SELECT id FROM plot WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Plot not found' });
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('plot_name', b.plot_name);
    set('farmer_id', b.farmer_id != null ? Number(b.farmer_id) : undefined);
    set('scheme', b.scheme);
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE plot SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Plot updated', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
router.put('/:id', authenticate, update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/plots/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM plot WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Plot not found' });
  return res.json({ message: 'Plot deleted' });
});

export default router;
