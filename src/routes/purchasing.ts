import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { compressImages } from '../services/imageProcessor';
import { entityScope } from '../utils/entityScope';
import { ENTITY_COL, purchasingScope } from '../utils/farmScope';
import { respondList } from '../utils/pagination';
import {
  RepaymentError, parseRepaymentBody, syncPurchasingRepayment, loadPurchasingRepayment, RepaymentResult,
} from '../utils/repayment';

export const router = Router();

const PAYMENT_STATUSES = ['paid', 'unpaid'] as const;
const SUPPLIER_TYPES = ['farmer', 'collector'] as const;

const files = upload.fields([
  { name: 'invoice_file',  maxCount: 1 },
  { name: 'payment_proof', maxCount: 1 },
]);

// scheme is DERIVED from plot.scheme; collector purchases default to BeliPutus.
const SELECT = `
  SELECT p.*,
         pl.plot_name AS plot__plot_name, pl.scheme AS plot__scheme, pl.farmer_id AS plot__farmer_id,
         f.farmer_name AS farmer__farmer_name,
         col.collector_name AS collector__collector_name,
         c.commodities_name AS commodity__commodities_name,
         g.grade_name AS grade__grade_name,
         w.warehouse_name AS warehouse__warehouse_name,
         COALESCE(pl.scheme, 'BeliPutus') AS scheme,
         -- The loan repayment deducted from this delivery (pre-finance only), and
         -- so what actually reached the farmer.
         COALESCE(ri.total_payment, 0) AS repayment_total,
         ri.id AS installment_id,
         COALESCE(ri.is_manual, 0) AS repayment_manual, ri.manual_reason AS repayment_reason,
         p.total_value - COALESCE(ri.total_payment, 0) AS net_payment
  FROM purchasing p
  LEFT JOIN pre_finance_installments ri ON ri.purchasing_id = p.id
  LEFT JOIN plot pl        ON pl.id = p.plot_id
  LEFT JOIN farmers f      ON f.id = pl.farmer_id
  LEFT JOIN collectors col ON col.id = p.collector_id
  LEFT JOIN commodities c  ON c.id = p.commodities_id
  LEFT JOIN grade g        ON g.id = p.grade_id
  LEFT JOIN warehouse w    ON w.id = p.warehouse_id
`;

function shape(row: any) {
  const out: any = {};
  const rel: Record<string, any> = { plot: {}, farmer: {}, collector: {}, commodity: {}, grade: {}, warehouse: {} };
  for (const k of Object.keys(row)) {
    const m = k.match(/^(plot|farmer|collector|commodity|grade|warehouse)__(.+)$/);
    if (m) rel[m[1]][m[2]] = row[k];
    else out[k] = row[k];
  }
  out.plot = row.plot_id ? { id: row.plot_id, ...rel.plot } : null;
  out.farmer = rel.plot.farmer_id ? { id: rel.plot.farmer_id, ...rel.farmer } : null;
  out.collector = row.collector_id ? { id: row.collector_id, ...rel.collector } : null;
  out.commodity = row.commodities_id ? { id: row.commodities_id, ...rel.commodity } : null;
  out.grade = row.grade_id ? { id: row.grade_id, ...rel.grade } : null;
  out.warehouse = row.warehouse_id ? { id: row.warehouse_id, ...rel.warehouse } : null;
  return out;
}

// Resolve the effective scheme for a plot (or BeliPutus when no plot).
async function schemeForPlot(plotId?: number | null): Promise<string> {
  if (!plotId) return 'BeliPutus';
  const [r] = await pool.query('SELECT scheme FROM plot WHERE id = ? LIMIT 1', [plotId]);
  return (r as any[])[0]?.scheme ?? 'BeliPutus';
}

// GET /api/purchasing?scheme=&commodities_id=&supplier_type=&entity_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.commodities_id) { where.push('p.commodities_id = ?'); args.push(req.query.commodities_id); }
  if (req.query.supplier_type)  { where.push('p.supplier_type = ?'); args.push(req.query.supplier_type); }
  if (req.query.payment_status) { where.push('p.payment_status = ?'); args.push(req.query.payment_status); }
  if (req.query.scheme)         { where.push("COALESCE(pl.scheme,'BeliPutus') = ?"); args.push(req.query.scheme); }
  // Staff bound to one PT see only that PT's purchases — the same rule the
  // dashboard counts by, so the KPI and this table cannot disagree.
  const scope = entityScope(req);
  if (scope != null) { where.push(`${ENTITY_COL} = ?`); args.push(scope); }
  if (req.query.search) {
    // Paging and a client-side filter cannot coexist: filtering one page would hide
    // matches on every other. The search moves to the query instead.
    where.push('(p.receipt_invoice LIKE ? OR pl.plot_name LIKE ? OR f.farmer_name LIKE ? OR col.collector_name LIKE ?)');
    const q = `%${req.query.search}%`;
    args.push(q, q, q, q);
  }
  const sql = SELECT + purchasingScope('p')
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY p.date DESC, p.id DESC';
  return respondList(req, res, sql, args, shape,
    'COALESCE(SUM(quantity),0) AS quantity, COALESCE(SUM(total_value),0) AS total_value, '
    + 'COALESCE(SUM(repayment_total),0) AS repayment_total');
});

