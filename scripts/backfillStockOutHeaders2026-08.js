// -----------------------------------------------------------------------------
// Backfill: give historical distributions a Stock Out header (2026-08)
//
// Saprodi distributions recorded before Stock Out existed have no header, so they
// never appear on the Stock Out screen even though they are exactly what it lists:
// goods that left a warehouse for a farmer.
//
// This groups them by (warehouse, date) and issues one header per group. That is
// the most a reconstruction can honestly claim — the real documents were never
// filed, and nothing in the data says which issues were handed over together.
//
// Reconstructed headers are numbered SOH-YYYY-NNNN, not SO-, and carry a note
// saying so. Do not let them read as documents somebody actually issued: no one
// signed them, and the grouping is inferred.
//
// Rows with no warehouse are left alone. There is no honest warehouse to file them
// under, and inventing one would move stock that never moved.
//
// Requires migrateWarehouseStock2026-08.js and migrateStockOut2026-08.js.
// Idempotent: only touches rows whose stock_out_id is still NULL.
//
// Usage:
//   node scripts/backfillStockOutHeaders2026-08.js            # dry run
//   node scripts/backfillStockOutHeaders2026-08.js --apply    # actually write
//
// BACK UP THE DATABASE FIRST — and check the dump is not empty:
//   mysqldump -u agro -p agro_supply > backup.sql && ls -lh backup.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);

const NOTE = 'Dibuat otomatis dari distribusi lama (sebelum fitur Stock Out ada). '
  + 'Pengelompokan berdasarkan gudang + tanggal, bukan dokumen asli.';

async function hasTable(conn, table) {
  const [r] = await conn.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1', [DB, table]);
  return r.length > 0;
}
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
    multipleStatements: true,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written.');
  log(`  database: ${DB}`);

  if (!(await hasTable(conn, 'stock_out')) || !(await hasColumn(conn, 'pre_finance_distributions', 'stock_out_id'))) {
    log('\n✗ stock_out / stock_out_id missing. Run scripts/migrateStockOut2026-08.js --apply first.');
    await conn.end();
    process.exit(1);
  }

  // -- 1. what can be grouped -------------------------------------------------
  step(1, 'group orphaned distributions by warehouse + date');
  const [groups] = await conn.query(
    `SELECT d.warehouse_id, d.date, w.warehouse_name,
            COUNT(*) AS lines_n, SUM(d.quantity) AS qty, SUM(d.total_amount) AS amount
     FROM pre_finance_distributions d
     JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
     LEFT JOIN warehouse w    ON w.id = d.warehouse_id
     WHERE d.stock_out_id IS NULL
       AND d.warehouse_id IS NOT NULL
       AND d.sapropdi_id IS NOT NULL
       AND t.type_name = 'Saprodi'
     GROUP BY d.warehouse_id, d.date, w.warehouse_name
     ORDER BY d.date ASC, d.warehouse_id ASC`);

  if (!groups.length) {
    log('   · nothing to do — every attributable distribution already has a header');
  } else {
    const totalLines = groups.reduce((s, g) => s + Number(g.lines_n), 0);
    log(`   ${groups.length} header(s) would cover ${totalLines} line(s)`);
    for (const g of groups.slice(0, 8)) {
      log(`     ${g.date}  ${g.warehouse_name ?? `#${g.warehouse_id}`}  ${g.lines_n} baris, ${g.qty} unit`);
    }
    if (groups.length > 8) log(`     … and ${groups.length - 8} more`);
  }

  // -- 2. issue the headers ---------------------------------------------------
  step(2, 'create SOH- headers');
  // Numbering continues from whatever reconstructed headers already exist, so a
  // re-run never reuses a number.
  const seqByYear = new Map();
  for (const g of groups) {
    const year = new Date(g.date).getFullYear();
    if (!seqByYear.has(year)) {
      const [[row]] = await conn.query(
        "SELECT COUNT(*) n FROM stock_out WHERE stock_out_number LIKE ?", [`SOH-${year}-%`]);
      seqByYear.set(year, Number(row.n));
    }
    const seq = seqByYear.get(year) + 1;
    seqByYear.set(year, seq);
    const number = `SOH-${year}-${String(seq).padStart(4, '0')}`;

    if (!APPLY) continue;
    const [res] = await conn.query(
      `INSERT INTO stock_out (stock_out_number, stock_out_date, warehouse_id, issued_by_user_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, NOW(), NOW())`,
      [number, g.date, g.warehouse_id, NOTE]);
    const id = res.insertId;
    await conn.query(
      `UPDATE pre_finance_distributions d
       JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
       SET d.stock_out_id = ?, d.updated_at = NOW()
       WHERE d.stock_out_id IS NULL
         AND d.warehouse_id = ? AND d.date = ?
         AND d.sapropdi_id IS NOT NULL
         AND t.type_name = 'Saprodi'`,
      [id, g.warehouse_id, g.date]);
  }
  log(APPLY ? `   + ${groups.length} header(s) created` : '   · dry run — nothing written');

  // -- 3. what stays out ------------------------------------------------------
  step(3, 'distributions that cannot be grouped');
  const [[left]] = await conn.query(
    `SELECT COUNT(*) n, COALESCE(SUM(d.quantity), 0) qty
     FROM pre_finance_distributions d
     JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
     WHERE d.stock_out_id IS NULL AND d.warehouse_id IS NULL
       AND d.sapropdi_id IS NOT NULL AND t.type_name = 'Saprodi'`);
  if (!Number(left.n)) {
    log('   · none');
  } else {
    log(`   ! ${left.n} saprodi line(s), ${left.qty} unit(s), still have no warehouse.`);
    log('     They stay off the Stock Out screen and out of the stock figures until one is set.');
    log('     Fix them first (see migrateWarehouseStock2026-08.js step 4), then re-run this.');
  }

  await conn.end();
  log(APPLY ? '\n✓ Backfill applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Backfill failed:', e.message); process.exit(1); });
