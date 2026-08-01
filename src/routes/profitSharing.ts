import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { crudRouter } from '../utils/crudFactory';

export const router = Router();

// Operational Cost / investment per farmer+plot+period.
router.use('/investments', crudRouter({
  table: 'profit_sharing_investments',
  columns: ['period', 'farmer_id', 'plot_id', 'pre_finance_type_id', 'quantity', 'unit_id', 'amount', 'description'],
  required: ['period', 'farmer_id'],
  numeric: ['farmer_id', 'plot_id', 'pre_finance_type_id', 'quantity', 'unit_id', 'amount'],
  filterColumns: ['period', 'farmer_id', 'plot_id'],
  orderBy: 'period DESC, id DESC',
  label: 'Investment',
}));

// Final profit-sharing records (P/L + split).
router.use('/shares', crudRouter({
  table: 'profit_sharing',
  columns: ['period', 'farmer_id', 'plot_id', 'commodities_id', 'total_revenue', 'total_investment', 'pct_farmer', 'pct_company', 'value_farmer', 'value_company', 'status'],
  required: ['period', 'farmer_id'],
  numeric: ['farmer_id', 'plot_id', 'commodities_id', 'total_revenue', 'total_investment', 'pct_farmer', 'pct_company', 'value_farmer', 'value_company'],
  filterColumns: ['period', 'farmer_id', 'plot_id'],
  orderBy: 'period DESC, id DESC',
  label: 'Profit sharing',
}));

// GET /api/profit-sharing/revenue  — selling records under ProfitSharing scheme.
router.get('/revenue', authenticate, async (req: Request, res: Response) => {
 try {
  const where: string[] = ["COALESCE(pl.scheme,'') = 'ProfitSharing'"];
  const args: any[] = [];
  if (req.query.period) { where.push("DATE_FORMAT(s.date, '%Y-%m') = ?"); args.push(req.query.period); }
  const [rows] = await pool.query(
    `SELECT DISTINCT s.id, s.date, DATE_FORMAT(s.date, '%Y-%m') AS period,
            f.id AS farmer_id, f.farmer_name, pl.id AS plot_id, pl.plot_name,
            o.offtaker_name AS customer, s.accepted_volume AS qty, s.price_per_unit, s.total_revenue
     FROM selling s
     JOIN processing pr             ON pr.id = s.processing_id
     JOIN processing_purchasings pp ON pp.processing_id = pr.id
     JOIN purchasing pu             ON pu.id = pp.purchasing_id
     JOIN plot pl                   ON pl.id = pu.plot_id
     JOIN farmers f                 ON f.id = pl.farmer_id
     LEFT JOIN offtaker o           ON o.id = s.offtaker_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.date DESC`, args);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// GET /api/profit-sharing/pl  — per period/farmer/plot: revenue − investment.
router.get('/pl', authenticate, async (req: Request, res: Response) => {
 try {
  const periodFilter = !!req.query.period;

  // Investment reaches a farmer two ways: a cash entry in profit_sharing_investments,
  // and saprodi actually issued from the warehouse to a ProfitSharing plot. Counting
  // only the first understates what the company put in — and since that table is
  // usually empty, it understated it to zero.
  //
  // The period/farmer keys are unioned first so a row survives when only one of the
  // three sources has data. Driving the query off investments alone used to drop any
  // farmer who had sold but had nothing booked against them, which is precisely the
  // farmer whose profit share needs looking at.
  const [rows] = await pool.query(
    `SELECT k.period, k.farmer_id, f.farmer_name,
            COALESCE(rev.total_revenue, 0) AS total_revenue,
            COALESCE(inv.cash_investment, 0)    AS cash_investment,
            COALESCE(dist.saprodi_investment, 0) AS saprodi_investment,
            COALESCE(inv.cash_investment, 0) + COALESCE(dist.saprodi_investment, 0) AS total_investment,
            COALESCE(rev.total_revenue, 0)
              - COALESCE(inv.cash_investment, 0)
              - COALESCE(dist.saprodi_investment, 0) AS net_profit
     FROM (
       SELECT period, farmer_id FROM profit_sharing_investments
       UNION
       SELECT DATE_FORMAT(d.date, '%Y-%m'), d.farmer_id
       FROM pre_finance_distributions d
       JOIN plot pl ON pl.id = d.plot_id
       WHERE COALESCE(pl.scheme,'') = 'ProfitSharing'
       UNION
       SELECT DATE_FORMAT(s.date, '%Y-%m'), pl.farmer_id
       FROM selling s
       JOIN processing pr             ON pr.id = s.processing_id
       JOIN processing_purchasings pp ON pp.processing_id = pr.id
       JOIN purchasing pu             ON pu.id = pp.purchasing_id
       JOIN plot pl                   ON pl.id = pu.plot_id
       WHERE COALESCE(pl.scheme,'') = 'ProfitSharing'
     ) k
     LEFT JOIN (
       SELECT period, farmer_id, SUM(amount) AS cash_investment
       FROM profit_sharing_investments GROUP BY period, farmer_id
     ) inv ON inv.period = k.period AND inv.farmer_id = k.farmer_id
     LEFT JOIN (
       SELECT DATE_FORMAT(d.date, '%Y-%m') AS period, d.farmer_id,
              SUM(d.total_amount) AS saprodi_investment
       FROM pre_finance_distributions d
       JOIN plot pl ON pl.id = d.plot_id
       WHERE COALESCE(pl.scheme,'') = 'ProfitSharing'
       GROUP BY DATE_FORMAT(d.date, '%Y-%m'), d.farmer_id
     ) dist ON dist.period = k.period AND dist.farmer_id = k.farmer_id
     LEFT JOIN (
       SELECT DATE_FORMAT(s.date, '%Y-%m') AS period, pl.farmer_id, SUM(s.total_revenue) AS total_revenue
       FROM selling s
       JOIN processing pr             ON pr.id = s.processing_id
       JOIN processing_purchasings pp ON pp.processing_id = pr.id
       JOIN purchasing pu             ON pu.id = pp.purchasing_id
       JOIN plot pl                   ON pl.id = pu.plot_id
       WHERE COALESCE(pl.scheme,'') = 'ProfitSharing'
       GROUP BY DATE_FORMAT(s.date, '%Y-%m'), pl.farmer_id
     ) rev ON rev.period = k.period AND rev.farmer_id = k.farmer_id
     LEFT JOIN farmers f ON f.id = k.farmer_id
     ${periodFilter ? 'WHERE k.period = ?' : ''}
     ORDER BY k.period DESC`, periodFilter ? [req.query.period] : []);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

export default router;
