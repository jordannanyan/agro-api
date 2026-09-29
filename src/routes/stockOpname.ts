// Stok opname  /api/stock-opname
//
// Menghitung barang di rak, lalu menuliskannya di sebelah apa kata sistem.
//
// Stok di sini TERHITUNG — `v_saprodi_stock` = masuk − keluar — dan opname tidak
// ikut menghitungnya. Keputusan 2026-09-29: yang dicatat adalah selisihnya, bukan
// koreksinya. Kalau opname boleh menimpa angka stok, akan ada perubahan stok yang
// tidak punya dokumen penjelas, dan gudang kehilangan satu-satunya sifat yang
// membuat angkanya bisa ditelusuri: setiap pergerakan punya surat.
//
// Karena itu modul ini tidak punya efek samping sama sekali. Ia dokumen kontrol:
// "tanggal sekian, di gudang ini, sistem bilang 12, yang ada 9." Menindaklanjutinya
// urusan orang, lewat dokumen gudang yang biasa.
//
// Satu gudang, satu opname per 30 hari. Aturan itu dijaga di sini dan bukan
// dianjurkan di layar, karena "sekali sebulan" yang boleh dilanggar diam-diam
// bukan jadwal, cuma niat.
//
// Lampiran opsional — lembar hitung bertanda tangan atau foto rak, kalau ada.
// Sengaja tidak diwajibkan (permintaan 2026-09-29, "untuk sekarang"), tidak seperti
// Stock In dan Stock Out yang justru wajib.

import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { nextDocNumber } from '../utils/docNumber';
import { entityScope } from '../utils/entityScope';
import { warehouseEntityPredicate } from '../utils/farmScope';
import { respondList } from '../utils/pagination';

export const router = Router();

/** Sekali setiap 30 hari, per gudang. */
export const OPNAME_INTERVAL_DAYS = 30;

const SELECT = `
  SELECT o.*, w.warehouse_name, u.name AS counted_by_name,
         ent.id AS entity_id, ent.entities_name AS entity_name,
         (SELECT COUNT(*) FROM stock_opname_items i WHERE i.stock_opname_id = o.id) AS line_count,
         (SELECT COUNT(*) FROM stock_opname_items i
           WHERE i.stock_opname_id = o.id AND i.counted_qty <> i.system_qty) AS variance_lines,
         (SELECT COALESCE(SUM(i.counted_qty - i.system_qty), 0) FROM stock_opname_items i
           WHERE i.stock_opname_id = o.id) AS variance_total
  FROM stock_opname o
  LEFT JOIN warehouse w  ON w.id = o.warehouse_id
  LEFT JOIN kth wk       ON wk.id = w.kth_id
  LEFT JOIN entities ent ON ent.id = wk.entities_id
  LEFT JOIN users u      ON u.id = o.counted_by_user_id
`;

const LINE_SELECT = `
  SELECT i.id, i.sapropdi_id, i.system_qty, i.counted_qty,
         (i.counted_qty - i.system_qty) AS variance,
         i.unit_id, i.remarks,
         s.sapropdi_name, s.category,
         COALESCE(un.unit_name, s.unit) AS unit_name
  FROM stock_opname_items i
  LEFT JOIN sapropdi s ON s.id = i.sapropdi_id
  LEFT JOIN units un   ON un.id = i.unit_id
  WHERE i.stock_opname_id = ?
  ORDER BY s.sapropdi_name ASC, i.id ASC
`;

/**
 * Kapan gudang ini boleh diopname lagi.
 *
 * Dipakai dua kali dan harus menjawab sama: sekali oleh layar, supaya tombolnya
 * bisa menjelaskan dirinya sendiri, dan sekali oleh POST, yang menolaknya. Dua
 * perhitungan terpisah untuk satu aturan adalah dua perhitungan yang suatu saat
 * berbeda pendapat.
 */
