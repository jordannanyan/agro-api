import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { crudRouter } from '../utils/crudFactory';
import { entityScope } from '../utils/entityScope';
import { ENTITY_COL, sellingScope } from '../utils/farmScope';
import { respondList } from '../utils/pagination';

export const router = Router();

// Freight, sorting, loading — costs of getting one sale out of the door. They are
// shared across the batch's depositors per kg when a profit share is worked out,
// so they must hang off the sale rather than off a plot.
//
// Mounted before `/:id` so `/costs` is not read as a selling id.
router.use('/costs', crudRouter({
  table: 'selling_costs',
  columns: ['selling_id', 'pre_finance_type_id', 'description', 'amount'],
  required: ['selling_id'],
  numeric: ['selling_id', 'pre_finance_type_id', 'amount'],
  filterColumns: ['selling_id', 'pre_finance_type_id'],
  orderBy: 'id ASC',
  label: 'Selling cost',
}));

// scheme derived through processing → purchasing → plot (best-effort: majority scheme of contributions).
const SELECT = `
  SELECT s.*,
         pr.processing_code AS processing__processing_code, pr.commodities_id AS processing__commodities_id,
         o.offtaker_name AS offtaker__offtaker_name,
         w.warehouse_name AS warehouse__warehouse_name,
         c.commodities_name AS commodity__commodities_name,
         (SELECT COALESCE(SUM(sc.amount), 0) FROM selling_costs sc WHERE sc.selling_id = s.id) AS total_cost,
         -- The invoice's grade lines in one string ("A 1703 · B 663 …") for the list.
         (SELECT GROUP_CONCAT(CONCAT(COALESCE(g.grade_name, si.description, '—'), ' ', TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity)))
                 ORDER BY si.sort_order, si.id SEPARATOR ' · ')
            FROM selling_items si LEFT JOIN grade g ON g.id = si.grade_id
           WHERE si.selling_id = s.id AND si.line_type = 'product') AS grade_summary,
         (SELECT COALESCE(SUM(si.amount), 0) FROM selling_items si WHERE si.selling_id = s.id AND si.line_type = 'fee') AS fee_total
  FROM selling s
  LEFT JOIN processing pr  ON pr.id = s.processing_id
  LEFT JOIN offtaker o     ON o.id = s.offtaker_id
  LEFT JOIN warehouse w    ON w.id = s.warehouse_id
  LEFT JOIN commodities c  ON c.id = pr.commodities_id
`;

const str = (v: any, max: number) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

function shape(row: any) {
  const out: any = {};
  const rel: Record<string, any> = { processing: {}, offtaker: {}, warehouse: {}, commodity: {} };
  for (const k of Object.keys(row)) {
    const m = k.match(/^(processing|offtaker|warehouse|commodity)__(.+)$/);
    if (m) rel[m[1]][m[2]] = row[k];
    else out[k] = row[k];
  }
  out.processing = row.processing_id ? { id: row.processing_id, ...rel.processing } : null;
  out.offtaker = row.offtaker_id ? { id: row.offtaker_id, ...rel.offtaker } : null;
  out.warehouse = row.warehouse_id ? { id: row.warehouse_id, ...rel.warehouse } : null;
  out.commodity = rel.processing.commodities_id ? { id: rel.processing.commodities_id, ...rel.commodity } : null;
  return out;
}

// GET /api/selling?processing_id=&offtaker_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.processing_id) { where.push('s.processing_id = ?'); args.push(req.query.processing_id); }
  if (req.query.offtaker_id)   { where.push('s.offtaker_id = ?'); args.push(req.query.offtaker_id); }
  // Same entity rule as purchasing — see utils/farmScope for how a sale reaches its PT.
  const scope = entityScope(req);
  if (scope != null) { where.push(`${ENTITY_COL} = ?`); args.push(scope); }
  const sql = SELECT + sellingScope('s')
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY s.date DESC, s.id DESC';
  return respondList(req, res, sql, args, shape);
});

// ── Invoice lines ────────────────────────────────────────────────────────────
// A sale is entered the way its invoice reads: one line per grade of the fruit
// (kilos × Rp/kg) and fee lines charged on top (Cleaning and Packing Rp 250/kg).
// The grade lines' kilos ARE the accepted volume, and the grand total is the
// sale's revenue (selling.invoice_total → total_revenue). price_per_unit keeps
// the blended price of the fruit, for the list.

type Db = { query: (sql: string, args?: any[]) => Promise<any> };
interface ItemIn { line_type: 'product' | 'fee'; grade_id: number | null; description: string | null; quantity: number; price_per_unit: number }

class ItemError extends Error {}

