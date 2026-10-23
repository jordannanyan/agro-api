// Fund Request  /api/fund-requests
//
// The monthly funding request per PT — the Ledger template and the Excel
// "Example_Fund_Request" made into one shared document that every role works on:
// HR fills the personnel costs, the PM operations and offtake, Finance everything
// else and compiles it; then Prepared (Finance) → every Director signer → every HQ
// signer. Once HQ has signed, its budget lines are the budget (input once), and
// their Actual is the Paid payment requests that point at them.
//
// Not behind opsGuard: the HQ and Admin accounts read everything and the HQ signs
// here, so write rights are decided per action below instead of by role list.

import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { entityScope } from '../utils/entityScope';
import { ROLE, FUND_REQUEST_FINANCE_ROLES } from '../utils/roles';
import { notifyUsers, fmtRp } from '../utils/notify';
import {
  Section, SectionKey, Stage, SECTIONS, SECTION_KEYS, BUDGET_SECTIONS, SECTION_LABEL, STAGE_LABEL,
  frAccess, FrAccess, mayEditSection, mayMarkSection, sectionKeyOf, sectionNeedsGroup, groupAreaFits,
  computeTotals, toIdr, reallocMap, paidByLine, entityShort, prevPeriod, defaultGroups,
} from '../utils/fundRequest';

export const router = Router();

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const fail = (status: number, message: string) => { throw new HttpError(status, message); };
const round2 = (n: number) => Math.round(n * 100) / 100;

