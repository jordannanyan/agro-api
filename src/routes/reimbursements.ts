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
//
// The lines carry the shape of the form that is actually filed (2026-09-18, see
// docs/reimbursement.md). Two facts that used to be one:
//
//   * `farmer_id` / `farmer_name` is **who is paid** — usually a daily worker, and
//     often not a registered farmer at all, so the id is optional and the name is
//     free text when it has to be.
//   * `on_behalf_*` is **whose land or loan the work was on** — the farmer the cost
//     belongs to. It is what makes the by-scheme recap possible.
//
// One person may appear on several lines. A worker who maintained three farmers'
// land in a week owes three different loans their share, and collapsing that into
// one line destroys the only record of which is which.
//
// Nothing here posts to a farmer's outstanding or to profit sharing. Recording
// only, by decision of 2026-09-18 — the same amounts may already be booked through
// another route, and a silent second posting is how the SNBS farmer debt came to be
// overstated by Rp 384.3 million.

import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import {
  seedApprovalSteps, assignRequestedStepToFiler, syncDocumentStatus,
  guardEdit, guardRequester, guardDelete, deleteDocumentChildren, requireAttachment,
} from './documents';
import { ROLE } from '../utils/roles';
import { inheritEntity, entityScope, canSeeEntity } from '../utils/entityScope';
import { PENDING_STEP_COLUMNS, pendingStepJoin, type DocType } from '../utils/pendingStep';

/** The two payment requests that never come from procurement. */
const CLAIM_DOC_TYPES: DocType[] = ['Reimbursement', 'Expense'];

export const router = Router();

/**
 * Who may raise one: the Field Admin who files it and the HR who files it for the
 * other PTs, plus the seniors above them.
 */
const CREATORS = [
  ROLE.FIELD_ADMIN, ROLE.HR, ROLE.PROJECT_MANAGER, ROLE.FINANCE_MANAGER, ROLE.SUPER_ADMIN,
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

// ---------------------------------------------------------------------------
// The two claims, on one list
// ---------------------------------------------------------------------------
//
// A payment request that did not come from procurement is one errand as far as the
// people signing it are concerned. There are two of them:
//
//   Reimbursement — paying farmers, one transfer to their KTH's account
//   Expense       — paying back a member of staff who laid the money out
//
// They differ in who receives the money and therefore in what the lines look like,
// which is why each keeps its own form and its own detail page. They do not differ
// in anything else: same header, same four signatures (Field Admin/HR → Project
// Manager → Finance Manager → Director), same payment code, same reconciliation. So
// they are one list, and splitting them across two menus only meant the people who
// file them had to remember which menu a claim had been filed under.
//
// Read-only on purpose. Creating and editing stay on the endpoint that understands
// the lines — nothing here can write a claim whose total disagrees with them.
//
// Declared before `/:id`, or Express reads "claims" as a reimbursement id.

const CLAIMS_SELECT = `
  SELECT pay.id, pay.payreq_number, pay.payreq_kind, pay.payment_code, pay.status,
         pay.amount, pay.reason, pay.entity_id, pay.kth_id, pay.beneficiary_name,
         pay.estimated_pay_date, pay.released_pay_date, pay.created_at,
         e.entities_name AS entity_name, bc.code AS budget_code,
         k.kth_name, u.name AS requested_by_name, ro.role_name AS requested_by_role,
         CASE pay.payreq_kind
           WHEN 'Reimbursement'
             THEN (SELECT COUNT(*) FROM reimbursement_items ri WHERE ri.payment_request_id = pay.id)
           ELSE (SELECT COUNT(*) FROM payment_request_items pi WHERE pi.payment_request_id = pay.id)
         END AS line_count,
${PENDING_STEP_COLUMNS}
  FROM payment_requests pay
  LEFT JOIN entities e      ON e.id = pay.entity_id
  LEFT JOIN budget_codes bc ON bc.id = pay.budget_code_id
  LEFT JOIN kth k           ON k.id = pay.kth_id
  LEFT JOIN users u         ON u.id = pay.requested_by_user_id
  LEFT JOIN roles ro        ON ro.id = u.role_id
${pendingStepJoin(CLAIM_DOC_TYPES, 'pay')}
  WHERE pay.payreq_kind IN ('Reimbursement', 'Expense')
`;

// GET /api/reimbursements/claims?kind=&entity_id=&status=&search=
router.get('/claims', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  // `kind` narrows to one of the two; anything else is ignored rather than refused,
  // so a stale bookmark shows the whole list instead of an error.
  const kind = String(req.query.kind || '');
  if (kind === 'Reimbursement' || kind === 'Expense') {
    where.push('pay.payreq_kind = ?'); args.push(kind);
  }
  // HR serves every PT and is flagged cross-entity, so this leaves their list alone;
  // a Field Admin still sees only the PT they work for.
  const scope = entityScope(req);
  if (scope != null) { where.push('pay.entity_id = ?'); args.push(scope); }
  if (req.query.status) { where.push('pay.status = ?'); args.push(req.query.status); }
  if (req.query.search) {
    where.push('(pay.payreq_number LIKE ? OR pay.reason LIKE ? OR k.kth_name LIKE ?'
      + ' OR pay.beneficiary_name LIKE ? OR u.name LIKE ?)');
    const like = `%${req.query.search}%`;
    args.push(like, like, like, like, like);
  }
  const sql = CLAIMS_SELECT + (where.length ? ` AND ${where.join(' AND ')}` : '')
    + ' ORDER BY pay.id DESC';
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
  // The two recaps the paper form lives by. Both add to the same total, and that
  // they do is the check a reader performs first — so they are computed from the
  // lines here rather than left to each client to get right separately.
  data.recap = buildRecap(items as any[]);
  const [appr] = await pool.query(
    `SELECT da.*, r.role_code, r.role_name FROM document_approvals da
     LEFT JOIN roles r ON r.id = da.role_id
     WHERE da.document_type = 'Reimbursement' AND da.document_id = ? ORDER BY da.step_order`,
    [req.params.id]);
  data.approvals = appr;
  return res.json({ data });
});

