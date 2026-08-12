import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import {
  seedApprovalSteps, syncDocumentStatus, resetRevisionSteps,
  guardEdit, guardRequester, guardDelete, deleteDocumentChildren,
} from './documents';
import { ROLE } from '../utils/roles';
import { resolveWriteEntity, entityScope, canSeeEntity } from '../utils/entityScope';
import { PENDING_STEP_COLUMNS, pendingStepJoin } from '../utils/pendingStep';

export const router = Router();

const STATUSES = ['Draft', 'Pending', 'Approved', 'Rejected', 'Revision'] as const;

async function loadItems(prId: number) {
  const [rows] = await pool.query(
    `SELECT pri.*, bc.code AS budget_code, u.unit_name, s.sapropdi_name
     FROM purchase_request_items pri
     LEFT JOIN budget_codes bc ON bc.id = pri.budget_code_id
     LEFT JOIN units u         ON u.id = pri.unit_id
     LEFT JOIN sapropdi s      ON s.id = pri.sapropdi_id
     WHERE pri.pr_id = ? ORDER BY pri.id ASC`, [prId]);
  return rows;
}

const SELECT = `
  SELECT pr.*, e.entities_name AS entity_name, u.name AS requested_by_name,
${PENDING_STEP_COLUMNS}
  FROM purchase_requests pr
  LEFT JOIN entities e ON e.id = pr.entity_id
  LEFT JOIN users u    ON u.id = pr.requested_by_user_id
${pendingStepJoin('PR', 'pr')}
`;

// GET /api/purchase-requests?entity_id=&status=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  // Staff bound to one PT see only that PT's requests. The cross-entity roles
  // (Procurement, Finance, Director) and the system admins see everything, and for
  // them ?entity_id narrows the list instead of being ignored.
  const scope = entityScope(req);
  if (scope != null) { where.push('pr.entity_id = ?'); args.push(scope); }
  if (req.query.status)    { where.push('pr.status = ?'); args.push(req.query.status); }
  if (req.query.search)    { where.push('pr.pr_number LIKE ?'); args.push(`%${req.query.search}%`); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY pr.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

// GET /api/purchase-requests/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'PR not found' });
  const data = list[0];
  if (!canSeeEntity(req, data.entity_id)) {
    return res.status(403).json({ message: 'This purchase request belongs to another entity.' });
  }
  data.items = await loadItems(Number(req.params.id));
  const [appr] = await pool.query(
    `SELECT da.*, r.role_code, r.role_name FROM document_approvals da LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type='PR' AND da.document_id=? ORDER BY da.step_order`, [req.params.id]);
  data.approvals = appr;
  return res.json({ data });
});

function itemCols(it: any) {
  return {
    budget_code_id: it.budget_code_id != null && it.budget_code_id !== '' ? Number(it.budget_code_id) : null,
    sapropdi_id: it.sapropdi_id != null && it.sapropdi_id !== '' ? Number(it.sapropdi_id) : null,
    description: it.description ?? '',
    unit_id: it.unit_id != null && it.unit_id !== '' ? Number(it.unit_id) : null,
    quantity: Number(it.quantity || 0),
    unit_cost: Number(it.unit_cost || 0),
  };
}

// Who may file a purchase request. Admin is absent on purpose: they supervise the
// flow rather than take part in it.
const PR_WRITERS = [ROLE.FIELD_ADMIN, ROLE.PROJECT_MANAGER, ROLE.PROCUREMENT,
                    ROLE.FINANCE_MANAGER, ROLE.DIRECTOR, ROLE.SUPER_ADMIN];