const wrap = (fn: (req: Request, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (err: any) {
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
    console.error('[fund-requests]', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

const uid = (req: Request) => (req.user?.type === 'User' ? req.user.id : null);
const num = (v: any) => (v != null && v !== '' ? Number(v) : null);
const str = (v: any, max = 500) => (v == null || v === '' ? null : String(v).slice(0, max));

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadHeader(id: number) {
  const [rows] = await pool.query(
    `SELECT fr.*, e.entities_name AS entity_name, uc.name AS created_by_name,
            up.name AS prepared_by_name, ur.name AS rejected_by_name
       FROM fund_requests fr
       JOIN entities e   ON e.id = fr.entity_id
       LEFT JOIN users uc ON uc.id = fr.created_by_user_id
       LEFT JOIN users up ON up.id = fr.prepared_by_user_id
       LEFT JOIN users ur ON ur.id = fr.rejected_by_user_id
      WHERE fr.id = ? LIMIT 1`, [id]);
  return (rows as any[])[0] || null;
}

/** The document the caller may read, or a 404 — scoped like every other PT document. */
async function scopedFr(req: Request, id: number) {
  const fr = await loadHeader(id);
  if (!fr) fail(404, 'Fund request tidak ditemukan');
  const a = frAccess(req, fr.entity_id);
  if (!a.read) fail(404, 'Fund request tidak ditemukan');
  return { fr, a };
}

async function signersFor(stage: 'director' | 'hq', entityId: number) {
  const [rows] = await pool.query(
    `SELECT s.id, s.stage, s.user_id, s.title, s.sort_order, u.name
       FROM fund_request_signers s JOIN users u ON u.id = s.user_id
      WHERE s.stage = ? AND s.is_active = 1 AND u.is_active = 1 AND (s.entity_id IS NULL OR s.entity_id = ?)
      ORDER BY s.sort_order, s.id`, [stage, entityId]);
  return rows as any[];
}

async function sectionStatus(frId: number) {
  const [rows] = await pool.query(
    `SELECT s.section_key, s.status, s.updated_at, u.name AS updated_by_name
       FROM fund_request_sections s LEFT JOIN users u ON u.id = s.updated_by_user_id
      WHERE s.fund_request_id = ?`, [frId]);
  const m: Record<string, any> = {};
  for (const k of SECTION_KEYS) m[k] = { status: 'not_started' };
  for (const r of rows as any[]) m[r.section_key] = r;
  return m;
}

/** Lines with their IDR value, budget after reallocation, Actual and Remaining. */
async function loadLines(fr: any) {
  const [rows] = await pool.query(
    `SELECT l.*, bc.code AS budget_code, bc.main_account, bc.sub_account, pc.name AS profit_center,
            (SELECT COUNT(*) FROM fund_request_comments c WHERE c.line_id = l.id) AS comment_count,
            sl.fund_request_id AS source_fr_id, sfr.period AS source_period
       FROM fund_request_lines l
       LEFT JOIN budget_codes bc        ON bc.id = l.budget_code_id
       LEFT JOIN finance_dimensions pc  ON pc.id = l.profit_center_id
       LEFT JOIN fund_request_lines sl  ON sl.id = l.source_line_id
       LEFT JOIN fund_requests sfr      ON sfr.id = sl.fund_request_id
      WHERE l.fund_request_id = ? ORDER BY l.section, l.group_id, l.sort_order, l.id`, [fr.id]);
  const lines = rows as any[];
  const adj = await reallocMap(pool, fr.id);
  const paid = await paidByLine(pool, lines.map((l) => l.id));
  for (const l of lines) {
    l.idr = round2(toIdr(l.amount, l.currency, fr));
    l.is_budget = BUDGET_SECTIONS.includes(l.section);
    l.realloc = round2(adj.get(l.id) || 0);
    l.budget = round2(l.idr + l.realloc);
    const p = paid.get(l.id);
    l.actual_paid = round2(p?.paid || 0);
    l.payreq_count = p?.count || 0;
    l.actual = round2(l.actual_paid + Number(l.actual_manual || 0));
    l.remaining = l.is_budget ? round2(l.budget - l.actual) : null;
  }
  return lines;
}

async function loadGroups(frId: number) {
  const [rows] = await pool.query(
    'SELECT * FROM fund_request_groups WHERE fund_request_id = ? ORDER BY area, sort_order, id', [frId]);
  return rows as any[];
}

async function loadFull(req: Request, id: number) {
  const { fr, a } = await scopedFr(req, id);
  const [groups, lines, sections, directors, hq] = await Promise.all([
    loadGroups(id), loadLines(fr), sectionStatus(id), signersFor('director', fr.entity_id), signersFor('hq', fr.entity_id),
  ]);
  const [sigRows] = await pool.query(
    `SELECT s.stage, s.user_id, s.signed_at, s.note, u.name FROM fund_request_signatures s
       JOIN users u ON u.id = s.user_id WHERE s.fund_request_id = ?`, [id]);
  const signed = (stage: string, userId: number) =>
    (sigRows as any[]).find((s) => s.stage === stage && Number(s.user_id) === Number(userId)) || null;
  const [reallocs] = await pool.query(
    `SELECT r.*, ur.name AS requested_by_name, ud.name AS decided_by_name, tl.description AS to_desc
       FROM fund_request_reallocations r
       LEFT JOIN users ur ON ur.id = r.requested_by_user_id
       LEFT JOIN users ud ON ud.id = r.decided_by_user_id
       LEFT JOIN fund_request_lines tl ON tl.id = r.to_line_id
      WHERE r.fund_request_id = ? ORDER BY r.id DESC`, [id]);
  const rIds = (reallocs as any[]).map((r) => r.id);
  const [rLines] = rIds.length ? await pool.query(
    `SELECT rl.*, fl.description AS from_desc FROM fund_request_realloc_lines rl
       JOIN fund_request_lines fl ON fl.id = rl.from_line_id WHERE rl.reallocation_id IN (?)`, [rIds]) : [[]];
  for (const r of reallocs as any[]) r.lines = (rLines as any[]).filter((x) => x.reallocation_id === r.id);
  const [activity] = await pool.query(
    `SELECT a.id, a.section_key, a.action, a.created_at, u.name AS user_name FROM fund_request_activities a
       LEFT JOIN users u ON u.id = a.user_id WHERE a.fund_request_id = ? ORDER BY a.id DESC LIMIT 100`, [id]);

  const totals = computeTotals(lines, groups, fr.rate_sgd,
    { wli: fr.funding_wli_pct, entity: fr.funding_entity_pct, feeSgd: fr.processing_fee_sgd });
  const signers = [
    ...directors.map((s) => ({ ...s, signature: signed('director', s.user_id) })),
    ...hq.map((s) => ({ ...s, signature: signed('hq', s.user_id) })),
  ];
  const me = a.userId;
  const stage: Stage = fr.stage;
  const myStage = stage === 'prepared' ? 'director' : stage === 'director_approved' ? 'hq' : null;
  const mySigner = myStage ? signers.find((s) => s.stage === myStage && Number(s.user_id) === Number(me)) : null;
  const open = stage === 'requested' && !fr.closed_at;
  const approvedOpen = stage === 'hq_approved' && !fr.closed_at;
  const directorDecider = directors.some((s) => Number(s.user_id) === Number(me)) || a.superAdmin;

  // Per line: may the caller edit it, in which part does it sit?
  const gById = new Map(groups.map((g) => [g.id, g]));
  for (const l of lines) {
    const key = sectionKeyOf(l.section, gById.get(l.group_id) || null);
    l.section_key = key;
    l.editable = open && mayEditSection(a, key, sections[key]?.status === 'done');
  }
  for (const g of groups) {
    const key = sectionKeyOf(g.area === 'trading' ? 'trading_new' : 'new_item', g);
    g.section_key = key;
    g.editable = open && mayEditSection(a, key, sections[key]?.status === 'done');
  }

  return {
    ...fr,
    stage_label: STAGE_LABEL[stage],
    groups, lines, sections, signers, reallocations: reallocs, activity, totals,
    permissions: {
      edit_header: open && (a.finance || a.superAdmin),
      prepare: open && (a.finance || a.superAdmin),
      sign: !!mySigner && !mySigner.signature && !fr.closed_at,
      unsign: !!mySigner && !!mySigner.signature,
      reject: !!myStage && !fr.closed_at && (!!mySigner || a.finance || a.superAdmin),
      process_remaining: open && (a.finance || a.superAdmin),
      actual_manual: approvedOpen && (a.finance || a.superAdmin),
      realloc_submit: approvedOpen && (a.finance || a.pm || a.superAdmin),
      realloc_decide: approvedOpen && directorDecider,
      comment: a.read,
      mark_sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, open && mayMarkSection(a, k)])),
      add_group: open && (a.finance || a.pm || a.superAdmin),
    },
  };
}

// ---------------------------------------------------------------------------
// Activity / section bookkeeping
// ---------------------------------------------------------------------------

async function logActivity(frId: number, userId: number | null, sectionKey: string | null, action: string, coalesce = false) {
  if (coalesce) {
    // Five edits to the same part by the same person in a few minutes are one entry.
    const [last] = await pool.query(
      `SELECT id FROM fund_request_activities WHERE fund_request_id = ? AND user_id <=> ? AND section_key <=> ?
          AND action = ? AND created_at > NOW() - INTERVAL 5 MINUTE ORDER BY id DESC LIMIT 1`,
      [frId, userId, sectionKey, action]);
    const row = (last as any[])[0];
    if (row) { await pool.query('UPDATE fund_request_activities SET created_at = NOW() WHERE id = ?', [row.id]); return; }
  }
  await pool.query(
    'INSERT INTO fund_request_activities (fund_request_id, user_id, section_key, action, created_at) VALUES (?,?,?,?,NOW())',
    [frId, userId, sectionKey, action.slice(0, 500)]);
}

async function touchSection(frId: number, key: SectionKey, userId: number | null) {
  await pool.query(
    `UPDATE fund_request_sections SET status = IF(status = 'not_started', 'in_progress', status),
            updated_by_user_id = ?, updated_at = NOW() WHERE fund_request_id = ? AND section_key = ?`,
    [userId, frId, key]);
  await pool.query('UPDATE fund_requests SET last_update = CURDATE(), updated_at = NOW() WHERE id = ?', [frId]);
}

function requireOpen(fr: any) {
  if (fr.closed_at) fail(409, 'Fund request ini sudah ditutup; tidak ada perubahan yang diizinkan.');
  if (fr.stage !== 'requested') {
    fail(409, 'Fund request sedang dalam persetujuan atau sudah disetujui. Isinya hanya bisa diubah '
      + 'setelah dikembalikan (ditolak) ke Finance.');
  }
}

async function financeAndPmOf(entityId: number) {
  const [rows] = await pool.query(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.is_active = 1 AND (r.role_code IN (?) OR (r.role_code = 'PROJECT_MANAGER' AND u.entity_id = ?))`,
    [FUND_REQUEST_FINANCE_ROLES, entityId]);
  return (rows as any[]).map((r) => Number(r.id));
}

const notifySafe = async (ids: (number | null | undefined)[], input: any, except: number | null) => {
  try { await notifyUsers(ids.filter((x): x is number => Number.isInteger(x)), input, except); }
  catch (e: any) { console.error('[notify] fund request:', e?.message || e); }
};

// ---------------------------------------------------------------------------
// List / create
// ---------------------------------------------------------------------------

router.get('/', authenticate, wrap(async (req, res) => {
  const where: string[] = [];
  const args: any[] = [];
  const scope = entityScope(req);
  if (scope != null) { where.push('fr.entity_id = ?'); args.push(scope); }
  if (req.query.entity_id) { where.push('fr.entity_id = ?'); args.push(Number(req.query.entity_id)); }
  if (req.query.stage) { where.push('fr.stage = ?'); args.push(String(req.query.stage)); }
  if (req.query.year) { where.push('fr.period LIKE ?'); args.push(`${req.query.year}-%`); }
  const [rows] = await pool.query(
    `SELECT fr.id, fr.fr_number, fr.entity_id, e.entities_name AS entity_name, fr.period, fr.stage,
            fr.rejected_at, fr.reject_note, fr.closed_at, fr.approved_at, fr.created_at, fr.last_update,
            uc.name AS created_by_name,
            (SELECT COUNT(*) FROM fund_request_lines l WHERE l.fund_request_id = fr.id) AS line_count
       FROM fund_requests fr JOIN entities e ON e.id = fr.entity_id
       LEFT JOIN users uc ON uc.id = fr.created_by_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY fr.period DESC, e.entities_name`, args);
  // Totals per document, computed the one way computeTotals does.
  const list = rows as any[];
  for (const fr of list) {
    const full = await loadHeader(fr.id);
    const lines = await loadLines(full);
    const groups = await loadGroups(fr.id);
    const t = computeTotals(lines, groups, full.rate_sgd,
      { wli: full.funding_wli_pct, entity: full.funding_entity_pct, feeSgd: full.processing_fee_sgd });
    fr.grand_total = round2(t.grand);
    fr.grand_total_sgd = full.rate_sgd ? round2(t.grand / full.rate_sgd) : null;
    fr.budget_total = round2(lines.filter((l: any) => l.is_budget).reduce((s: number, l: any) => s + l.budget, 0));
    fr.stage_label = STAGE_LABEL[fr.stage as Stage];
  }
  return res.json({ data: list });
}));

// POST /api/fund-requests { entity_id, period: 'YYYY-MM', copy_previous?: boolean }
router.post('/', authenticate, wrap(async (req, res) => {
  const b = req.body || {};
  const entityId = num(b.entity_id);
  const period = String(b.period || '');
  if (!entityId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail(422, 'entity_id dan period (YYYY-MM) wajib diisi.');
  const a = frAccess(req, entityId!);
  if (!a.read) fail(404, 'Entitas tidak ditemukan');
  if (!(a.finance || a.pm || a.superAdmin)) fail(403, 'Fund request dibuat oleh Finance atau Project Manager PT ini.');

  const [[ent]] = await pool.query('SELECT id, entities_name FROM entities WHERE id = ? LIMIT 1', [entityId]) as any;
  if (!ent) fail(404, 'Entitas tidak ditemukan');
  // One document per PT per month: a second one is the same request, so it opens it.
  const [ex] = await pool.query('SELECT id FROM fund_requests WHERE entity_id = ? AND period = ? LIMIT 1', [entityId, period]);
  if ((ex as any[]).length) {
    return res.status(409).json({ message: 'Fund request untuk PT dan bulan ini sudah ada.', data: { id: (ex as any[])[0].id } });
  }

  const short = entityShort(ent.entities_name, ent.id);
  const prev = b.copy_previous === false ? null : ((await pool.query(
    'SELECT * FROM fund_requests WHERE entity_id = ? AND period < ? ORDER BY period DESC LIMIT 1',
    [entityId, period]))[0] as any[])[0] || null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query(
      `INSERT INTO fund_requests (fr_number, entity_id, period, fx_date, last_update, prev_update, balance_date,
         rate_eur, rate_usd, rate_sgd, funding_wli_pct, funding_entity_pct, processing_fee_sgd, funding_label,
         created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,CURDATE(),CURDATE(),?,CURDATE(),?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [`FR-${period}-${short}`, entityId, period, prev?.last_update ?? null,
       prev?.rate_eur ?? 0, prev?.rate_usd ?? 0, prev?.rate_sgd ?? 0,
       prev?.funding_wli_pct ?? 0.2, prev?.funding_entity_pct ?? 0.8, prev?.processing_fee_sgd ?? 35,
       prev?.funding_label ?? (short === 'JNBS' ? '[Equity]' : '[Loan]'), uid(req)]);
    const frId = (r as any).insertId;
    for (const k of SECTION_KEYS) {
      await conn.query('INSERT INTO fund_request_sections (fund_request_id, section_key, status) VALUES (?,?,\'not_started\')', [frId, k]);
    }

    if (prev) {
      // Carry the structure of last month over: its groups and the lines that recur
      // every month (accounts, planned items, reserves). Balances start at zero —
      // they are this month's to state; planned amounts are kept to be adjusted.
      const [pg] = await conn.query('SELECT * FROM fund_request_groups WHERE fund_request_id = ? ORDER BY id', [prev.id]);
      const gMap = new Map<number, number>();
      for (const g of pg as any[]) {
        const [gr] = await conn.query(
          `INSERT INTO fund_request_groups (fund_request_id, area, label, owner_role, sort_order, created_at, updated_at)
           VALUES (?,?,?,?,?,NOW(),NOW())`, [frId, g.area, g.label, g.owner_role, g.sort_order]);
        gMap.set(g.id, (gr as any).insertId);
      }
      const [pl] = await conn.query(
        `SELECT * FROM fund_request_lines WHERE fund_request_id = ?
           AND section IN ('bank_balance','new_item','offtake_in','offtake_out','min_balance','trading_bank','trading_new','trading_min')
         ORDER BY id`, [prev.id]);
      for (const l of pl as any[]) {
        const zero = l.section === 'bank_balance' || l.section === 'trading_bank';
        await conn.query(
          `INSERT INTO fund_request_lines (fund_request_id, group_id, section, kind, description, currency, amount,
             budget_code_id, reason, link, filter_tag, period_to_be_paid, activities, species, profit_center_id,
             sort_order, created_by_user_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
          [frId, l.group_id ? gMap.get(l.group_id) ?? null : null, l.section, l.kind, l.description, l.currency,
           zero ? 0 : l.amount, l.budget_code_id, l.reason, l.link, l.filter_tag, null, l.activities, l.species,
           l.profit_center_id, l.sort_order, uid(req)]);
      }
    } else {
      let i = 0;
      for (const g of defaultGroups(short)) {
        await conn.query(
          `INSERT INTO fund_request_groups (fund_request_id, area, label, owner_role, sort_order, created_at, updated_at)
           VALUES (?,?,?,?,?,NOW(),NOW())`, [frId, g.area, g.label, g.owner_role, i++]);
      }
    }
    await conn.commit();
    await logActivity(frId, uid(req), null,
      prev ? `Membuat fund request ${period} (struktur disalin dari ${prev.period})` : `Membuat fund request ${period}`);
    return res.status(201).json({ message: 'Fund request dibuat', data: await loadFull(req, frId) });
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally { conn.release(); }
}));

// ---------------------------------------------------------------------------
// Lines usable by a payment request (must precede /:id)
// ---------------------------------------------------------------------------

// GET /api/fund-requests/lines/picker?entity_id=&search=&include_id=
// Budget lines of approved, still-open months — what a payment can be booked against.
router.get('/lines/picker', authenticate, wrap(async (req, res) => {
  const where = [`l.section IN (?)`, `fr.stage = 'hq_approved'`, 'fr.closed_at IS NULL'];
  const args: any[] = [BUDGET_SECTIONS];
  const scope = entityScope(req);
  if (scope != null) { where.push('fr.entity_id = ?'); args.push(scope); }
  if (req.query.entity_id) { where.push('fr.entity_id = ?'); args.push(Number(req.query.entity_id)); }
  if (req.query.search) {
    where.push('(l.description LIKE ? OR bc.code LIKE ?)');
    args.push(`%${req.query.search}%`, `%${req.query.search}%`);
  }
  // ?include_id keeps the line a payment request already points at, even when its
  // month has since closed — the form being edited must show its own value.
  let cond = where.join(' AND ');
  if (req.query.include_id) { cond = `(${cond}) OR l.id = ?`; args.push(Number(req.query.include_id)); }
  const sql = `SELECT l.id, l.fund_request_id, fr.fr_number, fr.period, fr.entity_id, l.section, l.description,
                      l.amount, l.currency, l.budget_code_id, bc.code AS budget_code, g.label AS group_label,
                      fr.rate_sgd, fr.rate_usd, fr.rate_eur, l.actual_manual
                 FROM fund_request_lines l
                 JOIN fund_requests fr ON fr.id = l.fund_request_id
                 LEFT JOIN budget_codes bc ON bc.id = l.budget_code_id
                 LEFT JOIN fund_request_groups g ON g.id = l.group_id
                WHERE ${cond}`;
  const [rows] = await pool.query(sql + ' ORDER BY fr.period DESC, l.description', args);
  const list = rows as any[];
  const paid = await paidByLine(pool, list.map((l) => l.id));
  const frIds = [...new Set(list.map((l) => l.fund_request_id))];
  const adjs = new Map<number, Map<number, number>>();
  for (const id of frIds) adjs.set(id, await reallocMap(pool, id));
  for (const l of list) {
    const idr = toIdr(l.amount, l.currency, l);
    l.budget = round2(idr + (adjs.get(l.fund_request_id)?.get(l.id) || 0));
    l.actual = round2((paid.get(l.id)?.paid || 0) + Number(l.actual_manual || 0));
    l.remaining = round2(l.budget - l.actual);
    delete l.rate_sgd; delete l.rate_usd; delete l.rate_eur;
  }
  return res.json({ data: list });
}));

router.get('/:id', authenticate, wrap(async (req, res) => {
  return res.json({ data: await loadFull(req, Number(req.params.id)) });
}));

// PUT /api/fund-requests/:id — header (dates, FX) and Section 4. Finance only.
router.put('/:id', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  if (!(a.finance || a.superAdmin)) fail(403, 'Header dan kurs diisi oleh Finance.');
  requireOpen(fr);
  const b = req.body || {};
  const cols: Record<string, any> = {};
  for (const k of ['fx_date', 'prev_update', 'balance_date']) if (b[k] !== undefined) cols[k] = b[k] || null;
  for (const k of ['rate_eur', 'rate_usd', 'rate_sgd', 'processing_fee_sgd']) {
    if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= 0)) fail(422, `${k} tidak valid`); cols[k] = v; }
  }
  for (const k of ['funding_wli_pct', 'funding_entity_pct']) {
    if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= 0 && v <= 1)) fail(422, `${k} harus antara 0 dan 1`); cols[k] = v; }
  }
  if (b.funding_label !== undefined) {
    if (!['[Loan]', '[Equity]'].includes(b.funding_label)) fail(422, 'funding_label tidak valid');
    cols.funding_label = b.funding_label;
  }
  const keys = Object.keys(cols);
  if (keys.length) {
    await pool.query(`UPDATE fund_requests SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')}, last_update = CURDATE(), updated_at = NOW() WHERE id = ?`,
      [...keys.map((k) => cols[k]), id]);
    await logActivity(id, uid(req), 'finance_core', 'Mengubah header / kurs', true);
  }
  return res.json({ message: 'Header diperbarui', data: await loadFull(req, id) });
}));

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

router.post('/:id/groups', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  requireOpen(fr);
  const b = req.body || {};
  const area = String(b.area || '');
  if (!['overhead', 'operational', 'offtake', 'trading'].includes(area)) fail(422, 'area tidak valid');
  const label = str(b.label, 200);
  if (!label) fail(422, 'Nama grup wajib diisi');
  const owner = area === 'overhead' ? (b.owner_role === 'hr' ? 'hr' : 'finance') : 'pm';
  const key = sectionKeyOf(area === 'trading' ? 'trading_new' : 'new_item', { area, owner_role: owner });
  if (!(a.finance || a.superAdmin || (a.pm && (key === 'operational' || key === 'offtake')))) {
    fail(403, 'Anda tidak mengisi bagian ini.');
  }
  const [[m]] = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM fund_request_groups WHERE fund_request_id = ? AND area = ?', [id, area]) as any;
  await pool.query(
    `INSERT INTO fund_request_groups (fund_request_id, area, label, owner_role, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,NOW(),NOW())`, [id, area, label, owner, m.n]);
  await touchSection(id, key, uid(req));
  await logActivity(id, uid(req), key, `Menambah grup "${label}"`);
  return res.status(201).json({ message: 'Grup ditambahkan', data: await loadFull(req, id) });
}));

