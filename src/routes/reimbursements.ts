// Reimbursement — paying farmers, through their KTH.
//
// The shape of the thing: one transfer leaves the company account and lands in the
// KTH's account, and the document says which farmers that one transfer is meant to
// settle and how much each is owed. The KTH hands it on. So there is one amount at
// the bank and a list of people behind it, and the two have to agree — the header
// amount is therefore *derived* from the lines here, never typed. A payment whose
// total disagrees with its own breakdown is a payment nobody can account for.
//
// It is a `payment_requests` row with `payreq_kind = 'Reimbursement'`, not a table
// of its own. That is the whole point: the approval chain, the payment code issued
// when the chain closes, the bank-statement matching that turns a code and an
// amount into `Paid`, the attachments and the timeline all already exist and all
// key on a payment request. A parallel implementation would have been a second
// copy of every one of them, free to disagree about what "paid" means.
//
// What differs from a procurement PayReq:
//   * no PR and no PO behind it — nothing was procured
//   * the entity comes from the KTH, not from a source document
//   * a Field Admin files it (approval_routes, document_type 'Reimbursement')
//   * the bank details are the KTH's, snapshotted at creation
//
// Design note on `farmer_name`: it is stored on the line, not joined at read time.
// Farmers get renamed and deleted; a record of who was paid has to keep saying so.

import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import {
  seedApprovalSteps, syncDocumentStatus,
  guardEdit, guardRequester, guardDelete, deleteDocumentChildren,
} from './documents';
import { ROLE } from '../utils/roles';
import { inheritEntity, entityScope, canSeeEntity } from '../utils/entityScope';
import { PENDING_STEP_COLUMNS, pendingStepJoin } from '../utils/pendingStep';

export const router = Router();

/** Who may raise one: the Field Admin who files it, plus the seniors above them. */
const CREATORS = [
  ROLE.FIELD_ADMIN, ROLE.PROJECT_MANAGER, ROLE.FINANCE_MANAGER, ROLE.SUPER_ADMIN,
] as const;

const SELECT = `
  SELECT pay.*, e.entities_name AS entity_name, bc.code AS budget_code,
         k.kth_name, k.bank_name AS kth_bank_name, k.bank_account AS kth_bank_account,
         k.bank_account_name AS kth_bank_account_name,
         u.name AS requested_by_name,
         (SELECT COUNT(*)      FROM reimbursement_items ri WHERE ri.payment_request_id = pay.id) AS farmer_count,
         (SELECT COALESCE(SUM(ri.amount), 0) FROM reimbursement_items ri WHERE ri.payment_request_id = pay.id) AS items_total,
${PENDING_STEP_COLUMNS}
  FROM payment_requests pay
  LEFT JOIN entities e      ON e.id = pay.entity_id
  LEFT JOIN budget_codes bc ON bc.id = pay.budget_code_id
  LEFT JOIN kth k           ON k.id = pay.kth_id
  LEFT JOIN users u         ON u.id = pay.requested_by_user_id
${pendingStepJoin('Reimbursement', 'pay')}
  WHERE pay.payreq_kind = 'Reimbursement'
`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// GET /api/reimbursements?entity_id=&status=&kth_id=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  const scope = entityScope(req);
  if (scope != null) { where.push('pay.entity_id = ?'); args.push(scope); }
  if (req.query.status) { where.push('pay.status = ?'); args.push(req.query.status); }
  if (req.query.kth_id) { where.push('pay.kth_id = ?'); args.push(Number(req.query.kth_id)); }
  if (req.query.search) {
    where.push('(pay.payreq_number LIKE ? OR pay.reason LIKE ? OR k.kth_name LIKE ?)');
    const like = `%${req.query.search}%`;
    args.push(like, like, like);
  }
  const sql = SELECT + (where.length ? ` AND ${where.join(' AND ')}` : '') + ' ORDER BY pay.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

/**
 * GET /api/reimbursements/farmer-summary?entity_id=&farmer_id=&from=&to=
 *
 * What each farmer has actually been paid, and what is still working its way
 * through the chain.
 *
 * This is the half that makes the farmer lines worth recording. It is deliberately
 * *reporting only* — nothing in the profit-sharing calculation reads it yet, and
 * `alreadyPaidToFarmer()` in profitSharing.ts is still a stub returning 0. Wiring
 * the two together changes what the system says is payable, which is a decision
 * about money rather than a piece of plumbing; see docs/reimbursement.md.
 */
