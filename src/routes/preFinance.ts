import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { ROLE } from '../utils/roles';
import { upload, fileToPath } from '../middleware/upload';
import { compressImages } from '../services/imageProcessor';
import { entityScope } from '../utils/entityScope';
import { distributionEntityPredicate, farmerEntityPredicate } from '../utils/farmScope';
import { respondList } from '../utils/pagination';
import { outstandingByType, suggestRepayment } from '../utils/repayment';

// -----------------------------------------------------------------------------
// Distributions  /api/pre-finance/distributions
// -----------------------------------------------------------------------------
export const distributionsRouter = Router();

// `scheme` is derived from the plot, never stored here — same rule as purchasing.
// A distribution with no plot cannot be attributed to a scheme, so it reads as
// BeliPutus, which is the scheme that carries no farmer obligation.
const DIST_SELECT = `
  SELECT d.*, t.type_name, f.farmer_name, p.plot_name, s.sapropdi_name, u.unit_name,
         w.warehouse_name,
         COALESCE(fk.entities_id, wk.entities_id) AS entity_id,
         COALESCE(fe.entities_name, we.entities_name) AS entity_name,
         COALESCE(p.scheme, 'BeliPutus') AS scheme
  FROM pre_finance_distributions d
  LEFT JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
  LEFT JOIN farmers f           ON f.id = d.farmer_id
  LEFT JOIN kth fk              ON fk.id = f.kth_id
  LEFT JOIN entities fe         ON fe.id = fk.entities_id
  LEFT JOIN plot p              ON p.id = d.plot_id
  LEFT JOIN sapropdi s          ON s.id = d.sapropdi_id
  LEFT JOIN units u             ON u.id = d.unit_id
  LEFT JOIN warehouse w         ON w.id = d.warehouse_id
  LEFT JOIN kth wk              ON wk.id = w.kth_id
  LEFT JOIN entities we         ON we.id = wk.entities_id
`;

const distFiles = upload.fields([
  { name: 'upload_proof',   maxCount: 1 },
  { name: 'delivery_proof', maxCount: 1 },
]);

distributionsRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.farmer_id)           { where.push('d.farmer_id = ?'); args.push(req.query.farmer_id); }
  if (req.query.pre_finance_type_id) { where.push('d.pre_finance_type_id = ?'); args.push(req.query.pre_finance_type_id); }
  if (req.query.warehouse_id)        { where.push('d.warehouse_id = ?'); args.push(req.query.warehouse_id); }
  if (req.query.plot_id)             { where.push('d.plot_id = ?'); args.push(req.query.plot_id); }
  if (req.query.scheme)              { where.push("COALESCE(p.scheme, 'BeliPutus') = ?"); args.push(req.query.scheme); }
  // "Riwayat Barang Keluar" is farmer debt and a warehouse movement at once, so it
  // follows the same PT rule as both: the farmer's PT, or the issuing warehouse's
  // when no farmer is named.
  const scope = entityScope(req);
  if (scope != null) { where.push(distributionEntityPredicate('d')); args.push(scope); }
  // The screen searches by farmer; with paging that has to happen in the query.
  if (req.query.search) {
    where.push('(f.farmer_name LIKE ? OR s.sapropdi_name LIKE ? OR p.plot_name LIKE ?)');
    const q = `%${req.query.search}%`;
    args.push(q, q, q);
  }
  const sql = DIST_SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY d.date DESC, d.id DESC';
  return respondList(req, res, sql, args, undefined,
    'COALESCE(SUM(total_amount),0) AS total_amount');
});

