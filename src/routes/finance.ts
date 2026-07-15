import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

// Operational finance reports (budget vs actual). No double-entry GL.
export const router = Router();

// GET /api/finance/budget-monitoring?entity_id=&period=
router.get('/budget-monitoring', authenticate, async (req: Request, res: Response) => {
 try {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.entity_id) { where.push('b.entity_id = ?'); args.push(req.query.entity_id); }
  if (req.query.period)    { where.push('b.period = ?'); args.push(req.query.period); }
  const [rows] = await pool.query(
    `SELECT b.id, b.entity_id, e.entities_name, b.period, b.budget_code_id, bc.code AS budget_code,
            b.sub_category, b.budget_amount,
            COALESCE(a.actual_amount, 0) AS actual_amount,
            b.budget_amount - COALESCE(a.actual_amount, 0) AS variance,
            CASE WHEN b.budget_amount = 0 THEN 0
                 ELSE ROUND(COALESCE(a.actual_amount,0) / b.budget_amount * 100, 1) END AS used_pct
     FROM budgets b
     LEFT JOIN entities e     ON e.id = b.entity_id
     LEFT JOIN budget_codes bc ON bc.id = b.budget_code_id
     LEFT JOIN v_budget_actual a
            ON a.entity_id = b.entity_id AND a.period = b.period AND a.budget_code_id = b.budget_code_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY b.period DESC, bc.code`, args);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// GET /api/finance/actual?entity_id=&period=  — raw actual (from view).
router.get('/actual', authenticate, async (req: Request, res: Response) => {
 try {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.entity_id) { where.push('a.entity_id = ?'); args.push(req.query.entity_id); }
  if (req.query.period)    { where.push('a.period = ?'); args.push(req.query.period); }
  const [rows] = await pool.query(
    `SELECT a.*, bc.code AS budget_code, e.entities_name
     FROM v_budget_actual a
     LEFT JOIN budget_codes bc ON bc.id = a.budget_code_id
     LEFT JOIN entities e      ON e.id = a.entity_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.period DESC, bc.code`, args);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

export default router;
