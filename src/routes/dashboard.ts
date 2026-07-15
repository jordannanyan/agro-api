import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

// Aggregations for the Executive Dashboard and module dashboards.
export const router = Router();

async function scalar(sql: string, args: any[] = []): Promise<number> {
  const [rows] = await pool.query(sql, args);
  return Number((rows as any[])[0]?.v || 0);
}

// GET /api/dashboard/executive
router.get('/executive', authenticate, async (_req: Request, res: Response) => {
  try {
    const [
      farmers, plots, purchasingQty, purchasingValue, sellingRevenue,
      openProcessing, pendingPR, pendingPO, outstanding,
    ] = await Promise.all([
      scalar('SELECT COUNT(*) AS v FROM farmers'),
      scalar('SELECT COUNT(*) AS v FROM plot'),
      scalar('SELECT COALESCE(SUM(quantity),0) AS v FROM purchasing'),
      scalar('SELECT COALESCE(SUM(total_value),0) AS v FROM purchasing'),
      scalar('SELECT COALESCE(SUM(total_revenue),0) AS v FROM selling'),
      scalar("SELECT COUNT(*) AS v FROM processing WHERE status <> 'closed'"),
      scalar("SELECT COUNT(*) AS v FROM purchase_requests WHERE status = 'Pending'"),
      scalar("SELECT COUNT(*) AS v FROM purchase_orders WHERE status = 'Pending'"),
      scalar('SELECT COALESCE(SUM(outstanding),0) AS v FROM v_pre_finance_outstanding'),
    ]);

    // Purchasing by scheme
    const [bySchemeRows] = await pool.query(
      `SELECT COALESCE(pl.scheme,'BeliPutus') AS scheme, COUNT(*) AS count,
              COALESCE(SUM(p.quantity),0) AS qty, COALESCE(SUM(p.total_value),0) AS value
       FROM purchasing p LEFT JOIN plot pl ON pl.id = p.plot_id
       GROUP BY COALESCE(pl.scheme,'BeliPutus')`);

    // Monthly trend (last 6 months) of purchasing value & selling revenue
    const [trend] = await pool.query(
      `SELECT m.period,
              COALESCE(pu.value, 0) AS purchasing_value,
              COALESCE(se.revenue, 0) AS selling_revenue
       FROM (
         SELECT DATE_FORMAT(date, '%Y-%m') AS period FROM purchasing
         UNION SELECT DATE_FORMAT(date, '%Y-%m') FROM selling
       ) m
       LEFT JOIN (SELECT DATE_FORMAT(date,'%Y-%m') AS period, SUM(total_value) AS value FROM purchasing GROUP BY 1) pu ON pu.period = m.period
       LEFT JOIN (SELECT DATE_FORMAT(date,'%Y-%m') AS period, SUM(total_revenue) AS revenue FROM selling GROUP BY 1) se ON se.period = m.period
       GROUP BY m.period ORDER BY m.period DESC LIMIT 6`);

    return res.json({
      data: {
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
