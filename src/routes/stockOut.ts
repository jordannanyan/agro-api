import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { nextDocNumber } from '../utils/docNumber';
import { entityScope } from '../utils/entityScope';
import { warehouseEntityPredicate } from '../utils/farmScope';
import { respondList } from '../utils/pagination';

// -----------------------------------------------------------------------------
// Stock Out  /api/stock-out
//
// The single place goods leave a warehouse. It replaces two screens that each did
// half the job: "Distribusi" under Pre-Finance, which recorded farmer debt but was
// not a warehouse document, and "Operational Investment" under Profit Sharing,
// which recorded money and never touched stock at all.
//
// A header names the warehouse and the date; each line names the farmer, the plot
// and the item. The scheme is read off the plot rather than chosen, so one form
// serves Pre-Finance and Profit Sharing without asking the keeper which is which.
//
// Lines are stored in pre_finance_distributions because the farmer's outstanding
// balance is computed from that table — moving them would change every debt
// figure. The header is a grouping over rows that already had to exist.
// -----------------------------------------------------------------------------
export const router = Router();

// Every list in this cluster carries the owning PT, so a reader who legitimately
// sees several (the NBSV admins, the cross-entity roles) can tell them apart.
const SELECT = `
  SELECT so.*, w.warehouse_name, u.name AS issued_by_name,
         ent.id AS entity_id, ent.entities_name AS entity_name,
         (SELECT COUNT(*) FROM pre_finance_distributions d WHERE d.stock_out_id = so.id) AS line_count,
         (SELECT COALESCE(SUM(d.quantity), 0) FROM pre_finance_distributions d WHERE d.stock_out_id = so.id) AS total_qty,
         (SELECT COALESCE(SUM(d.total_amount), 0) FROM pre_finance_distributions d WHERE d.stock_out_id = so.id) AS total_amount
  FROM stock_out so
  LEFT JOIN warehouse w ON w.id = so.warehouse_id
  LEFT JOIN kth wk      ON wk.id = w.kth_id
  LEFT JOIN entities ent ON ent.id = wk.entities_id
  LEFT JOIN users u     ON u.id = so.issued_by_user_id
`;

const LINE_SELECT = `
  SELECT d.id, d.farmer_id, d.plot_id, d.sapropdi_id, d.unit_id, d.quantity,
         d.price_per_unit, d.total_amount, d.description,
         f.farmer_name, p.plot_name, s.sapropdi_name, un.unit_name,
         COALESCE(p.scheme, 'BeliPutus') AS scheme
  FROM pre_finance_distributions d
  LEFT JOIN farmers f  ON f.id = d.farmer_id
  LEFT JOIN plot p     ON p.id = d.plot_id
  LEFT JOIN sapropdi s ON s.id = d.sapropdi_id
  LEFT JOIN units un   ON un.id = d.unit_id
  WHERE d.stock_out_id = ?
  ORDER BY d.id ASC
`;

/** Remaining stock of one item in one warehouse, from the same view the reports use. */
async function remaining(warehouseId: number, sapropdiId: number): Promise<number> {
  const [r] = await pool.query(
    'SELECT COALESCE(remaining, 0) AS remaining FROM v_saprodi_stock WHERE warehouse_id = ? AND sapropdi_id = ? LIMIT 1',
    [warehouseId, sapropdiId]);
  return Number((r as any[])[0]?.remaining ?? 0);
}

// GET /api/stock-out?warehouse_id=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const where: string[] = [];
    const args: any[] = [];
    if (req.query.warehouse_id) { where.push('so.warehouse_id = ?'); args.push(req.query.warehouse_id); }
    if (req.query.search)       { where.push('so.stock_out_number LIKE ?'); args.push(`%${req.query.search}%`); }
    // Narrow to one plot. The plot lives on the LINES, not the header — a stock-out
    // can be split across several — so this asks whether any line went to it rather
    // than joining, which would duplicate the header row once per matching line.
    if (req.query.plot_id) {
      where.push('EXISTS (SELECT 1 FROM pre_finance_distributions d WHERE d.stock_out_id = so.id AND d.plot_id = ?)');
      args.push(req.query.plot_id);
    }
    // A warehouse belongs to a KTH, which belongs to a PT — so does everything
    // issued from it. Staff bound to one PT see only their own warehouses' issues.
    const scope = entityScope(req);
    if (scope != null) { where.push(warehouseEntityPredicate('so.warehouse_id')); args.push(scope); }
    const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY so.stock_out_date DESC, so.id DESC';
    return respondList(req, res, sql, args);
  } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// GET /api/stock-out/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const scope = entityScope(req);
    const sql = SELECT + ` WHERE so.id = ?${scope != null ? ` AND ${warehouseEntityPredicate('so.warehouse_id')}` : ''} LIMIT 1`;
    const [rows] = await pool.query(sql, scope != null ? [req.params.id, scope] : [req.params.id]);
    const list = rows as any[];
    if (!list.length) return res.status(404).json({ message: 'Stock out not found' });
    const data = list[0];
    const [lines] = await pool.query(LINE_SELECT, [req.params.id]);
    data.lines = lines;
    return res.json({ data });
  } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