/**
 * The two ways the same total is read.
 *
 * By scheme — whose loan or whose wage bill this is — and by recipient, who
 * actually gets the money. Every reimbursement document in use prints both, and a
 * reader checks them against each other before looking at anything else.
 */
function buildRecap(items: any[]) {
  const LABEL: Record<string, string> = {
    DailyWorker: 'Daily worker',
    LabourLoanPreFinance: 'Labour loan — pre finance',
    LabourLoanProfitSharing: 'Labour loan — profit sharing',
  };

  const scheme = new Map<string, any>();
  const recipient = new Map<string, any>();
  let total = 0;

  for (const it of items) {
    const amount = Number(it.amount || 0);
    total += amount;

    // A labour loan is grouped by whose loan it is; a daily worker line has no
    // owner and stands as its own group.
    const owner = it.category === 'DailyWorker' ? null : (it.on_behalf_name || null);
    const key = `${it.category}|${owner ?? ''}`;
    if (!scheme.has(key)) {
      scheme.set(key, {
        category: it.category,
        category_label: LABEL[it.category] ?? it.category,
        on_behalf_farmer_id: it.on_behalf_farmer_id ?? null,
        on_behalf_name: owner,
        label: owner ? `${owner} — ${LABEL[it.category] ?? it.category}` : (LABEL[it.category] ?? it.category),
        amount: 0,
        lines: 0,
      });
    }
    const sg = scheme.get(key);
    sg.amount += amount;
    sg.lines += 1;

    const rkey = it.farmer_id ? `id:${it.farmer_id}` : `name:${String(it.farmer_name || '').toLowerCase()}`;
    if (!recipient.has(rkey)) {
      recipient.set(rkey, {
        farmer_id: it.farmer_id ?? null,
        farmer_name: it.farmer_name,
        bank_name: it.recipient_bank_name ?? null,
        bank_account: it.recipient_bank_account ?? it.no_rek ?? null,
        amount: 0,
        lines: 0,
      });
    }
    const rg = recipient.get(rkey);
    rg.amount += amount;
    rg.lines += 1;
    // The account is often filled on only one of a person's lines.
    if (!rg.bank_name && it.recipient_bank_name) rg.bank_name = it.recipient_bank_name;
    if (!rg.bank_account && it.recipient_bank_account) rg.bank_account = it.recipient_bank_account;
  }

  const byAmount = (a: any, b: any) => b.amount - a.amount;
  return {
    total,
    by_scheme: [...scheme.values()].sort(byAmount),
    by_recipient: [...recipient.values()].sort(byAmount),
  };
}

