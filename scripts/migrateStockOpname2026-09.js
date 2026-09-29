// -----------------------------------------------------------------------------
// Migration: modul stok opname (2026-09)
//
// `stock_opnames` + `opname_types` pernah ada di skema lama dan DIBUANG saat
// normalisasi, dengan alasan yang jujur waktu itu: "tidak ada modul verifikasi
// fisik". Sekarang modulnya ada, jadi tabelnya kembali — bentuk baru, bukan yang
// lama dihidupkan: satu header per gudang per hitungan, satu baris per barang,
// membawa angka sistem SEBAGAI POTRET di samping angka fisiknya.
//
// Opname TIDAK mengubah stok. Stok di sistem ini terhitung (masuk − keluar), dan
// menimpanya lewat opname akan membuat ada perubahan stok yang tidak punya dokumen
// penjelas. Yang dicatat di sini adalah selisihnya, untuk ditindaklanjuti.
//
// DDL-nya dibaca dari db/schema.sql, bukan diketik ulang di sini: dua salinan DDL
// yang sama adalah dua salinan yang akan berbeda suatu hari, dan install bersih
// wajib identik dengan basis data yang dimigrasikan.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateStockOpname2026-09.js            # dry run
//   node scripts/migrateStockOpname2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

/**
 * Ambil satu blok CREATE TABLE dari schema.sql, apa adanya.
 *
 * Dicari lewat indeks, bukan regex: pola dengan escape berlapis gampang salah tulis
 * dan gagalnya diam — regex yang keliru hanya "tidak cocok", dan itu terbaca seperti
 * tabelnya tidak ada.
 */
function ddlFor(schema, table) {
  const head = 'CREATE TABLE `' + table + '` (';
  const i = schema.indexOf(head);
  if (i < 0) throw new Error(`DDL untuk \`${table}\` tidak ditemukan di db/schema.sql`);
  const tail = ') ENGINE=InnoDB;';
  const j = schema.indexOf(tail, i);
  if (j < 0) throw new Error(`Penutup DDL \`${table}\` tidak ditemukan di db/schema.sql`);
  return schema.slice(i, j + tail.length);
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(`\n=== Migrasi modul stok opname — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  let changes = 0;

  // Urutan penting: baris menunjuk header lewat foreign key.
  for (const table of ['stock_opname', 'stock_opname_items']) {
    const [[exists]] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [DB, table]);
    if (exists.n) {
      const [cols] = await conn.query('SHOW COLUMNS FROM `' + table + '`');
      log(`  tabel \`${table}\` sudah ada (${cols.length} kolom) — dilewati`);
      continue;
    }
    log(`  tabel \`${table}\` akan dibuat dari db/schema.sql`);
    changes++;
    if (APPLY) {
      await conn.query(ddlFor(schema, table));
      log(`   dibuat`);
    }
  }

  // ENUM document_type harus memuat 'StockOpname' SEBELUM ada yang menulisnya.
  //
  // Ini bukan kehati-hatian teoretis: migrasi September lalu menulis 'Expense' ke
  // ENUM yang belum memuatnya, dan karena MySQL di sini berjalan tanpa STRICT,
  // nilainya tersimpan sebagai string kosong sementara API menjawab "berhasil".
  // Delapan rute approval dan satu lampiran mendarat di tempat yang tidak bisa
  // dibaca lagi. Jadi: diperluas lebih dulu, bukan sesudah.
  log('');
  for (const table of ['document_attachments', 'document_activities']) {
    const [[dt]] = await conn.query(
      "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS"
      + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'document_type'",
      [DB, table]);
    if (!dt) { log(`  ${table}: tidak ada di database ini - dilewati`); continue; }
    if (!/^enum/i.test(dt.t)) { log(`  ${table}.document_type = ${dt.t} - bukan ENUM, aman`); continue; }
    if (/'StockOpname'/.test(dt.t)) { log(`  ${table}.document_type sudah memuat 'StockOpname' - dilewati`); continue; }
    log(`  ${table}.document_type akan diperluas dengan 'StockOpname'`);
    changes++;
    if (APPLY) {
      const widened = dt.t.replace(/^enum\(/i, '').replace(/\)$/, '') + ",'StockOpname'";
      await conn.query('ALTER TABLE `' + table + '` MODIFY `document_type` ENUM(' + widened + ') NOT NULL');
      log('   diperluas');
    }
  }

  // Perbaikan, bukan pencegahan: kalau pernah ada baris yang terlanjur tersimpan
  // dengan document_type kosong, ia tidak akan pernah terbaca lagi dan hanya
  // menumpuk. Dilaporkan saja, tidak dihapus diam-diam.
  for (const table of ['document_attachments', 'document_activities']) {
    const [rowsBad] = await conn.query(
      'SELECT COUNT(*) AS n FROM `' + table + "` WHERE document_type = ''");
    const n = Number(rowsBad[0].n || 0);
    if (n) log(`  PERHATIAN: ${n} baris ${table} bertipe kosong - sisa penulisan yang gagal diam-diam.`);
  }

  log('');
  if (!changes) log('Tidak ada yang perlu diubah — database sudah sesuai.');
  else if (!APPLY) log(`${changes} perubahan menunggu. Jalankan ulang dengan --apply untuk menerapkannya.`);
  else log(`${changes} perubahan diterapkan.`);

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
