// -----------------------------------------------------------------------------
// Migration: Stock Out as a warehouse document (2026-08)
//
// Goods left the warehouse through two unrelated screens — "Distribusi" under
// Pre-Finance and "Operational Investment" under Profit Sharing — and neither was
// a warehouse document. The warehouse keeper had no single place to issue stock,
// and Profit Sharing never touched stock at all.
//
// Stock Out becomes that one place. It mirrors Stock In: one header per issue,
// many lines, one warehouse.
//
// The lines keep living in pre_finance_distributions. That table is what the
// farmer's outstanding balance is computed from, so moving rows out of it would
// change every debt figure in the system. It gains a link to its header instead.
//
//   1. stock_out — new header table
//   2. pre_finance_distributions — add stock_out_id + FK
//
// Requires migrateWarehouseStock2026-08.js to have run first (warehouse_id).
// Both steps are idempotent.
//
// Usage:
//   node scripts/migrateStockOut2026-08.js            # dry run: report only
//   node scripts/migrateStockOut2026-08.js --apply    # actually write
//
// BACK UP THE DATABASE FIRST:
//   mysqldump -u agro -p agro_supply > backup-before-stockout-2026-08.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);

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
async function hasConstraint(conn, table, name) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`, [DB, table, name]);
  return r.length > 0;
}

const STOCK_OUT_DDL = `
CREATE TABLE \`stock_out\` (
  \`id\` INT(11) NOT NULL AUTO_INCREMENT,
  \`stock_out_number\` VARCHAR(60) NOT NULL,
  \`stock_out_date\` DATE NOT NULL,
  \`warehouse_id\` INT(11) NOT NULL,
  \`issued_by_user_id\` INT(11) DEFAULT NULL,
  \`notes\` TEXT DEFAULT NULL,
  \`created_at\` DATETIME DEFAULT NULL,
  \`updated_at\` DATETIME DEFAULT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_stock_out_number\` (\`stock_out_number\`),
  KEY \`fk_so_warehouse\` (\`warehouse_id\`),
  KEY \`fk_so_user\` (\`issued_by_user_id\`),
  CONSTRAINT \`fk_so_warehouse\` FOREIGN KEY (\`warehouse_id\`) REFERENCES \`warehouse\` (\`id\`),
  CONSTRAINT \`fk_so_user\` FOREIGN KEY (\`issued_by_user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

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

  if (!(await hasColumn(conn, 'pre_finance_distributions', 'warehouse_id'))) {
    log('\n✗ pre_finance_distributions.warehouse_id is missing.');
    log('  Run scripts/migrateWarehouseStock2026-08.js --apply first — a stock out');
    log('  cannot be recorded against a warehouse that the line does not name.');
    await conn.end();
    process.exit(1);
  }

  // -- 1. the header table ----------------------------------------------------
  step(1, 'stock_out');
  if (await hasTable(conn, 'stock_out')) {
    log('   · already present');
  } else {
    log('   + stock_out (number, date, warehouse, issued_by, notes)');
    if (APPLY) await conn.query(STOCK_OUT_DDL);
  }

  // -- 2. link the lines ------------------------------------------------------
  step(2, 'pre_finance_distributions.stock_out_id');
  if (await hasColumn(conn, 'pre_finance_distributions', 'stock_out_id')) {
    log('   · already present');
  } else {
    log('   + stock_out_id INT NULL AFTER warehouse_id');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `pre_finance_distributions` ADD COLUMN `stock_out_id` INT(11) NULL AFTER `warehouse_id`');
    }
  }
  if (await hasConstraint(conn, 'pre_finance_distributions', 'fk_pfd_stock_out')) {
    log('   · fk_pfd_stock_out already present');
  } else {
    // RESTRICT, not CASCADE: these lines are the farmer's debt. Deleting a header
    // must not quietly erase what a farmer owes, so a header with lines cannot be
    // deleted until the lines are dealt with explicitly.
    log('   + fk_pfd_stock_out -> stock_out(id) ON DELETE RESTRICT');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `pre_finance_distributions` ADD CONSTRAINT `fk_pfd_stock_out` ' +
        'FOREIGN KEY (`stock_out_id`) REFERENCES `stock_out` (`id`) ON DELETE RESTRICT');
    }
  }

  // -- what this leaves behind ------------------------------------------------
  step(3, 'existing distributions');
  const [[old]] = await conn.query(
    `SELECT COUNT(*) n FROM pre_finance_distributions d
     JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
     WHERE t.type_name = 'Saprodi'`);
  log(`   · ${old.n} saprodi distribution(s) predate Stock Out and keep stock_out_id = NULL.`);
  log('     They still count against stock — the link is only for documents issued from now on.');

  await conn.end();
  log(APPLY ? '\n✓ Migration applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
