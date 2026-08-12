import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, AuthUser } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { SYSTEM_ADMIN_ROLES, WRITE_OVERRIDE_ROLES, ROLE } from '../utils/roles';

// Polymorphic document layer: approvals / attachments / activities.
// Mounted at /api/documents/:type/:id/(approvals|attachments|activities)
export const router = Router({ mergeParams: true });

const DOC_TYPES = ['PR', 'PO', 'PayReq'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Where each document type keeps its own status column. */
const DOC_TABLE: Record<DocType, string> = {
  PR: 'purchase_requests',
  PO: 'purchase_orders',
  PayReq: 'payment_requests',
};

function checkType(req: Request, res: Response): boolean {
  if (!DOC_TYPES.includes(req.params.type as any)) {
    res.status(422).json({ message: `Invalid document type. Allowed: ${DOC_TYPES.join(', ')}` });
    return false;
  }
  return true;
}

/**
 * Load the document these sub-resources hang off, and refuse callers from another PT.
 *
 * The approval chain, the attachments and the activity log are all *about* a
 * document, so they are exactly as confidential as the document itself. Scoping
 * only /purchase-requests and leaving these open meant another PT's chain, file
 * list and history were readable — and its attachments writable — by anyone who
 * knew an id. Returns null once the response has been sent.
 */
async function loadScopedDocument(req: Request, res: Response): Promise<any | null> {
  const docType = req.params.type as DocType;
  const [rows] = await pool.query(
    `SELECT * FROM ${DOC_TABLE[docType]} WHERE id = ? LIMIT 1`, [req.params.id]);
  const doc = (rows as any[])[0];
  if (!doc) { res.status(404).json({ message: 'Document not found.' }); return null; }

  const user = req.user;
  if (!user || user.type !== 'User') {
    res.status(403).json({ message: 'Staff access only.' }); return null;
  }
  const isAdmin = SYSTEM_ADMIN_ROLES.includes(user.roleCode as any);
  if (!isAdmin && !user.roleCrossEntity && doc.entity_id != null && user.entityId !== doc.entity_id) {
    res.status(403).json({ message: 'This document belongs to another entity.' }); return null;
  }
  return doc;
}

// ---- Approvals ----
router.get('/:type/:id/approvals', authenticate, async (req, res) => {
  if (!checkType(req, res)) return;
  if (!(await loadScopedDocument(req, res))) return;
  const [rows] = await pool.query(
    `SELECT da.*, r.role_code, r.role_name, u.name AS user_name
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
  const docType = req.params.type as DocType;
  const docId = Number(req.params.id);
  const { action, note } = req.body || {};
  const map: Record<string, string> = { approve: 'Approved', reject: 'Rejected', revision: 'Revision' };
  const status = map[String(action)];
  if (!status) return res.status(422).json({ message: 'action must be approve | reject | revision' });
  const user = req.user!;

  if (user.type !== 'User') return res.status(403).json({ message: 'Staff access only.' });
  const [stepRows] = await pool.query(
    `SELECT da.id, da.step_order, da.step_label, da.status, da.role_id, r.role_code, r.role_name
     FROM document_approvals da
     LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.id = ? AND da.document_type = ? AND da.document_id = ? LIMIT 1`,
    [req.params.stepId, docType, docId]
  );
  const step = (stepRows as any[])[0];
  if (!step) return res.status(404).json({ message: 'Approval step not found.' });

  // The Payment step is an execution record, not an approval — it is written by
  // POST /api/payment-requests/:id/pay, never through this endpoint.
  if (step.step_label === 'Payment') {
    return res.status(409).json({ message: 'The payment step is recorded by the payment endpoint, not by approving.' });
  }

  // RBAC: only a staff user holding the step's role may act. System admins may override.
  // Note: Director no longer bypasses other roles' steps — with the 2026-08 flow the
  // Director owns explicit steps on PO and PayReq, so a blanket bypass would hollow out
  // exactly the control the flow is meant to enforce.
  // Super Admin only: an Admin sees every document but does not sign for anyone.
  const isSystemAdmin = WRITE_OVERRIDE_ROLES.includes(user.roleCode as any);
  if (!isSystemAdmin && (!step.role_code || user.roleCode !== step.role_code)) {
    return res.status(403).json({ message: `Only ${step.role_name || 'the assigned role'} may act on this step.` });
  }

  // Holding the right role is not enough — it has to be the right role *for this
  // entity*. SNBS and JNBS each have their own Project Manager and Field Admin, so
  // without this the JNBS PM could sign off an SNBS document. Roles flagged
  // is_cross_entity (Procurement, Finance, Director) legitimately serve both PTs.
  if (!isSystemAdmin) {
    const [docRows] = await pool.query(
      `SELECT d.entity_id, r.is_cross_entity
       FROM ${DOC_TABLE[docType]} d
       JOIN roles r ON r.id = ?
       WHERE d.id = ? LIMIT 1`,
      [user.roleId, docId]
    );
    const doc = (docRows as any[])[0];
    if (doc && !doc.is_cross_entity && doc.entity_id != null && user.entityId !== doc.entity_id) {
      return res.status(403).json({ message: 'This document belongs to another entity.' });
    }
  }

  // Steps must be taken in order: every earlier step has to be Approved first.
  const [pendingBefore] = await pool.query(
    `SELECT step_order FROM document_approvals
     WHERE document_type = ? AND document_id = ? AND step_order < ? AND status <> 'Approved'
     ORDER BY step_order ASC LIMIT 1`,
    [docType, docId, step.step_order]
  );
  const blocker = (pendingBefore as any[])[0];
  if (blocker) {
    return res.status(409).json({
      message: `Step ${step.step_order} cannot be actioned yet — step ${blocker.step_order} is still outstanding.`,
    });
  }

  await pool.query(
    `UPDATE document_approvals
     SET status = ?, user_id = ?, name = ?, position = ?, note = ?, action_date = CURDATE(), updated_at = NOW()
     WHERE id = ? AND document_type = ? AND document_id = ?`,
    [status, user.id, user.data?.name ?? null, user.data?.position ?? null, note ?? null,
     req.params.stepId, docType, docId]
  );
  await pool.query(
    `INSERT INTO document_activities (document_type, document_id, action, user_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [docType, docId, `${status} (step ${step.step_order}${isSystemAdmin && user.roleCode !== step.role_code ? ', admin override' : ''})`,
     user.id, note ?? null]
  );

  const documentStatus = await syncDocumentStatus(docType, docId);

  const [rows] = await pool.query('SELECT * FROM document_approvals WHERE id = ? LIMIT 1', [req.params.stepId]);
  return res.json({ message: `Step ${status}`, data: (rows as any[])[0], document_status: documentStatus });
});

// Resubmit a document that an approver sent back for revision.
//
// A "Revision" verdict is not a dead end: it hands the document back to whoever
// filed it, who fixes it and pushes it into the same chain again. Without this the
// document sat in Revision forever — every approver's step was already actioned,
// so the timeline offered nobody anything to do.
//
// Steps that were already Approved stay approved: the document returns to the
// approver who asked for the change, not to the very beginning.
router.post('/:type/:id/resubmit', authenticate, async (req: Request, res: Response) => {
  if (!checkType(req, res)) return;
  const docType = req.params.type as DocType;
  const docId = Number(req.params.id);
  const user = req.user!;
  if (user.type !== 'User') return res.status(403).json({ message: 'Staff access only.' });

  const [docRows] = await pool.query(`SELECT * FROM ${DOC_TABLE[docType]} WHERE id = ? LIMIT 1`, [docId]);
  const doc = (docRows as any[])[0];
  if (!doc) return res.status(404).json({ message: 'Document not found.' });
  if (doc.status !== 'Revision') {
    return res.status(409).json({ message: `Only a document sent back for revision can be resubmitted (this one is ${doc.status}).` });
  }

  const denied = await guardRequester(user, docType, docId, doc);
  if (denied) return res.status(403).json({ message: denied });

  const reset = await resetRevisionSteps(docType, docId, user);
  const documentStatus = await syncDocumentStatus(docType, docId);
  return res.json({ message: 'Document resubmitted for approval', steps_reset: reset, document_status: documentStatus });
});

// ---- Attachments ----
router.get('/:type/:id/attachments', authenticate, async (req, res) => {
  if (!checkType(req, res)) return;
  if (!(await loadScopedDocument(req, res))) return;
  const [rows] = await pool.query(
    'SELECT * FROM document_attachments WHERE document_type = ? AND document_id = ? ORDER BY id DESC',
    [req.params.type, req.params.id]
  );
  return res.json({ data: rows });
});

router.post('/:type/:id/attachments', authenticate, upload.single('file'), async (req: Request, res: Response) => {
  if (!checkType(req, res)) return;
  // Deliberately not gated on status: Finance uploads the transfer receipt after a
  // payment request is already Paid, and a requester uploads revision evidence
  // while the document sits in Revision. The entity is the line that matters.
  if (!(await loadScopedDocument(req, res))) return;
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
  if (!(await loadScopedDocument(req, res))) return;
  await pool.query('DELETE FROM document_attachments WHERE id = ? AND document_type = ? AND document_id = ?',
    [req.params.attId, req.params.type, req.params.id]);
  return res.json({ message: 'Attachment deleted' });
});

// ---- Activities (timeline) ----
router.get('/:type/:id/activities', authenticate, async (req, res) => {
  if (!checkType(req, res)) return;
  if (!(await loadScopedDocument(req, res))) return;
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
// Editing rules shared by the PR / PO / PayReq update handlers.
//
// A document may only be rewritten while it is still the requester's to hold:
// as a Draft, or after an approver sent it back for revision. Once it is in the
// chain (Pending), signed off (Approved), refused (Rejected) or paid, changing
// its contents would silently invalidate signatures already given.
// -----------------------------------------------------------------------------
export const EDITABLE_STATUSES = ['Draft', 'Revision'];

/** May this user override a business rule? Super Admin only — see utils/roles. */
function canOverride(user: AuthUser): boolean {
  return WRITE_OVERRIDE_ROLES.includes(user.roleCode as any);
}

/**
 * May this caller rewrite this document? Returns a message to send as 403, or
 * null when the edit is allowed.
 *
 * System admins are exempt: they are the documented override path for stuck
 * documents, and the override is recorded in document_activities.
 */
export function guardEdit(
  user: AuthUser | undefined,
  doc: { status: string; entity_id?: number | null },
  nextStatus?: string,
): string | null {
  if (!user || user.type !== 'User') return 'Staff access only.';
  // A document already in the chain must not be pushed back to Draft: its steps
  // would stay behind in Revision while the document claimed to be unsubmitted.
  if (nextStatus === 'Draft' && doc.status === 'Revision') {
    return 'A document in revision cannot be moved back to draft — edit it and resubmit.';
  }
  if (canOverride(user)) return null;
  if (!user.roleCrossEntity && doc.entity_id != null && user.entityId !== doc.entity_id) {
    return 'This document belongs to another entity.';
  }
  if (!EDITABLE_STATUSES.includes(doc.status)) {
    return `A document with status ${doc.status} can no longer be edited. Only Draft and Revision documents are editable.`;
  }
  return null;
}

/**
 * The role that files this kind of document, read off its own approval chain
 * rather than hard-coded: the chain comes from `approval_routes`, which an admin
 * may re-point from Settings, and a hard-coded map would quietly disagree with it.
 */
/**
 * Who raises each kind of document, for the one case the chain cannot answer:
 * a Draft, which has no chain yet. Kept in step with db/seed.sql's approval_routes.
 */
const DEFAULT_REQUESTER_ROLE: Record<DocType, string> = {
  PR: ROLE.FIELD_ADMIN,
  PO: ROLE.PROCUREMENT,
  PayReq: ROLE.PROCUREMENT,
};

async function requesterRoleCode(docType: DocType, docId: number): Promise<string | null> {
  const [rows] = await pool.query(
    `SELECT r.role_code FROM document_approvals da
     JOIN roles r ON r.id = da.role_id
     WHERE da.document_type = ? AND da.document_id = ?
     ORDER BY (COALESCE(da.step_label, '') = 'Requested') DESC, da.step_order ASC
     LIMIT 1`,
    [docType, docId]
  );
  return (rows as any[])[0]?.role_code ?? null;
}

/**
 * May this caller act *as the requester* of this document — edit it during a
 * revision and push it back into the chain? Returns a 403 message or null.
 */
export async function guardRequester(
  user: AuthUser,
  docType: DocType,
  docId: number,
  doc: { entity_id?: number | null; requested_by_user_id?: number | null },
): Promise<string | null> {
  if (canOverride(user)) return null;
  if (!user.roleCrossEntity && doc.entity_id != null && user.entityId !== doc.entity_id) {
    return 'This document belongs to another entity.';
  }
  // Whoever filed it may always take it back, even if their role has since changed.
  if (doc.requested_by_user_id != null && doc.requested_by_user_id === user.id) return null;
  const owner = await requesterRoleCode(docType, docId);
  if (owner && user.roleCode !== owner) {
    return `Only ${owner} may resubmit this document.`;
  }
  return null;
}

/**
 * May this caller delete this document?
 *
 * Deleting was the one operation with no guard at all: any signed-in staff member
 * could remove another PT's purchase request by id, mid-approval, and the approvals
 * and attachments hanging off it were left behind as orphans.
 *
 * The rule: a document is destroyable only while nobody has acted on it. Draft
 * belongs to whoever filed it and may be thrown away. Anything that has entered
 * the chain — Pending, Revision, Approved, Rejected — is a record of decisions
 * people made, so removing it is a system-administrator act, not a daily one.
 * `Paid` is refused outright: money moved, and the trail has to survive.
 */
export async function guardDelete(
  user: AuthUser | undefined,
  docType: DocType,
  docId: number,
  doc: { status: string; entity_id?: number | null; requested_by_user_id?: number | null },
): Promise<string | null> {
  if (!user || user.type !== 'User') return 'Staff access only.';
  if (doc.status === 'Paid') {
    return 'A paid payment request cannot be deleted — the payment record must stay.';
  }
  if (canOverride(user)) return null;
  if (!user.roleCrossEntity && doc.entity_id != null && user.entityId !== doc.entity_id) {
    return 'This document belongs to another entity.';
  }
  if (doc.status !== 'Draft') {
    return `Only a Draft can be deleted; this one is ${doc.status}. Ask an administrator if it really has to go.`;
  }

  // A draft has no approval chain yet, so — unlike resubmitting — who filed it
  // cannot be read off one. A purchase request records its author, so that is the
  // test; a PO and a PayReq do not, so they fall back to the role that raises them.
  // Without this a Project Manager could delete a Field Admin's draft simply by
  // sharing the entity with it.
  if (doc.requested_by_user_id != null) {
    return doc.requested_by_user_id === user.id
      ? null
      : 'Only the person who filed this draft may delete it.';
  }
  const owner = (await requesterRoleCode(docType, docId)) ?? DEFAULT_REQUESTER_ROLE[docType];
  if (owner && user.roleCode !== owner) return `Only ${owner} may delete this draft.`;
  return null;
}

/**
 * Remove the polymorphic rows that hang off a deleted document.
 *
 * document_approvals / _attachments / _activities reference their document by
 * (type, id) rather than by a foreign key, so nothing cascades: without this the
 * rows survive their document and reattach themselves to whatever later takes that
 * id back.
 */
export async function deleteDocumentChildren(docType: DocType, docId: number): Promise<void> {
  for (const table of ['document_approvals', 'document_attachments', 'document_activities']) {
    await pool.query(`DELETE FROM ${table} WHERE document_type = ? AND document_id = ?`, [docType, docId]);
  }
}

/**
 * Hand a revised document back to the approver who asked for the change: every
 * step still marked Revision returns to Pending. The reviewer's note is kept on
 * the step so the reason stays visible, but their name and date are cleared —
 * they have not acted on this round yet.
 */
export async function resetRevisionSteps(docType: DocType, docId: number, user: AuthUser): Promise<number> {
  const [result] = await pool.query(
    `UPDATE document_approvals
     SET status = 'Pending', user_id = NULL, name = NULL, position = NULL, action_date = NULL, updated_at = NOW()
     WHERE document_type = ? AND document_id = ? AND status = 'Revision'`,
    [docType, docId]
  );
  const n = Number((result as any).affectedRows || 0);
  if (n) {
    await pool.query(
      `INSERT INTO document_activities (document_type, document_id, action, user_id, note, created_at)
       VALUES (?, ?, 'Resubmitted after revision', ?, NULL, NOW())`,
      [docType, docId, user.id]
    );
  }
  return n;
}

// -----------------------------------------------------------------------------
// Helper: keep the document's own status column in step with its approval chain.
//
// Without this the approval rows moved to Approved but purchase_requests.status /
// purchase_orders.status / payment_requests.status stayed 'Pending' forever, so a
// fully signed-off document still looked outstanding in every list and dashboard.
//
// Rules: any Rejected step  -> Rejected
//        any Revision step  -> Revision
//        all approval steps Approved -> Approved
//        otherwise                   -> Pending
// The Payment step is excluded — payment execution is tracked by payment_requests
// (status 'Paid' + released_pay_date), not by the approval chain. The comparison is
// COALESCE'd because rows migrated from before step_label existed have it NULL, and
// `NULL <> 'Payment'` is NULL, not true — a plain <> would silently drop them and
// declare a half-approved document fully approved.
// -----------------------------------------------------------------------------
export async function syncDocumentStatus(docType: DocType, docId: number): Promise<string | null> {
  const [rows] = await pool.query(
    `SELECT status FROM document_approvals
     WHERE document_type = ? AND document_id = ?
       AND COALESCE(step_label, '') <> 'Payment'`,
    [docType, docId]
  );
  const steps = rows as { status: string }[];
  if (!steps.length) return null;

  let status: string;
  if (steps.some((s) => s.status === 'Rejected')) status = 'Rejected';
  else if (steps.some((s) => s.status === 'Revision')) status = 'Revision';
  else if (steps.every((s) => s.status === 'Approved')) status = 'Approved';
  else status = 'Pending';

  // A PayReq already marked Paid must not be dragged back to Approved.
  const table = DOC_TABLE[docType];
  if (docType === 'PayReq') {
    const [cur] = await pool.query(`SELECT status FROM ${table} WHERE id = ? LIMIT 1`, [docId]);
    if ((cur as any[])[0]?.status === 'Paid') return 'Paid';
  }

  await pool.query(`UPDATE ${table} SET status = ?, updated_at = NOW() WHERE id = ?`, [status, docId]);
  return status;
}

// -----------------------------------------------------------------------------
// Helper: seed approval steps for a freshly created document from approval_routes.
// Used by PR/PO/PayReq create handlers.
// -----------------------------------------------------------------------------
export async function seedApprovalSteps(docType: DocType, docId: number, entityId: number | null, amount: number) {
  // Entity-specific routes win outright; the entity-agnostic rows (entity_id IS NULL)
  // are only a fallback for entities that have no route of their own. Merging both
  // sets — as this used to — produced duplicate steps at the same step_order whenever
  // an entity-specific route and a global route coexisted.
  const [entityRows] = await pool.query(
    `SELECT * FROM approval_routes
     WHERE document_type = ? AND entity_id = ? ORDER BY step_order ASC`,
    [docType, entityId]
  );
  let routes = entityRows as any[];
  if (!routes.length) {
    const [globalRows] = await pool.query(
      `SELECT * FROM approval_routes
       WHERE document_type = ? AND entity_id IS NULL ORDER BY step_order ASC`,
      [docType]
    );
    routes = globalRows as any[];
  }

  for (const r of routes) {
    // Amount thresholds (e.g. a step that only applies above a certain value).
    if (r.min_amount != null && amount < Number(r.min_amount)) continue;
    if (r.max_amount != null && amount > Number(r.max_amount)) continue;
    await pool.query(
      `INSERT INTO document_approvals (document_type, document_id, step_order, step_label, role_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'Pending', NOW(), NOW())`,
      [docType, docId, r.step_order, r.step_label, r.role_id]
    );
  }
}
