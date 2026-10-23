import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { entityScope } from '../utils/entityScope';
import { BUDGET_SECTIONS, STAGE_LABEL, Stage, toIdr, reallocMap, paidByLine } from '../utils/fundRequest';

// -----------------------------------------------------------------------------
// Finance reports — Budget, Actual, Budget vs Actual (2026-10).
//
// Nothing here is typed in. INPUT ONCE:
//   Budget  = the budget lines of the Fund Requests (approved ones by default),
//             each traceable to its document;
//   Actual  = payment requests that reached Paid (the statement confirmed them),
//             plus what Finance booked by hand on a line for spending that never
//             passes through a payment request;
//   Budget vs Actual = the two side by side per budget code.
// A PO is a commitment, not spending, and a Fund Request is a plan — neither ever
// counts as Actual.
// -----------------------------------------------------------------------------
export const router = Router();

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Common filters: entity (scoped), period range YYYY-MM. */
function filters(req: Request, alias: { entity: string; period: string }) {
  const where: string[] = [];
  const args: any[] = [];
  const scope = entityScope(req);
  if (scope != null) { where.push(`${alias.entity} = ?`); args.push(scope); }
  else if (req.query.entity_id) { where.push(`${alias.entity} = ?`); args.push(Number(req.query.entity_id)); }
  if (req.query.from) { where.push(`${alias.period} >= ?`); args.push(String(req.query.from).slice(0, 7)); }
  if (req.query.to) { where.push(`${alias.period} <= ?`); args.push(String(req.query.to).slice(0, 7)); }
  return { where, args };
}

/** Budget lines with their final budget (after reallocation), Actual and Remaining. */
async function budgetLines(req: Request, includeAll: boolean) {
  const { where, args } = filters(req, { entity: 'fr.entity_id', period: 'fr.period' });
  where.push('l.section IN (?)'); args.push(BUDGET_SECTIONS);
  if (!includeAll) where.push("fr.stage = 'hq_approved'");
  if (req.query.budget_code_id) { where.push('l.budget_code_id = ?'); args.push(Number(req.query.budget_code_id)); }
  if (req.query.main_account) { where.push('bc.main_account = ?'); args.push(String(req.query.main_account)); }
  if (req.query.profit_center_id) { where.push('l.profit_center_id = ?'); args.push(Number(req.query.profit_center_id)); }
  if (req.query.species) { where.push('l.species = ?'); args.push(String(req.query.species)); }
  if (req.query.search) {
    where.push('(l.description LIKE ? OR fr.fr_number LIKE ? OR bc.code LIKE ?)');
    const q = `%${req.query.search}%`; args.push(q, q, q);
  }
  const [rows] = await pool.query(
    `SELECT l.id, l.fund_request_id, fr.fr_number, fr.period, fr.stage, fr.rejected_at, fr.closed_at,
            fr.entity_id, e.entities_name AS entity_name, l.section, l.kind, g.area AS group_area, g.label AS group_label,
            l.description, l.reason, l.period_to_be_paid, l.activities, l.species, l.currency, l.amount,
            l.budget_code_id, bc.code AS budget_code, bc.main_account, bc.sub_account,
            l.profit_center_id, pc.name AS profit_center, l.actual_manual, l.actual_manual_note,
            l.remaining_shifted, l.remaining_saving, fr.rate_sgd, fr.rate_usd, fr.rate_eur
       FROM fund_request_lines l
       JOIN fund_requests fr ON fr.id = l.fund_request_id
       JOIN entities e ON e.id = fr.entity_id
       LEFT JOIN fund_request_groups g ON g.id = l.group_id
       LEFT JOIN budget_codes bc ON bc.id = l.budget_code_id
       LEFT JOIN finance_dimensions pc ON pc.id = l.profit_center_id
      WHERE ${where.join(' AND ')}
      ORDER BY fr.period DESC, e.entities_name, bc.sort_order, l.id`, args);
  const list = rows as any[];
  const paid = await paidByLine(pool, list.map((l) => l.id));
  const adj = new Map<number, Map<number, number>>();
  for (const id of new Set(list.map((l) => l.fund_request_id))) adj.set(id, await reallocMap(pool, id));
  for (const l of list) {
    const idr = toIdr(l.amount, l.currency, l);
    l.planned = round2(idr);
    l.realloc = round2(adj.get(l.fund_request_id)?.get(l.id) || 0);
    l.budget = round2(idr + l.realloc);
    l.actual_paid = round2(paid.get(l.id)?.paid || 0);
    l.actual = round2(l.actual_paid + Number(l.actual_manual || 0));
    l.remaining = round2(l.budget - l.actual);
    // Budget purpose follows where the line sits in the document.
    l.budget_purpose = l.section === 'offtake_out' || String(l.section).startsWith('trading_')
      ? 'Operational Offtake'
      : (l.group_area === 'overhead' || l.kind === 'overhead') ? 'Overhead' : 'Operational Non-Offtake';
    l.status = l.rejected_at && l.stage === 'requested' ? 'Revisi' : STAGE_LABEL[l.stage as Stage];
    delete l.rate_sgd; delete l.rate_usd; delete l.rate_eur;
  }
  return list;
}

