import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { compressImages } from '../services/imageProcessor';

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
         COALESCE(pl.scheme, 'BeliPutus') AS scheme
  FROM purchasing p
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
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY p.date DESC, p.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: (rows as any[]).map(shape) });
});

// GET /api/purchasing/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Purchasing not found' });
  return res.json({ data: shape(list[0]) });
});

// POST /api/purchasing
router.post('/', authenticate, files, async (req: Request, res: Response) => {
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
    const [result] = await pool.query(
      `INSERT INTO purchasing (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [(result as any).insertId]);
    return res.status(201).json({ message: 'Purchasing created', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/purchasing/:id
const update = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id, plot_id FROM purchasing WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Purchasing not found' });
    const b = req.body || {};
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
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE purchasing SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Purchasing updated', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
router.put('/:id', authenticate, files, update);
router.post('/:id', authenticate, files, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/purchasing/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM purchasing WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Purchasing not found' });
  return res.json({ message: 'Purchasing deleted' });
});

export default router;
