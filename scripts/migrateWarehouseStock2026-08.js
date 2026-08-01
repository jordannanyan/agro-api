// -----------------------------------------------------------------------------
// Migration: warehouse-scoped stock out (2026-08)
//
// `v_saprodi_stock` builds one row per warehouse x saprodi, but its OUT subquery
// was keyed on sapropdi alone. With two warehouses that means every distribution
// is subtracted from BOTH of them: 100 kg issued once reads as 200 kg gone. The
// IN side was already warehouse-scoped, so only OUT drifts, and it drifts by a
// factor equal to the number of warehouses.
//
// The cause is that a distribution never recorded which warehouse it left. This
// adds that column, backfills it from the farmer's KTH, and rebuilds the view so
// both sides are scoped the same way.
//
//   1. pre_finance_distributions — add warehouse_id + FK
//   2. backfill warehouse_id via farmers.kth_id -> warehouse.kth_id
//   3. rebuild v_saprodi_stock with a warehouse-scoped OUT
//   4. report distributions that could not be attributed
//
// Every step is idempotent; re-running is safe.
//
// Usage:
//   node scripts/migrateWarehouseStock2026-08.js            # dry run: report only
//   node scripts/migrateWarehouseStock2026-08.js --apply    # actually write
//
// BACK UP THE DATABASE FIRST:
//   mysqldump -u agro -p agro_supply > backup-before-warehouse-2026-08.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);

async function hasColumn(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB, table, column]
  );
  return r.length > 0;
}

