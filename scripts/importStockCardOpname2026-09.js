// -----------------------------------------------------------------------------
// Menarik sheet "Stock card" dari workbook lapangan menjadi satu stok opname.
//
// Latar belakang: angka stok di sistem untuk gudang SNBS negatif seluruhnya —
// barang keluar tercatat tanpa penerimaan yang mengimbanginya, karena pencatatan
// selama ini berjalan di spreadsheet. Permintaan user: "stoknya mengikuti ini
// dulu".
//
// Yang TIDAK dilakukan skrip ini: menulis angka stok. Ia membuat sebuah STOK
// OPNAME berisi saldo per barang menurut spreadsheet, lalu berhenti. Menyetujuinya
// adalah tindakan terpisah yang dilakukan orang dari layar (tombol "Sesuaikan
// Stok"), dan di situlah angka stok berubah — lewat jalur yang sama dengan opname
// mana pun, dengan jejak siapa dan kapan. Sebuah impor yang langsung menimpa stok
// akan jadi satu-satunya perubahan stok di sistem ini yang tidak punya dokumen.
//
// Nama material dicocokkan ke master `sapropdi` setelah dinormalisasi (huruf kecil,
// buang non-alfanumerik). Yang tidak cocok atau bermakna ganda TIDAK ditebak — ia
// dilaporkan dan dilewati, karena menebak barang berarti menaruh angka pada barang
// yang salah, dan itu lebih buruk daripada barisnya tidak ada.
//
// Usage:
//   node scripts/importStockCardOpname2026-09.js --file "<path.xlsx>" --warehouse 1
//   node scripts/importStockCardOpname2026-09.js --file "<path.xlsx>" --warehouse 1 --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const path = require('path');
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const APPLY = argv.includes('--apply');
const FILE = argOf('file');
const WAREHOUSE = Number(argOf('warehouse', 0));
const SHEET = argOf('sheet', 'Stock card');
const DATE = argOf('date', new Date().toISOString().slice(0, 10));

const log = (...a) => console.log(...a);
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const fmt = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 3 });

/**
 * Ejaan berbeda untuk barang yang sama, dipetakan dengan sengaja.
 *
 * Hanya perbedaan tulis yang tidak mengubah barangnya: huruf besar-kecil sudah
 * ditangani normalisasi, jadi yang tersisa di sini adalah salah ketik. Padanan yang
 * MENAFSIRKAN (mis. "KCL" yang di master ada dua) sengaja tidak ditaruh di sini —
 * itu keputusan orang, bukan keputusan skrip.
 */
const ALIAS = {
  baycline: 'bayclin',
};

