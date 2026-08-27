// -----------------------------------------------------------------------------
// Migration: processing cost priced per kilo (2026-08)
//
// `processing.total_processing_cost` was a lump sum typed by hand, so nothing
// said what the number was made of and nothing moved it when the batch changed:
// adding a purchase to a batch raised its input volume and left the cost where
// it was.
//
// This adds `processing.processing_cost_per_kg`. When it is set, the total is
// derived — per_kg x volume_input, priced against what went IN, because the
// sorting and drying are done on the material received and the weight lost in
// the process has still cost what it cost. When it is NULL the old behaviour
// stands: a lump sum entered directly.
//
// The 185 imported batches are LEFT ALONE — their totals came from the ledgers
// as single figures and back-computing a per-kilo price would only invite
// rounding drift the next time one of them is saved.
//
// Idempotent. Dry run by default.
//
// Usage:
//   node scripts/migrateProcessingCostPerKg2026-08.js            # dry run
//   node scripts/migrateProcessingCostPerKg2026-08.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });

async function hasColumn(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [DB, table, column]);
  return r.length > 0;
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written.');
  log(`  database: ${DB}`);

  log('\n1) processing.processing_cost_per_kg');
  if (await hasColumn(conn, 'processing', 'processing_cost_per_kg')) {
    log('   · already present');
  } else {
    log('   + `processing_cost_per_kg` DECIMAL(15,2) NULL AFTER `volume_output`');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `processing` ADD COLUMN `processing_cost_per_kg` DECIMAL(15,2) NULL AFTER `volume_output`');
    }
  }

  const [[before]] = await conn.query(
    `SELECT COUNT(*) AS batches,
            SUM(total_processing_cost > 0) AS with_cost,
            COALESCE(SUM(total_processing_cost), 0) AS total
     FROM processing`);
  log(`\n   ${before.batches} batch · ${before.with_cost} punya biaya · total ${rupiah(before.total)}`);
  log('   Angka lama tidak disentuh: kolom baru NULL, totalnya tetap seperti yang tercatat.');
  log('   Biaya per Kg berlaku untuk batch yang diisi mulai sekarang.');

  await conn.end();
  log(APPLY
    ? '\n✓ Migration applied.'
    : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