router.put('/:id/groups/:gid', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  requireOpen(fr);
  const [[g]] = await pool.query('SELECT * FROM fund_request_groups WHERE id = ? AND fund_request_id = ?', [req.params.gid, id]) as any;
  if (!g) fail(404, 'Grup tidak ditemukan');
  const key = sectionKeyOf(g.area === 'trading' ? 'trading_new' : 'new_item', g);
  const sec = await sectionStatus(id);
  if (!mayEditSection(a, key, sec[key]?.status === 'done')) fail(403, 'Anda tidak mengisi bagian ini.');
  const label = str(req.body?.label, 200);
  if (!label) fail(422, 'Nama grup wajib diisi');
  await pool.query('UPDATE fund_request_groups SET label = ?, updated_at = NOW() WHERE id = ?', [label, g.id]);
  return res.json({ message: 'Grup diperbarui', data: await loadFull(req, id) });
}));

router.delete('/:id/groups/:gid', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  requireOpen(fr);
  const [[g]] = await pool.query('SELECT * FROM fund_request_groups WHERE id = ? AND fund_request_id = ?', [req.params.gid, id]) as any;
  if (!g) fail(404, 'Grup tidak ditemukan');
  if (!(a.finance || a.superAdmin)) fail(403, 'Grup dihapus oleh Finance.');
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM fund_request_lines WHERE group_id = ? AND (amount <> 0 OR description <> \'\')', [g.id]) as any;
  if (n.n) fail(409, 'Grup ini masih berisi item. Hapus itemnya dulu.');
  await pool.query('DELETE FROM fund_request_groups WHERE id = ?', [g.id]);
  await logActivity(id, uid(req), null, `Menghapus grup "${g.label}"`);
  return res.json({ message: 'Grup dihapus', data: await loadFull(req, id) });
}));

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const LINE_FIELDS = ['description', 'currency', 'amount', 'budget_code_id', 'reason', 'link', 'filter_tag',
  'period_to_be_paid', 'activities', 'species', 'profit_center_id', 'finance_note', 'pm_note', 'kind'] as const;

