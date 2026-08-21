// -----------------------------------------------------------------------------
// Migration: profit defined the way the ledgers define it (2026-08)
//
// The settlement engine subtracted saprodi, land cost, processing and selling
// cost from revenue. Neither operational ledger does that. Both compute a gross
// margin per Delivery Order out of a small, fixed set of costs, and treat the
// farmer's debt as a GATE on paying out rather than as a cost:
//
//   AML (JNBS), "AML - Data Entry Banana" AK:
//     margin = offtake value − purchase value − 1.125/kg × vol beli − 30/kg × vol beli
//     farmer = porsi volume × margin × 50%   ... × IF(purchase value ≠ 0, 0, 1)
//
//   SJ (SNBS), "SJ - Data Entry Banana" BB:
//     margin = offtake value − 950/kg × vol offtake − 30/kg × vol beli
//              (AV + AW = AT × 950, split harvesting/washing)
//     farmer = margin × 30%, KTH = margin × 7% but only for `Inside KTH SJ = Yes`
//
// Both reproduce exactly from their own rows: farmer Rp 144.750.801 (AML) and
// Rp 69.261.990 (SJ), matching the stored Farmer Database figures.
//
// One caveat worth writing down: the live AK formula subtracts the harvesting
// cost TWICE (`SUMIFS(AE,"Purchasing")` and again `SUMIF(AE)`), which would give
// Rp 95.636.080. The figures the business actually reports match subtracting it
// ONCE, so that is what this implements — the double subtraction looks like an
// edit the sheet was never recalculated after.
//
//   1. entities — harvest_cost_per_kg, harvest_cost_basis, pnbp_per_kg
//   2. plot     — inside_kth (the ledger's `Inside KTH SJ` column)
//   3. profit_sharing — cost_purchase, cost_harvest, cost_pnbp
//   4. isi tarif tiap PT dan tandai lahan di luar KTH
//
// Idempotent. Run AFTER migrateProfitSharingSheetModel2026-08.js.
//
// Usage:
//   node scripts/migrateLedgerMarginModel2026-08.js            # dry run
//   node scripts/migrateLedgerMarginModel2026-08.js --apply
//
// BACK UP THE DATABASE FIRST:
//   mysqldump -u agro -p agro_supply > backup-before-ledger-margin-2026-08.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);

// Rates straight out of each ledger's own formulas.
const RATES = [
  { match: '%JNBS%', harvest: 1125, basis: 'Purchase', pnbp: 30, note: 'AE = vol beli x 1125' },
  { match: '%SNBS%', harvest: 950, basis: 'Offtake', pnbp: 30, note: 'AV+AW = vol offtake x 950' },
];

// `Inside KTH SJ = No` in "SJ - Farmer Database" — these two get no KTH cut.
const OUTSIDE_KTH = ['AMA', 'SUM'];

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
    log(`\n  ! ${settled.n} baris bagi hasil sudah ada. Baris itu dihitung dengan model biaya`);
    log('    yang LAMA dan tidak dihitung ulang di sini. Hapus lalu hitung ulang.');
  } else {
    log('  profit_sharing masih kosong — aman.');
  }

  // -- 1. tarif per PT --------------------------------------------------------
  step(1, 'entities: tarif harvesting dan PNBP');
  await addColumn(conn, 'entities', 'harvest_cost_per_kg',
    '`harvest_cost_per_kg` DECIMAL(15,2) NULL AFTER `profit_share_kth_pct`');
  // Which volume the harvesting rate multiplies: AML charges it on the volume
  // bought from farmers, SJ on the volume actually shipped to the offtaker.
  await addColumn(conn, 'entities', 'harvest_cost_basis',
    "`harvest_cost_basis` ENUM('Purchase','Offtake') NOT NULL DEFAULT 'Purchase' AFTER `harvest_cost_per_kg`");
  await addColumn(conn, 'entities', 'pnbp_per_kg',
    '`pnbp_per_kg` DECIMAL(15,2) NULL AFTER `harvest_cost_basis`');

  // -- 2. lahan di luar KTH ---------------------------------------------------
  step(2, 'plot.inside_kth');
  // The KTH's cut is paid only for plots the ledger marks `Inside KTH SJ = Yes`.
  await addColumn(conn, 'plot', 'inside_kth',
    '`inside_kth` TINYINT(1) NOT NULL DEFAULT 1 AFTER `scheme`');

  // -- 3. komponen biaya versi buku besar ------------------------------------
  step(3, 'profit_sharing: komponen biaya buku besar');
  let prev = 'share_pct';
  for (const c of ['cost_purchase', 'cost_harvest', 'cost_pnbp']) {
    await addColumn(conn, 'profit_sharing', c,
      `\`${c}\` DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER \`${prev}\``);
    prev = c;
  }

  // -- 4. isi nilainya --------------------------------------------------------
  step(4, 'isi tarif dan penanda KTH');
  if (await hasColumn(conn, 'entities', 'harvest_cost_per_kg')) {
    for (const r of RATES) {
      const e = await one(conn,
        `SELECT id, entities_name FROM entities
         WHERE entities_name LIKE ? AND entity_type = 'Operational' LIMIT 1`, [r.match]);
      if (!e.id) { log(`   ! tidak ada entitas cocok ${r.match}`); continue; }
      log(`   ${e.entities_name}: harvest ${r.harvest}/kg basis ${r.basis} · PNBP ${r.pnbp}/kg   (${r.note})`);
      if (APPLY) {
        await conn.query(
          `UPDATE entities SET harvest_cost_per_kg = ?, harvest_cost_basis = ?, pnbp_per_kg = ?,
                               updated_at = NOW() WHERE id = ?`,
          [r.harvest, r.basis, r.pnbp, e.id]);
      }
    }
  } else {
    log('   · kolom tarif belum ada (dry run) — pengisian dilewati');
  }

  if (await hasColumn(conn, 'plot', 'inside_kth')) {
    const ph = OUTSIDE_KTH.map(() => '?').join(',');
    const [outs] = await conn.query(
      `SELECT plot_name, inside_kth FROM plot WHERE plot_name IN (${ph})`, OUTSIDE_KTH);
    log(`   di luar KTH SJ (tanpa bagian KTH): ${outs.map((o) => o.plot_name).join(', ') || '(tidak ketemu)'}`);
    if (APPLY) {
      await conn.query(
        `UPDATE plot SET inside_kth = 0, updated_at = NOW() WHERE plot_name IN (${ph})`, OUTSIDE_KTH);
      await conn.query(
        `UPDATE plot SET inside_kth = 1 WHERE plot_name NOT IN (${ph}) AND inside_kth <> 1`, OUTSIDE_KTH);
    }
  } else {
    log('   · kolom inside_kth belum ada (dry run) — penandaan dilewati');
  }

  log('\n   Saprodi dan biaya lahan TIDAK lagi mengurangi margin. Keduanya jadi');
  log('   penghalang pembayaran: uang keluar hanya bila margin kumulatif lahan');
  log('   sudah melampaui utangnya — sama seperti kolom Distributable di buku besar.');

  await conn.end();
  log(APPLY ? '\n✓ Migration applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