function parseItems(v: any): ItemIn[] | undefined {
  if (v === undefined) return undefined;
  let list = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { throw new ItemError('items tidak bisa dibaca'); } }
  if (!Array.isArray(list)) throw new ItemError('items harus berupa daftar');
  return list.map((x: any, i: number): ItemIn => {
    const type = x?.line_type === 'fee' ? 'fee' : 'product';
    const qty = Number(x?.quantity); const price = Number(x?.price_per_unit);
    if (!isFinite(qty) || qty < 0 || !isFinite(price) || price < 0) throw new ItemError(`Baris ${i + 1}: kuantitas/harga tidak valid`);
    const grade = x?.grade_id != null && x.grade_id !== '' ? Number(x.grade_id) : null;
    const desc = x?.description != null && String(x.description).trim() !== '' ? String(x.description).trim().slice(0, 255) : null;
    if (type === 'fee' && !desc) throw new ItemError(`Baris biaya ${i + 1}: isi keterangannya (mis. Cleaning and Packing)`);
    return { line_type: type, grade_id: type === 'fee' ? null : grade, description: desc, quantity: qty, price_per_unit: price };
  }).filter((x: ItemIn) => x.quantity > 0 || x.price_per_unit > 0);
}

const money = (n: number) => Math.round(n * 100) / 100;