async function intervalCheck(warehouseId: number, forDate: string) {
  const [rows] = await pool.query(
    `SELECT id, opname_number, opname_date,
            DATEDIFF(?, opname_date) AS day_gap
       FROM stock_opname
      WHERE warehouse_id = ?
      ORDER BY ABS(DATEDIFF(?, opname_date)) ASC
      LIMIT 1`,
    [forDate, warehouseId, forDate]);
  const last = (rows as any[])[0];
  if (!last) return { ok: true as const, last: null };

  const gap = Math.abs(Number(last.day_gap));
  if (gap >= OPNAME_INTERVAL_DAYS) return { ok: true as const, last };

  // Tanggal boleh berikutnya dihitung dari opname TERDEKAT, bukan yang terakhir
  // dibuat: sebuah hitungan yang dimundurkan tanggalnya tetap menutup jendela di
  // sekitarnya.
  const [[next]] = await pool.query(
    'SELECT DATE_ADD(?, INTERVAL ? DAY) AS d', [last.opname_date, OPNAME_INTERVAL_DAYS]) as any;
  return {
    ok: false as const,
    last,
    nextAllowed: next.d,
    message: `Gudang ini sudah diopname pada ${String(last.opname_date).slice(0, 10)} `
      + `(${last.opname_number}). Opname berikutnya paling cepat `
      + `${String(next.d).slice(0, 10)} — satu gudang satu opname per ${OPNAME_INTERVAL_DAYS} hari.`,
  };
}

/** Dokumen ini milik PT pemanggil? Dipakai sebelum membaca atau mengubahnya. */
async function scopedOpname(req: Request, id: number) {
  const scope = entityScope(req);
  const where = scope != null
    ? `o.id = ? AND ${warehouseEntityPredicate('o.warehouse_id')}`
    : 'o.id = ?';
  const args = scope != null ? [id, scope] : [id];
  const [rows] = await pool.query(SELECT + ` WHERE ${where} LIMIT 1`, args);
  return (rows as any[])[0] || null;
}

// ---------------------------------------------------------------------------
// Membaca
// ---------------------------------------------------------------------------

/**
 * GET /api/stock-opname/sheet?warehouse_id=&date=
 *
 * Lembar hitungnya: setiap saprodi yang pernah bergerak di gudang itu, dengan
 * angka sistem hari ini di sebelahnya, plus jawaban apakah gudang ini memang boleh
 * diopname sekarang.
 *
 * Diletakkan sebelum `/:id`, kalau tidak Express membaca "sheet" sebagai id.
 */
