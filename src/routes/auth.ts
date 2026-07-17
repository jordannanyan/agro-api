import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, issueToken, comparePassword, hashPassword } from '../middleware/auth';

export const router = Router();

// POST /api/login  — staff login (users + roles). Main dashboard entry.
router.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(422).json({ message: 'username and password required' });
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND is_active = 1 LIMIT 1', [username]);
    const list = rows as any[];
    if (!list.length || !(await comparePassword(password, list[0].password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const u = list[0];
    delete u.password;
    const [r] = await pool.query('SELECT role_name FROM roles WHERE id = ? LIMIT 1', [u.role_id]);
    const role = (r as any[])[0]?.role_name ?? null;
    let entity = null;
    if (u.entity_id) {
      const [e] = await pool.query('SELECT id, entities_name FROM entities WHERE id = ? LIMIT 1', [u.entity_id]);
      entity = (e as any[])[0] ?? null;
    }
    const token = await issueToken('User', u.id, 'staff-login');
    return res.json({ message: 'Login successful', token, user: { ...u, role, entity } });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/login/entity  — PT/entity login (used by the land+tree app).
router.post('/login/entity', async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(422).json({ message: 'username and password required' });
  try {
    const [rows] = await pool.query('SELECT * FROM entities WHERE username = ? LIMIT 1', [username]);
    const list = rows as any[];
    if (!list.length || !(await comparePassword(password, list[0].password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const entity = list[0];
    delete entity.password;
    entity.is_superadmin = !!entity.is_superadmin;
    const token = await issueToken('Entities', entity.id, 'entity-login');
    return res.json({ message: 'Login successful', token, entity });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/check-token — verify a JWT without consuming it.
router.post('/check-token', async (req: Request, res: Response) => {
  const header = req.headers.authorization || '';
  const fromHeader = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = (req.body?.token || fromHeader || '').toString().trim();
  if (!token) return res.status(401).json({ valid: false, message: 'Token not provided.' });
  try {
    const jwt = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret') as any;
    const [tok] = await pool.query('SELECT id FROM personal_access_tokens WHERE jti = ? LIMIT 1', [payload.jti]);
    if (!(tok as any[]).length) return res.status(401).json({ valid: false, message: 'Token revoked.' });
    return res.json({ valid: true, tokenable_type: payload.type, tokenable_id: payload.sub });
  } catch {
    return res.status(401).json({ valid: false, message: 'Invalid or expired token.' });
  }
});

// POST /api/login/kth
router.post('/login/kth', async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(422).json({ message: 'username and password required' });
  try {
    const [rows] = await pool.query('SELECT * FROM kth WHERE username = ? LIMIT 1', [username]);
    const list = rows as any[];
    if (!list.length || !(await comparePassword(password, list[0].password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const kth = list[0];
    delete kth.password;
    const token = await issueToken('Kth', kth.id, 'kth-login');
    return res.json({ message: 'Login successful', token, kth });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/login/farmer
router.post('/login/farmer', async (req: Request, res: Response) => {
  const { nik, password } = req.body || {};
  if (!nik || !password) return res.status(422).json({ message: 'nik and password required' });
  try {
    const [rows] = await pool.query('SELECT * FROM farmers WHERE nik = ? LIMIT 1', [nik]);
    const list = rows as any[];
    if (!list.length || !(await comparePassword(password, list[0].password))) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    const farmer = list[0];
    delete farmer.password;
    const token = await issueToken('Farmers', farmer.id, 'farmer-login');
    return res.json({ message: 'Login successful', token, farmer });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/me
router.get('/me', authenticate, (req: Request, res: Response) => {
  return res.json({ user: req.user });
});

// POST /api/logout — revoke current token (delete jti row).
router.post('/logout', authenticate, async (req: Request, res: Response) => {
  if (req.jti) await pool.query('DELETE FROM personal_access_tokens WHERE jti = ?', [req.jti]);
  return res.json({ message: 'Logged out successfully' });
});

// POST /api/change-password — staff self-service.
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  const { old_password, new_password } = req.body || {};
  if (!req.user || req.user.type !== 'User') return res.status(403).json({ message: 'Staff only' });
  if (!old_password || !new_password) return res.status(422).json({ message: 'old_password and new_password required' });
  const [rows] = await pool.query('SELECT password FROM users WHERE id = ? LIMIT 1', [req.user.id]);
  const u = (rows as any[])[0];
  if (!u || !(await comparePassword(old_password, u.password))) {
    return res.status(401).json({ message: 'Old password incorrect' });
  }
  await pool.query('UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?', [await hashPassword(new_password), req.user.id]);
  return res.json({ message: 'Password changed' });
});

export default router;
