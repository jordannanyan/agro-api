// -----------------------------------------------------------------------------
// Berita Acara Stock Opname Pupuk JNBS, 29 September 2026 -> satu stok opname.
//
// Sumber: "260929_Stock Opname Pupuk September.docx" (pemeriksa Nanda Sukma,
// disetujui Eren Efendi). Sama seperti impor SNBS (importStockCardOpname2026-09.js):
// skrip ini hanya MEMBUAT dokumen opname, tidak menulis stok. Stok baru berubah
// saat seseorang menekan "Sesuaikan Stok" di layar.
//
// Berita acara ditulis dalam satuan lapangan (pack, sak, botol per ukuran), jadi
// pemetaan ke master dan konversi satuannya ditulis tangan di bawah, bukan
// dicocokkan otomatis. Barang dipetakan ke baris master yang memang memuat riwayat
// keluar-masuk gudang JNBS, supaya penyesuaiannya menutup saldo yang benar.
// Pencocokan lewat NAMA master (bukan id) karena id lokal dan produksi bisa beda.
//
// Usage:
//   node scripts/importBeritaAcaraOpnameJnbs2026-09.js
//   node scripts/importBeritaAcaraOpnameJnbs2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DATE = '2026-09-29';
const WAREHOUSE_NAME = 'KTH AML';
const SOURCE = '260929_Stock Opname Pupuk September.docx';

const log = (...a) => console.log(...a);
const fmt = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 3 });