// GET /api/purchasing/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  // Scoped here too: filtering only the list leaves the record one guessed id away.
  const scope = entityScope(req);
  const sql = SELECT + purchasingScope('p')
    + ` WHERE p.id = ?${scope != null ? ` AND ${ENTITY_COL} = ?` : ''} LIMIT 1`;
  const [rows] = await pool.query(sql, scope != null ? [req.params.id, scope] : [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Purchasing not found' });
  const data = shape(list[0]);
  data.repayment = await loadPurchasingRepayment(pool, Number(req.params.id));
  return res.json({ data });
});

/** A short note for the caller when the deduction is not what the rate alone says. */
function repaymentNote(r: RepaymentResult | null): string | undefined {
  if (!r) return undefined;
  if (r.no_rate) return 'Plot Pre-Finance ini belum punya tarif potongan — tidak ada cicilan yang dipotong.';
  if (r.capped) return 'Potongan dibatasi sisa utang petani.';
  return undefined;
}

// POST /api/purchasing
router.post('/', authenticate, files, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const f = req.files as Record<string, Express.Multer.File[]> | undefined;

    if (!b.commodities_id || !b.date) return res.status(422).json({ message: 'commodities_id and date are required' });
    const supplierType = b.supplier_type || 'farmer';
    if (!SUPPLIER_TYPES.includes(supplierType)) return res.status(422).json({ message: 'Invalid supplier_type' });
    if (supplierType === 'farmer' && !b.plot_id) return res.status(422).json({ message: 'plot_id is required for farmer purchases' });
    if (supplierType === 'collector' && !b.collector_id) return res.status(422).json({ message: 'collector_id is required for collector purchases' });
    if (b.payment_status && !PAYMENT_STATUSES.includes(b.payment_status)) return res.status(422).json({ message: 'Invalid payment_status' });

    const plotId = b.plot_id != null && b.plot_id !== '' ? Number(b.plot_id) : null;
    const scheme = await schemeForPlot(plotId);
    // ProfitSharing: raw material is not bought outright → price is always 0.
    const price = scheme === 'ProfitSharing'
      ? 0
      : (b.price_per_unit != null ? Number(b.price_per_unit) : 0);

    const repaymentMode = parseRepaymentBody(b.repayment);

    await compressImages([f?.invoice_file?.[0]?.path, f?.payment_proof?.[0]?.path]);

    const cols: any = {
      plot_id: plotId,
      collector_id: b.collector_id != null && b.collector_id !== '' ? Number(b.collector_id) : null,
      supplier_type: supplierType,
      commodities_id: Number(b.commodities_id),
      grade_id: b.grade_id != null && b.grade_id !== '' ? Number(b.grade_id) : null,
      warehouse_id: b.warehouse_id != null && b.warehouse_id !== '' ? Number(b.warehouse_id) : null,
      receipt_invoice: b.receipt_invoice ?? null,
      date: b.date,
      quantity: b.quantity != null ? Number(b.quantity) : 0,
      price_per_unit: price,
      payment_status: b.payment_status ?? 'unpaid',
      is_process: b.is_process ? 1 : 0,
      invoice_file: fileToPath(f?.invoice_file?.[0]),
      payment_proof: fileToPath(f?.payment_proof?.[0]),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    // The delivery and the loan repayment deducted from it are one event: both
    // are written, or neither is.
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO purchasing (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const newId = (result as any).insertId;
    const rep = await syncPurchasingRepayment(conn, newId, repaymentMode, b.repayment_reason);
    await conn.commit();
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [newId]);
    const data = shape((rows as any[])[0]);
    data.repayment = await loadPurchasingRepayment(pool, newId);
    return res.status(201).json({ message: 'Purchasing created', data, repayment_note: repaymentNote(rep) });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    if (err instanceof RepaymentError) return res.status(err.status).json({ message: err.message });
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/purchasing/:id
const update = async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = req.params.id;
    const [ex] = await pool.query(
      'SELECT id, plot_id, grade_id, date, quantity, supplier_type FROM purchasing WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Purchasing not found' });
    const before = (ex as any[])[0];
    const b = req.body || {};
    // Sent explicitly -> exactly that. Not sent -> recomputed from the rate, but only
    // when something the rate depends on changed, so an edit to the invoice number
    // does not overwrite a deduction someone adjusted by hand.
    const explicitRepayment = b.repayment !== undefined && b.repayment !== '';
    const repaymentMode = parseRepaymentBody(b.repayment);
    const f = req.files as Record<string, Express.Multer.File[]> | undefined;
    if (b.payment_status && !PAYMENT_STATUSES.includes(b.payment_status)) return res.status(422).json({ message: 'Invalid payment_status' });

    await compressImages([f?.invoice_file?.[0]?.path, f?.payment_proof?.[0]?.path]);

    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    // Determine the effective plot (new value if provided, else existing) to derive scheme.
    let effectivePlotId: number | null | undefined;
    if (b.plot_id !== undefined) {
      effectivePlotId = b.plot_id === '' || b.plot_id === null ? null : Number(b.plot_id);
      updates.plot_id = effectivePlotId;
    } else {
      effectivePlotId = (ex as any[])[0].plot_id ?? null;
    }
    const effectiveScheme = await schemeForPlot(effectivePlotId);
    set('collector_id', b.collector_id !== undefined ? (b.collector_id === '' || b.collector_id === null ? null : Number(b.collector_id)) : undefined);
    set('supplier_type', b.supplier_type);
    set('commodities_id', b.commodities_id != null ? Number(b.commodities_id) : undefined);
    set('grade_id', b.grade_id !== undefined ? (b.grade_id === '' || b.grade_id === null ? null : Number(b.grade_id)) : undefined);
    set('warehouse_id', b.warehouse_id !== undefined ? (b.warehouse_id === '' || b.warehouse_id === null ? null : Number(b.warehouse_id)) : undefined);
    set('receipt_invoice', b.receipt_invoice);
    set('date', b.date);
    set('quantity', b.quantity != null ? Number(b.quantity) : undefined);
    // ProfitSharing always 0; otherwise use provided price.
    if (effectiveScheme === 'ProfitSharing') updates.price_per_unit = 0;
    else set('price_per_unit', b.price_per_unit != null ? Number(b.price_per_unit) : undefined);
    set('payment_status', b.payment_status);
    if (b.is_process !== undefined) updates.is_process = b.is_process ? 1 : 0;
    if (f?.invoice_file?.[0]) updates.invoice_file = fileToPath(f.invoice_file[0]);
    if (f?.payment_proof?.[0]) updates.payment_proof = fileToPath(f.payment_proof[0]);

    const keys = Object.keys(updates);
    const changed = (k: string, cur: any, norm: (v: any) => any = (v) => v) =>
      k in updates && norm(updates[k]) !== norm(cur);
    const drivesRate =
      changed('plot_id', before.plot_id, (v) => (v == null ? null : Number(v)))
      || changed('grade_id', before.grade_id, (v) => (v == null ? null : Number(v)))
      || changed('quantity', before.quantity, (v) => Number(v))
      || changed('date', before.date, (v) => String(v).slice(0, 10))
      || changed('supplier_type', before.supplier_type);

    await conn.beginTransaction();
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await conn.query(`UPDATE purchasing SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    let rep: RepaymentResult | null = null;
    if (explicitRepayment || drivesRate) {
      rep = await syncPurchasingRepayment(conn, Number(id), repaymentMode, b.repayment_reason);
    } else if ('receipt_invoice' in updates) {
      // The deduction's reference is the delivery's receipt; keep them in step.
      await conn.query(
        'UPDATE pre_finance_installments SET reference_no = ?, updated_at = NOW() WHERE purchasing_id = ?',
        [updates.receipt_invoice || null, id]);
    }
    await conn.commit();
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [id]);
    const data = shape((rows as any[])[0]);
    data.repayment = await loadPurchasingRepayment(pool, Number(id));
    return res.json({ message: 'Purchasing updated', data, repayment_note: repaymentNote(rep) });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    if (err instanceof RepaymentError) return res.status(err.status).json({ message: err.message });
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};
router.put('/:id', authenticate, files, update);
router.post('/:id', authenticate, files, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/purchasing/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  // The loan repayment deducted from this delivery goes with it (FK CASCADE): a
  // delivery that never happened deducted nothing, so the debt comes back.
  const [result] = await pool.query('DELETE FROM purchasing WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Purchasing not found' });
  return res.json({ message: 'Purchasing deleted' });
});

export default router;
