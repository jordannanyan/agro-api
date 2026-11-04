// -----------------------------------------------------------------------------
// Migration: paying the profit share out at the end, Pre-Finance debt first (2026-11)
//
// Business rule of 2026-11-05: the farmer's profit share is paid once, after the
// plot's harvests are done (JNBS: 2027/2028), and only while the plot stands in
// profit. Of what is then released, the farmer's remaining Pre-Finance debt —
// the loans from before the plot became profit sharing — is kept back first and
// booked as a repayment. The per-sale settlements keep only building balances.
//
//   profit_sharing_payouts                              one payout per plot
//   pre_finance_installments.profit_sharing_payout_id   its repayment, deleted with it
//
// The table is created from db/schema.sql itself, so a clean install and this
// migration cannot drift apart. Nothing is paid here. Idempotent; dry-run by default.
//
// Usage:
//   node scripts/migrateProfitSharePayouts2026-11.js [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

function tableSql() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const start = src.indexOf('CREATE TABLE `profit_sharing_payouts`');
  const end = src.indexOf(') ENGINE=InnoDB;', start);
  if (start < 0 || end < 0) throw new Error('profit_sharing_payouts not found in db/schema.sql');
  return src.slice(start, end + ') ENGINE=InnoDB'.length);
}

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const [[t]] = await c.query(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'profit_sharing_payouts'`, [DB]);
    const [[col]] = await c.query(`SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = 'pre_finance_installments' AND COLUMN_NAME = 'profit_sharing_payout_id'`, [DB]);
    if (!Number(t.n)) { log('+ tabel profit_sharing_payouts'); if (APPLY) await c.query(tableSql()); }
    if (!Number(col.n)) {
      log('+ pre_finance_installments.profit_sharing_payout_id');
      if (APPLY) {
        await c.query('ALTER TABLE pre_finance_installments ADD COLUMN `profit_sharing_payout_id` INT NULL AFTER `purchasing_id`, '
          + 'ADD UNIQUE KEY `uq_pfi_ps_payout` (`profit_sharing_payout_id`), '
          + 'ADD CONSTRAINT `fk_pfi_ps_payout` FOREIGN KEY (`profit_sharing_payout_id`) REFERENCES `profit_sharing_payouts`(`id`) ON DELETE CASCADE');
      }
    }
    if (Number(t.n) && Number(col.n)) log('· sudah ada semua');
    log(APPLY ? '\ndone' : '\ndry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
