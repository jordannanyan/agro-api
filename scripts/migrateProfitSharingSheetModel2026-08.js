// -----------------------------------------------------------------------------
// Migration: align profit sharing with the business's own model (2026-08)
//
// The split model was found in the source workbook after the first version
// shipped: `20251008_Database Cavendish SNBS Lampung.xlsx`, sheets
// "1 Hitungan Simulasi" and "2 Hitungan Simulasi". Its formulas say:
//
//   NCF          = hasil panen − biaya operasional
//   NCF SNBS     = 0.7 × NCF                     (C18)
//   NCF PETANI   = 0.3 × NCF                     (C30)
//   KTH          = (NCF × 0.7) × 0.07            (C20)  ← out of SNBS's share
//   Cumulative … = running balance per party     (rows 19/25/31)
//   WITHDRAWAL   = payout, "ketika cumulative +" (rows 26/32, note at K13)
//
// Three things differ from what was built first:
//
//   1. The percentages. 50/50 was a placeholder used while testing; the sheet
//      says 30/70, and a third party — KTH — takes 7% out of the company half.
//   2. A loss is shared too. The sheet multiplies a negative NCF by the same
//      percentages, so the farmer carries 30% of it in their own balance. The
//      first version floored the farmer at zero and put the whole loss on the
//      company, which is stricter than what was agreed.
//   3. Accumulation is per party. The sheet keeps a running balance for each of
//      the three and pays out of it; the first version folded one lump deficit
//      back into the next settlement's net (`carry_in`).
//
// So `carry_in` goes, `net_profit` returns to revenue − cost for that sale
// alone, and three running-balance columns take over. Nothing is converted:
// `profit_sharing` holds 0 rows in production, so there is no history to migrate.
//
//   1. entities.profit_share_kth_pct
//   2. profit_sharing — pct_kth, value_kth, cum_farmer, cum_kth, cum_company
//   3. profit_sharing — drop carry_in, net_profit back to revenue − investment
//   4. report the percentages now in force
//
// Idempotent. Run AFTER migrateProfitSharing2026-08.js.
//
// Usage:
//   node scripts/migrateProfitSharingSheetModel2026-08.js            # dry run
//   node scripts/migrateProfitSharingSheetModel2026-08.js --apply
//
// BACK UP THE DATABASE FIRST:
//   mysqldump -u agro -p agro_supply > backup-before-sheetmodel-2026-08.sql
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
    [DB, table, column]);
  return r.length > 0;
}

const one = async (conn, sql, args = []) => {
  const [r] = await conn.query(sql, args);
  return r[0] || {};
};

async function addColumn(conn, table, column, ddl) {
  if (await hasColumn(conn, table, column)) { log(`   · ${table}.${column} already present`); return; }
  log(`   + ${table}.${column}`);
  if (APPLY) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
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

  const settled = await one(conn, 'SELECT COUNT(*) n FROM profit_sharing');
  if (Number(settled.n)) {
    log(`\n  ! ${settled.n} settlement row(s) already exist. Their value_farmer / value_company`);
    log('    were worked out under the previous rule and are NOT recalculated here.');
    log('    Delete and re-settle them if they should follow the sheet model.');
  } else {
    log('  profit_sharing is empty — nothing to convert.');
  }

  // -- 1. the KTH cut -------------------------------------------------------
  step(1, 'entities.profit_share_kth_pct');
  // Taken OUT of the company's half, not added on top: the sheet computes it as
  // (NCF x 0.7) x 0.07, so farmer + company still add up to 100.
  await addColumn(conn, 'entities', 'profit_share_kth_pct',
    '`profit_share_kth_pct` DECIMAL(5,2) NULL AFTER `profit_share_farmer_pct`');

  // -- 2. per-party split and running balances ------------------------------
  step(2, 'profit_sharing: KTH share and a running balance per party');
  await addColumn(conn, 'profit_sharing', 'pct_kth',
    '`pct_kth` DECIMAL(5,2) NOT NULL DEFAULT 0 AFTER `pct_company`');
  await addColumn(conn, 'profit_sharing', 'value_kth',
    '`value_kth` DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER `value_company`');
  // Balance carried by each party AFTER this settlement — the sheet's
  // "Cumulative PETANI / KTH / SNBS" rows. A payout is possible while the
  // farmer's balance is positive.
  let prev = 'value_kth';
  for (const c of ['cum_farmer', 'cum_company', 'cum_kth']) {
    await addColumn(conn, 'profit_sharing', c,
      `\`${c}\` DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER \`${prev}\``);
    prev = c;
  }

  // -- 3. net_profit is this sale's own result again ------------------------
  step(3, 'profit_sharing: drop carry_in, net_profit = revenue − investment');
  const gen = await one(conn,
    `SELECT GENERATION_EXPRESSION g FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'profit_sharing' AND COLUMN_NAME = 'net_profit'`, [DB]);
  if (!String(gen.g || '').includes('carry_in')) {
    log('   · net_profit already excludes carry_in');
  } else {
    log('   ~ net_profit := total_revenue - total_investment');
    if (APPLY) {
      await conn.query('ALTER TABLE `profit_sharing` DROP COLUMN `net_profit`');
      await conn.query(
        'ALTER TABLE `profit_sharing` ADD COLUMN `net_profit` DECIMAL(18,2) ' +
        'GENERATED ALWAYS AS (`total_revenue` - `total_investment`) STORED AFTER `total_investment`');
    }
  }
  if (await hasColumn(conn, 'profit_sharing', 'carry_in')) {
    log('   − carry_in (superseded by cum_farmer / cum_company / cum_kth)');
    if (APPLY) await conn.query('ALTER TABLE `profit_sharing` DROP COLUMN `carry_in`');
  } else {
    log('   · carry_in already removed');
  }

  // -- 4. what the percentages say now --------------------------------------
  step(4, 'percentages in force');
  const cols = (await hasColumn(conn, 'entities', 'profit_share_kth_pct'))
    ? 'profit_share_farmer_pct, profit_share_kth_pct'
    : 'profit_share_farmer_pct, NULL AS profit_share_kth_pct';
  const [ents] = await conn.query(
    `SELECT id, entities_name, ${cols} FROM entities WHERE entity_type = 'Operational' ORDER BY id`);
  for (const e of ents) {
    const f = e.profit_share_farmer_pct;
    const k = e.profit_share_kth_pct;
    log(`   ${e.entities_name}`);
    log(`      petani ${f == null ? '(belum diisi)' : f + '%'}` +
        `  ·  KTH ${k == null ? '(belum diisi)' : k + '% dari bagian perusahaan'}`);
    if (f != null && k != null) {
      const eff = (100 - Number(f)) * (Number(k) / 100);
      log(`      efektif: petani ${Number(f).toFixed(1)}% · KTH ${eff.toFixed(2)}% · ` +
          `perusahaan ${(100 - Number(f) - eff).toFixed(2)}%`);
    }
  }
  log('\n   Sheet "1 Hitungan Simulasi" says: petani 30 · SNBS 70 · KTH 7 (of SNBS).');
  log('   Set them in Settings → Entitas if they do not match.');

  await conn.end();
  log(APPLY ? '\n✓ Migration applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
