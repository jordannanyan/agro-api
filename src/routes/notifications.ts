// What happened that you should know about — see utils/notify.ts for why this is
// separate from the approval inbox.
//
// Read state belongs to the person, not to the event, so every row here is already
// addressed to the caller: there is no "whose is this" check to get wrong, only a
// user_id filter that every query carries.

import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

/** Staff only. Entities, KTH and farmers have no notification list of their own. */
function staffId(req: Request): number | null {
  return req.user?.type === 'User' ? Number(req.user.id) : null;
}

// GET /api/notifications?unread=1&limit=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const uid = staffId(req);
  if (uid == null) return res.json({ data: [], unread: 0 });

  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const where = ['user_id = ?'];
  const args: any[] = [uid];
  if (req.query.unread) where.push('read_at IS NULL');

  const [rows] = await pool.query(
    `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`, args);
  const [cnt] = await pool.query(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [uid]);

  return res.json({ data: rows, unread: Number((cnt as any[])[0]?.n || 0) });
});

// GET /api/notifications/unread-count — what the bell needs, and nothing else.
router.get('/unread-count', authenticate, async (req: Request, res: Response) => {
  const uid = staffId(req);
  if (uid == null) return res.json({ data: { unread: 0 } });
  const [cnt] = await pool.query(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [uid]);
  return res.json({ data: { unread: Number((cnt as any[])[0]?.n || 0) } });
});

// POST /api/notifications/:id/read
router.post('/:id/read', authenticate, async (req: Request, res: Response) => {
  const uid = staffId(req);
  if (uid == null) return res.status(403).json({ message: 'Staff access only.' });
  await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ? AND read_at IS NULL',
    [Number(req.params.id), uid]);
  return res.json({ message: 'Notifikasi ditandai sudah dibaca' });
});

// POST /api/notifications/read-all
router.post('/read-all', authenticate, async (req: Request, res: Response) => {
  const uid = staffId(req);
  if (uid == null) return res.status(403).json({ message: 'Staff access only.' });
  const [r] = await pool.query(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [uid]);
  return res.json({ message: 'Semua notifikasi ditandai sudah dibaca', data: { updated: (r as any).affectedRows || 0 } });
});

export default router;
