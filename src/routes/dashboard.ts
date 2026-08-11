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
    ]);

    // Purchasing by scheme. The scope fragment brings its own plot join (es_pl) —
    // the scheme is read from the one already joined here.
    const [bySchemeRows] = await pool.query(
      `SELECT COALESCE(pl.scheme,'BeliPutus') AS scheme, COUNT(*) AS count,
              COALESCE(SUM(p.quantity),0) AS qty, COALESCE(SUM(p.total_value),0) AS value
       FROM purchasing p
       LEFT JOIN plot pl ON pl.id = p.plot_id
       ${purchasingScope('p')}
       ${whereClause(byEntity)}
       GROUP BY COALESCE(pl.scheme,'BeliPutus')`, a);

    // Monthly trend (last 6 months) of purchasing value & selling revenue. Each
    // derived table is its own alias namespace, so the fragment repeats safely;
    // the four scope arguments follow the order the clauses appear in the text.
    const [trend] = await pool.query(
      `SELECT m.period,
              COALESCE(pu.value, 0) AS purchasing_value,
              COALESCE(se.revenue, 0) AS selling_revenue
       FROM (
         SELECT DATE_FORMAT(p.date, '%Y-%m') AS period FROM purchasing p ${purchasingScope('p')}${whereClause(byEntity)}
         UNION SELECT DATE_FORMAT(s.date, '%Y-%m') FROM selling s ${sellingScope('s')}${whereClause(byEntity)}
       ) m
       LEFT JOIN (
         SELECT DATE_FORMAT(p.date,'%Y-%m') AS period, SUM(p.total_value) AS value
         FROM purchasing p ${purchasingScope('p')}${whereClause(byEntity)} GROUP BY 1
       ) pu ON pu.period = m.period
       LEFT JOIN (
         SELECT DATE_FORMAT(s.date,'%Y-%m') AS period, SUM(s.total_revenue) AS revenue
         FROM selling s ${sellingScope('s')}${whereClause(byEntity)} GROUP BY 1
       ) se ON se.period = m.period
       GROUP BY m.period ORDER BY m.period DESC LIMIT 6`,
      [...a, ...a, ...a, ...a]);

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
        },
        purchasing_by_scheme: bySchemeRows,
        trend: (trend as any[]).reverse(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;