function lineCols(b: any) {
  const c: Record<string, any> = {};
  if (b.description !== undefined) c.description = String(b.description ?? '').slice(0, 500);
  if (b.currency !== undefined) {
    if (!['IDR', 'SGD', 'USD', 'EUR'].includes(b.currency)) fail(422, 'currency tidak valid');
    c.currency = b.currency;
  }
  if (b.amount !== undefined) { const v = Number(b.amount); if (!Number.isFinite(v)) fail(422, 'amount harus angka'); c.amount = round2(v); }
  for (const k of ['budget_code_id', 'profit_center_id'] as const) if (b[k] !== undefined) c[k] = num(b[k]);
  for (const k of ['reason', 'link', 'finance_note', 'pm_note'] as const) if (b[k] !== undefined) c[k] = str(b[k]);
  for (const [k, n] of [['filter_tag', 80], ['period_to_be_paid', 40], ['activities', 150], ['species', 60]] as const) {
    if (b[k] !== undefined) c[k] = str(b[k], n);
  }
  if (b.kind !== undefined) {
    if (b.kind !== null && !['overhead', 'operational'].includes(b.kind)) fail(422, 'kind tidak valid');
    c.kind = b.kind;
  }
  return c;
}

async function lineContext(id: number, lid: number) {
  const [[l]] = await pool.query('SELECT * FROM fund_request_lines WHERE id = ? AND fund_request_id = ?', [lid, id]) as any;
  if (!l) fail(404, 'Item tidak ditemukan');
  const [[g]] = l.group_id ? await pool.query('SELECT * FROM fund_request_groups WHERE id = ?', [l.group_id]) as any : [[null]];
  return { l, g: g || null, key: sectionKeyOf(l.section, g || null) };
}

