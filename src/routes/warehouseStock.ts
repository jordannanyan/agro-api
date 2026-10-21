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
  // Qualified: the pending-count join below carries the same column names.
  if (req.query.warehouse_id) { where.push('v.warehouse_id = ?'); args.push(req.query.warehouse_id); }
  if (req.query.sapropdi_id)  { where.push('v.sapropdi_id = ?'); args.push(req.query.sapropdi_id); }
  // Stock sits in a warehouse, and a warehouse belongs to a PT.
  const scope = entityScope(req);
  if (scope != null) { where.push(warehouseEntityPredicate('v.warehouse_id')); args.push(scope); }
  // The view has no entity of its own; name the PT so a reader who sees several
  // warehouses can tell whose stock each line is.
  const [rows] = await pool.query(
    `SELECT v.*,
            (SELECT wk.entities_id FROM warehouse w JOIN kth wk ON wk.id = w.kth_id
              WHERE w.id = v.warehouse_id) AS entity_id,
            (SELECT e.entities_name FROM warehouse w
               JOIN kth wk  ON wk.id = w.kth_id
               JOIN entities e ON e.id = wk.entities_id
              WHERE w.id = v.warehouse_id) AS entity_name,
            -- Why the remaining figure is not simply in − out: the approved stock
            -- counts that adjusted it, named, so the reader can open them.
            (SELECT GROUP_CONCAT(CONCAT(o.opname_number, ' (', DATE_FORMAT(o.opname_date, '%Y-%m-%d'), '): ',
                                        IF(oi.adjustment > 0, '+', ''), TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM oi.adjustment)))
                                 ORDER BY o.applied_at SEPARATOR '; ')
               FROM stock_opname o JOIN stock_opname_items oi ON oi.stock_opname_id = o.id
              WHERE o.warehouse_id = v.warehouse_id AND oi.sapropdi_id = v.sapropdi_id
                AND o.applied_at IS NOT NULL AND oi.adjustment <> 0) AS opname_refs,
            -- The latest count not yet in the figure (recorded, waiting for the PM,
            -- or rejected): what the shelf held that day, beside what the system said.
            po.opname_id AS pending_opname_id, po.opname_number AS pending_opname_number,
            po.opname_date AS pending_opname_date, po.approval_status AS pending_opname_status,
            po.counted_qty AS pending_counted_qty, po.system_qty AS pending_system_qty
       FROM v_saprodi_stock v
       LEFT JOIN (
         SELECT o.id AS opname_id, o.opname_number, o.opname_date, o.approval_status, o.warehouse_id,
                oi.sapropdi_id, oi.counted_qty, oi.system_qty
           FROM stock_opname o JOIN stock_opname_items oi ON oi.stock_opname_id = o.id
          WHERE o.applied_at IS NULL
            AND o.id = (SELECT o2.id FROM stock_opname o2 JOIN stock_opname_items i2 ON i2.stock_opname_id = o2.id
                         WHERE o2.warehouse_id = o.warehouse_id AND i2.sapropdi_id = oi.sapropdi_id
                           AND o2.applied_at IS NULL
                         ORDER BY o2.opname_date DESC, o2.id DESC LIMIT 1)
       ) po ON po.warehouse_id = v.warehouse_id AND po.sapropdi_id = v.sapropdi_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY v.warehouse_name, v.sapropdi_name`, args);
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
  // Sejalan dengan v_saprodi_stock: penerimaan yang masih Draft belum jadi barang,
  // jadi ia tidak boleh muncul sebagai pergerakan pada kartu stok — kalau tidak,
  // saldo berjalan di kartu ini tidak akan cocok dengan angka di inventory.
  let inWhere = "sii.sapropdi_id = ? AND COALESCE(si.status, '') <> 'Draft'";
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

  // Approved stock counts. They are the third term of v_saprodi_stock, so a card
  // without them runs to a different balance than the inventory shows — exactly
  // the "remaining ≠ in − out" a reader cannot explain. Dated the day the PM
  // approved, because that is when the figure moved; the count date is in the note.
  const opArgs: any[] = [sapropdiId];
  let opWhere = 'oi.sapropdi_id = ? AND o.applied_at IS NOT NULL AND oi.adjustment <> 0';
  if (warehouseId) { opWhere += ' AND o.warehouse_id = ?'; opArgs.push(warehouseId); }
  if (scope != null) { opWhere += ` AND ${warehouseEntityPredicate('o.warehouse_id')}`; opArgs.push(scope); }
  const [ops] = await pool.query(
    `SELECT DATE_FORMAT(o.applied_at, '%Y-%m-%d') AS date, 'Opname' AS type, o.opname_number AS ref,
            GREATEST(oi.adjustment, 0) AS qty_in, GREATEST(-oi.adjustment, 0) AS qty_out, o.warehouse_id,
            w.warehouse_name, ent.entities_name AS entity_name, o.id AS opname_id,
            CONCAT('Hitung fisik ', DATE_FORMAT(o.opname_date, '%Y-%m-%d'), ': ',
                   TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM oi.counted_qty)),
                   ' — disetujui ', COALESCE(ur.name, ua.name, 'PM')) AS note
     FROM stock_opname_items oi
     JOIN stock_opname o    ON o.id = oi.stock_opname_id
     LEFT JOIN users ur     ON ur.id = o.reviewed_by_user_id
     LEFT JOIN users ua     ON ua.id = o.applied_by_user_id
     LEFT JOIN warehouse w  ON w.id = o.warehouse_id
     LEFT JOIN kth wk       ON wk.id = w.kth_id
     LEFT JOIN entities ent ON ent.id = wk.entities_id
     WHERE ${opWhere}`, opArgs);

  // Same day: receipts and issues first, the count's correction last — it was
  // computed against the balance those had already produced.
  const order: Record<string, number> = { 'Stock In': 0, Distribution: 1, Opname: 2 };
  const rows = [...(ins as any[]), ...(outs as any[]), ...(ops as any[])]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || order[a.type] - order[b.type]);
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
            -- The item's own category and unit, rather than the placeholders the
            -- screen used to invent: every row read "3_Material" with no unit.
            s.category, COALESCE(un.unit_name, s.unit) AS unit_name,
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
     LEFT JOIN units un ON un.id = s.unit_id
     LEFT JOIN v_saprodi_stock st ON st.warehouse_id = r.warehouse_id AND st.sapropdi_id = r.sapropdi_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY status DESC, w.warehouse_name`, args);
  return res.json({ data: rows });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

export default router;