router.get('/farmer-summary', authenticate, async (req: Request, res: Response) => {
  const where: string[] = ["pay.payreq_kind = 'Reimbursement'"];
  const args: any[] = [];
  const scope = entityScope(req);
  if (scope != null) { where.push('pay.entity_id = ?'); args.push(scope); }
  if (req.query.farmer_id) { where.push('ri.farmer_id = ?'); args.push(Number(req.query.farmer_id)); }
  if (req.query.from) { where.push('pay.released_pay_date >= ?'); args.push(req.query.from); }
  if (req.query.to) { where.push('pay.released_pay_date <= ?'); args.push(req.query.to); }

  const [rows] = await pool.query(
    `SELECT ri.farmer_id,
            MAX(ri.farmer_name) AS farmer_name,
            MAX(k.kth_name)     AS kth_name,
            COUNT(DISTINCT CASE WHEN pay.status = 'Paid' THEN pay.id END)  AS paid_documents,
            COALESCE(SUM(CASE WHEN pay.status = 'Paid' THEN ri.amount END), 0) AS paid_total,
            COALESCE(SUM(CASE WHEN pay.status NOT IN ('Paid','Rejected') THEN ri.amount END), 0) AS in_progress_total,
            MAX(CASE WHEN pay.status = 'Paid' THEN pay.released_pay_date END) AS last_paid_date
     FROM reimbursement_items ri
     JOIN payment_requests pay ON pay.id = ri.payment_request_id
     LEFT JOIN kth k ON k.id = pay.kth_id
     WHERE ${where.join(' AND ')}
     GROUP BY ri.farmer_id
     ORDER BY paid_total DESC`, args);
  return res.json({ data: rows });
});

// GET /api/reimbursements/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' AND pay.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Reimbursement not found' });
  const data = list[0];
  if (!canSeeEntity(req, data.entity_id)) {
    return res.status(403).json({ message: 'This reimbursement belongs to another entity.' });
  }
  const [items] = await pool.query(
    `SELECT ri.*, f.no_hp, f.no_rek
     FROM reimbursement_items ri
     LEFT JOIN farmers f ON f.id = ri.farmer_id
     WHERE ri.payment_request_id = ? ORDER BY ri.id ASC`, [req.params.id]);
  data.items = items;
  const [appr] = await pool.query(
    `SELECT da.*, r.role_code, r.role_name FROM document_approvals da
     LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type = 'Reimbursement' AND da.document_id = ? ORDER BY da.step_order`,
    [req.params.id]);
  data.approvals = appr;
  return res.json({ data });
});

// ---------------------------------------------------------------------------
// The farmer lines
// ---------------------------------------------------------------------------

interface ItemInput { farmer_id: number; description?: string | null; amount: number }

/**
 * Read the farmer lines out of a request body, refusing anything that would make
 * the document unpayable.
 *
 * Every line names a farmer from the master list. A free-typed name would be
 * easier to file and useless afterwards: the whole reason to keep this breakdown
 * is to be able to answer "what has this person been paid", and a name typed three
 * different ways cannot answer it.
 */
async function readItems(raw: any): Promise<{ items: (ItemInput & { farmer_name: string })[] } | { error: string }> {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: 'Isi minimal satu baris petani — reimbursement tanpa daftar petani tidak bisa dipertanggungjawabkan.' };
  }
  const cleaned: ItemInput[] = [];
  for (const [i, r] of raw.entries()) {
    const farmerId = r?.farmer_id != null && r.farmer_id !== '' ? Number(r.farmer_id) : null;
    const amount = Number(r?.amount || 0);
    if (!farmerId) return { error: `Baris ${i + 1}: petani belum dipilih.` };
    if (!(amount > 0)) return { error: `Baris ${i + 1}: nominal harus lebih dari 0.` };
    cleaned.push({ farmer_id: farmerId, description: r?.description ?? null, amount });
  }

  // One farmer twice in one document is almost always two rows that should have
  // been one, and it makes the per-farmer total ambiguous to read back.
  const seen = new Set<number>();
  for (const c of cleaned) {
    if (seen.has(c.farmer_id)) return { error: 'Ada petani yang muncul dua kali. Gabungkan jadi satu baris.' };
    seen.add(c.farmer_id);
  }

  const [rows] = await pool.query(
    'SELECT id, farmer_name, kth_id FROM farmers WHERE id IN (?)', [cleaned.map((c) => c.farmer_id)]);
  const byId = new Map<number, any>((rows as any[]).map((f) => [Number(f.id), f]));
  const missing = cleaned.filter((c) => !byId.has(c.farmer_id));
  if (missing.length) return { error: `Petani tidak ditemukan: ${missing.map((m) => m.farmer_id).join(', ')}` };

  return {
    items: cleaned.map((c) => ({ ...c, farmer_name: byId.get(c.farmer_id).farmer_name ?? `#${c.farmer_id}` })),
  };
}