// POST /api/purchase-requests  body: {entity_id, request_date, date_required, status, items:[...]}
router.post('/', authenticate, requireRole(...PR_WRITERS), async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.request_date) return res.status(422).json({ message: 'request_date is required' });
    if (b.status && !STATUSES.includes(b.status)) return res.status(422).json({ message: 'Invalid status' });
    // Entity-bound staff get their own entity; they never pick one.
    const scoped = resolveWriteEntity(req, b.entity_id);
    if ('error' in scoped) return res.status(422).json({ message: scoped.error });
    const entityId = scoped.entityId;
    const items = Array.isArray(b.items) ? b.items : [];
    const grandTotal = items.reduce((s: number, it: any) => s + Number(it.quantity || 0) * Number(it.unit_cost || 0), 0);

    await conn.beginTransaction();
    const prNumber = b.pr_number || await nextDocNumber('purchase_requests', 'pr_number', 'PR');
    const [result] = await conn.query(
      `INSERT INTO purchase_requests (pr_number, entity_id, requested_by_user_id, request_date, date_required, status, grand_total, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
      [prNumber, entityId, req.user?.type === 'User' ? req.user.id : null,
       b.request_date, b.date_required || null, b.status || 'Draft', grandTotal]
    );
    const id = (result as any).insertId;
    for (const it of items) {
      const c = itemCols(it);
      await conn.query(
        `INSERT INTO purchase_request_items (pr_id, budget_code_id, sapropdi_id, description, unit_id, quantity, unit_cost)
         VALUES (?,?,?,?,?,?,?)`,
        [id, c.budget_code_id, c.sapropdi_id, c.description, c.unit_id, c.quantity, c.unit_cost]
      );
    }
    await conn.commit();

    // Seed approval workflow when submitted (not Draft).
    if ((b.status || 'Draft') !== 'Draft') {
      await seedApprovalSteps('PR', id, entityId, grandTotal);
    }

    const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(id);
    return res.status(201).json({ message: 'PR created', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/purchase-requests/:id
const update = async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    // `finally` releases the connection; releasing on these early returns as well
    // would hand the same connection back to the pool twice.
    const [ex] = await conn.query('SELECT * FROM purchase_requests WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'PR not found' });
    const prev = (ex as any[])[0];
    const b = req.body || {};
    if (b.status && !STATUSES.includes(b.status)) return res.status(422).json({ message: 'Invalid status' });

    // Only the requester's own statuses (Draft / Revision) may be rewritten, and
    // only from within the owning entity — otherwise an edit could quietly change
    // what an approver has already signed.
    const denied = guardEdit(req.user, prev, b.status);
    if (denied) return res.status(403).json({ message: denied });

    // Pushing a revised request back into the chain is the requester's move, so it
    // is held to the requester's role, not merely to "can edit".
    const resubmitting = b.status === 'Pending' && prev.status === 'Revision';
    if (resubmitting) {
      const noRight = await guardRequester(req.user!, 'PR', Number(id), prev);
      if (noRight) return res.status(403).json({ message: noRight });
    }

    await conn.beginTransaction();
    let grandTotal: number | undefined;
    if (Array.isArray(b.items)) {
      await conn.query('DELETE FROM purchase_request_items WHERE pr_id = ?', [id]);
      grandTotal = 0;
      for (const it of b.items) {
        const c = itemCols(it);
        grandTotal += c.quantity * c.unit_cost;
        await conn.query(
          `INSERT INTO purchase_request_items (pr_id, budget_code_id, sapropdi_id, description, unit_id, quantity, unit_cost)
           VALUES (?,?,?,?,?,?,?)`,
          [id, c.budget_code_id, c.sapropdi_id, c.description, c.unit_id, c.quantity, c.unit_cost]
        );
      }
    }
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    // Entity-bound staff cannot move a request to another PT, on create or on edit.
    if (b.entity_id != null && b.entity_id !== '') {
      const scoped = resolveWriteEntity(req, b.entity_id);
      if ('error' in scoped) { await conn.rollback(); return res.status(422).json({ message: scoped.error }); }
      set('entity_id', scoped.entityId);
    }
    set('request_date', b.request_date);
    set('date_required', b.date_required);
    set('status', b.status);
    if (grandTotal !== undefined) updates.grand_total = grandTotal;
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await conn.query(`UPDATE purchase_requests SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    await conn.commit();

    // If transitioning out of Draft and no approvals exist yet, seed them.
    if (b.status && b.status !== 'Draft' && prev.status === 'Draft') {
      const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM document_approvals WHERE document_type=? AND document_id=?', ['PR', id]);
      if (!Number((cnt as any[])[0].n)) {
        await seedApprovalSteps('PR', Number(id), Number(updates.entity_id ?? prev.entity_id), Number(grandTotal ?? prev.grand_total));
      }
    }
    // Resubmitting after a revision: the steps already exist, so hand the document
    // back to the approver who asked for the change rather than seeding a new chain.
    if (resubmitting) await resetRevisionSteps('PR', Number(id), req.user!);
    // The chain, not the request body, decides the status once a chain exists.
    if (b.status && b.status !== 'Draft') await syncDocumentStatus('PR', Number(id));

    const [rows] = await pool.query(SELECT + ' WHERE pr.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.items = await loadItems(Number(id));
    return res.json({ message: 'PR updated', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};
router.put('/:id', authenticate, requireRole(...PR_WRITERS), update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/purchase-requests/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [ex] = await pool.query('SELECT * FROM purchase_requests WHERE id = ? LIMIT 1', [id]);
  const prev = (ex as any[])[0];
  if (!prev) return res.status(404).json({ message: 'PR not found' });

  const denied = await guardDelete(req.user, 'PR', id, prev);
  if (denied) return res.status(403).json({ message: denied });

  // Orders and payments descend from the request and inherit its entity. The
  // foreign key would quietly set their pointer to NULL, leaving a PO that claims
  // an entity nothing supports any more — so refuse instead of orphaning them.
  const [deps] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM purchase_orders WHERE purchase_request_id = ?) AS po,
            (SELECT COUNT(*) FROM payment_requests WHERE purchase_request_id = ?) AS pay`,
    [id, id]);
  const { po, pay } = (deps as any[])[0];
  if (Number(po) || Number(pay)) {
    return res.status(409).json({
      message: `PR ini masih dipakai ${Number(po)} PO dan ${Number(pay)} payment request. Hapus dokumen turunannya lebih dulu.`,
    });
  }

  await pool.query('DELETE FROM purchase_requests WHERE id = ?', [id]);
  await deleteDocumentChildren('PR', id);
  return res.json({ message: 'PR deleted' });
});

export default router;
