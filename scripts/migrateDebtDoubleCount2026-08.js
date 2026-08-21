// -----------------------------------------------------------------------------
// Migration: stop counting SNBS farmer debt twice (2026-08)
//
// Found by reconciling production against the five source workbooks —
// docs/rekonsiliasi-buku-besar-2026-08.md. The debt shown beside a Profit
// Sharing plot decides whether anything may be paid out, and for SNBS it was
// Rp 384,3 juta too large (+77%). Two separate causes:
//
//   1. Harvesting booked as farmer debt · Rp 35.880.600
//      50 rows in `profit_sharing_investments` named "Harvesting cost DO 1..15",
//      on five plots (AG1, AG2, M2, NC, SU). The total equals the SJ ledger's
//      own Total Harvesting Cost across its 15 Delivery Orders exactly.
//      Harvesting is a company cost and is already charged in the margin as
//      Rp 950/kg × offtake volume. It is not a farmer debt at all — these rows
//      are simply wrong, so they go.
//
//   2. Material counted twice · Rp 348.377.789
//      `pre_finance_distributions` holds 1.066 rows for SNBS Profit Sharing
//      plots — the Cavendish workbook's `Stock card`, i.e. saprodi physically
//      issued from the warehouse. The same spend is already in
//      `profit_sharing_investments` as the `Daily Update` material column.
//      926 of the 1.066 have a psi twin on plot + month + quantity.
//
//      These rows may NOT be deleted: every one carries `stock_out_id`,
//      `warehouse_id` and `sapropdi_id`, and `v_saprodi_stock` subtracts them
//      to compute warehouse stock. Removing them would silently inflate stock
//      by everything ever issued to those plots. So the row stays and only
//      stops counting as debt, through a new `counts_as_debt` flag.
//
// JNBS is deliberately untouched: there `pfd` carries the saprodi and labour
// loans and `psi` carries only the ojek reimbursements, so the two do not
// overlap and adding them is correct. Its loans reconcile to the rupiah
// against `JNBS Database.xlsx` — 1.823 loan numbers, zero differing values.
//
// Both selectors are the import bundles' own signatures, so re-running
// IMPORT_V5_SNBS_SAPRODI.sql restores the old state; just run this again after.
//
// Idempotent. Dry run by default.
//
// Usage:
//   node scripts/migrateDebtDoubleCount2026-08.js            # dry run
//   node scripts/migrateDebtDoubleCount2026-08.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

// The two import signatures. Both are as specific as the bundles that wrote them.
const HARVEST_LIKE = 'Harvesting cost DO %';   // profit_sharing_investments
const SNBS_SAPRODI_LIKE = 'Saprodi SNBS - %';  // pre_finance_distributions

const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });

async function hasColumn(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [DB, table, column]);
  return r.length > 0;
}