/** Replace the lines wholesale and return the total they add up to. */
async function writeItems(payreqId: number, items: (ItemInput & { farmer_name: string })[]): Promise<number> {
  await pool.query('DELETE FROM reimbursement_items WHERE payment_request_id = ?', [payreqId]);
  let total = 0;
  for (const it of items) {
    total += Number(it.amount);
    await pool.query(
      `INSERT INTO reimbursement_items
         (payment_request_id, farmer_id, farmer_name, description, amount, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [payreqId, it.farmer_id, it.farmer_name, it.description ?? null, it.amount]);
  }
  await pool.query(
    'UPDATE payment_requests SET amount = ?, updated_at = NOW() WHERE id = ?', [total, payreqId]);
  return total;
}

/**
 * The KTH decides both who is paid and who is paying.
 *
 * The entity comes off the KTH rather than the body for the same reason a PayReq
 * takes it from its PR: it is already settled upstream, and asking again only
 * creates a way for the two to disagree about which PT's money is moving.
 */
async function kthContext(kthId: number | null) {
  if (!kthId) return { error: 'kth_id wajib diisi — reimbursement dibayarkan ke rekening KTH.' };
  const [rows] = await pool.query(
    'SELECT id, kth_name, entities_id, bank_name, bank_account, bank_account_name FROM kth WHERE id = ? LIMIT 1',
    [kthId]);
  const kth = (rows as any[])[0];
  if (!kth) return { error: 'KTH tidak ditemukan.' };
  if (kth.entities_id == null) return { error: `KTH "${kth.kth_name}" belum terhubung ke PT mana pun.` };
  if (!kth.bank_account) {
    return { error: `KTH "${kth.kth_name}" belum punya nomor rekening. Lengkapi dulu di data KTH.` };
  }
  return { kth };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function bodyToCols(b: any) {
  return {
    reason: b.reason ?? null,
    person_in_charge: b.person_in_charge ?? null,
    activity_date: b.activity_date || null,
    estimated_pay_date: b.estimated_pay_date || null,
    request_type: b.request_type ?? null,
    reference_no: b.reference_no ?? null,
    budget_code_id: b.budget_code_id != null && b.budget_code_id !== '' ? Number(b.budget_code_id) : null,
  };
}

// POST /api/reimbursements
router.post('/', authenticate, requireRole(...CREATORS), async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const ctx = await kthContext(b.kth_id != null && b.kth_id !== '' ? Number(b.kth_id) : null);
    if ('error' in ctx) return res.status(422).json({ message: ctx.error });
    const scoped = inheritEntity(req, ctx.kth.entities_id);
    if ('error' in scoped) return res.status(422).json({ message: scoped.error });

    const parsed = await readItems(b.items);
    if ('error' in parsed) return res.status(422).json({ message: parsed.error });

    const status = b.status === 'Pending' ? 'Pending' : 'Draft';
    const number = await nextDocNumber('payment_requests', 'payreq_number', 'RMB');
    const cols: Record<string, any> = {
      payreq_number: number,
      payreq_kind: 'Reimbursement',
      entity_id: scoped.entityId,
      kth_id: ctx.kth.id,
      requested_by_user_id: req.user!.id,
      ...bodyToCols(b),
      // Snapshotted, not joined: the KTH may change its account later, and a
      // payment record has to keep saying where the money was actually sent.
      bank_name: ctx.kth.bank_name ?? null,
      bank_account: ctx.kth.bank_account,
      beneficiary_name: ctx.kth.bank_account_name || ctx.kth.kth_name,
      amount: 0,   // replaced by writeItems below
      status,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [result] = await pool.query(
      `INSERT INTO payment_requests (${keys.map((k) => `\`${k}\``).join(',')})
       VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k]));
    const id = (result as any).insertId;

    const total = await writeItems(id, parsed.items);
    if (status !== 'Draft') await seedApprovalSteps('Reimbursement', id, scoped.entityId, total);
    await pool.query(
      `INSERT INTO document_activities (document_type, document_id, action, user_id, note, created_at)
       VALUES ('Reimbursement', ?, 'Reimbursement created', ?, ?, NOW())`,
      [id, req.user!.id, `${parsed.items.length} petani`]);

    const [rows] = await pool.query(SELECT + ' AND pay.id = ? LIMIT 1', [id]);
    return res.status(201).json({ message: 'Reimbursement created', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/reimbursements/:id
router.put('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const [ex] = await pool.query(
      "SELECT * FROM payment_requests WHERE id = ? AND payreq_kind = 'Reimbursement' LIMIT 1", [id]);
    const prev = (ex as any[])[0];
    if (!prev) return res.status(404).json({ message: 'Reimbursement not found' });

    const b = req.body || {};
    if (String(b.status || '') === 'Paid') {
      return res.status(422).json({
        message: 'Pelunasan dicatat dari rekening koran, bukan dari halaman ini.',
      });
    }
    const denied = guardEdit(req.user, prev, b.status);
    if (denied) return res.status(403).json({ message: denied });

    const resubmitting = b.status === 'Pending' && prev.status === 'Revision';
    if (resubmitting) {
      const noRight = await guardRequester(req.user!, 'Reimbursement', id, prev);
      if (noRight) return res.status(403).json({ message: noRight });
    }

    const updates: Record<string, any> = {};
    const c = bodyToCols(b);
    for (const k of Object.keys(c)) if (b[k] !== undefined) updates[k] = (c as any)[k];

    // Moving the document to another KTH moves the money and the PT with it.
    if (b.kth_id !== undefined) {
      const ctx = await kthContext(b.kth_id != null && b.kth_id !== '' ? Number(b.kth_id) : null);
      if ('error' in ctx) return res.status(422).json({ message: ctx.error });
      const scoped = inheritEntity(req, ctx.kth.entities_id);
      if ('error' in scoped) return res.status(422).json({ message: scoped.error });
      updates.kth_id = ctx.kth.id;
      updates.entity_id = scoped.entityId;
      updates.bank_name = ctx.kth.bank_name ?? null;
      updates.bank_account = ctx.kth.bank_account;
      updates.beneficiary_name = ctx.kth.bank_account_name || ctx.kth.kth_name;
    }
    if (b.status !== undefined) updates.status = b.status;

    if (Object.keys(updates).length) {
      updates.updated_at = new Date();
      const keys = Object.keys(updates);
      await pool.query(
        `UPDATE payment_requests SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((k) => updates[k]), id]);
    }

    // Lines are replaced wholesale rather than patched: the form edits them as one
    // table, and a partial update is how a header stops matching its breakdown.
    if (b.items !== undefined) {
      const parsed = await readItems(b.items);
      if ('error' in parsed) return res.status(422).json({ message: parsed.error });
      await writeItems(id, parsed.items);
    }

    const [cur] = await pool.query('SELECT entity_id, amount, status FROM payment_requests WHERE id = ? LIMIT 1', [id]);
    const now = (cur as any[])[0];
    // Leaving Draft is what puts a document into the chain; if it was already in
    // one (a resubmission) the steps stay and only the status is recomputed.
    if (prev.status === 'Draft' && now.status !== 'Draft') {
      await seedApprovalSteps('Reimbursement', id, now.entity_id, Number(now.amount));
    }
    await syncDocumentStatus('Reimbursement', id);

    const [rows] = await pool.query(SELECT + ' AND pay.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Reimbursement updated', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE /api/reimbursements/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [ex] = await pool.query(
    "SELECT * FROM payment_requests WHERE id = ? AND payreq_kind = 'Reimbursement' LIMIT 1", [id]);
  const doc = (ex as any[])[0];
  if (!doc) return res.status(404).json({ message: 'Reimbursement not found' });

  const denied = await guardDelete(req.user, 'Reimbursement', id, doc);
  if (denied) return res.status(403).json({ message: denied });

  // reimbursement_items cascade with the row; the polymorphic tables do not.
  await deleteDocumentChildren('Reimbursement', id);
  await pool.query('DELETE FROM payment_requests WHERE id = ?', [id]);
  return res.json({ message: 'Reimbursement deleted' });
});

export default router;
