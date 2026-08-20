// -----------------------------------------------------------------------------
// Migration: profit sharing settled per sale, per plot (2026-08)
//
// The profit-sharing report credited every depositor with the WHOLE value of a
// sale. `/pl` joined selling -> processing -> processing_purchasings -> purchasing
// -> plot and then summed `selling.total_revenue`, so one sale was duplicated once
// per deposit in its batch. Against the 19 Aug 2026 production data that turned
// Rp 273.119.023 of real sales into Rp 1.134.207.766 — 4,15x too high — because a
// batch holds up to 7 deposits. Nothing was double-counted in the ledger; the
// report simply had no notion of a share.
//
// The model the process owner asked for splits a sale three ways:
//   layer 1  revenue, processing cost and selling cost — shared per kg, by the
//            plot's contribution to the batch
//   layer 2  saprodi and land cost — carried by that plot alone
//   layer 3  what is left is divided by the entity's percentage
//
// Two of those had nowhere to live: a sale had no cost lines at all, and no table
// held the split percentage. This adds them, plus the columns that let a
// settlement be a snapshot rather than a formula re-evaluated forever.
//
//   1. entities.profit_share_farmer_pct   — the PT's default farmer share
//   2. selling.profit_share_farmer_pct    — per-sale override
//   3. selling_costs                      — freight/sorting/loading per sale
//   4. profit_sharing                     — selling_id, volume + cost breakdown
//   5. report data that the corrected calculation will expose
//
// Every step is idempotent; re-running is safe. No row is rewritten or deleted.
//
// Usage:
//   node scripts/migrateProfitSharing2026-08.js            # dry run: report only
//   node scripts/migrateProfitSharing2026-08.js --apply    # actually write
//
// BACK UP THE DATABASE FIRST:
//   mysqldump -u root -p agro_supply > backup-before-profitsharing-2026-08.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });

async function hasColumn(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB, table, column]
  );
  return r.length > 0;
}

