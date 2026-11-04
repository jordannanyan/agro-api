// -----------------------------------------------------------------------------
// Migration: Pre-Finance debt deducted from the farmer's profit share (2026-11)
//
// Business rule of 2026-11-05: when a plot that was Pre-Finance becomes profit
// sharing (the five JNBS plots of Mustari, Eko Irawan and Yudis, 29 Aug 2025),
// whatever the farmer still owes from the Pre-Finance period comes out of the
// farmer's share at settlement — the profit-sharing deliveries carry no per-kg
// deduction, so nothing else would ever pay it back.
//
//   profit_sharing.pf_deduction                  the share kept back
//   pre_finance_installments.profit_sharing_id   the repayment it is booked as;
//                                                deleted with the settlement row
//
// Columns only; nothing is settled here. Idempotent. Dry-run by default.
//
// Usage:
//   node scripts/migrateProfitSharePfDeduction2026-11.js [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const has = async (t, col) => Number((await c.query(`SELECT COUNT(*) n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [DB, t, col]))[0][0].n) > 0;
    const steps = [];
    if (!(await has('profit_sharing', 'pf_deduction'))) {
      steps.push(['profit_sharing.pf_deduction',
        'ALTER TABLE profit_sharing ADD COLUMN `pf_deduction` DECIMAL(18,2) NOT NULL DEFAULT 0 AFTER `cum_kth`']);
    }
    if (!(await has('pre_finance_installments', 'profit_sharing_id'))) {
      steps.push(['pre_finance_installments.profit_sharing_id',
        'ALTER TABLE pre_finance_installments ADD COLUMN `profit_sharing_id` INT NULL AFTER `purchasing_id`, '
        + 'ADD UNIQUE KEY `uq_pfi_profit_sharing` (`profit_sharing_id`), '
        + 'ADD CONSTRAINT `fk_pfi_profit_sharing` FOREIGN KEY (`profit_sharing_id`) REFERENCES `profit_sharing`(`id`) ON DELETE CASCADE']);
    }
    if (!steps.length) log('· kedua kolom sudah ada');
    for (const [name, sql] of steps) {
      log(`+ ${name}`);
      if (APPLY) await c.query(sql);
    }
    const [[n]] = await c.query('SELECT COUNT(*) n FROM profit_sharing');
    log(`catatan bagi hasil yang sudah ada: ${n.n} (tidak diubah — potongan hanya berlaku untuk perhitungan berikutnya)`);
    log(APPLY ? '\ndone' : '\ndry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
