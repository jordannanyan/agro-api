// -----------------------------------------------------------------------------
// Migration: mark the five JNBS plots as ProfitSharing (2026-08)
//
// `plot.scheme` for the AML/JNBS plots was never read from the ledger. The
// legacy migration set 98 plots to PreFinance from the `farmers.pre_finance`
// flag, and the later import that DOES read a scheme
// (import_output_v2/_scripts/v2_1_identity.py:154) never overwrote them. So five
// plots the business runs as profit sharing have been sitting as PreFinance.
//
// The source is explicit — "[G-Sheet Format] Buku Besar - AML - Banana (1).xlsx",
// sheet `AML - Farmer Database`, column `Scheme`:
//
//     Pre-Financing 9 · Labour Loan 5 · Profit Sharing 5 · Outgrower 4
//
// and the five Profit Sharing rows are exactly the ones below. They are also the
// five in that workbook's `Overview Bagi Hasil Panen`, and 312 of their 313
// purchases were recorded at price 0 — the signature of profit sharing, since a
// profit-sharing farmer is not paid at delivery.
//
// Same file, `AML - Data Entry Banana`, computes the split per transaction:
// `Profit Sharing Farmer` (AM) and `Profit Sharing JNBS` (AL), with the farmer
// on a plain 50% (`Total Profit Generated = K/0.5`). JNBS has no KTH cut.
//
//   1. flip the five plots to ProfitSharing
//   2. set the percentages both PTs actually use
//   3. report what moves into the profit-sharing report as a result
//
// Idempotent. Nothing is deleted, and no purchase is repriced: the existing rows
// already carry price 0, and purchasing.ts forces 0 for ProfitSharing from now on.
//
// Usage:
//   node scripts/migrateJnbsProfitSharingPlots2026-08.js            # dry run
//   node scripts/migrateJnbsProfitSharingPlots2026-08.js --apply
//
// BACK UP THE DATABASE FIRST:
//   mysqldump -u agro -p agro_supply > backup-before-jnbs-ps-2026-08.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });

// Plot codes, straight from the ledger's Scheme column.
const PLOTS = ['SM003002', 'SM019003', 'GK006001', 'GK006002', 'GW006003'];