(async () => {
  if (!FILE) { console.error('--file wajib diisi (path ke .xlsx)'); process.exit(1); }
  if (!WAREHOUSE) { console.error('--warehouse wajib diisi (id gudang)'); process.exit(1); }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agro_supply',
  });

  const [whRows] = await conn.query(
    'SELECT w.id, w.warehouse_name, e.entities_name FROM warehouse w'
    + ' LEFT JOIN kth k ON k.id = w.kth_id LEFT JOIN entities e ON e.id = k.entities_id'
    + ' WHERE w.id = ? LIMIT 1', [WAREHOUSE]);
  const wh = whRows[0];
  if (!wh) { console.error(`Gudang id ${WAREHOUSE} tidak ada.`); process.exit(1); }

  log(`\n=== Impor Stock card -> stok opname ===`);
  log(`berkas : ${path.basename(FILE)}  (sheet "${SHEET}")`);
  log(`gudang : ${wh.warehouse_name} — ${wh.entities_name}`);
  log(`tanggal: ${DATE}`);
  log(APPLY ? 'MODE   : APPLY (membuat dokumen opname)\n' : 'MODE   : DRY RUN (tidak menulis apa pun)\n');

  // ── baca sheet ────────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) { console.error(`Sheet "${SHEET}" tidak ada. Yang tersedia: ${wb.worksheets.map((w) => w.name).join(', ')}`); process.exit(1); }

  // Kolom: Tanggal | Bulan | Tahun | material | stock in | stock out | Satuan | ...
  const num = (v) => {
    if (v == null) return 0;
    if (typeof v === 'object' && v.result != null) v = v.result;  // sel berformula
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const agg = new Map();   // key ternormalisasi -> { labels:Set, in, out, units:Map }
  let used = 0, skipped = 0;
  ws.eachRow((row, i) => {
    if (i === 1) return;                       // baris judul
    const mat = row.getCell(4).value;
    const label = typeof mat === 'object' && mat && mat.richText
      ? mat.richText.map((t) => t.text).join('')
      : mat;
    const name = String(label == null ? '' : label).trim();
    if (!name) { skipped++; return; }
    used++;
    const key = ALIAS[norm(name)] || norm(name);
    if (!agg.has(key)) agg.set(key, { labels: new Set(), in: 0, out: 0, units: new Map() });
    const a = agg.get(key);
    a.labels.add(name);
    a.in += num(row.getCell(5).value);
    a.out += num(row.getCell(6).value);
    const u = String(row.getCell(7).value == null ? '' : row.getCell(7).value).trim();
    if (u) a.units.set(u, (a.units.get(u) || 0) + 1);
  });
  log(`baris pergerakan terbaca: ${used} (dilewati karena tanpa nama material: ${skipped})`);
  log(`material unik setelah digabung ejaan: ${agg.size}\n`);

  // ── cocokkan ke master ────────────────────────────────────────────────────
  const [sap] = await conn.query('SELECT id, sapropdi_name, unit, unit_id FROM sapropdi');
  const byNorm = new Map();
  for (const s of sap) {
    const k = norm(s.sapropdi_name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(s);
  }

  const matched = [], ambiguous = [], missing = [];
  for (const [key, a] of agg) {
    const net = a.in - a.out;
    const labels = [...a.labels].join(' / ');
    const units = [...a.units.keys()].join(', ');
    const hit = byNorm.get(key) || [];
    if (hit.length === 1) matched.push({ key, labels, net, units, sap: hit[0], mixedUnits: a.units.size > 1 });
    else if (hit.length > 1) ambiguous.push({ key, labels, net, units, options: hit });
    else missing.push({ key, labels, net, units });
  }

  log(`=== COCOK (${matched.length}) ===`);
  for (const m of matched) {
    const flag = m.net < 0 ? '  <-- SALDO NEGATIF' : (m.mixedUnits ? '  <-- satuan campur: ' + m.units : '');
    log(`  ${m.labels.padEnd(34).slice(0, 34)} -> ${String(m.sap.sapropdi_name).padEnd(28).slice(0, 28)} ${fmt(m.net).padStart(12)}${flag}`);
  }

  if (ambiguous.length) {
    log(`\n=== BERMAKNA GANDA (${ambiguous.length}) — dilewati, butuh keputusan ===`);
    for (const a of ambiguous) {
      log(`  "${a.labels}" (saldo ${fmt(a.net)} ${a.units}) cocok ke ${a.options.length} baris master:`);
      a.options.forEach((o) => log(`      - [${o.id}] ${o.sapropdi_name}`));
    }
  }

  if (missing.length) {
    log(`\n=== TIDAK ADA DI MASTER (${missing.length}) — dilewati ===`);
    for (const m of missing) log(`  "${m.labels}" (saldo ${fmt(m.net)} ${m.units})`);
  }

  const negatives = matched.filter((m) => m.net < 0);
  if (negatives.length) {
    log(`\n=== PERHATIAN: ${negatives.length} barang bersaldo NEGATIF menurut spreadsheet ===`);
    log('  Spreadsheet-nya sendiri mencatat keluar lebih banyak daripada masuk, jadi');
    log('  saldonya bukan jumlah yang bisa ada di rak. Baris ini TIDAK diikutkan:');
    negatives.forEach((m) => log(`    ${m.labels}: ${fmt(m.net)}`));
  }

  const usable = matched.filter((m) => m.net >= 0);
  log(`\n=== RINGKASAN ===`);
  log(`  akan masuk opname : ${usable.length} barang`);
  log(`  dilewati          : ${ambiguous.length} ganda + ${missing.length} tak dikenal + ${negatives.length} negatif`);

  if (!APPLY) {
    log('\nDRY RUN — belum ada yang ditulis. Tambahkan --apply untuk membuat dokumen opname.');
    log('Opname yang dibuat TIDAK langsung mengubah stok: buka dokumennya di layar,');
    log('periksa selisihnya, lalu tekan "Sesuaikan Stok" bila memang mau diikuti.');
    await conn.end();
    return;
  }

  if (!usable.length) { console.error('\nTidak ada baris yang bisa dimasukkan.'); process.exit(1); }

  // ── tulis opname ──────────────────────────────────────────────────────────
  // Lewat SQL langsung dan bukan lewat API karena ini pemuatan data sekali jalan;
  // aturan 30 hari tetap dihormati supaya impor ini tidak jadi pintu belakang.
  const [[last]] = await conn.query(
    'SELECT opname_number, opname_date, ABS(DATEDIFF(?, opname_date)) AS gap'
    + ' FROM stock_opname WHERE warehouse_id = ? ORDER BY gap ASC LIMIT 1', [DATE, WAREHOUSE]);
  if (last && Number(last.gap) < 30) {
    console.error(`\nDITOLAK: gudang ini sudah diopname ${String(last.opname_date).slice(0, 10)} `
      + `(${last.opname_number}), jaraknya ${last.gap} hari. Satu gudang satu opname per 30 hari.`);
    process.exit(1);
  }

  const [[seq]] = await conn.query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(opname_number, '-', -1) AS UNSIGNED)), 0) + 1 AS n"
    + ' FROM stock_opname WHERE opname_number LIKE ?', [`OPN-${DATE.slice(0, 4)}-%`]);
  const number = `OPN-${DATE.slice(0, 4)}-${String(seq.n).padStart(4, '0')}`;

  await conn.beginTransaction();
  try {
    const [res] = await conn.query(
      'INSERT INTO stock_opname (opname_number, opname_date, warehouse_id, counted_by_user_id, notes, created_at, updated_at)'
      + ' VALUES (?,?,?,NULL,?,NOW(),NOW())',
      [number, DATE, WAREHOUSE,
       `Impor sheet "${SHEET}" dari ${path.basename(FILE)} — saldo per barang menurut spreadsheet lapangan`]);
    const id = res.insertId;

    // Angka sistem diambil dari view, sama seperti kalau lembar hitungnya dibuka
    // di layar, supaya selisih yang tampil nanti adalah selisih yang sebenarnya.
    const [stockRows] = await conn.query(
      'SELECT sapropdi_id, COALESCE(remaining, 0) AS remaining FROM v_saprodi_stock WHERE warehouse_id = ?',
      [WAREHOUSE]);
    const system = new Map(stockRows.map((r) => [Number(r.sapropdi_id), Number(r.remaining)]));

    for (const m of usable) {
      await conn.query(
        'INSERT INTO stock_opname_items (stock_opname_id, sapropdi_id, system_qty, counted_qty, unit_id, remarks, created_at, updated_at)'
        + ' VALUES (?,?,?,?,?,?,NOW(),NOW())',
        [id, m.sap.id, system.get(Number(m.sap.id)) || 0, m.net, m.sap.unit_id || null,
         `dari spreadsheet: ${m.labels}`.slice(0, 255)]);
    }
    await conn.commit();
    log(`\nOpname ${number} dibuat (id ${id}) dengan ${usable.length} baris.`);
    log('BELUM mengubah stok. Buka /warehouse/opname di aplikasi, periksa selisihnya,');
    log('lalu tekan "Sesuaikan Stok" kalau angka spreadsheet memang yang mau diikuti.');
  } catch (e) {
    await conn.rollback();
    throw e;
  }

  await conn.end();
})().catch((e) => {
  console.error('\nImpor GAGAL:', e.message);
  process.exit(1);
});
