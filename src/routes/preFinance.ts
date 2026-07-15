import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { compressImages } from '../services/imageProcessor';

// -----------------------------------------------------------------------------
// Distributions  /api/pre-finance/distributions
// -----------------------------------------------------------------------------
export const distributionsRouter = Router();

const DIST_SELECT = `
  SELECT d.*, t.type_name, f.farmer_name, p.plot_name, s.sapropdi_name, u.unit_name
  FROM pre_finance_distributions d
  LEFT JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
  LEFT JOIN farmers f           ON f.id = d.farmer_id
  LEFT JOIN plot p              ON p.id = d.plot_id
  LEFT JOIN sapropdi s          ON s.id = d.sapropdi_id
  LEFT JOIN units u             ON u.id = d.unit_id
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
  const sql = DIST_SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY d.date DESC, d.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

distributionsRouter.get('/:id', authenticate, async (req, res) => {
  const [rows] = await pool.query(DIST_SELECT + ' WHERE d.id = ? LIMIT 1', [req.params.id]);
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
  const [result] = await pool.query('DELETE FROM pre_finance_distributions WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Distribution not found' });
  return res.json({ message: 'Distribution deleted' });
});

// -----------------------------------------------------------------------------
// Installments  /api/pre-finance/installments  (header + details breakdown)
// -----------------------------------------------------------------------------
export const installmentsRouter = Router();

const INST_SELECT = `
  SELECT i.*, f.farmer_name, pm.method_name
  FROM pre_finance_installments i
  LEFT JOIN farmers f          ON f.id = i.farmer_id
  LEFT JOIN payment_methods pm ON pm.id = i.payment_method_id
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
  const sql = INST_SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY i.date DESC, i.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: rows });
});

installmentsRouter.get('/:id', authenticate, async (req, res) => {
  const [rows] = await pool.query(INST_SELECT + ' WHERE i.id = ? LIMIT 1', [req.params.id]);
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
    let details = b.details;
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = []; } }
    details = Array.isArray(details) ? details : [];
    const total = details.reduce((s: number, d: any) => s + Number(d.amount || 0), 0);
    const proof = fileToPath(req.file);

    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO pre_finance_installments (purchasing_id, farmer_id, date, payment_method_id, reference_no, upload_proof, total_payment, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [b.purchasing_id != null && b.purchasing_id !== '' ? Number(b.purchasing_id) : null,
       Number(b.farmer_id), b.date,
       b.payment_method_id != null && b.payment_method_id !== '' ? Number(b.payment_method_id) : null,
       b.reference_no || null, proof, total, b.notes || null]
    );
    const id = (result as any).insertId;
    for (const d of details) {
      if (!d.pre_finance_type_id || !Number(d.amount)) continue;
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
  const [result] = await pool.query('DELETE FROM pre_finance_installments WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Installment not found' });
  return res.json({ message: 'Installment deleted' });
});

// -----------------------------------------------------------------------------
// Outstanding  /api/pre-finance/outstanding  (from view)
// -----------------------------------------------------------------------------
export const outstandingRouter = Router();

outstandingRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = ['outstanding <> 0'];
  const args: any[] = [];
  if (req.query.farmer_id) { where.push('farmer_id = ?'); args.push(req.query.farmer_id); }
  const [rows] = await pool.query(
    `SELECT * FROM v_pre_finance_outstanding WHERE ${where.join(' AND ')} ORDER BY farmer_name, type_name`, args);
  return res.json({ data: rows });
});

// Summary per farmer (all types combined).
outstandingRouter.get('/summary', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query(
    `SELECT farmer_id, farmer_name, SUM(distributed_total) AS distributed_total,
            SUM(paid_total) AS paid_total, SUM(outstanding) AS outstanding
     FROM v_pre_finance_outstanding GROUP BY farmer_id, farmer_name HAVING outstanding <> 0
     ORDER BY outstanding DESC`);
  return res.json({ data: rows });
});