router.post('/:id/lines', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  requireOpen(fr);
  const b = req.body || {};
  const section = String(b.section || '') as Section;
  if (!SECTIONS.includes(section)) fail(422, 'section tidak valid');
  let group: any = null;
  if (sectionNeedsGroup(section)) {
    const [[g]] = await pool.query('SELECT * FROM fund_request_groups WHERE id = ? AND fund_request_id = ?', [num(b.group_id), id]) as any;
    if (!g || !groupAreaFits(section, g.area)) fail(422, 'Grup tidak cocok untuk bagian ini');
    group = g;
  }
  if (section === 'shifted' && !['overhead', 'operational'].includes(b.kind)) fail(422, 'Item shifted harus overhead atau operational');
  const key = sectionKeyOf(section, group);
  const sec = await sectionStatus(id);
  if (!mayEditSection(a, key, sec[key]?.status === 'done')) fail(403, `Bagian "${SECTION_LABEL[key]}" diisi oleh pemiliknya.`);
  const c = lineCols(b);
  const [[m]] = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM fund_request_lines WHERE fund_request_id = ? AND section = ? AND group_id <=> ?',
    [id, section, group?.id ?? null]) as any;
  const cols: Record<string, any> = {
    fund_request_id: id, group_id: group?.id ?? null, section, kind: section === 'shifted' ? b.kind : null,
    currency: 'IDR', amount: 0, description: '', ...c, sort_order: m.n,
    created_by_user_id: uid(req), updated_by_user_id: uid(req), created_at: new Date(), updated_at: new Date(),
  };
  const keys = Object.keys(cols);
  await pool.query(`INSERT INTO fund_request_lines (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map((k) => cols[k]));
  await touchSection(id, key, uid(req));
  await logActivity(id, uid(req), key, `Mengubah ${SECTION_LABEL[key]}`, true);
  return res.status(201).json({ message: 'Item ditambahkan', data: await loadFull(req, id) });
}));

router.put('/:id/lines/:lid', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  const { l, key } = await lineContext(id, Number(req.params.lid));
  const b = req.body || {};

  // After approval only Finance's booking of spending outside payment requests may change.
  if (fr.stage === 'hq_approved' && !fr.closed_at && (b.actual_manual !== undefined || b.actual_manual_note !== undefined)) {
    if (!(a.finance || a.superAdmin)) fail(403, 'Actual manual diisi oleh Finance.');
    if (!BUDGET_SECTIONS.includes(l.section)) fail(422, 'Actual hanya untuk item budget.');
    const v = b.actual_manual === '' || b.actual_manual == null ? null : Number(b.actual_manual);
    if (v != null && !(v >= 0)) fail(422, 'Actual manual harus angka ≥ 0');
    await pool.query('UPDATE fund_request_lines SET actual_manual = ?, actual_manual_note = ?, updated_by_user_id = ?, updated_at = NOW() WHERE id = ?',
      [v, str(b.actual_manual_note, 255), uid(req), l.id]);
    await logActivity(id, uid(req), key, `Mencatat actual manual "${l.description}": ${v == null ? '—' : fmtRp(v)}`);
    return res.json({ message: 'Actual manual disimpan', data: await loadFull(req, id) });
  }

  requireOpen(fr);
  const sec = await sectionStatus(id);
  if (!mayEditSection(a, key, sec[key]?.status === 'done')) fail(403, `Bagian "${SECTION_LABEL[key]}" diisi oleh pemiliknya.`);
  const c = lineCols(b);
  if (l.section !== 'shifted') delete c.kind;
  // A line carried over from last month's remaining keeps its amount: it is what was shifted.
  if (l.source_line_id && c.amount !== undefined && Number(c.amount) !== Number(l.amount)) {
    fail(409, 'Nominal item ini berasal dari remaining bulan lalu. Hapus itemnya lalu proses ulang remaining bila perlu diubah.');
  }
  const keys = Object.keys(c);
  if (keys.length) {
    await pool.query(`UPDATE fund_request_lines SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')}, updated_by_user_id = ?, updated_at = NOW() WHERE id = ?`,
      [...keys.map((k) => c[k]), uid(req), l.id]);
    await touchSection(id, key, uid(req));
    await logActivity(id, uid(req), key, `Mengubah ${SECTION_LABEL[key]}`, true);
  }
  return res.json({ message: 'Item diperbarui', data: await loadFull(req, id) });
}));

router.delete('/:id/lines/:lid', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  requireOpen(fr);
  const { l, key } = await lineContext(id, Number(req.params.lid));
  const sec = await sectionStatus(id);
  if (!mayEditSection(a, key, sec[key]?.status === 'done')) fail(403, `Bagian "${SECTION_LABEL[key]}" diisi oleh pemiliknya.`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Removing a line shifted from last month puts its remaining back in the queue.
    if (l.source_line_id) {
      await conn.query(
        `UPDATE fund_request_lines SET remaining_shifted = NULL, remaining_saving = NULL, remaining_processed_at = NULL
          WHERE id = ?`, [l.source_line_id]);
      await conn.query(
        `UPDATE fund_requests SET closed_at = NULL WHERE id = (SELECT fund_request_id FROM fund_request_lines WHERE id = ?)`,
        [l.source_line_id]);
    }
    await conn.query('DELETE FROM fund_request_lines WHERE id = ?', [l.id]);
    await conn.commit();
  } catch (e) { await conn.rollback().catch(() => {}); throw e; } finally { conn.release(); }
  await touchSection(id, key, uid(req));
  await logActivity(id, uid(req), key, `Menghapus item "${l.description || '(tanpa nama)'}"`);
  return res.json({ message: 'Item dihapus', data: await loadFull(req, id) });
}));

// ---------------------------------------------------------------------------
// Section progress
// ---------------------------------------------------------------------------