const one = async (conn, sql, args = []) => {
  const [r] = await conn.query(sql, args);
  return r[0] || {};
};

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

  // Settled rows were computed against the inflated debt. Debt never enters the
  // margin, so their money is unaffected — but the page beside them changes.
  const settled = await one(conn, 'SELECT COUNT(*) n FROM profit_sharing');
  if (Number(settled.n)) {
    log(`\n  ! ${settled.n} baris bagi hasil sudah tersimpan. Nilainya tidak berubah —`);
    log('    utang tidak pernah masuk rumus margin — tapi kolom utang di sampingnya berubah.');
  }

  const before = await one(conn, `
    SELECT COALESCE(SUM(d.total_amount), 0) pfd
      FROM pre_finance_distributions d
      JOIN plot p ON p.id = d.plot_id
      JOIN farmers f ON f.id = p.farmer_id
      JOIN kth k ON k.id = f.kth_id
     WHERE k.entities_id = 1 AND p.scheme = 'ProfitSharing'`);
  const beforePsi = await one(conn, `
    SELECT COALESCE(SUM(i.amount), 0) psi
      FROM profit_sharing_investments i
      JOIN plot p ON p.id = i.plot_id
      JOIN farmers f ON f.id = p.farmer_id
      JOIN kth k ON k.id = f.kth_id
     WHERE k.entities_id = 1`);
  const debtBefore = Number(before.pfd) + Number(beforePsi.psi);

  // -- 1. Harvesting rows -------------------------------------------------
  log('\n1) Biaya panen yang tercatat sebagai utang petani');
  const harvest = await one(conn,
    'SELECT COUNT(*) n, COALESCE(SUM(amount), 0) v FROM profit_sharing_investments WHERE description LIKE ?',
    [HARVEST_LIKE]);
  if (!Number(harvest.n)) {
    log('   · tidak ada baris "Harvesting cost DO" — sudah bersih');
  } else {
    const [plots] = await conn.query(
      `SELECT p.plot_name, COUNT(*) n, SUM(i.amount) v
         FROM profit_sharing_investments i JOIN plot p ON p.id = i.plot_id
        WHERE i.description LIKE ? GROUP BY p.plot_name ORDER BY p.plot_name`, [HARVEST_LIKE]);
    for (const r of plots) log(`   - ${r.plot_name.padEnd(6)} ${String(r.n).padStart(3)} baris  ${rupiah(r.v)}`);
    log(`   = ${harvest.n} baris dihapus, ${rupiah(harvest.v)}`);
    if (APPLY) {
      await conn.query('DELETE FROM profit_sharing_investments WHERE description LIKE ?', [HARVEST_LIKE]);
    }
  }

  // -- 2. counts_as_debt flag ---------------------------------------------
  log('\n2) Material yang tercatat dua kali');
  if (await hasColumn(conn, 'pre_finance_distributions', 'counts_as_debt')) {
    log('   · pre_finance_distributions.counts_as_debt already present');
  } else {
    log('   + pre_finance_distributions.counts_as_debt');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `pre_finance_distributions` ADD COLUMN `counts_as_debt` TINYINT(1) NOT NULL DEFAULT 1 AFTER `total_amount`');
    }
  }

  let flagged = 0;
  if (!APPLY && !(await hasColumn(conn, 'pre_finance_distributions', 'counts_as_debt'))) {
    // Dry run on a database that has not got the column yet: count what would be flagged.
    const cand = await one(conn,
      'SELECT COUNT(*) n, COALESCE(SUM(total_amount), 0) v FROM pre_finance_distributions WHERE description LIKE ?',
      [SNBS_SAPRODI_LIKE]);
    flagged = Number(cand.v);
    log(`   ~ ${cand.n} baris akan ditandai counts_as_debt = 0  (${rupiah(cand.v)})`);
  } else {
    const cand = await one(conn,
      `SELECT COUNT(*) n, COALESCE(SUM(total_amount), 0) v FROM pre_finance_distributions
        WHERE description LIKE ? AND counts_as_debt = 1`, [SNBS_SAPRODI_LIKE]);
    if (!Number(cand.n)) {
      const done = await one(conn,
        'SELECT COUNT(*) n FROM pre_finance_distributions WHERE counts_as_debt = 0');
      log(`   · ${done.n} baris sudah bertanda counts_as_debt = 0 — tidak ada yang diubah`);
    } else {
      flagged = Number(cand.v);
      log(`   ~ ${cand.n} baris ditandai counts_as_debt = 0  (${rupiah(cand.v)})`);
      if (APPLY) {
        await conn.query(
          `UPDATE pre_finance_distributions SET counts_as_debt = 0, updated_at = NOW()
            WHERE description LIKE ? AND counts_as_debt = 1`, [SNBS_SAPRODI_LIKE]);
      }
    }
  }

  // -- 3. The outstanding view has to honour the flag too -----------------
  //
  // `v_pre_finance_outstanding` sums the same table, so leaving it alone would
  // keep the doubled figure on the Outstanding page while the P/L page showed
  // the corrected one. Kept byte-identical to db/views.sql — the clean-install
  // invariant is checked with scripts/compareSchema.js.
  log('\n3) v_pre_finance_outstanding mengikuti penanda yang sama');
  const VIEW_SQL = `
CREATE VIEW \`v_pre_finance_outstanding\` AS
SELECT
  f.id            AS farmer_id,
  f.farmer_name   AS farmer_name,
  t.id            AS pre_finance_type_id,
  t.type_name     AS type_name,
  COALESCE(d.dist_total, 0) AS distributed_total,
  COALESCE(p.paid_total, 0) AS paid_total,
  COALESCE(d.dist_total, 0) - COALESCE(p.paid_total, 0) AS outstanding
FROM farmers f
CROSS JOIN pre_finance_types t
LEFT JOIN (
  SELECT farmer_id, pre_finance_type_id, SUM(total_amount) AS dist_total
  FROM pre_finance_distributions
  WHERE counts_as_debt = 1
  GROUP BY farmer_id, pre_finance_type_id
) d ON d.farmer_id = f.id AND d.pre_finance_type_id = t.id
LEFT JOIN (
  SELECT i.farmer_id, det.pre_finance_type_id, SUM(det.amount) AS paid_total
  FROM pre_finance_installments i
  JOIN pre_finance_installment_details det ON det.installment_id = i.id
  GROUP BY i.farmer_id, det.pre_finance_type_id
) p ON p.farmer_id = f.id AND p.pre_finance_type_id = t.id
WHERE d.dist_total IS NOT NULL OR p.paid_total IS NOT NULL`;
  const viewDef = await one(conn,
    `SELECT VIEW_DEFINITION v FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'v_pre_finance_outstanding'`, [DB]);
  if (String(viewDef.v || '').includes('counts_as_debt')) {
    log('   · view sudah menyaring counts_as_debt');
  } else {
    log('   ~ view dibuat ulang');
    if (APPLY) {
      await conn.query('DROP VIEW IF EXISTS `v_pre_finance_outstanding`');
      await conn.query(VIEW_SQL);
    }
  }

  // -- Guard: JNBS must be left exactly as it was -------------------------
  const jnbs = await one(conn, `
    SELECT COUNT(*) n FROM pre_finance_distributions d
      JOIN plot p ON p.id = d.plot_id
      JOIN farmers f ON f.id = p.farmer_id
      JOIN kth k ON k.id = f.kth_id
     WHERE k.entities_id = 3 AND d.description LIKE ?`, [SNBS_SAPRODI_LIKE]);
  log(`\n   pemeriksaan: baris JNBS yang ikut tertandai = ${jnbs.n} (harus 0)`);
  if (Number(jnbs.n)) throw new Error('selector kena baris JNBS — dibatalkan');

  // -- Result -------------------------------------------------------------
  const after = await one(conn, `
    SELECT COALESCE(SUM(d.total_amount), 0) pfd
      FROM pre_finance_distributions d
      JOIN plot p ON p.id = d.plot_id
      JOIN farmers f ON f.id = p.farmer_id
      JOIN kth k ON k.id = f.kth_id
     WHERE k.entities_id = 1 AND p.scheme = 'ProfitSharing'
       ${(await hasColumn(conn, 'pre_finance_distributions', 'counts_as_debt')) ? 'AND d.counts_as_debt = 1' : ''}`);
  const afterPsi = await one(conn, `
    SELECT COALESCE(SUM(i.amount), 0) psi
      FROM profit_sharing_investments i
      JOIN plot p ON p.id = i.plot_id
      JOIN farmers f ON f.id = p.farmer_id
      JOIN kth k ON k.id = f.kth_id
     WHERE k.entities_id = 1`);

  // A dry run cannot read the result off the database — neither change has been
  // made — so it subtracts what the two steps above reported they would remove.
  const projected = APPLY
    ? Number(after.pfd) + Number(afterPsi.psi)
    : debtBefore - Number(harvest.v || 0) - flagged;

  log('\n   Utang 14 lahan Profit Sharing SNBS');
  log(`     sebelum : ${rupiah(debtBefore)}`);
  log(`     ${APPLY ? 'sesudah ' : 'akan jadi'}: ${rupiah(projected)}`);
  log('     sasaran : Rp 496.592.653  (Daily Update: labor 158.571.530 + material 338.021.123)');

  await conn.end();
  log(APPLY
    ? '\n✓ Migration applied. Jalankan ulang perhitungan bagi hasil bila baris tersimpan perlu disegarkan.'
    : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
