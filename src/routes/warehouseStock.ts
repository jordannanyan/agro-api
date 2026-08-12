import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { entityScope } from '../utils/entityScope';
import { warehouseEntityPredicate } from '../utils/farmScope';

// Calculated warehouse stock (saprodi only). Mounted at /api/warehouse-stock.
export const router = Router();

// GET /api/warehouse-stock/inventory?warehouse_id=&sapropdi_id=
router.get('/inventory', authenticate, async (req: Request, res: Response) => {
 try {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.warehouse_id) { where.push('warehouse_id = ?'); args.push(req.query.warehouse_id); }
  if (req.query.sapropdi_id)  { where.push('sapropdi_id = ?'); args.push(req.query.sapropdi_id); }
  // Stock sits in a warehouse, and a warehouse belongs to a PT.
  const scope = entityScope(req);
  if (scope != null) { where.push(warehouseEntityPredicate('warehouse_id')); args.push(scope); }
  // The view has no entity of its own; name the PT so a reader who sees several
  // warehouses can tell whose stock each line is.
  const [rows] = await pool.query(
    `SELECT v.*,
            (SELECT wk.entities_id FROM warehouse w JOIN kth wk ON wk.id = w.kth_id
              WHERE w.id = v.warehouse_id) AS entity_id,
            (SELECT e.entities_name FROM warehouse w
               JOIN kth wk  ON wk.id = w.kth_id
               JOIN entities e ON e.id = wk.entities_id
              WHERE w.id = v.warehouse_id) AS entity_name
       FROM v_saprodi_stock v
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY warehouse_name, sapropdi_name`, args);
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

  const scope = entityScope(req);
  const inArgs: any[] = [sapropdiId];
  let inWhere = 'sii.sapropdi_id = ?';
  if (warehouseId) { inWhere += ' AND si.warehouse_id = ?'; inArgs.push(warehouseId); }
  if (scope != null) { inWhere += ` AND ${warehouseEntityPredicate('si.warehouse_id')}`; inArgs.push(scope); }

  const [ins] = await pool.query(
    `SELECT si.stock_in_date AS date, 'Stock In' AS type, si.stock_in_number AS ref,
            sii.received_qty AS qty_in, 0 AS qty_out, si.warehouse_id,
            w.warehouse_name, ent.entities_name AS entity_name
     FROM stock_in_items sii
     JOIN stock_in si       ON si.id = sii.stock_in_id
     LEFT JOIN warehouse w  ON w.id = si.warehouse_id
     LEFT JOIN kth wk       ON wk.id = w.kth_id
     LEFT JOIN entities ent ON ent.id = wk.entities_id
     WHERE ${inWhere}`, inArgs);

  // Distributions carry their own warehouse, so OUT filters exactly like IN. Before
  // that column existed this query fell back to sapropdi alone, which meant asking
  // for one warehouse still returned every warehouse's issues.
  const outArgs: any[] = [sapropdiId];
  let outWhere = "d.sapropdi_id = ? AND t.type_name = 'Saprodi'";
  if (warehouseId) { outWhere += ' AND d.warehouse_id = ?'; outArgs.push(warehouseId); }
  if (scope != null) { outWhere += ` AND ${warehouseEntityPredicate('d.warehouse_id')}`; outArgs.push(scope); }

  const [outs] = await pool.query(
    `SELECT d.date AS date, 'Distribution' AS type, CONCAT('DIST-', d.id) AS ref,
            0 AS qty_in, d.quantity AS qty_out, d.warehouse_id,
            w.warehouse_name, ent.entities_name AS entity_name,
            COALESCE(pl.scheme, 'BeliPutus') AS scheme
     FROM pre_finance_distributions d
     JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
     LEFT JOIN plot pl        ON pl.id = d.plot_id
     LEFT JOIN warehouse w    ON w.id = d.warehouse_id
     LEFT JOIN kth wk         ON wk.id = w.kth_id
     LEFT JOIN entities ent   ON ent.id = wk.entities_id
     WHERE ${outWhere}`, outArgs);

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
  const scope = entityScope(req);
  if (scope != null) { where.push(warehouseEntityPredicate('r.warehouse_id')); args.push(scope); }
  const [rows] = await pool.query(
    `SELECT r.id, r.warehouse_id, w.warehouse_name, r.sapropdi_id, s.sapropdi_name,
            ent.id AS entity_id, ent.entities_name AS entity_name,
            r.min_stock, r.reorder_qty, r.is_active,
            COALESCE(st.remaining, 0) AS current_stock,
            GREATEST(r.min_stock - COALESCE(st.remaining, 0), 0) AS shortage,
            CASE WHEN COALESCE(st.remaining,0) <= 0 THEN 'Critical'
                 WHEN COALESCE(st.remaining,0) < r.min_stock THEN 'Low'
                 ELSE 'OK' END AS status
     FROM saprodi_reorder_levels r
     JOIN warehouse w  ON w.id = r.warehouse_id
     LEFT JOIN kth wk      ON wk.id = w.kth_id
     LEFT JOIN entities ent ON ent.id = wk.entities_id
     JOIN sapropdi s   ON s.id = r.sapropdi_id
     LEFT JOIN v_saprodi_stock st ON st.warehouse_id = r.warehouse_id AND st.sapropdi_id = r.sapropdi_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY status DESC, w.warehouse_name`, args);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

export default router;
