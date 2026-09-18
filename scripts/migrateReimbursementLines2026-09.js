// -----------------------------------------------------------------------------
// Migration: baris reimbursement mengikuti bentuk dokumen aslinya (2026-09)
//
// The reimbursement form the field admins actually file carries far more per line
// than the table held. A line was: farmer, description, amount. The document's is:
// who was paid, what kind of cost it is, whose land or loan the work was on, the
// rate, how many days, which days, the amount, and the worker's own account.
//
// Without those columns the two recaps the document lives by — by scheme and by
// recipient, both adding to the same total — cannot be produced at all, which is
// why the form was still being typed in Google Docs.
//
// Adds to `reimbursement_items`:
//   category              DailyWorker | LabourLoanPreFinance | LabourLoanProfitSharing
//   on_behalf_farmer_id   whose land/loan the work was on (nullable)
//   on_behalf_name        ...as text, for names not in the farmer master
//   rate, work_days, work_dates
//   recipient_bank_name, recipient_bank_account
//
// Existing rows keep their meaning exactly: `farmer_id` / `farmer_name` has always
// been "who is paid", and it still is. They are left as `DailyWorker` with no
// on-behalf farmer, which is the honest reading — nothing in the old data says
// whose loan a line belonged to, and inventing one would be worse than a blank.
//
// Nothing here posts to a farmer's outstanding or to profit sharing. Recording
// only, by decision of 2026-09-18: the same amounts may already be booked through
// another route, and a silent second posting is how the SNBS farmer debt came to be
// overstated by Rp 384.3 million.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateReimbursementLines2026-09.js            # dry run
//   node scripts/migrateReimbursementLines2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [DB, table, column]);
  return Number(r[0].n) > 0;
}

async function indexExists(conn, table, index) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?',
    [DB, table, index]);
  return Number(r[0].n) > 0;
}

// Order matters: each ADD COLUMN names the one before it, so the column order of a
// migrated table matches a clean install from db/schema.sql.
const COLUMNS = [
  ['category', "ENUM('DailyWorker','LabourLoanPreFinance','LabourLoanProfitSharing') NOT NULL DEFAULT 'DailyWorker' AFTER `farmer_name`"],
  ['on_behalf_farmer_id', 'INT NULL AFTER `category`'],
  ['on_behalf_name', 'VARCHAR(255) NULL AFTER `on_behalf_farmer_id`'],
  ['rate', 'DECIMAL(15,2) NULL AFTER `description`'],
  ['work_days', 'DECIMAL(6,2) NULL AFTER `rate`'],
  ['work_dates', 'VARCHAR(255) NULL AFTER `work_days`'],
  ['recipient_bank_name', 'VARCHAR(80) NULL AFTER `amount`'],
  ['recipient_bank_account', 'VARCHAR(60) NULL AFTER `recipient_bank_name`'],
];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(`\n=== Migrasi baris reimbursement — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const [[{ n: rows }]] = await conn.query('SELECT COUNT(*) AS n FROM reimbursement_items');
  log(`Baris reimbursement saat ini: ${rows}`);

  let changes = 0;

  for (const [name, ddl] of COLUMNS) {
    if (await columnExists(conn, 'reimbursement_items', name)) {
      log(`  kolom \`${name}\` sudah ada — dilewati`);
      continue;
    }
    log(`  kolom \`${name}\` akan ditambah`);
    changes++;
    if (APPLY) await conn.query(`ALTER TABLE \`reimbursement_items\` ADD COLUMN \`${name}\` ${ddl}`);
  }

  // FK for the on-behalf farmer, added after its column exists.
  if (await columnExists(conn, 'reimbursement_items', 'on_behalf_farmer_id')) {
    const [fk] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.table_constraints
       WHERE table_schema = ? AND table_name = 'reimbursement_items' AND constraint_name = 'fk_ri_behalf'`, [DB]);
    if (Number(fk[0].n)) {
      log('  constraint `fk_ri_behalf` sudah ada — dilewati');
    } else {
      log('  constraint `fk_ri_behalf` akan ditambah');
      changes++;
      if (APPLY) {
        await conn.query(
          'ALTER TABLE `reimbursement_items` ADD CONSTRAINT `fk_ri_behalf` '
          + 'FOREIGN KEY (`on_behalf_farmer_id`) REFERENCES `farmers`(`id`) ON DELETE SET NULL');
      }
    }
  }

  if (await indexExists(conn, 'reimbursement_items', 'idx_ri_category')) {
    log('  index `idx_ri_category` sudah ada — dilewati');
  } else if (await columnExists(conn, 'reimbursement_items', 'category')) {
    log('  index `idx_ri_category` akan ditambah');
    changes++;
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `reimbursement_items` ADD KEY `idx_ri_category` (`payment_request_id`, `category`)');
    }
  }

  // A clean install never grows a separate index for `fk_ri_payreq`: the new
  // `idx_ri_category` starts with `payment_request_id`, so MySQL uses that to back
  // the foreign key. A migrated table still carries the one created with the
  // original table, and that single extra index is enough to make a clean install
  // and a migrated database disagree — which is the invariant db/schema.sql exists
  // to hold. Dropping it is safe precisely because the wider index covers the key.
  if (await indexExists(conn, 'reimbursement_items', 'idx_ri_category')
      && await indexExists(conn, 'reimbursement_items', 'fk_ri_payreq')) {
    log('  index `fk_ri_payreq` kini mubazir (tercakup idx_ri_category) — akan dibuang');
    changes++;
    if (APPLY) await conn.query('ALTER TABLE `reimbursement_items` DROP INDEX `fk_ri_payreq`');
  }

  log('');
  if (!changes) log('Tidak ada yang perlu diubah — database sudah sesuai.');
  else if (!APPLY) log(`${changes} perubahan menunggu. Jalankan ulang dengan --apply untuk menerapkannya.`);
  else {
    log(`${changes} perubahan diterapkan.`);
    log(`Catatan: ${rows} baris lama tetap berarti sama — "siapa yang dibayar" — dan`);
    log('berkategori DailyWorker tanpa pemilik lahan/pinjaman. Data lama tidak menyimpan');
    log('keterangan itu, dan menebaknya lebih buruk daripada mengosongkannya.');
  }

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