/** Replace a sale's invoice lines and bring the sale's volume, price and total in line with them. */
async function writeItems(db: Db, sellingId: number, items: ItemIn[], setDelivered: boolean) {
  await db.query('DELETE FROM selling_items WHERE selling_id = ?', [sellingId]);
  if (!items.length) {
    await db.query('UPDATE selling SET invoice_total = NULL WHERE id = ?', [sellingId]);
    return;
  }
  const now = new Date();
  let i = 0;
  for (const it of items) {
    await db.query(`INSERT INTO selling_items (selling_id, line_type, grade_id, description, quantity, price_per_unit, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [sellingId, it.line_type, it.grade_id, it.description, it.quantity, it.price_per_unit, i++, now, now]);
  }
  const products = items.filter((x) => x.line_type === 'product');
  const kg = products.reduce((s, x) => s + x.quantity, 0);
  const goods = products.reduce((s, x) => s + money(x.quantity * x.price_per_unit), 0);
  const all = items.reduce((s, x) => s + money(x.quantity * x.price_per_unit), 0);
  // A new sale with no kilos sent typed has sent what it invoiced; otherwise the
  // kilos sent stay as they are, never below the kilos invoiced.
  await db.query(`UPDATE selling SET accepted_volume = ?, price_per_unit = ?, invoice_total = ?,
      delivered_volume = ${setDelivered ? '?' : 'GREATEST(delivered_volume, ?)'} WHERE id = ?`,
    [kg, kg > 0 ? money(goods / kg) : 0, money(all), kg, sellingId]);
}

async function loadItems(db: Db, sellingId: number) {
  const [rows] = await db.query(`SELECT si.id, si.line_type, si.grade_id, g.grade_name, si.description,
      si.quantity, si.price_per_unit, si.amount
    FROM selling_items si LEFT JOIN grade g ON g.id = si.grade_id
    WHERE si.selling_id = ? ORDER BY si.sort_order, si.id`, [sellingId]);
  return rows;
}

// GET /api/selling/grade-source?processing_id=&offtaker_id=
// What the batch was bought as, grade by grade (from its purchases), and the
// price each grade last sold for — to that buyer if there is one, else to anyone
// — so the invoice lines start from the grades the farmers delivered.
router.get('/grade-source', authenticate, async (req: Request, res: Response) => {
  try {
    const procId = Number(req.query.processing_id);
    if (!procId) return res.status(422).json({ message: 'processing_id is required' });
    const [bought] = await pool.query(
      `SELECT pu.grade_id, g.grade_name, SUM(pp.volume_contributed) AS kg
       FROM processing_purchasings pp
       JOIN purchasing pu ON pu.id = pp.purchasing_id
       LEFT JOIN grade g ON g.id = pu.grade_id
       WHERE pp.processing_id = ?
       GROUP BY pu.grade_id, g.grade_name ORDER BY pu.grade_id IS NULL, pu.grade_id`, [procId]);
    const [procRows] = await pool.query('SELECT commodities_id, volume_output FROM processing WHERE id = ?', [procId]);
    const proc = (procRows as any[])[0];
    const commodity = proc?.commodities_id ?? 0;
    const offId = req.query.offtaker_id ? Number(req.query.offtaker_id) : null;
    const [last] = await pool.query(
      `SELECT x.grade_id, x.price_per_unit, x.date, x.same_buyer FROM (
         SELECT si.grade_id, si.price_per_unit, s.date, (s.offtaker_id <=> ?) AS same_buyer,
                ROW_NUMBER() OVER (PARTITION BY si.grade_id ORDER BY (s.offtaker_id <=> ?) DESC, s.date DESC, si.id DESC) AS rn
         FROM selling_items si
         JOIN selling s ON s.id = si.selling_id
         JOIN processing pr ON pr.id = s.processing_id
         WHERE si.line_type = 'product' AND si.grade_id IS NOT NULL AND pr.commodities_id = ?
       ) x WHERE x.rn = 1`, [offId, offId, commodity]);
    const [fees] = await pool.query(
      `SELECT si.description, si.price_per_unit, s.date FROM selling_items si
       JOIN selling s ON s.id = si.selling_id JOIN processing pr ON pr.id = s.processing_id
       WHERE si.line_type = 'fee' AND pr.commodities_id = ?
       ORDER BY s.date DESC, si.id DESC LIMIT 20`, [commodity]);
    const seen = new Set<string>();
    const lastFees = (fees as any[]).filter((f) => {
      const k = String(f.description).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    return res.json({ data: { bought, last_prices: last, last_fees: lastFees, volume_output: proc?.volume_output ?? null } });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/selling/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const scope = entityScope(req);
  const sql = SELECT + sellingScope('s')
    + ` WHERE s.id = ?${scope != null ? ` AND ${ENTITY_COL} = ?` : ''} LIMIT 1`;
  const [rows] = await pool.query(sql, scope != null ? [req.params.id, scope] : [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Selling not found' });
  const data = shape(list[0]);
  data.items = await loadItems(pool, Number(req.params.id));
  return res.json({ data });
});

// POST /api/selling
router.post('/', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.processing_id || !b.date) return res.status(422).json({ message: 'processing_id and date are required' });
    const items = parseItems(b.items);
    const cols: any = {
      processing_id: Number(b.processing_id),
      offtaker_id: b.offtaker_id != null && b.offtaker_id !== '' ? Number(b.offtaker_id) : null,
      warehouse_id: b.warehouse_id != null && b.warehouse_id !== '' ? Number(b.warehouse_id) : null,
      invoice_number: str(b.invoice_number, 100),
      do_number: str(b.do_number, 100),
      vehicle_number: str(b.vehicle_number, 30),
      date: b.date,
      delivered_volume: b.delivered_volume != null ? Number(b.delivered_volume) : 0,
      accepted_volume: b.accepted_volume != null ? Number(b.accepted_volume) : 0,
      price_per_unit: b.price_per_unit != null ? Number(b.price_per_unit) : 0,
      // NULL = fall back to the selling PT's default share.
      profit_share_farmer_pct: b.profit_share_farmer_pct != null && b.profit_share_farmer_pct !== ''
        ? Number(b.profit_share_farmer_pct) : null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    // The sale and its invoice lines are one document: both are written, or neither.
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO selling (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const id = (result as any).insertId;
    if (items?.length) await writeItems(conn, id, items, !(Number(b.delivered_volume) > 0));
    await conn.commit();
    const [rows] = await pool.query(SELECT + ' WHERE s.id = ? LIMIT 1', [id]);
    const data = shape((rows as any[])[0]);
    data.items = await loadItems(pool, id);
    return res.status(201).json({ message: 'Selling created', data });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    if (err instanceof ItemError) return res.status(422).json({ message: err.message });
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/selling/:id
const update = async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id FROM selling WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Selling not found' });
    const b = req.body || {};
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('processing_id', b.processing_id != null ? Number(b.processing_id) : undefined);
    set('offtaker_id', b.offtaker_id !== undefined ? (b.offtaker_id === '' || b.offtaker_id === null ? null : Number(b.offtaker_id)) : undefined);
    set('warehouse_id', b.warehouse_id !== undefined ? (b.warehouse_id === '' || b.warehouse_id === null ? null : Number(b.warehouse_id)) : undefined);
    set('date', b.date);
    for (const [k, n] of [['invoice_number', 100], ['do_number', 100], ['vehicle_number', 30]] as const) {
      if (b[k] !== undefined) updates[k] = str(b[k], n);
    }
    const items = parseItems(b.items);
    set('delivered_volume', b.delivered_volume != null ? Number(b.delivered_volume) : undefined);
    set('accepted_volume', b.accepted_volume != null ? Number(b.accepted_volume) : undefined);
    set('price_per_unit', b.price_per_unit != null ? Number(b.price_per_unit) : undefined);
    set('profit_share_farmer_pct', b.profit_share_farmer_pct !== undefined
      ? (b.profit_share_farmer_pct === '' || b.profit_share_farmer_pct === null
          ? null : Number(b.profit_share_farmer_pct))
      : undefined);
    // With invoice lines the volume and price come from the lines, not the form.
    if (items?.length) { delete updates.accepted_volume; delete updates.price_per_unit; }
    const keys = Object.keys(updates);
    await conn.beginTransaction();
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await conn.query(`UPDATE selling SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    if (items !== undefined) await writeItems(conn, Number(id), items, false);
    await conn.commit();
    const [rows] = await pool.query(SELECT + ' WHERE s.id = ? LIMIT 1', [id]);
    const data = shape((rows as any[])[0]);
    data.items = await loadItems(pool, Number(id));
    return res.json({ message: 'Selling updated', data });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    if (err instanceof ItemError) return res.status(422).json({ message: err.message });
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};
router.put('/:id', authenticate, update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/selling/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM selling WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Selling not found' });
  return res.json({ message: 'Selling deleted' });
});

export default router;