// ---------------------------------------------------------------------------
// The farmer lines
// ---------------------------------------------------------------------------

const CATEGORIES = ['DailyWorker', 'LabourLoanPreFinance', 'LabourLoanProfitSharing'] as const;
type Category = (typeof CATEGORIES)[number];

interface ItemInput {
  farmer_id: number | null;
  farmer_name: string;
  category: Category;
  on_behalf_farmer_id: number | null;
  on_behalf_name: string | null;
  description: string | null;
  rate: number | null;
  work_days: number | null;
  work_dates: string | null;
  amount: number;
  recipient_bank_name: string | null;
  recipient_bank_account: string | null;
}

/** A number, or null when the field was left alone. Zero is a value; '' is not. */
function optNum(v: any): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const optText = (v: any): string | null => {
  const t = String(v ?? '').trim();
  return t ? t : null;
};

/**
 * Read the lines out of a request body, refusing anything that would make the
 * document unpayable.
 *
 * A recipient is identified by `farmer_id` where they are in the master list, and
 * by name where they are not — most of the people on these documents are daily
 * workers, not farmers, and refusing to record them was the reason the form went on
 * being typed outside the system. A picked farmer's name is still taken from the
 * master rather than the body, so it cannot be spelled three ways.
 *
 * Duplicates are allowed now. The same worker maintaining three farmers' land is
 * three lines because it is three different loans; merging them would leave nothing
 * able to say which.
 *
 * `rate` x `work_days` is NOT checked against `amount`, and must not be: the real
 * documents carry weeks where one of four days was paid at half rate.
 */
async function readItems(raw: any): Promise<{ items: ItemInput[] } | { error: string }> {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: 'Isi minimal satu baris — reimbursement tanpa rincian penerima tidak bisa dipertanggungjawabkan.' };
  }

  const draft: (ItemInput & { _pickedFarmer: number | null; _pickedBehalf: number | null })[] = [];
  for (const [i, r] of raw.entries()) {
    const amount = Number(r?.amount || 0);
    if (!(amount > 0)) return { error: `Baris ${i + 1}: nominal harus lebih dari 0.` };

    const farmerId = optNum(r?.farmer_id);
    const typedName = optText(r?.farmer_name);
    if (!farmerId && !typedName) {
      return { error: `Baris ${i + 1}: isi nama penerima, atau pilih petani dari daftar.` };
    }

    const category = CATEGORIES.includes(r?.category) ? (r.category as Category) : 'DailyWorker';
    const behalfId = optNum(r?.on_behalf_farmer_id);
    const behalfName = optText(r?.on_behalf_name);
    // A labour loan is charged to somebody. Without that the by-scheme recap has a
    // row it cannot name, which is exactly the number finance asks about.
    if (category !== 'DailyWorker' && !behalfId && !behalfName) {
      return { error: `Baris ${i + 1}: labour loan harus menyebut lahan/pinjaman siapa.` };
    }

    draft.push({
      farmer_id: farmerId,
      farmer_name: typedName ?? '',
      category,
      on_behalf_farmer_id: behalfId,
      on_behalf_name: behalfName,
      description: optText(r?.description),
      rate: optNum(r?.rate),
      work_days: optNum(r?.work_days),
      work_dates: optText(r?.work_dates),
      amount,
      recipient_bank_name: optText(r?.recipient_bank_name),
      recipient_bank_account: optText(r?.recipient_bank_account),
      _pickedFarmer: farmerId,
      _pickedBehalf: behalfId,
    });
  }

  // Resolve every farmer named by id in one query — recipients and on-behalf alike.
  const ids = [...new Set(draft.flatMap((d) => [d._pickedFarmer, d._pickedBehalf]).filter((v): v is number => !!v))];
  const byId = new Map<number, any>();
  if (ids.length) {
    const [rows] = await pool.query('SELECT id, farmer_name FROM farmers WHERE id IN (?)', [ids]);
    for (const f of rows as any[]) byId.set(Number(f.id), f);
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return { error: `Petani tidak ditemukan: ${missing.join(', ')}` };
  }

  const items: ItemInput[] = draft.map((d) => ({
    farmer_id: d.farmer_id,
    farmer_name: d.farmer_id ? (byId.get(d.farmer_id)?.farmer_name ?? d.farmer_name) : d.farmer_name,
    category: d.category,
    on_behalf_farmer_id: d.on_behalf_farmer_id,
    on_behalf_name: d.on_behalf_farmer_id
      ? (byId.get(d.on_behalf_farmer_id)?.farmer_name ?? d.on_behalf_name)
      : d.on_behalf_name,
    description: d.description,
    rate: d.rate,
    work_days: d.work_days,
    work_dates: d.work_dates,
    amount: d.amount,
    recipient_bank_name: d.recipient_bank_name,
    recipient_bank_account: d.recipient_bank_account,
  }));
  return { items };
}