// Farmer share per PT, from each ledger's own formula.
//   AML  (JNBS): Total Profit Generated = K/0.5           -> farmer 50, no KTH
//   SJ   (SNBS): Total Sales Profit Generated = O/0.3     -> farmer 30
//                Total Distributable Profit Share SJ = P*7/30 -> KTH 7 of base
const PCT = [
  { match: '%JNBS%', farmer: 50, kth: 0 },
  { match: '%SNBS%', farmer: 30, kth: 7 },
];

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
    multipleStatements: true,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written.');
  log(`  database: ${DB}`);

  // -- 1. the five plots ------------------------------------------------------
  step(1, 'plot.scheme for the five AML profit-sharing plots');
  const ph = PLOTS.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT pl.id, pl.plot_name, pl.scheme, f.farmer_name, k.kth_name, e.entities_name,
            (SELECT COUNT(*) FROM purchasing pu WHERE pu.plot_id = pl.id) AS n_beli,
            (SELECT COUNT(*) FROM purchasing pu WHERE pu.plot_id = pl.id AND pu.price_per_unit > 0) AS n_berharga
     FROM plot pl
     LEFT JOIN farmers f  ON f.id = pl.farmer_id
     LEFT JOIN kth k      ON k.id = f.kth_id
     LEFT JOIN entities e ON e.id = k.entities_id
     WHERE pl.plot_name IN (${ph}) ORDER BY pl.plot_name`, PLOTS);

  if (rows.length !== PLOTS.length) {
    log(`   ! expected ${PLOTS.length} plots, found ${rows.length}. Missing: ` +
        PLOTS.filter((p) => !rows.some((r) => r.plot_name === p)).join(', '));
  }
  for (const r of rows) {
    const mark = r.scheme === 'ProfitSharing' ? '·' : '~';
    log(`   ${mark} ${r.plot_name.padEnd(10)} ${String(r.farmer_name ?? '?').padEnd(14)} ` +
        `${r.kth_name ?? '?'} / ${r.entities_name ?? '?'}`);
    log(`     ${r.scheme} → ProfitSharing   (${r.n_beli} pembelian, ${r.n_berharga} berharga > 0)`);
    // A priced purchase means the farmer was already paid for that delivery, which
    // a profit-sharing plot should never have. Worth a look, but not blocking.
    if (Number(r.n_berharga)) {
      log(`     ! ${r.n_berharga} pembelian berharga > 0 — periksa apakah itu memang seharusnya`);
    }
  }
  if (APPLY) {
    const [res] = await conn.query(
      `UPDATE plot SET scheme = 'ProfitSharing', updated_at = NOW()
       WHERE plot_name IN (${ph}) AND scheme <> 'ProfitSharing'`, PLOTS);
    log(`   ${res.affectedRows} baris diubah`);
  }

  // -- 2. percentages ---------------------------------------------------------
  step(2, 'persentase bagi hasil per PT');
  for (const p of PCT) {
    const e = await one(conn,
      `SELECT id, entities_name, profit_share_farmer_pct f, profit_share_kth_pct k
       FROM entities WHERE entities_name LIKE ? AND entity_type = 'Operational' LIMIT 1`, [p.match]);
    if (!e.id) { log(`   ! tidak ada entitas cocok ${p.match}`); continue; }
    log(`   ${e.entities_name}: petani ${e.f ?? '—'} → ${p.farmer}` +
        ` · KTH ${e.k ?? '—'} → ${p.kth}`);
    if (APPLY) {
      await conn.query(
        `UPDATE entities SET profit_share_farmer_pct = ?, profit_share_kth_pct = ?, updated_at = NOW()
         WHERE id = ?`, [p.farmer, p.kth, e.id]);
    }
  }
  log('   KTH memotong dari basis yang sama, bukan dari bagian perusahaan:');
  log('     SNBS → petani 30 · KTH 7 · perusahaan 63');
  log('     JNBS → petani 50 · KTH 0 · perusahaan 50');

  // -- 3. what this pulls into the report ------------------------------------
  step(3, 'akibatnya di laporan bagi hasil');
  const before = await one(conn,
    "SELECT COUNT(*) n FROM plot WHERE scheme = 'ProfitSharing'");
  log(`   lahan ProfitSharing: ${before.n}${APPLY ? '' : ` → ${Number(before.n) + rows.filter((r) => r.scheme !== 'ProfitSharing').length}`}`);

  const stray = await one(conn,
    `SELECT COUNT(*) n, COALESCE(SUM(i.amount), 0) v
     FROM profit_sharing_investments i
     LEFT JOIN plot pl ON pl.id = i.plot_id
     WHERE COALESCE(pl.scheme, '') <> 'ProfitSharing'`);
  log(`   biaya di lahan non-PS yang tersisa: ${stray.n} baris, ${rp(stray.v)}`);

  const loans = await one(conn,
    `SELECT COUNT(*) n, COALESCE(SUM(d.total_amount), 0) v
     FROM pre_finance_distributions d JOIN plot pl ON pl.id = d.plot_id
     WHERE pl.plot_name IN (${ph})`, PLOTS);
  log(`   utang/saprodi kelima lahan yang kini jadi biaya bagi hasil: ${loans.n} baris, ${rp(loans.v)}`);

  const sales = await one(conn,
    `SELECT COUNT(DISTINCT s.id) n, COALESCE(SUM(DISTINCT s.total_revenue), 0) v
     FROM selling s
     JOIN processing_purchasings pp ON pp.processing_id = s.processing_id
     JOIN purchasing pu ON pu.id = pp.purchasing_id
     JOIN plot pl ON pl.id = pu.plot_id
     WHERE pl.plot_name IN (${ph})`, PLOTS);
  log(`   penjualan yang memuat panen kelima lahan itu: ${sales.n}`);

  const settled = await one(conn, 'SELECT COUNT(*) n FROM profit_sharing');
  if (Number(settled.n)) {
    log(`\n   ! ${settled.n} baris bagi hasil sudah tersimpan. Baris itu dihitung dengan`);
    log('     persentase lama dan TIDAK dihitung ulang. Hapus lalu hitung ulang bila perlu.');
  } else {
    log('   belum ada bagi hasil tersimpan — aman menghitung dari awal');
  }

  await conn.end();
  log(APPLY ? '\n✓ Migration applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