distributionsRouter.get('/:id', authenticate, async (req, res) => {
  const scope = entityScope(req);
  const sql = DIST_SELECT + ` WHERE d.id = ?${scope != null ? ` AND ${distributionEntityPredicate('d')}` : ''} LIMIT 1`;
  const [rows] = await pool.query(sql, scope != null ? [req.params.id, scope] : [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Distribution not found' });
  return res.json({ data: list[0] });
});

distributionsRouter.post('/', authenticate, distFiles, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const f = req.files as Record<string, Express.Multer.File[]> | undefined;
    if (!b.pre_finance_type_id || !b.farmer_id || !b.date) {
      return res.status(422).json({ message: 'pre_finance_type_id, farmer_id, date are required' });
    }

    // A saprodi distribution is a stock-out event, so it has to say which warehouse
    // it left. Without that the quantity cannot be subtracted from anything and the
    // stock report silently reads high — the exact drift this column was added to end.
    const warehouseId = b.warehouse_id != null && b.warehouse_id !== '' ? Number(b.warehouse_id) : null;
    const [typeRow] = await pool.query(
      'SELECT type_name FROM pre_finance_types WHERE id = ? LIMIT 1', [Number(b.pre_finance_type_id)]);
    const isSaprodi = (typeRow as any[])[0]?.type_name === 'Saprodi';
    if (isSaprodi && !warehouseId) {
      return res.status(422).json({ message: 'warehouse_id is required for a Saprodi distribution — it is a stock-out.' });
    }

    await compressImages([f?.upload_proof?.[0]?.path, f?.delivery_proof?.[0]?.path]);

    const qty = b.quantity != null && b.quantity !== '' ? Number(b.quantity) : null;
    const price = b.price_per_unit != null && b.price_per_unit !== '' ? Number(b.price_per_unit) : null;
    // Saprodi = qty × price; others = direct total_amount.
    const total = b.total_amount != null && b.total_amount !== ''
      ? Number(b.total_amount)
      : (qty != null && price != null ? qty * price : 0);

    const cols: any = {
      pre_finance_type_id: Number(b.pre_finance_type_id),
      date: b.date,
      farmer_id: Number(b.farmer_id),
      plot_id: b.plot_id != null && b.plot_id !== '' ? Number(b.plot_id) : null,
      commodities_id: b.commodities_id != null && b.commodities_id !== '' ? Number(b.commodities_id) : null,
      sapropdi_id: b.sapropdi_id != null && b.sapropdi_id !== '' ? Number(b.sapropdi_id) : null,
      warehouse_id: warehouseId,
      quantity: qty,
      unit_id: b.unit_id != null && b.unit_id !== '' ? Number(b.unit_id) : null,
      price_per_unit: price,
      total_amount: total,
      description: b.description ?? null,
      upload_proof: fileToPath(f?.upload_proof?.[0]),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [result] = await pool.query(
      `INSERT INTO pre_finance_distributions (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      keys.map((k) => cols[k])
    );
    const [rows] = await pool.query(DIST_SELECT + ' WHERE d.id = ? LIMIT 1', [(result as any).insertId]);
    return res.status(201).json({ message: 'Distribution created', data: (rows as any[])[0] });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/pre-finance/distributions/:id/ship  — confirm "barang dikirim" (replaces Stock Out).
distributionsRouter.post('/:id/ship', authenticate, upload.single('delivery_proof'), async (req: Request, res: Response) => {
  const proof = fileToPath(req.file);
  await compressImages([req.file?.path]);
  await pool.query(
    `UPDATE pre_finance_distributions
     SET shipped_at = NOW(), shipped_by_user_id = ?, delivery_proof = COALESCE(?, delivery_proof), updated_at = NOW()
     WHERE id = ?`,
    [req.user?.type === 'User' ? req.user.id : null, proof, req.params.id]
  );
  const [rows] = await pool.query(DIST_SELECT + ' WHERE d.id = ? LIMIT 1', [req.params.id]);
  if (!(rows as any[]).length) return res.status(404).json({ message: 'Distribution not found' });
  return res.json({ message: 'Distribution shipped', data: (rows as any[])[0] });
});

distributionsRouter.delete('/:id', authenticate, async (req, res) => {
 try {
  // A distribution line is a farmer's debt. Another PT's is not this caller's to
  // erase, so the delete is scoped exactly like the list it appears in.
  // MariaDB does not accept a table alias in a single-table DELETE, so the
  // predicate is qualified with the table name itself.
  const scope = entityScope(req);
  const sql = 'DELETE FROM pre_finance_distributions WHERE id = ?'
    + (scope != null ? ` AND ${distributionEntityPredicate('pre_finance_distributions')}` : '');
  const [result] = await pool.query(sql, scope != null ? [req.params.id, scope] : [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Distribution not found' });
  return res.json({ message: 'Distribution deleted' });
  // Without this the route had no error path at all: a failing query became an
  // unhandled rejection and the caller waited forever instead of seeing a 500.
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// -----------------------------------------------------------------------------
// Installments  /api/pre-finance/installments  (header + details breakdown)
// -----------------------------------------------------------------------------
export const installmentsRouter = Router();

// `purchasing_id` set = deducted from that delivery (booked through Purchasing);
// NULL = a cash repayment made outside any delivery.
const INST_SELECT = `
  SELECT i.*, f.farmer_name, pm.method_name,
         IF(i.purchasing_id IS NULL, 'cash', 'delivery') AS source,
         pu.receipt_invoice AS purchasing_invoice, pu.quantity AS purchasing_quantity,
         pl.plot_name AS purchasing_plot_name
  FROM pre_finance_installments i
  LEFT JOIN farmers f          ON f.id = i.farmer_id
  LEFT JOIN payment_methods pm ON pm.id = i.payment_method_id
  LEFT JOIN purchasing pu      ON pu.id = i.purchasing_id
  LEFT JOIN plot pl            ON pl.id = pu.plot_id
`;

async function loadDetails(id: number) {
  const [rows] = await pool.query(
    `SELECT det.*, t.type_name FROM pre_finance_installment_details det
     LEFT JOIN pre_finance_types t ON t.id = det.pre_finance_type_id
     WHERE det.installment_id = ? ORDER BY det.id`, [id]);
  return rows;
}

installmentsRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.farmer_id) { where.push('i.farmer_id = ?'); args.push(req.query.farmer_id); }
  if (req.query.source === 'delivery') where.push('i.purchasing_id IS NOT NULL');
  if (req.query.source === 'cash') where.push('i.purchasing_id IS NULL');
  if (req.query.search) {
    where.push('(f.farmer_name LIKE ? OR i.reference_no LIKE ? OR pu.receipt_invoice LIKE ?)');
    const q = `%${req.query.search}%`;
    args.push(q, q, q);
  }
  // A repayment belongs to the PT that farms the debt.
  const scope = entityScope(req);
  if (scope != null) { where.push(farmerEntityPredicate('i.farmer_id')); args.push(scope); }
  const sql = INST_SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY i.date DESC, i.id DESC';
  // Every delivery of a pre-finance farmer now carries one, so this list grows
  // with purchasing and pages the same way (opt-in, ?page / ?per_page).
  return respondList(req, res, sql, args, undefined, 'COALESCE(SUM(total_payment),0) AS total_payment');
});

installmentsRouter.get('/:id', authenticate, async (req, res) => {
  const scope = entityScope(req);
  const [rows] = await pool.query(
    INST_SELECT + ` WHERE i.id = ?${scope != null ? ` AND ${farmerEntityPredicate('i.farmer_id')}` : ''} LIMIT 1`,
    scope != null ? [req.params.id, scope] : [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Installment not found' });
  const data = list[0];
  data.details = await loadDetails(Number(req.params.id));
  return res.json({ data });
});

// body: {farmer_id, purchasing_id?, date, payment_method_id?, reference_no?, notes?, details:[{pre_finance_type_id, amount}]}
installmentsRouter.post('/', authenticate, upload.single('upload_proof'), async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.farmer_id || !b.date) return res.status(422).json({ message: 'farmer_id and date are required' });
    // A deduction from a delivery is booked with the delivery itself (Purchasing),
    // where its amount comes from the kilos and the rate. Booking one here as well
    // is how the same repayment ends up counted twice.
    if (b.purchasing_id != null && b.purchasing_id !== '') {
      return res.status(422).json({
        message: 'Potongan dari setoran dicatat lewat Purchasing, bukan di sini. Form ini hanya untuk pembayaran tunai di luar setoran.',
      });
    }
    let details = b.details;
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = []; } }
    details = (Array.isArray(details) ? details : []).filter((d: any) => d.pre_finance_type_id && Number(d.amount) > 0);
    if (!details.length) return res.status(422).json({ message: 'At least one repayment amount is required' });
    const total = details.reduce((s: number, d: any) => s + Number(d.amount || 0), 0);
    const proof = fileToPath(req.file);

    await conn.beginTransaction();
    // Same rule the delivery deduction follows: never pay back more than is owed.
    await conn.query('SELECT id FROM farmers WHERE id = ? FOR UPDATE', [Number(b.farmer_id)]);
    const owed = await outstandingByType(conn, Number(b.farmer_id), null);
    for (const d of details) {
      const o = owed.find((x) => x.pre_finance_type_id === Number(d.pre_finance_type_id));
      if (!o) { await conn.rollback(); return res.status(422).json({ message: `Unknown pre_finance_type_id ${d.pre_finance_type_id}` }); }
      if (Number(d.amount) > Math.max(0, Number(o.outstanding)) + 0.5) {
        await conn.rollback();
        return res.status(422).json({
          message: `Pembayaran ${o.type_name} melebihi outstanding Rp ${Math.max(0, Number(o.outstanding)).toLocaleString('id-ID')}`,
        });
      }
    }
    const [result] = await conn.query(
      `INSERT INTO pre_finance_installments (purchasing_id, farmer_id, date, payment_method_id, reference_no, upload_proof, total_payment, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [null,
       Number(b.farmer_id), b.date,
       b.payment_method_id != null && b.payment_method_id !== '' ? Number(b.payment_method_id) : null,
       b.reference_no || null, proof, total, b.notes || null]
    );
    const id = (result as any).insertId;
    for (const d of details) {
      await conn.query(
        'INSERT INTO pre_finance_installment_details (installment_id, pre_finance_type_id, amount) VALUES (?,?,?)',
        [id, Number(d.pre_finance_type_id), Number(d.amount || 0)]
      );
    }
    await conn.commit();
    const [rows] = await pool.query(INST_SELECT + ' WHERE i.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    data.details = await loadDetails(id);
    return res.status(201).json({ message: 'Installment created', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

installmentsRouter.delete('/:id', authenticate, async (req, res) => {
 try {
  const scope = entityScope(req);
  const [rows] = await pool.query(
    `SELECT id, purchasing_id FROM pre_finance_installments WHERE id = ?`
    + (scope != null ? ` AND ${farmerEntityPredicate('farmer_id')}` : '') + ' LIMIT 1',
    scope != null ? [req.params.id, scope] : [req.params.id]);
  const row = (rows as any[])[0];
  if (!row) return res.status(404).json({ message: 'Installment not found' });
  // A delivery's deduction is changed or removed on the delivery; deleting it here
  // would leave the delivery saying the farmer was paid less than they were.
  if (row.purchasing_id) {
    return res.status(422).json({ message: 'Potongan setoran diubah atau dihapus lewat Purchasing-nya.' });
  }
  await pool.query('DELETE FROM pre_finance_installments WHERE id = ?', [row.id]);
  return res.json({ message: 'Installment deleted' });
 } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// -----------------------------------------------------------------------------
// Payback rates  /api/pre-finance/payback-rates
// Rupiah per kilo deducted from a pre-finance delivery — the ledger's
// `AML - Purchase Price Database`.
// -----------------------------------------------------------------------------
export const paybackRatesRouter = Router();

// A rate decides how much is taken from every delivery a farmer makes, so it is
// set by the same roles that see the Pre-Finance screens — enforced here, not
// only by hiding the menu. Super Admin is the usual break-glass.
const RATE_WRITERS = [
  ROLE.PROCUREMENT, ROLE.PROJECT_MANAGER, ROLE.FINANCE_MANAGER, ROLE.DIRECTOR, ROLE.SUPER_ADMIN,
];

const RATE_SELECT = `
  SELECT r.*, pl.plot_name, pl.scheme, f.id AS farmer_id, f.farmer_name, g.grade_name,
         r.saprodi_per_kg + r.labor_per_kg AS total_per_kg,
         IF(r.full_price IS NULL, NULL, r.full_price - r.saprodi_per_kg - r.labor_per_kg) AS final_price
  FROM payback_rates r
  JOIN plot pl          ON pl.id = r.plot_id
  LEFT JOIN farmers f   ON f.id = pl.farmer_id
  LEFT JOIN grade g     ON g.id = r.grade_id
`;

// GET /preview?plot_id=&grade_id=&date=&quantity=&purchasing_id=
// What a delivery would deduct — the purchasing form shows this before saving.
// `purchasing_id` leaves that delivery's own current deduction out of the
// outstanding, so editing a delivery does not count its deduction against itself.
paybackRatesRouter.get('/preview', authenticate, async (req: Request, res: Response) => {
  try {
    const num = (v: any) => (v != null && v !== '' ? Number(v) : null);
    const s = await suggestRepayment(pool, {
      plotId: num(req.query.plot_id), gradeId: num(req.query.grade_id),
      date: String(req.query.date || '').slice(0, 10), quantity: Number(req.query.quantity || 0),
      excludePurchasingId: num(req.query.purchasing_id),
    });
    return res.json({ data: s });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

paybackRatesRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.plot_id) { where.push('r.plot_id = ?'); args.push(req.query.plot_id); }
  if (req.query.farmer_id) { where.push('pl.farmer_id = ?'); args.push(req.query.farmer_id); }
  if (req.query.search) {
    where.push('(pl.plot_name LIKE ? OR f.farmer_name LIKE ?)');
    const q = `%${req.query.search}%`;
    args.push(q, q);
  }
  const scope = entityScope(req);
  if (scope != null) { where.push(farmerEntityPredicate('pl.farmer_id')); args.push(scope); }
  const sql = RATE_SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY pl.plot_name, r.effective_date DESC, g.grade_name';
  return respondList(req, res, sql, args);
});

function rateCols(b: any) {
  const num = (v: any) => (v != null && v !== '' ? Number(v) : null);
  return {
    plot_id: num(b.plot_id),
    grade_id: num(b.grade_id),
    effective_date: b.effective_date ? String(b.effective_date).slice(0, 10) : null,
    full_price: num(b.full_price),
    saprodi_per_kg: num(b.saprodi_per_kg) ?? 0,
    labor_per_kg: num(b.labor_per_kg) ?? 0,
    notes: b.notes || null,
  };
}

function rateInvalid(c: ReturnType<typeof rateCols>): string | null {
  if (!c.plot_id || !c.effective_date) return 'plot_id and effective_date are required';
  if (c.saprodi_per_kg < 0 || c.labor_per_kg < 0) return 'Rates cannot be negative';
  if (c.full_price != null && c.saprodi_per_kg + c.labor_per_kg > c.full_price) {
    return 'Total payback per kg cannot exceed the full price';
  }
  return null;
}

/** Only a farmer's plot in the caller's own PT may be given a rate. */
async function plotInScope(req: Request, plotId: number): Promise<boolean> {
  const scope = entityScope(req);
  if (scope == null) return true;
  const [r] = await pool.query(
    `SELECT pl.id FROM plot pl WHERE pl.id = ? AND ${farmerEntityPredicate('pl.farmer_id')} LIMIT 1`, [plotId, scope]);
  return (r as any[]).length > 0;
}

paybackRatesRouter.post('/', authenticate, requireRole(...RATE_WRITERS), async (req: Request, res: Response) => {
  try {
    const c = rateCols(req.body || {});
    const bad = rateInvalid(c);
    if (bad) return res.status(422).json({ message: bad });
    if (!(await plotInScope(req, c.plot_id!))) return res.status(404).json({ message: 'Plot not found' });
    const [r] = await pool.query(
      `INSERT INTO payback_rates (plot_id, grade_id, effective_date, full_price, saprodi_per_kg, labor_per_kg, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
      [c.plot_id, c.grade_id, c.effective_date, c.full_price, c.saprodi_per_kg, c.labor_per_kg, c.notes]);
    const [rows] = await pool.query(RATE_SELECT + ' WHERE r.id = ?', [(r as any).insertId]);
    return res.status(201).json({ message: 'Payback rate created', data: (rows as any[])[0] });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(422).json({ message: 'Plot ini sudah punya tarif untuk tanggal dan grade yang sama' });
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// A rate change applies to deliveries saved from now on. Deliveries already
// booked keep their deduction: it is what the farmer was actually paid.
paybackRatesRouter.put('/:id', authenticate, requireRole(...RATE_WRITERS), async (req: Request, res: Response) => {
  try {
    const [ex] = await pool.query('SELECT * FROM payback_rates WHERE id = ? LIMIT 1', [req.params.id]);
    const cur = (ex as any[])[0];
    if (!cur || !(await plotInScope(req, cur.plot_id))) return res.status(404).json({ message: 'Payback rate not found' });
    const c = rateCols({ ...cur, ...(req.body || {}) });
    const bad = rateInvalid(c);
    if (bad) return res.status(422).json({ message: bad });
    if (!(await plotInScope(req, c.plot_id!))) return res.status(404).json({ message: 'Plot not found' });
    await pool.query(
      `UPDATE payback_rates SET plot_id = ?, grade_id = ?, effective_date = ?, full_price = ?, saprodi_per_kg = ?,
              labor_per_kg = ?, notes = ?, updated_at = NOW() WHERE id = ?`,
      [c.plot_id, c.grade_id, c.effective_date, c.full_price, c.saprodi_per_kg, c.labor_per_kg, c.notes, req.params.id]);
    const [rows] = await pool.query(RATE_SELECT + ' WHERE r.id = ?', [req.params.id]);
    return res.json({ message: 'Payback rate updated', data: (rows as any[])[0] });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(422).json({ message: 'Plot ini sudah punya tarif untuk tanggal dan grade yang sama' });
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

paybackRatesRouter.delete('/:id', authenticate, requireRole(...RATE_WRITERS), async (req: Request, res: Response) => {
  try {
    const [ex] = await pool.query('SELECT plot_id FROM payback_rates WHERE id = ? LIMIT 1', [req.params.id]);
    const cur = (ex as any[])[0];
    if (!cur || !(await plotInScope(req, cur.plot_id))) return res.status(404).json({ message: 'Payback rate not found' });
    await pool.query('DELETE FROM payback_rates WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Payback rate deleted' });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Outstanding  /api/pre-finance/outstanding  (from view)
// -----------------------------------------------------------------------------
export const outstandingRouter = Router();

outstandingRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = ['outstanding <> 0'];
  const args: any[] = [];
  if (req.query.farmer_id) { where.push('farmer_id = ?'); args.push(req.query.farmer_id); }
  const scope = entityScope(req);
  if (scope != null) { where.push(farmerEntityPredicate('farmer_id')); args.push(scope); }
  const [rows] = await pool.query(
    `SELECT * FROM v_pre_finance_outstanding WHERE ${where.join(' AND ')} ORDER BY farmer_name, type_name`, args);
  return res.json({ data: rows });
});

// Summary per farmer (all types combined).
outstandingRouter.get('/summary', authenticate, async (req: Request, res: Response) => {
  const scope = entityScope(req);
  const [rows] = await pool.query(
    `SELECT farmer_id, farmer_name, SUM(distributed_total) AS distributed_total,
            SUM(paid_total) AS paid_total, SUM(outstanding) AS outstanding
     FROM v_pre_finance_outstanding
     ${scope != null ? `WHERE ${farmerEntityPredicate('farmer_id')}` : ''}
     GROUP BY farmer_id, farmer_name HAVING outstanding <> 0
     ORDER BY outstanding DESC`, scope != null ? [scope] : []);
  return res.json({ data: rows });
});
