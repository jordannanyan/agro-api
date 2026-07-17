import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';

// Polymorphic document layer: approvals / attachments / activities.
// Mounted at /api/documents/:type/:id/(approvals|attachments|activities)
export const router = Router({ mergeParams: true });

const DOC_TYPES = ['PR', 'PO', 'PayReq'] as const;

function checkType(req: Request, res: Response): boolean {
  if (!DOC_TYPES.includes(req.params.type as any)) {
    res.status(422).json({ message: `Invalid document type. Allowed: ${DOC_TYPES.join(', ')}` });
    return false;
  }
  return true;
}

// ---- Approvals ----
router.get('/:type/:id/approvals', authenticate, async (req, res) => {
  if (!checkType(req, res)) return;
  const [rows] = await pool.query(
    `SELECT da.*, r.role_name, u.name AS user_name
     FROM document_approvals da
     LEFT JOIN roles r ON r.id = da.role_id
     LEFT JOIN users u ON u.id = da.user_id
     WHERE da.document_type = ? AND da.document_id = ? ORDER BY da.step_order ASC`,
    [req.params.type, req.params.id]
  );
  return res.json({ data: rows });
});

// Act on an approval step: approve / reject / revision.
router.post('/:type/:id/approvals/:stepId/action', authenticate, async (req: Request, res: Response) => {
  if (!checkType(req, res)) return;
  const { action, note } = req.body || {};
  const map: Record<string, string> = { approve: 'Approved', reject: 'Rejected', revision: 'Revision' };
  const status = map[String(action)];
  if (!status) return res.status(422).json({ message: 'action must be approve | reject | revision' });
  const user = req.user!;

  // RBAC: only a staff user whose role matches the step's role may act (Director may act on any step).
  if (user.type !== 'User') return res.status(403).json({ message: 'Staff access only.' });
  const [stepRows] = await pool.query(
    `SELECT da.role_id, r.role_name FROM document_approvals da
     LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.id = ? AND da.document_type = ? AND da.document_id = ? LIMIT 1`,
    [req.params.stepId, req.params.type, req.params.id]
  );
  const step = (stepRows as any[])[0];
  if (!step) return res.status(404).json({ message: 'Approval step not found.' });
  const stepRole = step.role_name as string | null;
  if (user.role !== 'Director' && (!stepRole || user.role !== stepRole)) {
    return res.status(403).json({ message: `Only ${stepRole || 'the assigned role'} may act on this step.` });
  }

  await pool.query(
    `UPDATE document_approvals
     SET status = ?, user_id = ?, name = ?, position = ?, note = ?, action_date = CURDATE(), updated_at = NOW()
     WHERE id = ? AND document_type = ? AND document_id = ?`,
    [status, user.id, user.data?.name ?? null, user.data?.position ?? null, note ?? null,
     req.params.stepId, req.params.type, req.params.id]
  );
  await pool.query(
    `INSERT INTO document_activities (document_type, document_id, action, user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [req.params.type, req.params.id, `${status} (step ${req.params.stepId})`, user.id, note ?? null]
  );
  const [rows] = await pool.query('SELECT * FROM document_approvals WHERE id = ? LIMIT 1', [req.params.stepId]);
  return res.json({ message: `Step ${status}`, data: (rows as any[])[0] });
});

// ---- Attachments ----
router.get('/:type/:id/attachments', authenticate, async (req, res) => {
  if (!checkType(req, res)) return;
  const [rows] = await pool.query(
    'SELECT * FROM document_attachments WHERE document_type = ? AND document_id = ? ORDER BY id DESC',
    [req.params.type, req.params.id]
  );
  return res.json({ data: rows });
});

router.post('/:type/:id/attachments', authenticate, upload.single('file'), async (req: Request, res: Response) => {
  if (!checkType(req, res)) return;
  const path = fileToPath(req.file);
  if (!path) return res.status(422).json({ message: 'file is required' });
  const [result] = await pool.query(
    `INSERT INTO document_attachments (document_type, document_id, category, subcategory, file_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [req.params.type, req.params.id, req.body?.category ?? null, req.body?.subcategory ?? null, path]
  );
  const [rows] = await pool.query('SELECT * FROM document_attachments WHERE id = ? LIMIT 1', [(result as any).insertId]);
  return res.status(201).json({ message: 'Attachment uploaded', data: (rows as any[])[0] });
});

router.delete('/:type/:id/attachments/:attId', authenticate, async (req, res) => {
  if (!checkType(req, res)) return;
  await pool.query('DELETE FROM document_attachments WHERE id = ? AND document_type = ? AND document_id = ?',
    [req.params.attId, req.params.type, req.params.id]);
  return res.json({ message: 'Attachment deleted' });
});

// ---- Activities (timeline) ----
router.get('/:type/:id/activities', authenticate, async (req, res) => {
  if (!checkType(req, res)) return;
  const [rows] = await pool.query(
    `SELECT da.*, u.name AS user_name FROM document_activities da
     LEFT JOIN users u ON u.id = da.user_id
     WHERE da.document_type = ? AND da.document_id = ? ORDER BY da.created_at DESC, da.id DESC`,
    [req.params.type, req.params.id]
  );
  return res.json({ data: rows });
});

export default router;

// -----------------------------------------------------------------------------
// Helper: seed approval steps for a freshly created document from approval_routes.
// Used by PR/PO/PayReq create handlers.
// -----------------------------------------------------------------------------
export async function seedApprovalSteps(docType: 'PR' | 'PO' | 'PayReq', docId: number, entityId: number | null, amount: number) {
  const [routes] = await pool.query(
    `SELECT * FROM approval_routes
     WHERE document_type = ? AND (entity_id = ? OR entity_id IS NULL)
     ORDER BY step_order ASC`,
    [docType, entityId]
  );
  for (const r of routes as any[]) {
    // Amount thresholds (e.g. Director only when >= min_amount).
    if (r.min_amount != null && amount < Number(r.min_amount)) continue;
    if (r.max_amount != null && amount > Number(r.max_amount)) continue;
    await pool.query(
      `INSERT INTO document_approvals (document_type, document_id, step_order, role_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Pending', NOW(), NOW())`,
      [docType, docId, r.step_order, r.role_id]
    );
  }
}