router.post('/:id/sections/:key', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  requireOpen(fr);
  const key = req.params.key as SectionKey;
  if (!SECTION_KEYS.includes(key)) fail(422, 'Bagian tidak valid');
  const status = req.body?.status === 'done' ? 'done' : 'in_progress';
  if (!mayMarkSection(a, key)) fail(403, 'Bagian ini ditandai oleh pemiliknya.');
  if (status === 'in_progress' && !(a.finance || a.superAdmin)) fail(403, 'Membuka kembali bagian dilakukan oleh Finance.');
  await pool.query('UPDATE fund_request_sections SET status = ?, updated_by_user_id = ?, updated_at = NOW() WHERE fund_request_id = ? AND section_key = ?',
    [status, uid(req), id, key]);
  await logActivity(id, uid(req), key, `${status === 'done' ? 'Menandai selesai' : 'Membuka kembali'}: ${SECTION_LABEL[key]}`);
  return res.json({ message: status === 'done' ? 'Bagian ditandai selesai' : 'Bagian dibuka kembali', data: await loadFull(req, id) });
}));

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

router.post('/:id/prepare', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  if (!(a.finance || a.superAdmin)) fail(403, 'Fund request ditandai prepared oleh Finance.');
  requireOpen(fr);
  const directors = await signersFor('director', fr.entity_id);
  if (!directors.length) fail(422, 'Belum ada penandatangan tahap Director untuk PT ini.');
  await pool.query(
    `UPDATE fund_requests SET stage = 'prepared', prepared_at = NOW(), prepared_by_user_id = ?,
            rejected_at = NULL, rejected_by_user_id = NULL, reject_note = NULL, updated_at = NOW() WHERE id = ?`,
    [uid(req), id]);
  await pool.query('DELETE FROM fund_request_signatures WHERE fund_request_id = ?', [id]);
  const sec = await sectionStatus(id);
  const open = SECTION_KEYS.filter((k) => sec[k].status !== 'done').map((k) => SECTION_LABEL[k]);
  await logActivity(id, uid(req), null, 'Menandai prepared — diajukan ke Director'
    + (open.length ? ` (belum selesai: ${open.join(', ')})` : ''));
  await notifySafe(directors.map((d) => d.user_id), {
    kind: 'fr_prepared', title: `Fund request ${fr.fr_number} menunggu tanda tangan Anda`,
    body: `${fr.entity_name} · ${fr.period}`, documentType: 'FundRequest', documentId: id, link: `/financial/fund-request/${id}`,
  }, uid(req));
  return res.json({ message: 'Diajukan ke Director', data: await loadFull(req, id) });
}));

router.post('/:id/sign', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr } = await scopedFr(req, id);
  if (fr.closed_at) fail(409, 'Fund request ini sudah ditutup.');
  const stage = fr.stage === 'prepared' ? 'director' : fr.stage === 'director_approved' ? 'hq' : null;
  if (!stage) fail(409, 'Fund request ini tidak sedang menunggu tanda tangan.');
  const signers = await signersFor(stage!, fr.entity_id);
  if (!signers.some((s) => Number(s.user_id) === Number(uid(req)))) {
    fail(403, `Anda bukan penandatangan tahap ${stage === 'director' ? 'Director' : 'HQ'}.`);
  }
  await pool.query(
    `INSERT IGNORE INTO fund_request_signatures (fund_request_id, stage, user_id, note, signed_at) VALUES (?,?,?,?,NOW())`,
    [id, stage, uid(req), str(req.body?.note)]);
  await logActivity(id, uid(req), null, `Menandatangani tahap ${stage === 'director' ? 'Director' : 'HQ'}`);

  const [sigs] = await pool.query('SELECT user_id FROM fund_request_signatures WHERE fund_request_id = ? AND stage = ?', [id, stage]);
  const done = new Set((sigs as any[]).map((s) => Number(s.user_id)));
  const all = signers.every((s) => done.has(Number(s.user_id)));
  let message = 'Tanda tangan tercatat';
  if (all && stage === 'director') {
    await pool.query("UPDATE fund_requests SET stage = 'director_approved', updated_at = NOW() WHERE id = ? AND stage = 'prepared'", [id]);
    await logActivity(id, null, null, 'Semua Director sudah menandatangani — diteruskan ke HQ');
    const hq = await signersFor('hq', fr.entity_id);
    await notifySafe(hq.map((h) => h.user_id), {
      kind: 'fr_director_approved', title: `Fund request ${fr.fr_number} menunggu tanda tangan HQ`,
      body: `${fr.entity_name} · ${fr.period}`, documentType: 'FundRequest', documentId: id, link: `/financial/fund-request/${id}`,
    }, uid(req));
    message = 'Semua Director sudah menandatangani — diteruskan ke HQ';
  } else if (all && stage === 'hq') {
    await pool.query("UPDATE fund_requests SET stage = 'hq_approved', approved_at = NOW(), updated_at = NOW() WHERE id = ? AND stage = 'director_approved'", [id]);
    await logActivity(id, null, null, 'Semua HQ sudah menandatangani — fund request disetujui; budget aktif');
    await notifySafe([...(await financeAndPmOf(fr.entity_id)), fr.created_by_user_id], {
      kind: 'fr_approved', title: `Fund request ${fr.fr_number} disetujui`,
      body: `${fr.entity_name} · ${fr.period} — budget bulan ini aktif.`, documentType: 'FundRequest', documentId: id,
      link: `/financial/fund-request/${id}`,
    }, uid(req));
    message = 'Semua HQ sudah menandatangani — fund request disetujui';
  }
  return res.json({ message, data: await loadFull(req, id) });
}));

router.post('/:id/unsign', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr } = await scopedFr(req, id);
  const stage = fr.stage === 'prepared' ? 'director' : fr.stage === 'director_approved' ? 'hq' : null;
  if (!stage) fail(409, 'Tanda tangan tahap ini sudah final.');
  const [r] = await pool.query('DELETE FROM fund_request_signatures WHERE fund_request_id = ? AND stage = ? AND user_id = ?', [id, stage, uid(req)]);
  if (!(r as any).affectedRows) fail(404, 'Anda belum menandatangani tahap ini.');
  await logActivity(id, uid(req), null, `Menarik tanda tangan tahap ${stage === 'director' ? 'Director' : 'HQ'}`);
  return res.json({ message: 'Tanda tangan ditarik', data: await loadFull(req, id) });
}));

router.post('/:id/reject', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  const stage = fr.stage === 'prepared' ? 'director' : fr.stage === 'director_approved' ? 'hq' : null;
  if (!stage || fr.closed_at) fail(409, 'Fund request ini tidak sedang dalam persetujuan.');
  const signers = await signersFor(stage!, fr.entity_id);
  const isSigner = signers.some((s) => Number(s.user_id) === Number(uid(req)));
  if (!(isSigner || a.finance || a.superAdmin)) fail(403, 'Hanya penandatangan tahap ini (atau Finance) yang bisa mengembalikan.');
  const note = String(req.body?.note || '').trim();
  if (!note) fail(422, 'Tuliskan alasan pengembalian.');
  await pool.query(
    `UPDATE fund_requests SET stage = 'requested', rejected_at = NOW(), rejected_by_user_id = ?, reject_note = ?,
            prepared_at = NULL, prepared_by_user_id = NULL, updated_at = NOW() WHERE id = ?`, [uid(req), note.slice(0, 2000), id]);
  await pool.query('DELETE FROM fund_request_signatures WHERE fund_request_id = ?', [id]);
  await logActivity(id, uid(req), null, `Mengembalikan ke Finance: ${note.slice(0, 400)}`);
  await notifySafe([...(await financeAndPmOf(fr.entity_id)), fr.created_by_user_id], {
    kind: 'fr_rejected', title: `Fund request ${fr.fr_number} dikembalikan`, body: note.slice(0, 400),
    documentType: 'FundRequest', documentId: id, link: `/financial/fund-request/${id}`,
  }, uid(req));
  return res.json({ message: 'Fund request dikembalikan ke Finance', data: await loadFull(req, id) });
}));