// Beberapa baris berita acara jatuh ke satu barang master; jumlahnya dijumlahkan.
const ROWS = [
  { no: 1, label: 'Urea (50kg/sak)', counted: '800 Kg', master: 'UREA (Fertilizer)', qty: 800 },
  { no: 2, label: 'Fertiphos (50kg/sak)', counted: '1375 Kg', master: 'FERTIPHOS', qty: 1375 },
  { no: 3, label: 'KCL (50kg/sak)', counted: '800 Kg', master: 'KCL (Fertilizer)', qty: 800 },
  { no: 4, label: 'Kieserit (50 kg/sak)', counted: '100 Kg', master: 'KIESERIT (Fertilizer)', qty: 100 },
  { no: 5, label: 'ZN (1kg/pack)', counted: '25 Pack', master: 'ZN (Fertilizer)', qty: 25 },
  { no: 6, label: 'NPK (50kg/sak)', counted: '50 Kg', master: 'NPK (Fertilizer)', qty: 50 },
  { no: 7, label: 'ZA (50kg/sak)', counted: '50 Kg', master: 'ZA (Fertilizer)', qty: 50 },
  { no: 8, label: 'Manzate (1 Kg/pack)', counted: '3 pack dan 500 gr', master: 'MANZATE (Fungicide)', qty: 3500 },
  { no: 9, label: 'Asam Humat (1 kg/pack)', counted: '4 Pack', master: 'ASAM HUMAT (Fungiside)', qty: 4 },
  { no: 10, label: 'Starban 400 ml', counted: '3200 ml', master: 'STARBAN (Insecticide)', qty: 3200 },
  { no: 11, label: 'Polytron 500 ml', counted: '0 ml', master: 'POLITRON (Adjuvant/Perekat)', qty: 0 },
  { no: 12, label: 'Starban 100 ml', counted: '1600 ml', master: 'STARBAN (Insecticide)', qty: 1600 },
  { no: 13, label: 'Blaze Natura (1 Box/20 pcs)', counted: '58 Pcs', master: 'BLAZE NATURA (Fertilizer)', qty: 58 },
  { no: 14, label: 'Gramaxone 1 Liter', counted: '1000 ml', master: 'GRAMAXONE', qty: 1000 },
  { no: 15, label: 'Polytron 1 liter', counted: '3000 ml', master: 'POLITRON (Adjuvant/Perekat)', qty: 3000 },
  { no: 16, label: 'Starban 1 liter', counted: '1000 ml', master: 'STARBAN (Insecticide)', qty: 1000 },
  { no: 17, label: 'Roundup', counted: '3000 ml', master: 'ROUNDUP', qty: 3000 },
  { no: 18, label: 'Primosid Gliotricho (Trichoderma)', counted: '7 Pack', master: 'TRICODHERMA', qty: 7 },
  { no: 19, label: 'Rafia', counted: '12 Roll', master: 'RAFIA', qty: 12 },
  { no: 20, label: 'Tali Strap', counted: '1 Roll', master: 'TALI STRAP', qty: 1 },
  { no: 21, label: 'Trichoderma', counted: '5 Pack', master: 'TRICODHERMA', qty: 5 },
  // Satuan tidak bisa dikonversi tanpa menebak isi kemasannya — dilewati.
  { no: 22, label: 'BioAstral', counted: '1 Liter', master: null, skip: 'master BIO ASTRAL bersatuan Botol, ukuran botol tidak diketahui' },
  { no: 23, label: 'Dolomit', counted: '14 Sak', master: null, skip: 'master DOLOMITE bersatuan Kg, berat per sak tidak tertulis' },
];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agro_supply',
  });

  const [whRows] = await conn.query('SELECT id, warehouse_name FROM warehouse WHERE warehouse_name = ?', [WAREHOUSE_NAME]);
  if (whRows.length !== 1) { console.error(`Gudang "${WAREHOUSE_NAME}" ditemukan ${whRows.length} kali.`); process.exit(1); }
  const WAREHOUSE = whRows[0].id;

  log('\n=== Berita Acara Stock Opname JNBS -> stok opname ===');
  log(`sumber : ${SOURCE}`);
  log(`gudang : ${WAREHOUSE_NAME} (id ${WAREHOUSE})`);
  log(`tanggal: ${DATE}`);
  log(APPLY ? 'MODE   : APPLY (membuat dokumen opname)\n' : 'MODE   : DRY RUN (tidak menulis apa pun)\n');

  const [stockRows] = await conn.query(
    'SELECT sapropdi_id, COALESCE(remaining, 0) AS remaining FROM v_saprodi_stock WHERE warehouse_id = ?', [WAREHOUSE]);
  const system = new Map(stockRows.map((r) => [Number(r.sapropdi_id), Number(r.remaining)]));

  const items = new Map();   // sapropdi_id -> { sap, qty, sources[] }
  for (const r of ROWS.filter((x) => !x.skip)) {
    const [hit] = await conn.query(
      'SELECT s.id, s.sapropdi_name, s.unit_id, COALESCE(u.unit_name, s.unit) AS unit_name'
      + ' FROM sapropdi s LEFT JOIN units u ON u.id = s.unit_id WHERE s.sapropdi_name = ?', [r.master]);
    if (hit.length !== 1) { console.error(`Master "${r.master}" ditemukan ${hit.length} kali — berhenti.`); process.exit(1); }
    const sap = hit[0];
    if (!items.has(sap.id)) items.set(sap.id, { sap, qty: 0, sources: [] });
    const it = items.get(sap.id);
    it.qty += r.qty;
    it.sources.push(`${r.no}. ${r.label}: ${r.counted}`);
  }

  log('=== MASUK OPNAME ===');
  log(`  ${'barang master'.padEnd(30)} ${'sistem'.padStart(12)} ${'fisik'.padStart(10)} ${'selisih'.padStart(12)}  satuan`);
  for (const it of items.values()) {
    const sys = system.get(Number(it.sap.id)) || 0;
    log(`  ${it.sap.sapropdi_name.padEnd(30).slice(0, 30)} ${fmt(sys).padStart(12)} ${fmt(it.qty).padStart(10)} ${fmt(it.qty - sys).padStart(12)}  ${it.sap.unit_name || '-'}`);
    if (it.sources.length > 1) it.sources.forEach((s) => log(`      ← ${s}`));
  }
  const skipped = ROWS.filter((x) => x.skip);
  log(`\n=== DILEWATI (${skipped.length}) ===`);
  skipped.forEach((r) => log(`  ${r.no}. ${r.label} (${r.counted}) — ${r.skip}`));

  if (!APPLY) {
    log('\nDRY RUN — belum ada yang ditulis. Tambahkan --apply untuk membuat dokumen opname.');
    await conn.end();
    return;
  }

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

  const notes = `Berita Acara Stock Opname Pupuk ${SOURCE} — pemeriksa Nanda Sukma (Agronomist Intern),`
    + ' disetujui Eren Efendi (Supervisor/Coor. Site). Dilewati: '
    + skipped.map((r) => `${r.label} ${r.counted} (${r.skip})`).join('; ');

  await conn.beginTransaction();
  try {
    const [res] = await conn.query(
      'INSERT INTO stock_opname (opname_number, opname_date, warehouse_id, counted_by_user_id, notes, created_at, updated_at)'
      + ' VALUES (?,?,?,NULL,?,NOW(),NOW())', [number, DATE, WAREHOUSE, notes]);
    const id = res.insertId;
    for (const it of items.values()) {
      await conn.query(
        'INSERT INTO stock_opname_items (stock_opname_id, sapropdi_id, system_qty, counted_qty, unit_id, remarks, created_at, updated_at)'
        + ' VALUES (?,?,?,?,?,?,NOW(),NOW())',
        [id, it.sap.id, system.get(Number(it.sap.id)) || 0, it.qty, it.sap.unit_id || null,
         `berita acara: ${it.sources.join('; ')}`.slice(0, 255)]);
    }
    await conn.commit();
    log(`\nOpname ${number} dibuat (id ${id}) dengan ${items.size} baris.`);
    log('BELUM mengubah stok. Buka /warehouse/opname, periksa selisihnya, lalu tekan "Sesuaikan Stok".');
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  await conn.end();
})().catch((e) => {
  console.error('\nImpor GAGAL:', e.message);
  process.exit(1);
});
