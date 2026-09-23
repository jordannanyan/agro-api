// -----------------------------------------------------------------------------
// Migration: penerimaan Draft tidak lagi dihitung sebagai stok (2026-09)
//
// `v_saprodi_stock` menjumlahkan SEMUA baris stock_in tanpa melihat statusnya, jadi
// stok bertambah begitu formulir disimpan — bahkan saat masih Draft. Akibatnya
// kolom `status` pada stock_in cuma hiasan sejauh menyangkut angka stok, dan aturan
// "surat jalan wajib sebelum diposting" menjaga sesuatu yang sudah tidak menentukan
// apa pun: barangnya sudah terhitung ada sebelum penjaganya sempat bicara.
//
// View-nya dibuat ulang supaya hanya menghitung penerimaan yang bukan Draft.
//
// Skrip ini SENGAJA melaporkan berapa banyak yang berubah sebelum menulis: kalau di
// basis data ini ada penerimaan Draft, angka stoknya akan turun setelah migrasi, dan
// itu harus terlihat lebih dulu — bukan ditemukan orang gudang minggu depan.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateDraftStockNotCounted2026-09.js            # dry run
//   node scripts/migrateDraftStockNotCounted2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(`\n=== Migrasi: penerimaan Draft tidak dihitung sebagai stok — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const [[cur]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.VIEWS"
    + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'v_saprodi_stock'", [DB]);
  if (!cur.n) {
    log('  view v_saprodi_stock tidak ada di database ini — tidak ada yang bisa diperbarui.');
    await conn.end();
    return;
  }

  const [[already]] = await conn.query(
    "SELECT VIEW_DEFINITION LIKE '%Draft%' AS done FROM information_schema.VIEWS"
    + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'v_saprodi_stock'", [DB]);

  // Dampaknya, sebelum apa pun ditulis.
  const [drafts] = await conn.query(
    "SELECT si.warehouse_id, w.warehouse_name, sii.sapropdi_id, s.sapropdi_name,"
    + " SUM(sii.received_qty) AS qty_draft"
    + " FROM stock_in si"
    + " JOIN stock_in_items sii ON sii.stock_in_id = si.id"
    + " LEFT JOIN warehouse w ON w.id = si.warehouse_id"
    + " LEFT JOIN sapropdi s  ON s.id = sii.sapropdi_id"
    + " WHERE COALESCE(si.status, '') = 'Draft' AND sii.sapropdi_id IS NOT NULL"
    + " GROUP BY si.warehouse_id, w.warehouse_name, sii.sapropdi_id, s.sapropdi_name"
    + " ORDER BY qty_draft DESC");

  if (!drafts.length) {
    log('  Tidak ada penerimaan berstatus Draft — tidak ada angka stok yang berubah.');
  } else {
    log(`  PERHATIAN: ${drafts.length} baris stok akan TURUN karena penerimaannya masih Draft:`);
    for (const d of drafts.slice(0, 20)) {
      log(`    ${d.warehouse_name} · ${d.sapropdi_name}: -${d.qty_draft}`);
    }
    if (drafts.length > 20) log(`    … dan ${drafts.length - 20} baris lagi`);
    log('  Angka itu memang tidak pernah benar — barangnya belum diposting. Tapi orang');
    log('  gudang akan melihat stoknya berubah, jadi beri tahu mereka.');
  }

  if (already.done) {
    log('\n  view sudah memfilter Draft — dilewati.');
  } else if (!APPLY) {
    log('\n  view akan dibuat ulang agar hanya menghitung penerimaan non-Draft.');
    log('  Jalankan ulang dengan --apply untuk menerapkannya.');
  } else {
    const views = fs.readFileSync(path.join(__dirname, '..', 'db', 'views.sql'), 'utf8');
    // Hanya view ini yang disentuh: file views.sql memuat beberapa view, dan
    // membuat ulang semuanya di produksi adalah risiko yang tidak perlu diambil
    // untuk satu perubahan.
    const m = views.match(/DROP VIEW IF EXISTS `v_saprodi_stock`;[\s\S]*?(?=\n\s*(?:DROP VIEW|--\s*={3,})|$)/);
    if (!m) throw new Error('definisi v_saprodi_stock tidak ditemukan di db/views.sql');
    await conn.query(m[0]);
    log('\n  view v_saprodi_stock dibuat ulang dari db/views.sql.');
  }

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