// -----------------------------------------------------------------------------
// Creating a stock out, with its evidence, in one request
//
// Every other document in this system is saved as a Draft first and only then
// submitted, which is what gives the "attachment required" rule somewhere to stand:
// the guard refuses to let the document *leave* Draft with nothing attached.
//
// A stock out has no Draft. There is one write, and when it lands the goods have
// already left the warehouse — the balance is calculated from these very rows. So
// there is no later door to guard, and asking for the file afterwards would mean a
// record that is already true and already unevidenced.
//
// Hence: the files travel with the document. Without one the request is refused
// before a single row is written, and the attachments are inserted inside the same
// transaction as the stock movement, so a stock out that exists always has its
// evidence and one that fails leaves nothing behind.
//
// The form sends multipart: `payload` is the document as a JSON string, beside the
// files. A plain JSON body is still read — it simply cannot carry a file, so it is
// refused by the same rule rather than by a separate one.
// -----------------------------------------------------------------------------
const stockOutUpload = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'files', maxCount: 20 },
]);

/** The document itself, whether it arrived as JSON or beside the files. */
function readPayload(req: Request): any {
  const raw = (req.body || {}) as any;
  if (typeof raw.payload === 'string') {
    try { return JSON.parse(raw.payload); } catch { return null; }
  }
  return raw;
}

