import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, hashPassword } from '../middleware/auth';

export const router = Router();

const SELECT = `
  SELECT f.*, k.kth_name AS kth__kth_name, k.entities_id AS kth__entities_id
  FROM farmers f
  LEFT JOIN kth k ON k.id = f.kth_id
`;

function shape(row: any) {
  const out: any = {};
  const kth: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('kth__')) kth[k.slice(5)] = row[k];
    else out[k] = row[k];
  }
  delete out.password;
  out.kth = row.kth_id ? { id: row.kth_id, ...kth } : null;
  return out;
}

// GET /api/farmers?kth_id=&entity_id=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.kth_id)    { where.push('f.kth_id = ?'); args.push(req.query.kth_id); }
  if (req.query.entity_id) { where.push('k.entities_id = ?'); args.push(req.query.entity_id); }
  if (req.query.search)    { where.push('(f.farmer_name LIKE ? OR f.nik LIKE ?)'); args.push(`%${req.query.search}%`, `%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY f.farmer_name ASC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: (rows as any[]).map(shape) });
});

// GET /api/farmers/:id  (with plots)
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE f.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Farmer not found' });
  const farmer = shape(list[0]);
  const [plots] = await pool.query('SELECT id, plot_name, scheme FROM plot WHERE farmer_id = ? ORDER BY plot_name', [req.params.id]);
  farmer.plots = plots;
  return res.json({ data: farmer });
});

// POST /api/farmers
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.farmer_name || !b.kth_id) return res.status(422).json({ message: 'farmer_name and kth_id are required' });
    const numN = (v: any) => (v != null && v !== '' ? Number(v) : null);
    const cols: any = {
      farmer_name: b.farmer_name,
      nik: b.nik ?? null,
      kth_id: Number(b.kth_id),
      no_hp: b.no_hp ?? null,
      address: b.address ?? null,
      date_of_birth: b.date_of_birth || null,
      number_of_children: numN(b.number_of_children),
      previous_income: numN(b.previous_income),
      no_rek: b.no_rek ?? null,
      foto: b.foto ?? null,
      pre_finance: b.pre_finance != null ? (b.pre_finance ? 1 : 0) : null,
      password: b.password ? await hashPassword(String(b.password)) : null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [result] = await pool.query(
      `INSERT INTO farmers (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const [rows] = await pool.query(SELECT + ' WHERE f.id = ? LIMIT 1', [(result as any).insertId]);
    return res.status(201).json({ message: 'Farmer created', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/farmers/:id
const update = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id FROM farmers WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Farmer not found' });
    const b = req.body || {};
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('farmer_name', b.farmer_name);
    set('nik', b.nik);
    set('kth_id', b.kth_id != null ? Number(b.kth_id) : undefined);
    set('no_hp', b.no_hp);
    set('address', b.address);
    set('date_of_birth', b.date_of_birth);
    set('number_of_children', b.number_of_children != null ? Number(b.number_of_children) : undefined);
    set('previous_income', b.previous_income != null ? Number(b.previous_income) : undefined);
    set('no_rek', b.no_rek);
    set('foto', b.foto);
    if (b.pre_finance !== undefined) updates.pre_finance = b.pre_finance ? 1 : 0;
    if (b.password) updates.password = await hashPassword(String(b.password));
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE farmers SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query(SELECT + ' WHERE f.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Farmer updated', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
router.put('/:id', authenticate, update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/farmers/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM farmers WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Farmer not found' });
  return res.json({ message: 'Farmer deleted' });
});

export default router;
