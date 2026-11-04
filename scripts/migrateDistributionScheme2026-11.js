// -----------------------------------------------------------------------------
// Migration: store each distribution line's scheme (2026-11)
//
// Until now a distribution's scheme was read from its plot at query time. That
// breaks the moment a plot changes scheme: the five JNBS plots of Mustari
// (GK006001, GK006002, GW006003), Eko Irawan (SM003002) and Yudis (SM019003) were
// Pre-Finance until 28 Aug 2025 and profit sharing after (per the business,
// 2026-11-05), so everything lent to them before that day read as a cost of the
// profit-sharing season — and everything after it as per-kg farmer debt too.
//
// `pre_finance_distributions.scheme` now holds the plot's scheme on the day of
// the line, and decides who carries it:
//   PreFinance / BeliPutus / NULL → farmer debt (v_pre_finance_outstanding)
//   ProfitSharing                 → profit-sharing cost (profitSharing.ts)
//
//   1. add the column
//   2. fill it from plot.scheme — the five plots before 2025-08-28 as PreFinance
//   3. rebuild v_pre_finance_outstanding from db/views.sql
//   4. report what moves out of farmer debt
//
// Idempotent. Dry-run by default.
//
// Usage:
//   node scripts/migrateDistributionScheme2026-11.js
//   node scripts/migrateDistributionScheme2026-11.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });

// The plots that changed scheme, and the first day of the new one.
const SWITCHED = ['SM003002', 'SM019003', 'GK006001', 'GK006002', 'GW006003'];
const PS_FROM = '2025-08-28';

function viewSql() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'views.sql'), 'utf8');
  const start = src.indexOf('CREATE VIEW `v_pre_finance_outstanding`');
  const end = src.indexOf(';', src.indexOf('WHERE d.dist_total IS NOT NULL', start));
  if (start < 0 || end < 0) throw new Error('v_pre_finance_outstanding not found in db/views.sql');
  return src.slice(start, end);
}

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const debtOf = async () => {
      const [r] = await c.query(
        `SELECT f.farmer_name, ROUND(SUM(o.outstanding)) os FROM v_pre_finance_outstanding o
           JOIN farmers f ON f.id = o.farmer_id
          WHERE o.farmer_id IN (SELECT farmer_id FROM plot WHERE plot_name IN (?))
          GROUP BY f.farmer_name ORDER BY f.farmer_name`, [SWITCHED]);
      return r;
    };
    const [[tot0]] = await c.query('SELECT ROUND(SUM(outstanding)) v FROM v_pre_finance_outstanding');
    const before = await debtOf();

    const [[col]] = await c.query(
      `SELECT COUNT(*) n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'pre_finance_distributions' AND COLUMN_NAME = 'scheme'`, [DB]);
    log(`1) kolom scheme: ${col.n ? 'sudah ada' : 'ditambahkan'}`);

    const [plan] = await c.query(
      `SELECT CASE WHEN p.plot_name IN (?) AND d.date < ? THEN 'PreFinance' ELSE p.scheme END AS scheme,
              COUNT(*) n, ROUND(SUM(d.total_amount)) rp
         FROM pre_finance_distributions d JOIN plot p ON p.id = d.plot_id
        GROUP BY 1 ORDER BY 1`, [SWITCHED, PS_FROM]);
    log('2) isi kolom dari skema lahan:');
    plan.forEach((r) => log(`   ${String(r.scheme).padEnd(14)} ${String(r.n).padStart(5)} baris  ${rp(r.rp)}`));
    const [sw] = await c.query(
      `SELECT p.plot_name, t.type_name, SUM(d.date < ?) pf_n, ROUND(SUM(IF(d.date < ?, d.total_amount, 0))) pf_rp,
              SUM(d.date >= ?) ps_n, ROUND(SUM(IF(d.date >= ?, d.total_amount, 0))) ps_rp
         FROM pre_finance_distributions d JOIN plot p ON p.id = d.plot_id
         JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
        WHERE p.plot_name IN (?) GROUP BY 1, 2 ORDER BY 1, 2`, [PS_FROM, PS_FROM, PS_FROM, PS_FROM, SWITCHED]);
    log(`   lima lahan yang berganti skema (sebelum ${PS_FROM} = PreFinance, sesudahnya = ProfitSharing):`);
    sw.forEach((r) => log(`   ${r.plot_name} ${r.type_name.padEnd(8)} PF ${String(r.pf_n).padStart(3)} ${rp(r.pf_rp).padStart(14)} · PS ${String(r.ps_n).padStart(3)} ${rp(r.ps_rp).padStart(14)}`));

    if (!APPLY) {
      log('\ndry-run only; re-run with --apply');
      log(`utang petani (semua) sekarang: ${rp(tot0.v)}`);
      before.forEach((r) => log(`   ${r.farmer_name.padEnd(12)} ${rp(r.os)}`));
      return;
    }

    if (!col.n) {
      await c.query(
        "ALTER TABLE pre_finance_distributions ADD COLUMN `scheme` ENUM('BeliPutus','PreFinance','ProfitSharing') NULL AFTER `counts_as_debt`");
    }
    await c.beginTransaction();
    await c.query(
      `UPDATE pre_finance_distributions d JOIN plot p ON p.id = d.plot_id
          SET d.scheme = CASE WHEN p.plot_name IN (?) AND d.date < ? THEN 'PreFinance' ELSE p.scheme END
        WHERE NOT (d.scheme <=> CASE WHEN p.plot_name IN (?) AND d.date < ? THEN 'PreFinance' ELSE p.scheme END)`,
      [SWITCHED, PS_FROM, SWITCHED, PS_FROM]);
    await c.commit();
    await c.query('DROP VIEW IF EXISTS `v_pre_finance_outstanding`');
    await c.query(viewSql());
    log('3) v_pre_finance_outstanding dibangun ulang');

    const [[tot1]] = await c.query('SELECT ROUND(SUM(outstanding)) v FROM v_pre_finance_outstanding');
    const after = await debtOf();
    log(`4) utang petani (semua): ${rp(tot0.v)} → ${rp(tot1.v)}`);
    for (const b of before) {
      const a = after.find((x) => x.farmer_name === b.farmer_name);
      log(`   ${b.farmer_name.padEnd(12)} ${rp(b.os).padStart(14)} → ${rp(a?.os).padStart(14)}`);
    }
    log('\ndone');
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