/** Replace the lines wholesale and return the total they add up to. */
async function writeItems(payreqId: number, items: ItemInput[]): Promise<number> {
  await pool.query('DELETE FROM reimbursement_items WHERE payment_request_id = ?', [payreqId]);
  let total = 0;
  for (const it of items) {
    total += Number(it.amount);
    await pool.query(
      `INSERT INTO reimbursement_items
         (payment_request_id, farmer_id, farmer_name, category, on_behalf_farmer_id, on_behalf_name,
          description, rate, work_days, work_dates, amount,
          recipient_bank_name, recipient_bank_account, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [payreqId, it.farmer_id, it.farmer_name, it.category, it.on_behalf_farmer_id, it.on_behalf_name,
       it.description, it.rate, it.work_days, it.work_dates, it.amount,
       it.recipient_bank_name, it.recipient_bank_account]);
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
    'SELECT id, kth_name, entities_id, bank_name, bank_account, bank_account_name, bank_id'
    + ' FROM kth WHERE id = ? LIMIT 1',
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
      // Which bank, as the code a Kopra transfer file carries. Snapshotted with the
      // rest of the account for the same reason.
      bank_id: ctx.kth.bank_id ?? null,
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
    // A document may not enter the chain with nothing attached (2026-09-18). This
    // kind was the one left out: the farmer list is evidence of who is owed what,
    // but not that the work happened or that the KTH agreed — which is what an
    // approver is signing for. Attachments hang off a saved document, so there is
    // nowhere to put one before this row exists: the form saves a Draft, uploads,
    // then submits. Left as a Draft rather than discarded, so nothing keyed in is
    // lost.
    if (status !== 'Draft') {
      const missing = await requireAttachment('Reimbursement', id);
      if (missing) {
        await pool.query("UPDATE payment_requests SET status = 'Draft' WHERE id = ?", [id]);
        const [draft] = await pool.query(SELECT + ' AND pay.id = ? LIMIT 1', [id]);
        return res.status(422).json({ message: missing, data: (draft as any[])[0] });
      }
      await seedApprovalSteps('Reimbursement', id, scoped.entityId, total);
      await assignRequestedStepToFiler('Reimbursement', id, req.user);
    }
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
      updates.bank_id = ctx.kth.bank_id ?? null;
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
      const missing = await requireAttachment('Reimbursement', id);
      if (missing) {
        await pool.query("UPDATE payment_requests SET status = 'Draft' WHERE id = ?", [id]);
        return res.status(422).json({ message: missing });
      }
      await seedApprovalSteps('Reimbursement', id, now.entity_id, Number(now.amount));
      await assignRequestedStepToFiler('Reimbursement', id, req.user);
    }
    // A resubmission goes through the same gate: the document was sent back to be
    // corrected, and it may not re-enter the chain any barer than it entered it.
    if (prev.status === 'Revision' && now.status === 'Pending') {
      const missing = await requireAttachment('Reimbursement', id);
      if (missing) {
        await pool.query("UPDATE payment_requests SET status = 'Revision' WHERE id = ?", [id]);
        return res.status(422).json({ message: missing });
      }
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
