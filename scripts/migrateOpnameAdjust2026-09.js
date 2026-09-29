// -----------------------------------------------------------------------------
// Migration: opsi menyesuaikan stok dari stok opname (2026-09)
//
// Opname dibangun sebagai pencatat selisih saja. Permintaan berikutnya: beri OPSI
// menyesuaikan stoknya kalau selisihnya memang benar. Opsi, bukan otomatis —
// keadaan bakunya tetap "dicatat saja".
//
// Caranya menjaga sifat yang membuat gudang ini bisa ditelusuri: penyesuaiannya
// TIDAK menimpa apa pun. Ia jadi suku ketiga di v_saprodi_stock —
// masuk - keluar + penyesuaian - dan setiap penyesuaian menunjuk balik ke dokumen
// opname yang menyebabkannya, lengkap dengan siapa yang menerapkannya dan kapan.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateOpnameAdjust2026-09.js            # dry run
//   node scripts/migrateOpnameAdjust2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

const COLUMNS = [
  ['stock_opname', 'applied_at', 'ADD COLUMN `applied_at` DATETIME NULL AFTER `notes`'],
  ['stock_opname', 'applied_by_user_id', 'ADD COLUMN `applied_by_user_id` INT NULL AFTER `applied_at`'],
  ['stock_opname_items', 'adjustment', 'ADD COLUMN `adjustment` DECIMAL(15,3) NULL AFTER `counted_qty`'],
];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(`\n=== Migrasi: opsi menyesuaikan stok dari opname — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const [[hasTable]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES"
    + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'stock_opname'", [DB]);
  if (!hasTable.n) {
    log('  tabel stock_opname belum ada — jalankan migrateStockOpname2026-09.js lebih dulu.');
    await conn.end();
    process.exit(1);
  }

  let changes = 0;

  for (const [table, column, clause] of COLUMNS) {
    const [[has]] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS'
      + ' WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [DB, table, column]);
    if (has.n) { log(`  ${table}.${column} sudah ada — dilewati`); continue; }
    log(`  ${table}.${column} akan ditambahkan`);
    changes++;
    if (APPLY) {
      await conn.query('ALTER TABLE `' + table + '` ' + clause);
      log('   ditambahkan');
    }
  }

  // Foreign key dipisah dari ALTER kolomnya supaya bisa dilewati sendiri saat
  // dijalankan ulang.
  const [[hasFk]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS"
    + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'stock_opname'"
    + " AND CONSTRAINT_NAME = 'fk_opname_applier'", [DB]);
  if (hasFk.n) log('  constraint fk_opname_applier sudah ada — dilewati');
  else {
    log('  constraint fk_opname_applier akan ditambahkan');
    changes++;
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `stock_opname` ADD CONSTRAINT `fk_opname_applier`'
        + ' FOREIGN KEY (`applied_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL');
      log('   ditambahkan');
    }
  }

  // View dibuat ulang dari db/views.sql, bukan diketik ulang di sini.
  //
  // Batas akhirnya dicari lewat pernyataan BERIKUTNYA, bukan lewat titik koma
  // pertama: titik koma bisa muncul di tengah komentar SQL, dan pernah muncul —
  // percobaan pertama migrasi ini men-drop view lalu gagal membuatnya kembali,
  // karena DDL-nya terpotong di sebuah komentar berbahasa Indonesia yang kebetulan
  // diakhiri titik koma.
  const views = fs.readFileSync(path.join(__dirname, '..', 'db', 'views.sql'), 'utf8');
  const head = 'DROP VIEW IF EXISTS `v_saprodi_stock`;';
  const i = views.indexOf(head);
  if (i < 0) throw new Error('definisi v_saprodi_stock tidak ditemukan di db/views.sql');
  const nextStmt = views.indexOf('DROP VIEW IF EXISTS', i + head.length);
  const raw = nextStmt < 0 ? views.slice(i) : views.slice(i, nextStmt);
  // Di antara dua pernyataan ada komentar milik pernyataan BERIKUTNYA. Baris
  // komentar dan baris kosong di ekor dibuang sampai yang tersisa benar-benar
  // berakhir pada titik koma penutup.
  const NL = String.fromCharCode(10);
  const kept = raw.split(NL);
  while (kept.length && (kept[kept.length - 1].trim() === ''
                      || kept[kept.length - 1].trim().startsWith('--'))) kept.pop();
  const ddl = kept.join(NL).trimEnd();
  if (!/CREATE VIEW/i.test(ddl) || !ddl.endsWith(';')) {
    throw new Error('potongan DDL v_saprodi_stock tidak utuh - periksa db/views.sql');
  }

  const [[cur]] = await conn.query(
    "SELECT COALESCE(VIEW_DEFINITION, '') AS d FROM information_schema.VIEWS"
    + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'v_saprodi_stock'", [DB]);
  if (cur && /stock_opname/i.test(cur.d)) {
    log('  view v_saprodi_stock sudah memperhitungkan opname — dilewati');
  } else {
    log('  view v_saprodi_stock akan dibuat ulang agar memperhitungkan penyesuaian opname');
    changes++;
    if (APPLY) { await conn.query(ddl); log('   dibuat ulang'); }
  }

  // Sebelum dan sesudah harus SAMA di basis data yang belum punya opname
  // diterapkan: suku ketiganya nol, jadi tidak ada satu angka stok pun yang boleh
  // bergeser karena migrasi ini.
  const [[applied]] = await conn.query(
    "SELECT COUNT(*) AS n FROM stock_opname WHERE applied_at IS NOT NULL")
    .catch(() => [[{ n: 0 }]]);
  log(`\n  opname yang sudah diterapkan saat ini: ${applied.n}`);
  log(applied.n
    ? '  → angka stok akan memperhitungkannya setelah view dibuat ulang.'
    : '  → tidak ada angka stok yang berubah karena migrasi ini.');

  log('');
  if (!changes) log('Tidak ada yang perlu diubah — database sudah sesuai.');
  else if (!APPLY) log(`${changes} perubahan menunggu. Jalankan ulang dengan --apply untuk menerapkannya.`);
  else log(`${changes} perubahan diterapkan.`);

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
