import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

// Calculated warehouse stock (saprodi only). Mounted at /api/warehouse-stock.
export const router = Router();

// GET /api/warehouse-stock/inventory?warehouse_id=&sapropdi_id=
router.get('/inventory', authenticate, async (req: Request, res: Response) => {
 try {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.warehouse_id) { where.push('warehouse_id = ?'); args.push(req.query.warehouse_id); }
  if (req.query.sapropdi_id)  { where.push('sapropdi_id = ?'); args.push(req.query.sapropdi_id); }
  const [rows] = await pool.query(
    `SELECT * FROM v_saprodi_stock ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY warehouse_name, sapropdi_name`, args);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// GET /api/warehouse-stock/stock-card?sapropdi_id=&warehouse_id=
// Chronological IN (stock_in_items) / OUT (distributions type=Saprodi) movements with running balance.
router.get('/stock-card', authenticate, async (req: Request, res: Response) => {
 try {
  const sapropdiId = req.query.sapropdi_id;
  const warehouseId = req.query.warehouse_id;
  if (!sapropdiId) return res.status(422).json({ message: 'sapropdi_id is required' });

  const inArgs: any[] = [sapropdiId];
  let inWhere = 'sii.sapropdi_id = ?';
  if (warehouseId) { inWhere += ' AND si.warehouse_id = ?'; inArgs.push(warehouseId); }

  const [ins] = await pool.query(
    `SELECT si.stock_in_date AS date, 'Stock In' AS type, si.stock_in_number AS ref,
            sii.received_qty AS qty_in, 0 AS qty_out, si.warehouse_id
     FROM stock_in_items sii JOIN stock_in si ON si.id = sii.stock_in_id
     WHERE ${inWhere}`, inArgs);

  // Distributions are not warehouse-scoped in schema; filter by sapropdi only.
  const [outs] = await pool.query(
    `SELECT d.date AS date, 'Distribution' AS type, CONCAT('DIST-', d.id) AS ref,
            0 AS qty_in, d.quantity AS qty_out, NULL AS warehouse_id
     FROM pre_finance_distributions d
     JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
     WHERE d.sapropdi_id = ? AND t.type_name = 'Saprodi'`, [sapropdiId]);

  const rows = [...(ins as any[]), ...(outs as any[])]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let balance = 0;
  const card = rows.map((r) => {
    balance += Number(r.qty_in) - Number(r.qty_out);
    return { ...r, balance };
  });
  return res.json({ data: card });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// GET /api/warehouse-stock/reorder  — items at/below minimum with suggested reorder.
router.get('/reorder', authenticate, async (req: Request, res: Response) => {
 try {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.warehouse_id) { where.push('r.warehouse_id = ?'); args.push(req.query.warehouse_id); }
  const [rows] = await pool.query(
    `SELECT r.id, r.warehouse_id, w.warehouse_name, r.sapropdi_id, s.sapropdi_name,
            r.min_stock, r.reorder_qty, r.is_active,
            COALESCE(st.remaining, 0) AS current_stock,
            GREATEST(r.min_stock - COALESCE(st.remaining, 0), 0) AS shortage,
            CASE WHEN COALESCE(st.remaining,0) <= 0 THEN 'Critical'
                 WHEN COALESCE(st.remaining,0) < r.min_stock THEN 'Low'
                 ELSE 'OK' END AS status
     FROM saprodi_reorder_levels r
     JOIN warehouse w  ON w.id = r.warehouse_id
     JOIN sapropdi s   ON s.id = r.sapropdi_id
     LEFT JOIN v_saprodi_stock st ON st.warehouse_id = r.warehouse_id AND st.sapropdi_id = r.sapropdi_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY status DESC, w.warehouse_name`, args);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

export default router;