router.get('/sheet', authenticate, async (req: Request, res: Response) => {
  try {
    const warehouseId = Number(req.query.warehouse_id || 0);
    if (!warehouseId) return res.status(422).json({ message: 'warehouse_id wajib diisi.' });

    const scope = entityScope(req);
    if (scope != null) {
      const [own] = await pool.query(
        `SELECT id FROM warehouse w WHERE w.id = ? AND ${warehouseEntityPredicate('w.id')} LIMIT 1`,
        [warehouseId, scope]);
      if (!(own as any[]).length) return res.status(404).json({ message: 'Gudang tidak ditemukan.' });
    }

    const date = String(req.query.date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const check = await intervalCheck(warehouseId, date);

    // Dibaca dari view yang sama dengan yang dipakai laporan, supaya angka "sistem"
    // di lembar ini persis angka yang dilihat orang di Inventory Saprodi.
    //
    // Baris bersisa nol IKUT ditampilkan kalau barangnya pernah bergerak di gudang
    // ini: menemukan barang yang menurut sistem habis justru salah satu hal yang
    // dicari opname. Yang dibuang hanya yang tidak pernah ada sama sekali.
    const [items] = await pool.query(
      `SELECT v.sapropdi_id, v.sapropdi_name, v.unit_id, v.unit_name,
              v.total_in, v.total_out, v.remaining AS system_qty, s.category
         FROM v_saprodi_stock v
         LEFT JOIN sapropdi s ON s.id = v.sapropdi_id
        WHERE v.warehouse_id = ?
          AND (v.total_in <> 0 OR v.total_out <> 0)
        ORDER BY v.sapropdi_name ASC`, [warehouseId]);

    return res.json({
      data: {
        warehouse_id: warehouseId,
        date,
        allowed: check.ok,
        last_opname: check.last,
        next_allowed: check.ok ? null : (check as any).nextAllowed,
        message: check.ok ? null : (check as any).message,
        interval_days: OPNAME_INTERVAL_DAYS,
        items,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/stock-opname?warehouse_id=&from=&to=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const where: string[] = [];
    const args: any[] = [];
    const scope = entityScope(req);
    if (scope != null) { where.push(warehouseEntityPredicate('o.warehouse_id')); args.push(scope); }
    if (req.query.warehouse_id) { where.push('o.warehouse_id = ?'); args.push(Number(req.query.warehouse_id)); }
    if (req.query.from) { where.push('o.opname_date >= ?'); args.push(req.query.from); }
    if (req.query.to) { where.push('o.opname_date <= ?'); args.push(req.query.to); }
    if (req.query.search) { where.push('o.opname_number LIKE ?'); args.push(`%${req.query.search}%`); }
    const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
      + ' ORDER BY o.opname_date DESC, o.id DESC';
    return await respondList(req, res, sql, args);
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/stock-opname/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const data = await scopedOpname(req, Number(req.params.id));
    if (!data) return res.status(404).json({ message: 'Stok opname tidak ditemukan' });
    const [lines] = await pool.query(LINE_SELECT, [data.id]);
    data.lines = lines;
    return res.json({ data });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Menulis
// ---------------------------------------------------------------------------

interface ParsedLine {
  sapropdi_id: number;
  system_qty: number;
  counted_qty: number;
  unit_id: number | null;
  remarks: string | null;
}

/**
 * Baca barisnya, dan JANGAN percaya angka sistem yang dikirim formulir.
 *
 * Yang dikirim layar bisa sudah basi — barang bisa masuk sejak lembarnya dibuka —
 * dan yang lebih penting, angka itulah yang menentukan besar selisihnya. Kalau ia
 * datang dari klien, selisih bisa dibuat apa saja. Jadi angka sistem dibaca ulang
 * dari view di sini, saat disimpan, dan itu yang jadi potret permanennya.
 */
async function readLines(warehouseId: number, raw: any): Promise<{ lines: ParsedLine[] } | { error: string }> {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: 'Isi minimal satu baris hitungan.' };
  }
  const [stockRows] = await pool.query(
    'SELECT sapropdi_id, unit_id, COALESCE(remaining, 0) AS remaining'
    + ' FROM v_saprodi_stock WHERE warehouse_id = ?', [warehouseId]);
  const system = new Map<number, { remaining: number; unit_id: number | null }>();
  for (const r of stockRows as any[]) {
    system.set(Number(r.sapropdi_id), { remaining: Number(r.remaining), unit_id: r.unit_id ?? null });
  }

  const lines: ParsedLine[] = [];
  const seen = new Set<number>();
  for (const [i, r] of raw.entries()) {
    const at = `Baris ${i + 1}`;
    const sapropdiId = Number(r?.sapropdi_id || 0);
    if (!sapropdiId) return { error: `${at}: barang wajib dipilih.` };
    // Satu barang satu baris: dua baris untuk barang yang sama membuat "berapa yang
    // ada" punya dua jawaban, dan tidak ada aturan yang adil untuk memilih salah satu.
    if (seen.has(sapropdiId)) return { error: `${at}: barang ini sudah dihitung di baris lain.` };
    seen.add(sapropdiId);

    const counted = Number(r?.counted_qty);
    if (!Number.isFinite(counted) || counted < 0) {
      return { error: `${at}: hasil hitung harus angka dan tidak boleh negatif.` };
    }
    const sys = system.get(sapropdiId);
    lines.push({
      sapropdi_id: sapropdiId,
      system_qty: sys ? sys.remaining : 0,
      counted_qty: counted,
      unit_id: r?.unit_id != null && r.unit_id !== '' ? Number(r.unit_id) : (sys ? sys.unit_id : null),
      remarks: r?.remarks ? String(r.remarks).slice(0, 255) : null,
    });
  }
  return { lines };
}

async function writeLines(conn: any, opnameId: number, lines: ParsedLine[]) {
  await conn.query('DELETE FROM stock_opname_items WHERE stock_opname_id = ?', [opnameId]);
  for (const l of lines) {
    await conn.query(
      `INSERT INTO stock_opname_items
         (stock_opname_id, sapropdi_id, system_qty, counted_qty, unit_id, remarks, created_at, updated_at)
       VALUES (?,?,?,?,?,?,NOW(),NOW())`,
      [opnameId, l.sapropdi_id, l.system_qty, l.counted_qty, l.unit_id, l.remarks]);
  }
}

// POST /api/stock-opname
// body: { warehouse_id, opname_date, notes, lines: [{ sapropdi_id, counted_qty, remarks }] }
router.post('/', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    const warehouseId = Number(b.warehouse_id || 0);
    const date = String(b.opname_date || '').slice(0, 10);
    if (!warehouseId || !date) {
      return res.status(422).json({ message: 'warehouse_id dan opname_date wajib diisi.' });
    }

    const scope = entityScope(req);
    if (scope != null) {
      const [own] = await pool.query(
        `SELECT id FROM warehouse w WHERE w.id = ? AND ${warehouseEntityPredicate('w.id')} LIMIT 1`,
        [warehouseId, scope]);
      if (!(own as any[]).length) {
        return res.status(403).json({ message: 'Gudang ini bukan milik PT Anda.' });
      }
    }

    // Aturan 30 hari diperiksa SEBELUM apa pun ditulis.
    const check = await intervalCheck(warehouseId, date);
    if (!check.ok) {
      return res.status(409).json({
        message: (check as any).message,
        data: { last_opname: check.last, next_allowed: (check as any).nextAllowed },
      });
    }

    const parsed = await readLines(warehouseId, b.lines);
    if ('error' in parsed) return res.status(422).json({ message: parsed.error });

    await conn.beginTransaction();
    const number = await nextDocNumber('stock_opname', 'opname_number', 'OPN');
    const [result] = await conn.query(
      `INSERT INTO stock_opname
         (opname_number, opname_date, warehouse_id, counted_by_user_id, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,NOW(),NOW())`,
      [number, date, warehouseId,
       req.user?.type === 'User' ? req.user.id : null, b.notes ?? null]);
    const id = (result as any).insertId;
    await writeLines(conn, id, parsed.lines);
    await conn.commit();

    const [rows] = await pool.query(SELECT + ' WHERE o.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    const [lines] = await pool.query(LINE_SELECT, [id]);
    data.lines = lines;
    return res.status(201).json({ message: 'Stok opname tercatat', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// PUT /api/stock-opname/:id — membetulkan hitungan yang salah ketik.
//
// Tanggal dan gudangnya TIDAK bisa diubah: keduanya yang menentukan jendela 30 hari,
// dan memindahkannya lewat edit adalah cara paling mudah untuk menyelinap dari
// aturan yang baru saja ditegakkan di POST.
router.put('/:id', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    const prev = await scopedOpname(req, id);
    if (!prev) { return res.status(404).json({ message: 'Stok opname tidak ditemukan' }); }

    const b = req.body || {};
    await conn.beginTransaction();
    if (b.notes !== undefined) {
      await conn.query('UPDATE stock_opname SET notes = ?, updated_at = NOW() WHERE id = ?',
        [b.notes ?? null, id]);
    }
    if (b.lines !== undefined) {
      const parsed = await readLines(Number(prev.warehouse_id), b.lines);
      if ('error' in parsed) { await conn.rollback(); return res.status(422).json({ message: parsed.error }); }
      await writeLines(conn, id, parsed.lines);
    }
    await conn.commit();

    const [rows] = await pool.query(SELECT + ' WHERE o.id = ? LIMIT 1', [id]);
    const data = (rows as any[])[0];
    const [lines] = await pool.query(LINE_SELECT, [id]);
    data.lines = lines;
    return res.json({ message: 'Stok opname diperbarui', data });
  } catch (err: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// DELETE /api/stock-opname/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const prev = await scopedOpname(req, id);
    if (!prev) return res.status(404).json({ message: 'Stok opname tidak ditemukan' });

    // Lampiran dialamatkan lewat (tipe, id) tanpa foreign key, jadi penghapusan
    // harus membawanya serta — kalau tidak ia akan menempel pada opname lain yang
    // kelak memakai id yang sama. Barisnya ikut lewat ON DELETE CASCADE.
    await pool.query(
      "DELETE FROM document_attachments WHERE document_type = 'StockOpname' AND document_id = ?", [id]);
    await pool.query(
      "DELETE FROM document_activities WHERE document_type = 'StockOpname' AND document_id = ?", [id]);
    const [result] = await pool.query('DELETE FROM stock_opname WHERE id = ?', [id]);
    if (!(result as any).affectedRows) return res.status(404).json({ message: 'Stok opname tidak ditemukan' });
    return res.json({ message: 'Stok opname dihapus' });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;
