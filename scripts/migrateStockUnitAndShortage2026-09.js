// -----------------------------------------------------------------------------
// Migration: satuan di stok saprodi (2026-09)
//
// `v_saprodi_stock` reported quantities with no unit beside them, so the inventory
// screen said "40" and left the reader to guess whether that was 40 sacks, 40 kilos
// or 40 litres. The item master has carried `unit_id` all along; the view simply
// never joined it.
//
// A view, so there is no data to migrate — it is dropped and recreated from
// db/views.sql. Safe to run any number of times.
//
// Usage:
//   node scripts/migrateStockUnitAndShortage2026-09.js            # dry run
//   node scripts/migrateStockUnitAndShortage2026-09.js --apply
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

  log(`\n=== Migrasi satuan pada v_saprodi_stock — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'v_saprodi_stock'`, [DB]);
  const names = cols.map((c) => c.COLUMN_NAME);

  let changes = 0;
  if (names.includes('unit_name')) {
    log('  v_saprodi_stock sudah memuat unit_name — dilewati');
  } else {
    log('  v_saprodi_stock akan dibuat ulang dengan unit_id + unit_name');
    changes++;
    if (APPLY) {
      // Taken from db/views.sql rather than repeated here, so the view a migrated
      // database ends up with is byte-for-byte the one a clean install creates.
      const file = path.join(__dirname, '..', 'db', 'views.sql');
      const sql = fs.readFileSync(file, 'utf8');
      const m = sql.match(/DROP VIEW IF EXISTS `v_saprodi_stock`;[\s\S]*?;\s*(?=DROP VIEW|$)/);
      if (!m) throw new Error('definisi v_saprodi_stock tidak ditemukan di db/views.sql');
      await conn.query(`USE \`${DB}\``);
      await conn.query(m[0]);
      log('   dibuat ulang');
    }
  }

  if (APPLY && changes) {
    const [[chk]] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.columns'
      + " WHERE table_schema = ? AND table_name = 'v_saprodi_stock' AND column_name = 'unit_name'", [DB]);
    log(chk.n ? '   terverifikasi: kolom unit_name ada' : '   PERINGATAN: unit_name tidak muncul');
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