async function hasConstraint(conn, table, name) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1`,
    [DB, table, name]
  );
  return r.length > 0;
}

const one = async (conn, sql, args = []) => {
  const [r] = await conn.query(sql, args);
  return r[0] || {};
};

// The rebuilt view. IN and OUT are now grouped the same way, so a warehouse only
// carries what actually moved through it. Distributions with no warehouse are
// left out rather than smeared across all of them — step 4 reports those.
const VIEW_SQL = `
CREATE OR REPLACE VIEW \`v_saprodi_stock\` AS
SELECT w.id             AS warehouse_id,
       w.warehouse_name AS warehouse_name,
       s.id             AS sapropdi_id,
       s.sapropdi_name  AS sapropdi_name,
       COALESCE(si.total_in, 0)  AS total_in,
       COALESCE(d.total_out, 0)  AS total_out,
       COALESCE(si.total_in, 0) - COALESCE(d.total_out, 0) AS remaining
FROM warehouse w
CROSS JOIN sapropdi s
LEFT JOIN (
  SELECT si.warehouse_id, sii.sapropdi_id, SUM(sii.received_qty) AS total_in
  FROM stock_in si
  JOIN stock_in_items sii ON sii.stock_in_id = si.id
  WHERE sii.sapropdi_id IS NOT NULL
  GROUP BY si.warehouse_id, sii.sapropdi_id
) si ON si.warehouse_id = w.id AND si.sapropdi_id = s.id
LEFT JOIN (
  SELECT pfd.warehouse_id, pfd.sapropdi_id, SUM(pfd.quantity) AS total_out
  FROM pre_finance_distributions pfd
  JOIN pre_finance_types t ON t.id = pfd.pre_finance_type_id
  WHERE pfd.sapropdi_id IS NOT NULL
    AND pfd.warehouse_id IS NOT NULL
    AND t.type_name = 'Saprodi'
  GROUP BY pfd.warehouse_id, pfd.sapropdi_id
) d ON d.warehouse_id = w.id AND d.sapropdi_id = s.id
WHERE si.total_in IS NOT NULL OR d.total_out IS NOT NULL`;

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

  const warehouses = (await one(conn, 'SELECT COUNT(*) n FROM warehouse')).n;
  log(`  ${warehouses} warehouse(s) — OUT is currently counted ${warehouses}x`);

  // -- 1. the missing column --------------------------------------------------
  step(1, 'pre_finance_distributions.warehouse_id');
  if (await hasColumn(conn, 'pre_finance_distributions', 'warehouse_id')) {
    log('   · already present');
  } else {
    log('   + warehouse_id INT NULL AFTER sapropdi_id');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `pre_finance_distributions` ADD COLUMN `warehouse_id` INT(11) NULL AFTER `sapropdi_id`');
    }
  }
  if (await hasConstraint(conn, 'pre_finance_distributions', 'fk_pfd_warehouse')) {
    log('   · fk_pfd_warehouse already present');
  } else {
    log('   + fk_pfd_warehouse -> warehouse(id) ON DELETE SET NULL');
    // Skipped on a dry run: the column it references may not exist yet.
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `pre_finance_distributions` ADD CONSTRAINT `fk_pfd_warehouse` ' +
        'FOREIGN KEY (`warehouse_id`) REFERENCES `warehouse` (`id`) ON DELETE SET NULL');
    }
  }

  // -- 2. backfill ------------------------------------------------------------
  step(2, 'attribute existing distributions to a warehouse');
  // A warehouse belongs to a KTH and so does a farmer, which is the only link
  // the schema offers. Where a KTH runs more than one warehouse the mapping is
  // genuinely ambiguous, so those are reported and left alone.
  const [ambiguous] = await conn.query(
    `SELECT kth_id, COUNT(*) n FROM warehouse WHERE kth_id IS NOT NULL GROUP BY kth_id HAVING n > 1`);
  for (const a of ambiguous) {
    log(`   ! KTH ${a.kth_id} has ${a.n} warehouses — its distributions stay unattributed`);
  }

  const canFill = (await one(conn,
    `SELECT COUNT(*) n
     FROM pre_finance_distributions d
     JOIN farmers f   ON f.id = d.farmer_id
     JOIN warehouse w ON w.kth_id = f.kth_id
     WHERE d.warehouse_id IS NULL
       AND w.kth_id NOT IN (SELECT kth_id FROM (
             SELECT kth_id FROM warehouse WHERE kth_id IS NOT NULL GROUP BY kth_id HAVING COUNT(*) > 1
           ) x)`)).n;
  log(`   ~ ${canFill} distribution(s) can be attributed from the farmer's KTH`);
  if (APPLY && canFill) {
    await conn.query(
      `UPDATE pre_finance_distributions d
       JOIN farmers f   ON f.id = d.farmer_id
       JOIN warehouse w ON w.kth_id = f.kth_id
       SET d.warehouse_id = w.id, d.updated_at = NOW()
       WHERE d.warehouse_id IS NULL
         AND w.kth_id NOT IN (SELECT kth_id FROM (
               SELECT kth_id FROM warehouse WHERE kth_id IS NOT NULL GROUP BY kth_id HAVING COUNT(*) > 1
             ) x)`);
  }

  // -- 3. the view ------------------------------------------------------------
  step(3, 'rebuild v_saprodi_stock');
  log('   ~ OUT grouped by (warehouse_id, sapropdi_id), matching the IN side');
  if (APPLY) await conn.query(VIEW_SQL);
  else log('   · dry run — view left as it is');

  // -- 4. what is still unattributed -----------------------------------------
  step(4, 'distributions still without a warehouse');
  // Only saprodi rows matter: labor and transport never touched stock.
  const left = await one(conn,
    `SELECT COUNT(*) n, COALESCE(SUM(d.quantity), 0) qty
     FROM pre_finance_distributions d
     JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
     WHERE d.warehouse_id IS NULL AND d.sapropdi_id IS NOT NULL AND t.type_name = 'Saprodi'`);
  if (!Number(left.n)) {
    log('   · none — every saprodi distribution is attributed');
  } else {
    log(`   ! ${left.n} saprodi distribution(s), ${left.qty} unit(s), have no warehouse.`);
    log('     They are excluded from OUT, so stock reads HIGHER than reality by that much.');
    log('     Set their warehouse by hand, or give the farmer a KTH that owns one:');
    const [sample] = await conn.query(
      `SELECT d.id, d.date, f.farmer_name, f.kth_id, s.sapropdi_name, d.quantity
       FROM pre_finance_distributions d
       JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
       LEFT JOIN farmers f  ON f.id = d.farmer_id
       LEFT JOIN sapropdi s ON s.id = d.sapropdi_id
       WHERE d.warehouse_id IS NULL AND d.sapropdi_id IS NOT NULL AND t.type_name = 'Saprodi'
       ORDER BY d.date DESC LIMIT 5`);
    for (const r of sample) {
      log(`       #${r.id} ${r.date} ${r.farmer_name ?? '?'} (KTH ${r.kth_id ?? '—'}) ${r.sapropdi_name ?? '?'} x${r.quantity}`);
    }
    if (sample.length < Number(left.n)) log(`       … and ${Number(left.n) - sample.length} more`);
  }

  await conn.end();
  log(APPLY ? '\n✓ Migration applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
