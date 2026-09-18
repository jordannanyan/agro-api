// -----------------------------------------------------------------------------
// Migration: notifikasi + budget code per barang di PO (2026-09)
//
// Two things the revision of 2026-09-18 needs from the database:
//
//   1. `notifications` — what somebody should be told once it has already happened.
//      Separate from the approval inbox, which counts what is waiting for *you to
//      act*. These are the other half: a request you filed came out approved, an
//      order you have to pay for cleared, goods you will receive have been paid
//      for. One row per recipient, because read state is per-person.
//
//   2. `purchase_order_items.budget_code_id` — a purchase request already carries a
//      code per item, and an order raised from it has to keep them. Until now a PO
//      held a single code for the whole document, so a request spanning two budgets
//      collapsed into one the moment it became an order. The column is backfilled
//      from the request item each line came from, falling back to the order's own
//      single code for lines that have no request item behind them.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateNotifications2026-09.js            # dry run
//   node scripts/migrateNotifications2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

async function tableExists(conn, table) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [DB, table]);
  return Number(r[0].n) > 0;
}

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [DB, table, column]);
  return Number(r[0].n) > 0;
}

const CREATE_NOTIFICATIONS = `
CREATE TABLE \`notifications\` (
  \`id\`            INT AUTO_INCREMENT PRIMARY KEY,
  \`user_id\`       INT NOT NULL,
  \`kind\`          VARCHAR(40) NOT NULL,
  \`title\`         VARCHAR(160) NOT NULL,
  \`body\`          VARCHAR(500) NULL,
  \`document_type\` VARCHAR(20) NULL,
  \`document_id\`   INT NULL,
  \`link\`          VARCHAR(200) NULL,
  \`read_at\`       DATETIME NULL,
  \`created_at\`    DATETIME NULL,
  KEY \`idx_notif_user\` (\`user_id\`, \`read_at\`, \`id\`),
  CONSTRAINT \`fk_notif_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB`;

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(`\n=== Migrasi notifikasi + budget code PO — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  let changes = 0;

  // ---- 1. notifications -----------------------------------------------------
  if (await tableExists(conn, 'notifications')) {
    log('1. tabel `notifications` sudah ada — dilewati');
  } else {
    log('1. tabel `notifications` BELUM ada — akan dibuat');
    changes++;
    if (APPLY) {
      await conn.query(CREATE_NOTIFICATIONS);
      log('   dibuat');
    }
  }

  // ---- 2. purchase_order_items.budget_code_id -------------------------------
  if (await columnExists(conn, 'purchase_order_items', 'budget_code_id')) {
    log('2. kolom `purchase_order_items.budget_code_id` sudah ada — dilewati');
  } else {
    const [[{ n: rows }]] = await conn.query('SELECT COUNT(*) AS n FROM purchase_order_items');
    log(`2. kolom \`purchase_order_items.budget_code_id\` BELUM ada — akan ditambah (${rows} baris item akan di-backfill)`);
    changes++;
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `purchase_order_items` ADD COLUMN `budget_code_id` INT NULL AFTER `pr_item_id`');
      await conn.query(
        'ALTER TABLE `purchase_order_items` ADD CONSTRAINT `fk_poi_budget` '
        + 'FOREIGN KEY (`budget_code_id`) REFERENCES `budget_codes`(`id`) ON DELETE SET NULL');
      log('   kolom ditambahkan');

      // Backfill: the request item this line came from knows its code. Where the
      // line has no request item behind it, the order's own single code stands in —
      // that is the code it was approved with, so it is the honest answer.
      const [a] = await conn.query(
        `UPDATE purchase_order_items poi
         JOIN purchase_request_items pri ON pri.id = poi.pr_item_id
         SET poi.budget_code_id = pri.budget_code_id
         WHERE poi.budget_code_id IS NULL AND pri.budget_code_id IS NOT NULL`);
      const [b] = await conn.query(
        `UPDATE purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.po_id
         SET poi.budget_code_id = po.budget_code_id
         WHERE poi.budget_code_id IS NULL AND po.budget_code_id IS NOT NULL`);
      log(`   backfill: ${a.affectedRows} dari item PR, ${b.affectedRows} dari kode PO`);
      const [[{ n: blank }]] = await conn.query(
        'SELECT COUNT(*) AS n FROM purchase_order_items WHERE budget_code_id IS NULL');
      if (blank) log(`   catatan: ${blank} item masih tanpa budget code — tidak ada sumber yang bisa dipercaya untuk diisi`);
    }
  }

  log('');
  if (!changes) log('Tidak ada yang perlu diubah — database sudah sesuai.');
  else if (!APPLY) log(`${changes} perubahan menunggu. Jalankan ulang dengan --apply untuk menerapkannya.`);
  else log(`${changes} perubahan diterapkan.`);

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
