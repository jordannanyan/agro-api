// -----------------------------------------------------------------------------
// Migration: lampiran untuk Stock In dan Stock Out (2026-09)
//
// A receiving clerk has a delivery note in one hand and a phone in the other, and
// neither had anywhere to go. Stock In carried `delivery_note_no` — the note's
// NUMBER — and no file at all; Stock Out carried nothing beyond the per-line proof
// columns on the distribution rows.
//
// Rather than new tables, this widens the polymorphic attachment layer that PR, PO
// and the payment requests already use. Three new document types:
//
//   StockIn       the delivery note — one sheet covers the whole shipment
//   StockInItem   photos of the goods, per LINE (stock_in_items.id)
//   StockOut      whatever the issue was evidenced by
//
// 'StockInItem' pointing at a line rather than a document is the point of the
// exercise: a clerk photographs each item as it comes off the truck, and a photo
// that cannot say which item it is of answers nothing.
//
// `document_activities` is widened alongside `document_attachments`. Nothing writes
// an activity for these types today, but MySQL here runs without STRICT mode: a
// value the ENUM does not list is stored as an EMPTY STRING and the insert reports
// success. That trap cost an afternoon on the Expense work; it is cheaper to close
// it now than to find it later.
//
// approval_routes and document_approvals are deliberately NOT widened. Stock
// movements have no approval chain, and listing them there would suggest otherwise.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateStockAttachments2026-09.js            # dry run
//   node scripts/migrateStockAttachments2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

const WIDER = "ENUM('PR','PO','PayReq','Reimbursement','Expense','StockIn','StockInItem','StockOut') NOT NULL";
const TABLES = ['document_attachments', 'document_activities'];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(`\n=== Migrasi lampiran Stock In / Stock Out — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  let changes = 0;

  for (const t of TABLES) {
    const [[c]] = await conn.query(
      `SELECT COLUMN_TYPE AS ct FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? AND column_name = 'document_type'`, [DB, t]);
    if (!c) { log(`  ${t}: tidak ada — dilewati`); continue; }
    if (String(c.ct).includes("'StockInItem'")) {
      log(`  ${t}.document_type sudah memuat jenis Stock — dilewati`);
      continue;
    }
    log(`  ${t}.document_type akan diperluas dengan StockIn / StockInItem / StockOut`);
    changes++;
    if (APPLY) {
      await conn.query(`ALTER TABLE \`${t}\` MODIFY COLUMN \`document_type\` ${WIDER}`);
    }
  }

  // Safety net, same as the Expense migration: anything written before the ENUM was
  // widened landed as '' and is unreachable by any lookup.
  for (const t of TABLES) {
    const [[bad]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE document_type = ''`);
    if (!Number(bad.n)) continue;
    log(`  ${t}: ${bad.n} baris ber-document_type kosong akan dibuang`);
    changes++;
    if (APPLY) await conn.query(`DELETE FROM \`${t}\` WHERE document_type = ''`);
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