// POST /api/stock-out
// multipart: payload = JSON string of
//   { warehouse_id, stock_out_date, notes,
//     lines: [{ farmer_id, plot_id, sapropdi_id, unit_id, quantity, price_per_unit, description }] }
// plus `file` / `files`
router.post('/', authenticate, stockOutUpload, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = readPayload(req);
    if (!b) return res.status(422).json({ message: 'Isi dokumen tidak terbaca (payload bukan JSON yang sah).' });

    // Checked first, before anything is validated or written: a refusal here must
    // leave the warehouse exactly as it was.
    const grouped = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const attachPaths = [...(grouped.file ?? []), ...(grouped.files ?? [])]
      .map(fileToPath).filter(Boolean) as string[];
    if (!attachPaths.length) {
      return res.status(422).json({
        message: 'Lampiran wajib diisi — barang keluar harus ada buktinya (tanda terima, foto serah '
          + 'terima, atau berita acara). Lampirkan gambar atau PDF, maksimal 5 MB per berkas.',
      });
    }

    const warehouseId = Number(b.warehouse_id);
    const date = b.stock_out_date;
    const lines = Array.isArray(b.lines) ? b.lines : [];

    if (!warehouseId || !date) return res.status(422).json({ message: 'warehouse_id and stock_out_date are required' });
    if (!lines.length) return res.status(422).json({ message: 'At least one line is required' });

    // A distribution row cannot exist without a type, and stock leaving a warehouse
    // is always Saprodi. Resolved by name — ids differ between environments.
    const [typeRows] = await conn.query(
      "SELECT id FROM pre_finance_types WHERE type_name = 'Saprodi' LIMIT 1");
    const saprodiTypeId = (typeRows as any[])[0]?.id;
    if (!saprodiTypeId) {
      return res.status(500).json({ message: "pre_finance_types is missing the 'Saprodi' row." });
    }

    // Validate every line before writing any of them, so a rejected form comes back
    // whole rather than half-applied.
    const wanted = new Map<number, number>();
    for (const [i, ln] of lines.entries()) {
      const at = `Baris ${i + 1}`;
      if (!ln.farmer_id)   return res.status(422).json({ message: `${at}: petani wajib dipilih` });
      // The plot carries the scheme, which is what tells Pre-Finance and Profit
      // Sharing apart. Without it the issue cannot be attributed to either.
      if (!ln.plot_id)     return res.status(422).json({ message: `${at}: plot wajib dipilih — skema dibaca dari plot` });
      if (!ln.sapropdi_id) return res.status(422).json({ message: `${at}: barang wajib dipilih` });
      const qty = Number(ln.quantity || 0);
      if (!(qty > 0))      return res.status(422).json({ message: `${at}: kuantitas harus lebih dari 0` });
      wanted.set(Number(ln.sapropdi_id), (wanted.get(Number(ln.sapropdi_id)) ?? 0) + qty);

      const [plotRows] = await conn.query('SELECT farmer_id FROM plot WHERE id = ? LIMIT 1', [Number(ln.plot_id)]);
      const plot = (plotRows as any[])[0];
      if (!plot) return res.status(422).json({ message: `${at}: plot tidak ditemukan` });
      if (Number(plot.farmer_id) !== Number(ln.farmer_id)) {
        return res.status(422).json({ message: `${at}: plot itu bukan milik petani yang dipilih` });
      }
    }

    // Stock is checked per item across the whole document, so two lines drawing the
    // same item cannot each pass on a balance only one of them could use.
    for (const [sapropdiId, qty] of wanted) {
      const have = await remaining(warehouseId, sapropdiId);
      if (qty > have) {
        const [n] = await conn.query('SELECT sapropdi_name FROM sapropdi WHERE id = ? LIMIT 1', [sapropdiId]);
        const name = (n as any[])[0]?.sapropdi_name ?? `#${sapropdiId}`;
        return res.status(422).json({
          message: `Stok ${name} tidak cukup di gudang ini: tersedia ${have}, diminta ${qty}.`,
        });
      }
    }

    await conn.beginTransaction();
    const number = b.stock_out_number || await nextDocNumber('stock_out', 'stock_out_number', 'SO');
    const [result] = await conn.query(
      `INSERT INTO stock_out (stock_out_number, stock_out_date, warehouse_id, issued_by_user_id, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,NOW(),NOW())`,
      [number, date, warehouseId, req.user?.type === 'User' ? req.user.id : null, b.notes ?? null]
    );
    const id = (result as any).insertId;

    for (const ln of lines) {
      const qty = Number(ln.quantity || 0);
      const price = ln.price_per_unit != null && ln.price_per_unit !== '' ? Number(ln.price_per_unit) : null;
      await conn.query(
        `INSERT INTO pre_finance_distributions
           (pre_finance_type_id, date, farmer_id, plot_id, sapropdi_id, warehouse_id, stock_out_id,
            quantity, unit_id, price_per_unit, total_amount, description, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [saprodiTypeId, date, Number(ln.farmer_id), Number(ln.plot_id), Number(ln.sapropdi_id),
         warehouseId, id, qty,
         ln.unit_id != null && ln.unit_id !== '' ? Number(ln.unit_id) : null,
         price, price != null ? qty * price : 0, ln.description ?? null]
      );
    }
    // Inside the transaction on purpose: if anything below fails, the attachment
    // rows go with the stock movement rather than outliving it as orphans pointing
    // at a document that was never created.
    for (const filePath of attachPaths) {
      await conn.query(
        `INSERT INTO document_attachments (document_type, document_id, category, subcategory, file_path, created_at, updated_at)
         VALUES ('StockOut', ?, ?, NULL, ?, NOW(), NOW())`,
        [id, (req.body as any)?.category ?? 'Bukti Serah Terima', filePath]);
    }
    await conn.commit();

    const [rows] = await pool.query(SELECT + ' WHERE so.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    const [createdLines] = await pool.query(LINE_SELECT, [id]);
    data.lines = createdLines;
    return res.status(201).json({ message: 'Stock out recorded', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// DELETE /api/stock-out/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    // Another PT's stock movement is not this caller's to remove.
    const scope = entityScope(req);
    if (scope != null) {
      const [own] = await pool.query(
        `SELECT id FROM stock_out WHERE id = ? AND ${warehouseEntityPredicate('warehouse_id')} LIMIT 1`,
        [req.params.id, scope]);
      if (!(own as any[]).length) return res.status(404).json({ message: 'Stock out not found' });
    }
    // The lines are farmer debt, so this refuses rather than cascading. Removing the
    // debt has to be a deliberate act on the distribution itself.
    const [c] = await pool.query(
      'SELECT COUNT(*) n FROM pre_finance_distributions WHERE stock_out_id = ?', [req.params.id]);
    const n = Number((c as any[])[0].n);
    if (n) {
      return res.status(409).json({
        message: `Stock out ini masih punya ${n} baris yang menjadi utang petani. Hapus barisnya lebih dulu.`,
      });
    }
    // Attachments are addressed by (type, id) with no foreign key, so a real delete
    // has to take them along or they end up pointing at an id a later stock-out
    // reuses. See the same clean-up in stockIn.ts.
    await pool.query(
      "DELETE FROM document_attachments WHERE document_type = 'StockOut' AND document_id = ?",
      [req.params.id]);
    const [result] = await pool.query('DELETE FROM stock_out WHERE id = ?', [req.params.id]);
    if (!(result as any).affectedRows) return res.status(404).json({ message: 'Stock out not found' });
    return res.json({ message: 'Stock out deleted' });
  } catch (err: any) { return res.status(500).json({ message: 'Server error', error: err.message }); }
});

export default router;
