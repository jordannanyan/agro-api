import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { entityScope } from '../utils/entityScope';
import {
  ENTITY_COL, kthScope, farmerRefScope, purchasingScope, processingScope, sellingScope, whereClause,
} from '../utils/farmScope';

// Aggregations for the Executive Dashboard and module dashboards.
export const router = Router();

async function scalar(sql: string, args: any[] = []): Promise<number> {
  const [rows] = await pool.query(sql, args);
  return Number((rows as any[])[0]?.v || 0);
}

// GET /api/dashboard/executive
router.get('/executive', authenticate, async (req: Request, res: Response) => {
  try {
    // Every figure follows the same scope as the lists behind it. A Field Admin who
    // can only open JNBS records must not be told there are five pending requests,
    // three of them SNBS's — a KPI that disagrees with the table under it is worse
    // than no KPI. The procurement tables carry entity_id; the farming ones reach
    // their PT through the farmer group, which is what utils/farmScope spells out.
    const scope = entityScope(req);
    const byEntity = scope != null ? `${ENTITY_COL} = ?` : null;
    const a = scope != null ? [scope] : [];      // args for one occurrence
    const docScope = scope != null ? ' AND entity_id = ?' : '';

    const [
      farmers, plots, purchasingQty, purchasingValue, sellingRevenue,
      openProcessing, pendingPR, pendingPO, outstanding,
      expensesPaid, expensesPaidCount,
    ] = await Promise.all([
      scalar(`SELECT COUNT(*) AS v FROM farmers f ${kthScope('f')}${whereClause(byEntity)}`, a),
      scalar(`SELECT COUNT(*) AS v FROM plot p ${farmerRefScope('p')}${whereClause(byEntity)}`, a),
      scalar(`SELECT COALESCE(SUM(p.quantity),0) AS v FROM purchasing p ${purchasingScope('p')}${whereClause(byEntity)}`, a),
      scalar(`SELECT COALESCE(SUM(p.total_value),0) AS v FROM purchasing p ${purchasingScope('p')}${whereClause(byEntity)}`, a),
      scalar(`SELECT COALESCE(SUM(s.total_revenue),0) AS v FROM selling s ${sellingScope('s')}${whereClause(byEntity)}`, a),
      scalar(`SELECT COUNT(*) AS v FROM processing pr ${processingScope('pr')}${whereClause("pr.status <> 'closed'", byEntity)}`, a),
      scalar(`SELECT COUNT(*) AS v FROM purchase_requests WHERE status = 'Pending'${docScope}`, a),
      scalar(`SELECT COUNT(*) AS v FROM purchase_orders WHERE status = 'Pending'${docScope}`, a),
      scalar(`SELECT COALESCE(SUM(o.outstanding),0) AS v FROM v_pre_finance_outstanding o ${farmerRefScope('o')}${whereClause(byEntity)}`, a),
      // Money actually out the door. A payment request only reaches 'Paid' through
      // the bank statement (or a logged manual override), so this is spend that has
      // left the account — not what has merely been approved.
      scalar(`SELECT COALESCE(SUM(amount),0) AS v FROM payment_requests WHERE status = 'Paid'${docScope}`, a),
      scalar(`SELECT COUNT(*) AS v FROM payment_requests WHERE status = 'Paid'${docScope}`, a),
    ]);

    // Paid spend split by what it paid for — buying goods vs. paying farmers back
    // through their KTH — and by budget code, which is how the office reads it.
    const [expensesByKind] = await pool.query(
      `SELECT payreq_kind AS kind, COUNT(*) AS count, COALESCE(SUM(amount),0) AS value
       FROM payment_requests WHERE status = 'Paid'${docScope}
       GROUP BY payreq_kind`, a);
    const [expensesByCode] = await pool.query(
      `SELECT COALESCE(bc.code, '(tanpa kode)') AS code, COUNT(*) AS count,
              COALESCE(SUM(pay.amount),0) AS value
       FROM payment_requests pay
       LEFT JOIN budget_codes bc ON bc.id = pay.budget_code_id
       WHERE pay.status = 'Paid'${scope != null ? ' AND pay.entity_id = ?' : ''}
       GROUP BY COALESCE(bc.code, '(tanpa kode)')
       ORDER BY value DESC LIMIT 6`, a);

    // Purchasing by scheme. The scope fragment brings its own plot join (es_pl) —
    // the scheme is read from the one already joined here.
    const [bySchemeRows] = await pool.query(
      `SELECT p.scheme AS scheme, COUNT(*) AS count,
              COALESCE(SUM(p.quantity),0) AS qty, COALESCE(SUM(p.total_value),0) AS value
       FROM purchasing p
       LEFT JOIN plot pl ON pl.id = p.plot_id
       ${purchasingScope('p')}
       ${whereClause(byEntity)}
       GROUP BY p.scheme`, a);

    // Monthly trend (last 6 months) of purchasing value & selling revenue. Each
    // derived table is its own alias namespace, so the fragment repeats safely;
    // the four scope arguments follow the order the clauses appear in the text.
    const [trend] = await pool.query(
      `SELECT m.period,
              COALESCE(pu.value, 0) AS purchasing_value,
              COALESCE(se.revenue, 0) AS selling_revenue,
              COALESCE(ex.expense, 0) AS expenses_paid
       FROM (
         SELECT DATE_FORMAT(p.date, '%Y-%m') AS period FROM purchasing p ${purchasingScope('p')}${whereClause(byEntity)}
         UNION SELECT DATE_FORMAT(s.date, '%Y-%m') FROM selling s ${sellingScope('s')}${whereClause(byEntity)}
         UNION SELECT DATE_FORMAT(pay.released_pay_date, '%Y-%m') FROM payment_requests pay
                WHERE pay.status = 'Paid' AND pay.released_pay_date IS NOT NULL${scope != null ? ' AND pay.entity_id = ?' : ''}
       ) m
       LEFT JOIN (
         SELECT DATE_FORMAT(p.date,'%Y-%m') AS period, SUM(p.total_value) AS value
         FROM purchasing p ${purchasingScope('p')}${whereClause(byEntity)} GROUP BY 1
       ) pu ON pu.period = m.period
       LEFT JOIN (
         SELECT DATE_FORMAT(s.date,'%Y-%m') AS period, SUM(s.total_revenue) AS revenue
         FROM selling s ${sellingScope('s')}${whereClause(byEntity)} GROUP BY 1
       ) se ON se.period = m.period
       LEFT JOIN (
         SELECT DATE_FORMAT(pay.released_pay_date,'%Y-%m') AS period, SUM(pay.amount) AS expense
         FROM payment_requests pay
         WHERE pay.status = 'Paid' AND pay.released_pay_date IS NOT NULL${scope != null ? ' AND pay.entity_id = ?' : ''}
         GROUP BY 1
       ) ex ON ex.period = m.period
       GROUP BY m.period ORDER BY m.period DESC LIMIT 6`,
      [...a, ...a, ...a, ...a, ...a, ...a]);

    return res.json({
      data: {
        // What the numbers cover, so the dashboard can say so out loud instead of
        // leaving an NBSV admin to guess whether they are looking at one PT or all.
        scope: { entity_id: scope, all_entities: scope == null },
        kpis: {
          farmers, plots,
          purchasing_qty: purchasingQty,
          purchasing_value: purchasingValue,
          selling_revenue: sellingRevenue,
          open_processing: openProcessing,
          pending_pr: pendingPR,
          pending_po: pendingPO,
          outstanding_total: outstanding,
          expenses_paid: expensesPaid,
          expenses_paid_count: expensesPaidCount,
        },
        purchasing_by_scheme: bySchemeRows,
        expenses_by_kind: expensesByKind,
        expenses_by_code: expensesByCode,
        trend: (trend as any[]).reverse(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/dashboard/segments?entity_id=
//
// Each PT × commodity read as a business of its own (JNBS · Pisang, SNBS ·
// Pisang, SNBS · Kakao …): what it sold, what that cost directly, and what was
// spent on the crop that is not tied to one sale.
//
//   Penjualan       selling.total_revenue (goods + fees invoiced), by the
//                   processing run's commodity.
//   Direct cost     purchases (purchasing.total_value — on Pre-Finance the final
//                   price, the cash paid; the loan part is the saprodi already
//                   counted as non-direct), harvesting and PNBP (the PT's per-kg
//                   rates, banana only: JNBS on farmer Pre-Finance/Profit Sharing
//                   kilos bought — outgrowers harvest their own — SNBS on kilos
//                   sold), processing (washing, packing, sorting) and selling
//                   costs (transport, loading …).
//   Non-direct      inputs and labour given to farmers (pre_finance_distributions
//                   that count as debt) and Profit Sharing plot costs
//                   (profit_sharing_investments). The SNBS stock-card issues that
//                   do not count as debt are left out — they are the same
//                   material as the plot costs, seen from the warehouse.
//
// Payment requests are not split here: a PayReq names no commodity, and the
// fertiliser it bought reaches this view when it is given to a farmer.
router.get('/segments', authenticate, async (req: Request, res: Response) => {
  try {
    const scope = entityScope(req);
    const [[banana]] = await pool.query("SELECT id FROM commodities WHERE commodities_name LIKE 'Banana%' LIMIT 1") as any;
    const BANANA = Number(banana?.id || 0);
    const [ents] = await pool.query(
      "SELECT id, entities_name, harvest_cost_per_kg, harvest_cost_basis, pnbp_per_kg FROM entities WHERE LOWER(entity_type) = 'operational'");
    const [comms] = await pool.query('SELECT id, commodities_name FROM commodities');
    const ym = (col: string) => `DATE_FORMAT(${col}, '%Y-%m')`;

    const [sales] = await pool.query(
      `SELECT ${ENTITY_COL} AS e, es_pr.commodities_id AS c, ${ym('s.date')} AS m,
              SUM(s.total_revenue) AS v, SUM(s.accepted_volume) AS kg
       FROM selling s ${sellingScope('s')} GROUP BY 1, 2, 3`);
    const [buys] = await pool.query(
      `SELECT ${ENTITY_COL} AS e, p.commodities_id AS c, ${ym('p.date')} AS m,
              SUM(p.total_value) AS v, SUM(p.quantity) AS kg,
              SUM(CASE WHEN p.supplier_type = 'farmer' AND p.scheme IN ('PreFinance','ProfitSharing') THEN p.quantity ELSE 0 END) AS farm_kg
       FROM purchasing p ${purchasingScope('p')} GROUP BY 1, 2, 3`);
    const [procs] = await pool.query(
      `SELECT ${ENTITY_COL} AS e, pr.commodities_id AS c, ${ym('pr.date')} AS m, SUM(pr.total_processing_cost) AS v
       FROM processing pr ${processingScope('pr')} GROUP BY 1, 2, 3`);
    const [scost] = await pool.query(
      `SELECT ${ENTITY_COL} AS e, es_pr.commodities_id AS c, ${ym('s.date')} AS m, SUM(sc.amount) AS v
       FROM selling_costs sc JOIN selling s ON s.id = sc.selling_id ${sellingScope('s')} GROUP BY 1, 2, 3`);
    const [dists] = await pool.query(
      `SELECT COALESCE(fk.entities_id, wk.entities_id) AS e, d.commodities_id AS c, ${ym('d.date')} AS m,
              t.type_name AS t, SUM(d.total_amount) AS v
       FROM pre_finance_distributions d
       JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
       LEFT JOIN farmers f ON f.id = d.farmer_id LEFT JOIN kth fk ON fk.id = f.kth_id
       LEFT JOIN warehouse w ON w.id = d.warehouse_id LEFT JOIN kth wk ON wk.id = w.kth_id
       WHERE d.counts_as_debt = 1 GROUP BY 1, 2, 3, 4`);
    // A Profit Sharing plot with no commodity of its own is a banana plot: both
    // PTs farm only banana under profit sharing.
    const [psi] = await pool.query(
      `SELECT k.entities_id AS e, COALESCE(pl.commodities_id, ?) AS c, LEFT(i.period, 7) AS m,
              t.type_name AS t, SUM(i.amount) AS v
       FROM profit_sharing_investments i
       JOIN plot pl ON pl.id = i.plot_id JOIN farmers f ON f.id = pl.farmer_id JOIN kth k ON k.id = f.kth_id
       JOIN pre_finance_types t ON t.id = i.pre_finance_type_id
       GROUP BY 1, 2, 3, 4`, [BANANA]);

    type Seg = { entity_id: number; commodity_id: number; parts: Record<string, number>; months: Record<string, Record<string, number>> };
    const segs = new Map<string, Seg>();
    const add = (e: any, c: any, m: any, part: string, v: any) => {
      const amount = Number(v) || 0;
      if (e == null || c == null || !amount) return;
      if (scope != null && Number(e) !== scope) return;
      const key = `${e}|${c}`;
      if (!segs.has(key)) segs.set(key, { entity_id: Number(e), commodity_id: Number(c), parts: {}, months: {} });
      const s = segs.get(key)!;
      s.parts[part] = (s.parts[part] || 0) + amount;
      const mm = String(m || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mm)) return;
      s.months[mm] = s.months[mm] || {};
      s.months[mm][part] = (s.months[mm][part] || 0) + amount;
    };
    const ent = new Map((ents as any[]).map((x) => [Number(x.id), x]));
    for (const r of sales as any[]) {
      add(r.e, r.c, r.m, 'sales', r.v);
      const en = ent.get(Number(r.e));
      if (en && Number(r.c) === BANANA && en.harvest_cost_basis === 'Offtake') {
        add(r.e, r.c, r.m, 'harvest', Number(en.harvest_cost_per_kg || 0) * Number(r.kg || 0));
        add(r.e, r.c, r.m, 'pnbp', Number(en.pnbp_per_kg || 0) * Number(r.kg || 0));
      }
    }
    for (const r of buys as any[]) {
      add(r.e, r.c, r.m, 'purchase', r.v);
      const en = ent.get(Number(r.e));
      if (en && Number(r.c) === BANANA && en.harvest_cost_basis !== 'Offtake') {
        add(r.e, r.c, r.m, 'harvest', Number(en.harvest_cost_per_kg || 0) * Number(r.farm_kg || 0));
        add(r.e, r.c, r.m, 'pnbp', Number(en.pnbp_per_kg || 0) * Number(r.kg || 0));
      }
    }
    for (const r of procs as any[]) add(r.e, r.c, r.m, 'processing', r.v);
    for (const r of scost as any[]) add(r.e, r.c, r.m, 'selling_cost', r.v);
    for (const r of dists as any[]) add(r.e, r.c, r.m, r.t === 'Labor' ? 'loan_labor' : 'loan_saprodi', r.v);
    for (const r of psi as any[]) add(r.e, r.c, r.m, r.t === 'Labor' ? 'ps_labor' : 'ps_material', r.v);

    const DIRECT = ['purchase', 'harvest', 'pnbp', 'processing', 'selling_cost'];
    const INDIRECT = ['loan_saprodi', 'loan_labor', 'ps_material', 'ps_labor'];
    const sum = (o: Record<string, number>, ks: string[]) => ks.reduce((a, k) => a + (o[k] || 0), 0);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const cname = new Map((comms as any[]).map((x) => [Number(x.id), x.commodities_name]));
    const out = [...segs.values()]
      .filter((s) => ent.has(s.entity_id))
      .map((s) => {
        const sales = s.parts.sales || 0, direct = sum(s.parts, DIRECT), indirect = sum(s.parts, INDIRECT);
        return {
          entity_id: s.entity_id, entity_name: ent.get(s.entity_id).entities_name,
          commodity_id: s.commodity_id, commodity_name: cname.get(s.commodity_id) ?? `#${s.commodity_id}`,
          totals: { sales: r2(sales), direct: r2(direct), indirect: r2(indirect), margin: r2(sales - direct - indirect) },
          parts: Object.fromEntries(Object.entries(s.parts).map(([k, v]) => [k, r2(v)])),
          monthly: Object.keys(s.months).sort().map((m) => ({
            period: m, sales: r2(s.months[m].sales || 0),
            direct: r2(sum(s.months[m], DIRECT)), indirect: r2(sum(s.months[m], INDIRECT)),
          })),
        };
      })
      .sort((a, b) => b.totals.sales - a.totals.sales || b.totals.direct - a.totals.direct);
    return res.json({ data: { scope: { entity_id: scope, all_entities: scope == null }, segments: out } });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;