async function hasTable(conn, table) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`, [DB, table]);
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

async function hasIndex(conn, table, name) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB, table, name]
  );
  return r.length > 0;
}

const one = async (conn, sql, args = []) => {
  const [r] = await conn.query(sql, args);
  return r[0] || {};
};

/** Add a column only when it is missing; report either way. */
async function addColumn(conn, table, column, ddl) {
  if (await hasColumn(conn, table, column)) { log(`   · ${table}.${column} already present`); return; }
  log(`   + ${table}.${column}`);
  if (APPLY) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
}

const SELLING_COSTS_SQL = `
CREATE TABLE \`selling_costs\` (
  \`id\`                  INT AUTO_INCREMENT PRIMARY KEY,
  \`selling_id\`          INT NOT NULL,
  \`pre_finance_type_id\` INT NULL,
  \`description\`         VARCHAR(255) NULL,
  \`amount\`              DECIMAL(18,2) NOT NULL DEFAULT 0,
  \`created_at\`          DATETIME NULL,
  \`updated_at\`          DATETIME NULL,
  KEY \`idx_sc_selling\` (\`selling_id\`),
  CONSTRAINT \`fk_sc_selling\` FOREIGN KEY (\`selling_id\`)          REFERENCES \`selling\`(\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`fk_sc_type\`    FOREIGN KEY (\`pre_finance_type_id\`) REFERENCES \`pre_finance_types\`(\`id\`) ON DELETE SET NULL
) ENGINE=InnoDB`;

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

  // -- 1. the entity's default share -----------------------------------------
  step(1, 'entities.profit_share_farmer_pct');
  // Only the farmer's half is stored. Keeping both halves in two columns is what
  // let the old `profit_sharing` rows hold 60 and 30 with nothing objecting.
  await addColumn(conn, 'entities', 'profit_share_farmer_pct',
    '`profit_share_farmer_pct` DECIMAL(5,2) NULL AFTER `entity_type`');

  // -- 2. per-sale override ---------------------------------------------------
  step(2, 'selling.profit_share_farmer_pct');
  await addColumn(conn, 'selling', 'profit_share_farmer_pct',
    '`profit_share_farmer_pct` DECIMAL(5,2) NULL AFTER `price_per_unit`');

  // -- 3. costs that belong to a sale ----------------------------------------
  step(3, 'selling_costs');
  if (await hasTable(conn, 'selling_costs')) {
    log('   · already present');
  } else {
    log('   + selling_costs (selling_id, pre_finance_type_id, description, amount)');
    log('     ON DELETE CASCADE: they are document lines, not standing costs.');
    if (APPLY) await conn.query(SELLING_COSTS_SQL);
  }

  // -- 4. settlement snapshot -------------------------------------------------
  step(4, 'profit_sharing: link to the sale, and record the breakdown');
  await addColumn(conn, 'profit_sharing', 'selling_id',
    '`selling_id` INT NULL AFTER `period`');
  await addColumn(conn, 'profit_sharing', 'volume_share',
    '`volume_share` DECIMAL(15,3) NOT NULL DEFAULT 0 AFTER `commodities_id`');
  await addColumn(conn, 'profit_sharing', 'share_pct',
    '`share_pct` DECIMAL(9,6) NOT NULL DEFAULT 0 AFTER `volume_share`');
  // Stored, not recomputed: a settlement already paid out must not change when
  // someone later edits a cost sheet or the entity's percentage.
  // Chained so they land in the same order as db/schema.sql. Adding them all
  // "AFTER total_revenue" would stack them back to front.
  let prev = 'total_revenue';
  for (const c of ['cost_processing', 'cost_selling', 'cost_saprodi', 'cost_land']) {
    await addColumn(conn, 'profit_sharing', c,
      `\`${c}\` DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER \`${prev}\``);
    prev = c;
  }

  // The deficit a plot brings into this settlement, and net_profit rebuilt to
  // include it. Without this a plot whose first settlement swallowed the whole
  // standing cost would read as profitable on its very next sale.
  await addColumn(conn, 'profit_sharing', 'carry_in',
    '`carry_in` DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER `total_investment`');
  const gen = await one(conn,
    `SELECT GENERATION_EXPRESSION g FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'profit_sharing' AND COLUMN_NAME = 'net_profit'`, [DB]);
  if (String(gen.g || '').includes('carry_in')) {
    log('   · net_profit already accounts for carry_in');
  } else {
    log('   ~ net_profit := total_revenue - total_investment + carry_in');
    if (APPLY) {
      // A stored generated column cannot be redefined in place on MariaDB 10.4;
      // dropping loses nothing, since every value in it is derived.
      await conn.query('ALTER TABLE `profit_sharing` DROP COLUMN `net_profit`');
      await conn.query(
        'ALTER TABLE `profit_sharing` ADD COLUMN `net_profit` DECIMAL(18,2) ' +
        'GENERATED ALWAYS AS (`total_revenue` - `total_investment` + `carry_in`) STORED AFTER `carry_in`');
    }
  }

  if (await hasConstraint(conn, 'profit_sharing', 'fk_ps_selling')) {
    log('   · fk_ps_selling already present');
  } else {
    log('   + fk_ps_selling -> selling(id) ON DELETE SET NULL');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `profit_sharing` ADD CONSTRAINT `fk_ps_selling` ' +
        'FOREIGN KEY (`selling_id`) REFERENCES `selling` (`id`) ON DELETE SET NULL');
    }
  }

  if (await hasIndex(conn, 'profit_sharing', 'uq_ps_selling_plot')) {
    log('   · uq_ps_selling_plot already present');
  } else if (!(await hasColumn(conn, 'profit_sharing', 'selling_id'))) {
    // Dry run on a database that does not have the column yet: there is nothing
    // to scan for duplicates against, and step 4 above already reported the add.
    log('   + UNIQUE uq_ps_selling_plot (selling_id, plot_id)  [after selling_id exists]');
  } else {
    // Guards against settling the same sale twice for one plot. Legacy rows have
    // selling_id NULL and repeated NULLs stay legal, so they are not affected.
    const dupe = await one(conn,
      `SELECT COUNT(*) n FROM (
         SELECT selling_id, plot_id FROM profit_sharing
         WHERE selling_id IS NOT NULL GROUP BY selling_id, plot_id HAVING COUNT(*) > 1) x`);
    if (Number(dupe.n)) {
      log(`   ! ${dupe.n} (selling, plot) pair(s) already duplicated — resolve them first,`);
      log('     the unique key is NOT added.');
    } else {
      log('   + UNIQUE uq_ps_selling_plot (selling_id, plot_id)');
      if (APPLY) {
        await conn.query(
          'ALTER TABLE `profit_sharing` ADD UNIQUE KEY `uq_ps_selling_plot` (`selling_id`, `plot_id`)');
      }
    }
  }

  // -- 5. what the corrected calculation will show ---------------------------
  step(5, 'what changes in the numbers');

  const before = await one(conn,
    `SELECT COALESCE(SUM(s.total_revenue), 0) v
     FROM selling s
     JOIN processing pr             ON pr.id = s.processing_id
     JOIN processing_purchasings pp ON pp.processing_id = pr.id
     JOIN purchasing pu             ON pu.id = pp.purchasing_id
     JOIN plot pl                   ON pl.id = pu.plot_id
     WHERE COALESCE(pl.scheme, '') = 'ProfitSharing'`);
  const after = await one(conn,
    `SELECT COALESCE(SUM(v.rev), 0) v FROM (
       SELECT DISTINCT s.id, s.total_revenue AS rev
       FROM selling s
       JOIN processing pr             ON pr.id = s.processing_id
       JOIN processing_purchasings pp ON pp.processing_id = pr.id
       JOIN purchasing pu             ON pu.id = pp.purchasing_id
       JOIN plot pl                   ON pl.id = pu.plot_id
       WHERE COALESCE(pl.scheme, '') = 'ProfitSharing') v`);
  log(`   revenue reported before : ${rp(before.v)}`);
  log(`   actual sales value      : ${rp(after.v)}`);
  if (Number(after.v) > 0) {
    log(`   overstated by           : ${(Number(before.v) / Number(after.v)).toFixed(2)}x`);
  }

  // Costs booked against plots that are not ProfitSharing at all. The old query
  // summed profit_sharing_investments with no scheme filter, so these showed up
  // as phantom farmers on the profit-sharing P/L. The rewritten endpoint filters
  // by the plot's scheme, so they simply disappear from that page — but they are
  // still sitting in the wrong table and are worth moving.
  const stray = await one(conn,
    `SELECT COUNT(*) n, COALESCE(SUM(i.amount), 0) v
     FROM profit_sharing_investments i
     LEFT JOIN plot pl ON pl.id = i.plot_id
     WHERE COALESCE(pl.scheme, '') <> 'ProfitSharing'`);
  if (Number(stray.n)) {
    log(`   ! ${stray.n} investment row(s), ${rp(stray.v)}, sit on non-ProfitSharing plots.`);
    const [sample] = await conn.query(
      `SELECT i.id, i.period, pl.plot_name, pl.scheme, i.amount, i.description
       FROM profit_sharing_investments i
       LEFT JOIN plot pl ON pl.id = i.plot_id
       WHERE COALESCE(pl.scheme, '') <> 'ProfitSharing'
       ORDER BY i.id LIMIT 5`);
    for (const r of sample) {
      log(`       #${r.id} ${r.period} ${r.plot_name ?? '(no plot)'} [${r.scheme ?? '—'}] ` +
          `${rp(r.amount)} — ${String(r.description ?? '').slice(0, 40)}`);
    }
    log('     They are excluded from the profit-sharing report from now on.');
  } else {
    log('   · every investment row sits on a ProfitSharing plot');
  }

  // Batches with no processing cost recorded. Now that the cost is subtracted,
  // a zero there flatters the result instead of being merely unused.
  const zero = await one(conn,
    `SELECT COUNT(*) n FROM (
       SELECT pr.id
       FROM processing pr
       JOIN processing_purchasings pp ON pp.processing_id = pr.id
       JOIN purchasing pu             ON pu.id = pp.purchasing_id
       JOIN plot pl                   ON pl.id = pu.plot_id
       WHERE COALESCE(pl.scheme, '') = 'ProfitSharing'
         AND COALESCE(pr.total_processing_cost, 0) = 0
       GROUP BY pr.id) x`);
  const all = await one(conn,
    `SELECT COUNT(*) n FROM (
       SELECT pr.id
       FROM processing pr
       JOIN processing_purchasings pp ON pp.processing_id = pr.id
       JOIN purchasing pu             ON pu.id = pp.purchasing_id
       JOIN plot pl                   ON pl.id = pu.plot_id
       WHERE COALESCE(pl.scheme, '') = 'ProfitSharing'
       GROUP BY pr.id) x`);
  log(`   processing batches with cost 0 : ${zero.n} of ${all.n}` +
      (Number(zero.n) ? '  → their share of profit reads too high until filled in' : ''));

  // Batches where output exceeds input. The share is taken off the input side so
  // the split still adds up, but a negative loss means the sheet is wrong.
  const grew = await one(conn,
    `SELECT COUNT(*) n FROM processing WHERE volume_output > volume_input`);
  if (Number(grew.n)) {
    log(`   ! ${grew.n} processing run(s) report more output than input — check those sheets`);
  }

  const ents = (await hasColumn(conn, 'entities', 'profit_share_farmer_pct'))
    ? await one(conn,
      `SELECT COUNT(*) n FROM entities
       WHERE entity_type = 'Operational' AND profit_share_farmer_pct IS NULL`)
    : await one(conn, `SELECT COUNT(*) n FROM entities WHERE entity_type = 'Operational'`);
  if (Number(ents.n)) {
    log(`\n   → ${ents.n} operational PT(s) have no farmer percentage yet.`);
    log('     Set it in Settings → Entitas before settling anything;');
    log('     a settlement refuses to run while it is empty.');
  }

  await conn.end();
  log(APPLY ? '\n✓ Migration applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