// GET /api/finance/budget?entity_id=&from=&to=&status=all&budget_code_id=&main_account=&search=
router.get('/budget', authenticate, async (req: Request, res: Response) => {
  try {
    const rows = await budgetLines(req, req.query.status === 'all');
    const approved = rows.filter((r) => r.stage === 'hq_approved');
    const sum = (a: any[], k: string) => round2(a.reduce((s, r) => s + Number(r[k] || 0), 0));
    return res.json({
      data: rows,
      summary: {
        total_budget: sum(approved, 'budget'), total_actual: sum(approved, 'actual'),
        remaining: sum(approved, 'remaining'), lines: rows.length,
      },
    });
  } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

/**
 * Actual transactions: Paid payment requests (period = the FR month of the line
 * they realise, or the month they were paid when they realise none), and the
 * manual bookings on approved lines.
 */
async function actualRows(req: Request) {
  const periodExpr = `COALESCE(fr.period, DATE_FORMAT(COALESCE(pay.released_pay_date, pay.updated_at), '%Y-%m'))`;
  const { where, args } = filters(req, { entity: 'pay.entity_id', period: periodExpr });
  where.push("pay.status = 'Paid'");
  const [pays] = await pool.query(
    `SELECT pay.id AS source_id, 'payment_request' AS source, pay.payreq_number AS reference, pay.payreq_kind,
            pay.entity_id, e.entities_name AS entity_name, ${periodExpr} AS period,
            COALESCE(pay.released_pay_date, DATE(pay.updated_at)) AS date,
            COALESCE(l.budget_code_id, pay.budget_code_id) AS budget_code_id, bc.code AS budget_code,
            bc.main_account, bc.sub_account,
            COALESCE(l.description, pay.reason) AS description, pay.beneficiary_name AS vendor,
            pay.amount, pay.fund_request_line_id, fr.id AS fund_request_id, fr.fr_number
       FROM payment_requests pay
       JOIN entities e ON e.id = pay.entity_id
       LEFT JOIN fund_request_lines l ON l.id = pay.fund_request_line_id
       LEFT JOIN fund_requests fr ON fr.id = l.fund_request_id
       LEFT JOIN budget_codes bc ON bc.id = COALESCE(l.budget_code_id, pay.budget_code_id)
      WHERE ${where.join(' AND ')}`, args);
  const m = filters(req, { entity: 'fr.entity_id', period: 'fr.period' });
  m.where.push('l.actual_manual IS NOT NULL', 'l.actual_manual <> 0');
  const [manual] = await pool.query(
    `SELECT l.id AS source_id, 'manual' AS source, fr.fr_number AS reference, NULL AS payreq_kind,
            fr.entity_id, e.entities_name AS entity_name, fr.period, DATE(l.updated_at) AS date,
            l.budget_code_id, bc.code AS budget_code, bc.main_account, bc.sub_account,
            l.description, l.actual_manual_note AS vendor, l.actual_manual AS amount,
            l.id AS fund_request_line_id, fr.id AS fund_request_id, fr.fr_number
       FROM fund_request_lines l
       JOIN fund_requests fr ON fr.id = l.fund_request_id
       JOIN entities e ON e.id = fr.entity_id
       LEFT JOIN budget_codes bc ON bc.id = l.budget_code_id
      WHERE ${m.where.join(' AND ')}`, m.args);
  return [...(pays as any[]), ...(manual as any[])]
    .filter((r) => !req.query.search || `${r.reference} ${r.description} ${r.vendor} ${r.budget_code}`
      .toLowerCase().includes(String(req.query.search).toLowerCase()))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// GET /api/finance/actual?entity_id=&from=&to=&search=
router.get('/actual', authenticate, async (req: Request, res: Response) => {
  try {
    const rows = await actualRows(req);
    const total = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
    const linked = round2(rows.filter((r) => r.fund_request_line_id).reduce((s, r) => s + Number(r.amount || 0), 0));
    return res.json({ data: rows, summary: { total_actual: total, linked, unlinked: round2(total - linked), count: rows.length } });
  } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// GET /api/finance/budget-vs-actual?entity_id=&from=&to=
// One row per budget code; budget = approved lines, actual = Paid + manual.
router.get('/budget-vs-actual', authenticate, async (req: Request, res: Response) => {
  try {
    const budget = await budgetLines(req, false);
    const actual = await actualRows(req);
    const by = new Map<string, any>();
    const row = (code: number | null, label: string | null, main: string | null, sub: string | null) => {
      const k = String(code ?? 'none');
      if (!by.has(k)) {
        by.set(k, {
          budget_code_id: code, budget_code: label ?? 'Tanpa budget code', main_account: main ?? '—', sub_account: sub ?? '—',
          budget: 0, actual: 0, lines: 0, transactions: 0,
        });
      }
      return by.get(k);
    };
    for (const l of budget) { const r = row(l.budget_code_id, l.budget_code, l.main_account, l.sub_account); r.budget += l.budget; r.lines++; }
    for (const t of actual) { const r = row(t.budget_code_id, t.budget_code, t.main_account, t.sub_account); r.actual += Number(t.amount || 0); r.transactions++; }
    const rows = [...by.values()].map((r) => {
      const variance = round2(r.budget - r.actual);
      const util = r.budget > 0 ? round2(r.actual / r.budget * 100) : (r.actual > 0 ? null : 0);
      return {
        ...r, budget: round2(r.budget), actual: round2(r.actual), variance, utilization: util,
        status: r.budget <= 0 && r.actual > 0 ? 'Unbudgeted' : util != null && util > 100 ? 'Over Budget'
          : util != null && util >= 90 ? 'Near Budget' : 'Under Budget',
      };
    }).sort((a, b) => String(a.budget_code).localeCompare(String(b.budget_code)));
    const tb = round2(rows.reduce((s, r) => s + r.budget, 0));
    const ta = round2(rows.reduce((s, r) => s + r.actual, 0));
    return res.json({
      data: rows,
      summary: {
        total_budget: tb, total_actual: ta, remaining: round2(tb - ta), variance: round2(tb - ta),
        utilization: tb > 0 ? round2(ta / tb * 100) : null,
      },
    });
  } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

export default router;
