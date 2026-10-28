// -----------------------------------------------------------------------------
// Migration: hand-typed loan deductions + SNBS cocoa payback (2026-10)
//
// Source: `Per KG Data/Skema Petani SNBS.xlsx` and `Skema Petani JNBS.xlsx`, the
// field team's list of each plot's scheme and deduction per kilo.
//
//   1. `pre_finance_installments.is_manual` + `manual_reason` — a deduction typed
//      at the delivery that differs from what the rate gives is kept, flagged,
//      and has to say why (DDL in db/schema.sql).
//   2. SNBS cocoa plots are listed as Pre-Finance with a deduction "Tidak Tetap".
//      The `Buku Besar - Sumber Jaya - Cocoa` ledger shows what that means: about
//      half of the 75 deductions are exactly Rp 5.000/kg, the rest are round sums
//      above it (Rp 200.000, Rp 1.000.000) the farmer chose to pay. So Rp 5.000/kg
//      goes in as the payback rate — the form starts from it and the clerk raises
//      it when the farmer pays more. From 2026-05-01, the month the ledger's first
//      deduction (2026-05-07) falls in.
//      NB: these farmers' cocoa loans (ledger: Rp 261,6 jt) are not in the system
//      yet, so the deduction stays capped at Rp 0 until they are imported.
//   3. SJ0007 (Kaji) and SJ0013 (Samsi) are Pre-Finance in the list, Beli Putus
//      here; the list wins.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateRepaymentManual2026-10.js
//   node scripts/migrateRepaymentManual2026-10.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

const SNBS_COCOA_PF = [
  'SJ0002', 'SJ0004', 'SJ0005', 'SJ0006', 'SJ0007', 'SJ0008', 'SJ0009', 'SJ0010', 'SJ0011',
  'SJ0013', 'SJ0014', 'SJ0015', 'SJ0016', 'SJ0017', 'SJ0020', 'SJ0021', 'SJ0022', 'SJ0023',
  'SJ0024', 'SJ0025', 'SJ0026', 'SJ0027', 'SJ0028', 'SJ0029', 'SJ0030', 'SJ0031', 'SJ0032',
  'SJ0033', 'SJ0034', 'SJ0035', 'SJ0036', 'SJ0038', 'SJ0039', 'SJ0040', 'SJ0041', 'SJ0042',
  'SJ0043', 'SJ0044', 'SJ0045', 'SJ0046', 'SJ0047', 'SJ0048', 'NO14001',
];
const TO_PREFINANCE = ['SJ0007', 'SJ0013'];
const RATE_DATE = '2026-05-01';
const RATE_PER_KG = 5000;
const RATE_NOTE = 'Minimum kakao SNBS; petani boleh bayar lebih (Skema Petani SNBS.xlsx)';

async function hasColumn(c, table, col) {
  const [r] = await c.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [DB, table, col]);
  return r.length > 0;
}

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASS, database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    // 1. columns
    if (!(await hasColumn(c, 'pre_finance_installments', 'is_manual'))) {
      log('+ pre_finance_installments.is_manual, manual_reason');
      if (APPLY) {
        await c.query(
          `ALTER TABLE pre_finance_installments
             ADD COLUMN is_manual TINYINT(1) NOT NULL DEFAULT 0 AFTER notes,
             ADD COLUMN manual_reason VARCHAR(255) NULL AFTER is_manual`);
      }
    } else log('= columns already there');

    // 3. scheme (before the rates, so the rates land on Pre-Finance plots)
    const [plots] = await c.query(
      'SELECT id, plot_name, scheme FROM plot WHERE plot_name IN (?)', [SNBS_COCOA_PF]);
    const byName = new Map(plots.map((p) => [p.plot_name, p]));
    const missing = SNBS_COCOA_PF.filter((n) => !byName.has(n));
    if (missing.length) throw new Error(`Plot tidak ditemukan: ${missing.join(', ')}`);
    for (const n of TO_PREFINANCE) {
      const p = byName.get(n);
      if (p.scheme === 'PreFinance') { log(`= ${n} already PreFinance`); continue; }
      log(`~ ${n}: ${p.scheme} -> PreFinance`);
      if (APPLY) await c.query("UPDATE plot SET scheme = 'PreFinance', updated_at = NOW() WHERE id = ?", [p.id]);
      p.scheme = 'PreFinance';
    }
    const notPf = plots.filter((p) => p.scheme !== 'PreFinance' && !TO_PREFINANCE.includes(p.plot_name));
    if (notPf.length) throw new Error(`Bukan Pre-Finance: ${notPf.map((p) => `${p.plot_name}=${p.scheme}`).join(', ')}`);

    // 2. rates
    let added = 0;
    for (const n of SNBS_COCOA_PF) {
      const p = byName.get(n);
      const [ex] = await c.query(
        'SELECT id FROM payback_rates WHERE plot_id = ? AND grade_id IS NULL AND effective_date = ?', [p.id, RATE_DATE]);
      if (ex.length) continue;
      added++;
      if (APPLY) {
        await c.query(
          `INSERT INTO payback_rates (plot_id, grade_id, effective_date, full_price, saprodi_per_kg, labor_per_kg, notes, created_at, updated_at)
           VALUES (?, NULL, ?, NULL, ?, 0, ?, NOW(), NOW())`, [p.id, RATE_DATE, RATE_PER_KG, RATE_NOTE]);
      }
    }
    log(`+ payback_rates Rp ${RATE_PER_KG}/kg since ${RATE_DATE}: ${added} new, ${SNBS_COCOA_PF.length - added} already there`);
    log(APPLY ? 'done' : 'dry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
