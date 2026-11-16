// -----------------------------------------------------------------------------
// Migration: a sale is recorded the way its invoice reads (2026-11)
//
// A sale had one price per kilo. The invoice the buyer receives does not: it has
// one line per grade (Cavendish A Rp 7.000, B Rp 6.000, C, FB, Non Grade…) and,
// below them, fee lines charged per kilo (Cleaning and Packing Rp 250/kg). So:
//
//   · selling_items — the invoice lines. `line_type` product = a grade of the
//     fruit (its kilos are the accepted volume), fee = a charge on top. amount
//     is quantity × price, generated.
//   · selling.invoice_number / do_number / vehicle_number — the invoice header.
//   · selling.invoice_total — the invoice's grand total, kept by the API from the
//     lines. total_revenue becomes COALESCE(invoice_total, accepted × price), so a
//     sale entered line by line is worth exactly its grand total (a blended price
//     rounded to 2 decimals would be a few rupiah off), and every sale entered
//     before — the ledger imports included — keeps the value it had.
//
// Idempotent. Dry-run by default (prints what it would do).
//
// Usage:
//   node scripts/migrateSellingInvoice2026-11.js [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const run = async (label, sql) => { log(`+ ${label}`); if (APPLY) await c.query(sql); };
  try {
    const cols = new Set((await c.query(`SELECT COLUMN_NAME n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'selling'`, [DB]))[0].map((r) => r.n));
    if (!cols.has('invoice_number')) {
      await run('selling.invoice_number / do_number / vehicle_number',
        `ALTER TABLE selling
           ADD COLUMN \`invoice_number\` VARCHAR(100) NULL AFTER \`warehouse_id\`,
           ADD COLUMN \`do_number\`      VARCHAR(100) NULL AFTER \`invoice_number\`,
           ADD COLUMN \`vehicle_number\` VARCHAR(30)  NULL AFTER \`do_number\``);
    }
    if (!cols.has('invoice_total')) {
      await run('selling.invoice_total', 'ALTER TABLE selling ADD COLUMN `invoice_total` DECIMAL(18,2) NULL AFTER `price_per_unit`');
    }
    const [[gen]] = await c.query(`SELECT GENERATION_EXPRESSION g FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'selling' AND COLUMN_NAME = 'total_revenue'`, [DB]);
    if (!/invoice_total/.test(gen?.g || '')) {
      await run('selling.total_revenue = COALESCE(invoice_total, accepted × price)',
        `ALTER TABLE selling MODIFY COLUMN \`total_revenue\` DECIMAL(18,2)
           GENERATED ALWAYS AS (COALESCE(\`invoice_total\`, \`accepted_volume\` * \`price_per_unit\`)) STORED`);
    }
    const [[t]] = await c.query(`SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'selling_items'`, [DB]);
    if (!Number(t.n)) {
      await run('selling_items', `CREATE TABLE \`selling_items\` (
  \`id\`             INT AUTO_INCREMENT PRIMARY KEY,
  \`selling_id\`     INT NOT NULL,
  \`line_type\`      ENUM('product','fee') NOT NULL DEFAULT 'product',
  \`grade_id\`       INT NULL,
  \`description\`    VARCHAR(255) NULL,
  \`quantity\`       DECIMAL(15,3) NOT NULL DEFAULT 0,
  \`price_per_unit\` DECIMAL(15,2) NOT NULL DEFAULT 0,
  \`amount\`         DECIMAL(18,2) GENERATED ALWAYS AS (\`quantity\` * \`price_per_unit\`) STORED,
  \`sort_order\`     INT NOT NULL DEFAULT 0,
  \`created_at\`     DATETIME NULL,
  \`updated_at\`     DATETIME NULL,
  KEY \`idx_sitem_selling\` (\`selling_id\`),
  CONSTRAINT \`fk_sitem_selling\` FOREIGN KEY (\`selling_id\`) REFERENCES \`selling\`(\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`fk_sitem_grade\`   FOREIGN KEY (\`grade_id\`)   REFERENCES \`grade\`(\`id\`) ON DELETE SET NULL
) ENGINE=InnoDB`);
    }
    if (APPLY) {
      const [[chk]] = await c.query('SELECT COUNT(*) n, SUM(total_revenue <> ROUND(accepted_volume * price_per_unit, 2)) bad FROM selling WHERE invoice_total IS NULL');
      log(`\ncek: ${chk.n} penjualan lama, nilai berubah: ${Number(chk.bad || 0)}`);
    }
    log(APPLY ? '\ndone' : '\ndry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