// ---------------------------------------------------------------------------
// Remaining budget of last month → shifted (1.2) or saving
// ---------------------------------------------------------------------------

async function remainingCandidates(fr: any) {
  const [[prev]] = await pool.query(
    'SELECT * FROM fund_requests WHERE entity_id = ? AND period = ? LIMIT 1', [fr.entity_id, prevPeriod(fr.period)]) as any;
  if (!prev) return { prev: null, rows: [] as any[] };
  const lines = (await loadLines(prev)).filter((l: any) => l.section === 'new_item' || l.section === 'shifted');
  const groups = new Map((await loadGroups(prev.id)).map((g: any) => [g.id, g]));
  const rows = lines.map((l: any) => {
    const g = groups.get(l.group_id);
    return {
      line_id: l.id, description: l.description, group_label: g?.label ?? (l.section === 'shifted' ? '1.2 Shifted' : ''),
      kind: l.section === 'shifted' ? l.kind : (g?.area === 'overhead' ? 'overhead' : 'operational'),
      budget_code: l.budget_code, budget: l.budget, actual: l.actual, remaining: l.remaining,
      processed: !!l.remaining_processed_at, shifted: l.remaining_shifted, saving: l.remaining_saving,
    };
  });
  return { prev, rows };
}

router.get('/:id/remaining', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr } = await scopedFr(req, id);
  const { prev, rows } = await remainingCandidates(fr);
  return res.json({
    data: {
      prev: prev ? { id: prev.id, fr_number: prev.fr_number, period: prev.period, stage: prev.stage, closed_at: prev.closed_at } : null,
      period: prevPeriod(fr.period), rows,
    },
  });
}));

// POST { allocations: [{ line_id, shift }] } — shift ≤ remaining; the rest is saving.
router.post('/:id/remaining', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  if (!(a.finance || a.superAdmin)) fail(403, 'Remaining diproses oleh Finance.');
  requireOpen(fr);
  const { prev, rows } = await remainingCandidates(fr);
  if (!prev) fail(422, `Tidak ada fund request ${prevPeriod(fr.period)} untuk PT ini.`);
  if (prev.stage !== 'hq_approved') fail(409, `Fund request ${prev.period} belum disetujui HQ; remaining-nya belum final.`);
  const alloc = new Map<number, number>();
  for (const x of (Array.isArray(req.body?.allocations) ? req.body.allocations : [])) alloc.set(Number(x.line_id), Number(x.shift || 0));
  const conn = await pool.getConnection();
  let shiftedSum = 0, savingSum = 0, n = 0;
  try {
    await conn.beginTransaction();
    for (const r of rows) {
      if (r.processed || !alloc.has(r.line_id)) continue;
      const rem = Number(r.remaining || 0);
      if (rem <= 0) continue;
      const shift = round2(Math.min(Math.max(0, alloc.get(r.line_id) || 0), rem));
      const saving = round2(rem - shift);
      await conn.query(
        'UPDATE fund_request_lines SET remaining_shifted = ?, remaining_saving = ?, remaining_processed_at = NOW() WHERE id = ?',
        [shift, saving, r.line_id]);
      if (shift > 0) {
        const [[src]] = await conn.query('SELECT * FROM fund_request_lines WHERE id = ?', [r.line_id]) as any;
        await conn.query(
          `INSERT INTO fund_request_lines (fund_request_id, section, kind, description, currency, amount, budget_code_id,
             reason, activities, species, profit_center_id, finance_note, source_line_id, sort_order,
             created_by_user_id, updated_by_user_id, created_at, updated_at)
           VALUES (?, 'shifted', ?, ?, 'IDR', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NOW(), NOW())`,
          [id, r.kind, src.description, shift, src.budget_code_id, src.reason, src.activities, src.species,
           src.profit_center_id, `Remaining ${prev.period}: ${fmtRp(rem)}, saving ${fmtRp(saving)}`, r.line_id,
           uid(req), uid(req)]);
      }
      shiftedSum += shift; savingSum += saving; n++;
    }
    // Every line with something left has now been decided → last month is closed.
    // Lines with nothing left (fully spent or overspent) have nothing to decide.
    const stillOpen = rows.filter((r) => !r.processed && Number(r.remaining) > 0 && !alloc.has(r.line_id)).length;
    if (stillOpen === 0) await conn.query('UPDATE fund_requests SET closed_at = NOW() WHERE id = ? AND closed_at IS NULL', [prev.id]);
    await conn.commit();
  } catch (e) { await conn.rollback().catch(() => {}); throw e; } finally { conn.release(); }
  if (n) {
    await touchSection(id, 'finance_core', uid(req));
    await logActivity(id, uid(req), 'finance_core', `Memproses remaining ${prev.period}: shifted ${fmtRp(shiftedSum)}, saving ${fmtRp(savingSum)}`);
    await logActivity(prev.id, uid(req), null, `Remaining diproses di ${fr.fr_number}: shifted ${fmtRp(shiftedSum)}, saving ${fmtRp(savingSum)}`);
  }
  return res.json({ message: `Remaining diproses: shifted ${fmtRp(shiftedSum)}, saving ${fmtRp(savingSum)}`, data: await loadFull(req, id) });
}));

// ---------------------------------------------------------------------------
// Section 3.1 — reallocation between lines of an approved month
// ---------------------------------------------------------------------------

/** Budget lines that may take part (personnel costs excluded, as in the template). */
async function reallocItems(fr: any, ignoreId?: number) {
  const lines = (await loadLines(fr)).filter((l: any) => l.is_budget);
  const groups = new Map((await loadGroups(fr.id)).map((g: any) => [g.id, g]));
  const [pend] = await pool.query(
    `SELECT rl.from_line_id, SUM(rl.amount) AS amt FROM fund_request_realloc_lines rl
       JOIN fund_request_reallocations r ON r.id = rl.reallocation_id
      WHERE r.fund_request_id = ? AND r.status = 'pending' AND r.id <> ? GROUP BY rl.from_line_id`, [fr.id, ignoreId ?? 0]);
  const pendOut = new Map((pend as any[]).map((p) => [Number(p.from_line_id), Number(p.amt)]));
  return new Map(lines
    .filter((l: any) => groups.get(l.group_id)?.owner_role !== 'hr')
    .map((l: any) => [l.id, { ...l, available: round2(Math.max(0, l.budget - (pendOut.get(l.id) || 0) - l.actual)) }]));
}

