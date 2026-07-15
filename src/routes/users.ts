import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, requireRole, hashPassword } from '../middleware/auth';

export const router = Router();

const SELECT = `
  SELECT u.id, u.entity_id, u.role_id, u.name, u.username, u.email, u.position, u.is_active,
         u.created_at, u.updated_at,
         r.role_name AS role_name,
         e.entities_name AS entity_name
  FROM users u
  LEFT JOIN roles r    ON r.id = u.role_id
  LEFT JOIN entities e ON e.id = u.entity_id
`;

// GET /api/users
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.entity_id) { where.push('u.entity_id = ?'); args.push(req.query.entity_id); }
  if (req.query.role_id)   { where.push('u.role_id = ?');   args.push(req.query.role_id); }
  if (req.query.search)    { where.push('(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
    args.push(`%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY u.name ASC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

// GET /api/users/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE u.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'User not found' });
  return res.json({ data: list[0] });
});

// POST /api/users  (Finance/Director manage staff)
router.post('/', authenticate, requireRole('Finance', 'Director'), async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    for (const k of ['name', 'username', 'role_id', 'password']) {
      if (b[k] === undefined || b[k] === null || b[k] === '') return res.status(422).json({ message: `${k} is required` });
    }
    const cols = {
      entity_id: b.entity_id != null && b.entity_id !== '' ? Number(b.entity_id) : null,
      role_id: Number(b.role_id),
      name: b.name,
      username: b.username,
      email: b.email ?? null,
      password: await hashPassword(String(b.password)),
      position: b.position ?? null,
      is_active: b.is_active === false || b.is_active === '0' || b.is_active === 0 ? 0 : 1,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [result] = await pool.query(
      `INSERT INTO users (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => (cols as any)[k])
    );
    const [rows] = await pool.query(SELECT + ' WHERE u.id = ? LIMIT 1', [(result as any).insertId]);
    return res.status(201).json({ message: 'User created', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/users/:id
const update = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id FROM users WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'User not found' });
    const b = req.body || {};
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('entity_id', b.entity_id !== undefined ? (b.entity_id === '' || b.entity_id === null ? null : Number(b.entity_id)) : undefined);
    set('role_id', b.role_id != null ? Number(b.role_id) : undefined);
    set('name', b.name);
    set('username', b.username);
    set('email', b.email);
    set('position', b.position);
    if (b.is_active !== undefined) updates.is_active = (b.is_active === false || b.is_active === '0' || b.is_active === 0) ? 0 : 1;
    if (b.password) updates.password = await hashPassword(String(b.password));
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE users SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query(SELECT + ' WHERE u.id = ? LIMIT 1', [id]);
    return res.json({ message: 'User updated', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
router.put('/:id', authenticate, requireRole('Finance', 'Director'), update);
router.post('/:id', authenticate, requireRole('Finance', 'Director'), (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/users/:id
router.delete('/:id', authenticate, requireRole('Finance', 'Director'), async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'User not found' });
  return res.json({ message: 'User deleted' });
});

export default router;