router.post('/:id/reallocations', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  if (fr.stage !== 'hq_approved' || fr.closed_at) fail(409, 'Pemindahan budget hanya untuk fund request yang sudah disetujui dan belum ditutup.');
  if (!(a.finance || a.pm || a.superAdmin)) fail(403, 'Pemindahan budget diajukan oleh Finance atau PM.');
  const b = req.body || {};
  const items = await reallocItems(fr);
  const dest = items.get(Number(b.to_line_id));
  if (!dest) fail(422, 'Item tujuan tidak ditemukan');
  const lines = (Array.isArray(b.lines) ? b.lines : []).map((x: any) => ({ from: Number(x.from_line_id), amount: round2(Number(x.amount || 0)) }));
  if (!lines.length) fail(422, 'Pilih item sumber');
  const seen = new Set<number>();
  for (const l of lines) {
    const src = items.get(l.from);
    if (!src || l.from === dest.id) fail(422, 'Item sumber tidak valid');
    if (seen.has(l.from)) fail(422, 'Satu item sumber hanya boleh dipilih sekali');
    seen.add(l.from);
    if (!(l.amount > 0) || l.amount > src.available + 0.5) fail(422, `Nominal melebihi sisa budget "${src.description}" (${fmtRp(src.available)})`);
  }
  const reason = String(b.reason || '').trim();
  if (!reason) fail(422, 'Alasan wajib diisi');
  const total = round2(lines.reduce((s: number, l: any) => s + l.amount, 0));
  const [r] = await pool.query(
    `INSERT INTO fund_request_reallocations (fund_request_id, to_line_id, total, reason, status, requested_by_user_id, requested_at)
     VALUES (?,?,?,?, 'pending', ?, NOW())`, [id, dest.id, total, reason.slice(0, 500), uid(req)]);
  for (const l of lines) {
    await pool.query('INSERT INTO fund_request_realloc_lines (reallocation_id, from_line_id, amount) VALUES (?,?,?)', [(r as any).insertId, l.from, l.amount]);
  }
  await logActivity(id, uid(req), null, `Mengajukan pemindahan budget ${fmtRp(total)} ke "${dest.description}"`);
  const directors = await signersFor('director', fr.entity_id);
  await notifySafe(directors.map((d) => d.user_id), {
    kind: 'fr_realloc', title: `Pemindahan budget ${fmtRp(total)} menunggu keputusan Anda`,
    body: `${fr.fr_number} · ke ${dest.description}`, documentType: 'FundRequest', documentId: id, link: `/financial/fund-request/${id}`,
  }, uid(req));
  return res.status(201).json({ message: 'Pemindahan budget diajukan, menunggu Director', data: await loadFull(req, id) });
}));

router.post('/:id/reallocations/:rid/decide', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { fr, a } = await scopedFr(req, id);
  if (fr.stage !== 'hq_approved' || fr.closed_at) fail(409, 'Fund request ini tidak menerima pemindahan budget.');
  const directors = await signersFor('director', fr.entity_id);
  if (!(a.superAdmin || directors.some((d) => Number(d.user_id) === Number(uid(req))))) fail(403, 'Pemindahan budget diputuskan oleh Director.');
  const [[r]] = await pool.query('SELECT * FROM fund_request_reallocations WHERE id = ? AND fund_request_id = ?', [req.params.rid, id]) as any;
  if (!r || r.status !== 'pending') fail(409, 'Pengajuan ini sudah diputuskan.');
  const decision = req.body?.decision === 'approved' ? 'approved' : req.body?.decision === 'rejected' ? 'rejected' : null;
  if (!decision) fail(422, 'decision harus approved atau rejected');
  if (decision === 'approved') {
    // The sources may have been spent since the request; check against today's figures.
    const items = await reallocItems(fr, r.id);
    const [rl] = await pool.query('SELECT * FROM fund_request_realloc_lines WHERE reallocation_id = ?', [r.id]);
    for (const l of rl as any[]) {
      const src = items.get(Number(l.from_line_id));
      if (!src || Number(l.amount) > src.available + 0.5) {
        fail(409, `Sisa budget "${src?.description ?? l.from_line_id}" tidak cukup lagi. Tolak lalu ajukan ulang.`);
      }
    }
  }
  await pool.query('UPDATE fund_request_reallocations SET status = ?, decided_by_user_id = ?, decided_at = NOW(), decide_note = ? WHERE id = ?',
    [decision, uid(req), str(req.body?.note), r.id]);
  await logActivity(id, uid(req), null, `${decision === 'approved' ? 'Menyetujui' : 'Menolak'} pemindahan budget ${fmtRp(r.total)}`);
  await notifySafe([r.requested_by_user_id], {
    kind: 'fr_realloc', title: `Pemindahan budget ${fmtRp(r.total)} ${decision === 'approved' ? 'disetujui' : 'ditolak'}`,
    body: fr.fr_number, documentType: 'FundRequest', documentId: id, link: `/financial/fund-request/${id}`,
  }, uid(req));
  return res.json({ message: decision === 'approved' ? 'Pemindahan budget disetujui' : 'Pemindahan budget ditolak', data: await loadFull(req, id) });
}));

// ---------------------------------------------------------------------------
// Comments per line
// ---------------------------------------------------------------------------

router.get('/:id/lines/:lid/comments', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await scopedFr(req, id);
  await lineContext(id, Number(req.params.lid));
  const [rows] = await pool.query(
    `SELECT c.*, u.name AS user_name, r.role_name FROM fund_request_comments c
       LEFT JOIN users u ON u.id = c.user_id LEFT JOIN roles r ON r.id = u.role_id
      WHERE c.line_id = ? ORDER BY c.id`, [req.params.lid]);
  return res.json({ data: rows });
}));

router.post('/:id/lines/:lid/comments', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { a } = await scopedFr(req, id);
  const { l } = await lineContext(id, Number(req.params.lid));
  const body = String(req.body?.body || '').trim();
  if (!body) fail(422, 'Komentar kosong');
  await pool.query('INSERT INTO fund_request_comments (fund_request_id, line_id, user_id, body, created_at) VALUES (?,?,?,?,NOW())',
    [id, l.id, a.userId, body.slice(0, 4000)]);
  return res.status(201).json({ message: 'Komentar ditambahkan' });
}));

router.put('/:id/lines/:lid/comments/:cid', authenticate, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { a } = await scopedFr(req, id);
  const body = String(req.body?.body || '').trim();
  if (!body) fail(422, 'Komentar kosong');
  const [r] = await pool.query('UPDATE fund_request_comments SET body = ?, edited_at = NOW() WHERE id = ? AND line_id = ? AND user_id = ?',
    [body.slice(0, 4000), req.params.cid, req.params.lid, a.userId]);
  if (!(r as any).affectedRows) fail(404, 'Komentar tidak ditemukan atau bukan milik Anda');
  return res.json({ message: 'Komentar diperbarui' });
}));

// GET /api/fund-requests/meta/signers — who signs which stage.
router.get('/meta/signers', authenticate, wrap(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT s.*, u.name, e.entities_name FROM fund_request_signers s JOIN users u ON u.id = s.user_id
       LEFT JOIN entities e ON e.id = s.entity_id ORDER BY s.stage, s.sort_order, s.id`);
  return res.json({ data: rows });
}));

export default router;
