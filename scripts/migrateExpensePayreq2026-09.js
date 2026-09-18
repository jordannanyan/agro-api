// -----------------------------------------------------------------------------
// Migration: Payment Request tanpa PR/PO — mengganti uang yang ditalangi (2026-09)
//
// A Field Admin who buys fuel, pays a courier or covers a meal out of their own
// pocket has to be paid back, and there is no purchase request or order behind any
// of it. Until now the only source-less payment request in the system was the KTH
// reimbursement, which pays FARMERS — a different thing entirely, and using it for
// staff expenses would have put the two in one list with one name.
//
// So a third kind:
//
//   payment_requests.payreq_kind  gains 'Expense'
//   payment_request_items         what is being claimed back, line by line
//   approval_routes               document_type 'Expense', copied from the
//                                 Reimbursement chain of each entity that has one
//
// The chain is deliberately identical to the KTH reimbursement's — Requested
// (Field Admin) -> Project Manager -> Finance Manager -> Director (acknowledged) —
// because it is the same people signing for the same kind of money. It is a
// separate document_type only so the two can be told apart on a timeline and in
// the inbox.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateExpensePayreq2026-09.js            # dry run
//   node scripts/migrateExpensePayreq2026-09.js --apply
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

const CREATE_ITEMS = `
CREATE TABLE \`payment_request_items\` (
  \`id\`                 INT AUTO_INCREMENT PRIMARY KEY,
  \`payment_request_id\` INT NOT NULL,
  \`description\`        VARCHAR(255) NOT NULL,
  \`amount\`             DECIMAL(18,2) NOT NULL DEFAULT 0,
  \`created_at\`         DATETIME NULL,
  \`updated_at\`         DATETIME NULL,
  KEY \`idx_pri_payreq\` (\`payment_request_id\`),
  CONSTRAINT \`fk_pri_payreq\` FOREIGN KEY (\`payment_request_id\`)
    REFERENCES \`payment_requests\`(\`id\`) ON DELETE CASCADE
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

  log(`\n=== Migrasi Payment Request tanpa PR/PO — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  let changes = 0;

  // ---- 1. payreq_kind mendapat nilai 'Expense' ------------------------------
  const [[col]] = await conn.query(
    `SELECT COLUMN_TYPE AS t FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'payment_requests' AND column_name = 'payreq_kind'`, [DB]);
  if (col && String(col.t).includes("'Expense'")) {
    log("1. payreq_kind sudah memuat 'Expense' — dilewati");
  } else {
    log("1. payreq_kind akan diperluas dengan 'Expense'");
    changes++;
    if (APPLY) {
      await conn.query(
        "ALTER TABLE `payment_requests` MODIFY COLUMN `payreq_kind` "
        + "ENUM('Procurement','Reimbursement','Expense') NOT NULL DEFAULT 'Procurement'");
      log('   diperluas');
    }
  }

  // ---- 2. payment_request_items --------------------------------------------
  if (await tableExists(conn, 'payment_request_items')) {
    log('2. tabel `payment_request_items` sudah ada — dilewati');
  } else {
    log('2. tabel `payment_request_items` akan dibuat');
    changes++;
    if (APPLY) { await conn.query(CREATE_ITEMS); log('   dibuat'); }
  }

  // ---- 3. document_type ENUM di empat tabel ---------------------------------
  //
  // approval_routes, document_approvals, document_attachments and
  // document_activities each pin document_type to an ENUM. MySQL here runs without
  // STRICT mode, so writing a value the ENUM does not list stores an EMPTY STRING
  // and returns success — the row is written, the insert "works", and every later
  // lookup finds nothing. Caught in testing: eight approval routes and an
  // attachment landed as '' before this was added. The ALTERs therefore have to run
  // BEFORE anything writes 'Expense'.
  const ENUM_TABLES = ['approval_routes', 'document_approvals', 'document_attachments', 'document_activities'];
  for (const t of ENUM_TABLES) {
    const [[c]] = await conn.query(
      `SELECT COLUMN_TYPE AS ct FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? AND column_name = 'document_type'`, [DB, t]);
    if (!c) { log(`3. ${t}: tidak ada kolom document_type — dilewati`); continue; }
    if (String(c.ct).includes("'Expense'")) {
      log(`3. ${t}.document_type sudah memuat 'Expense' — dilewati`);
      continue;
    }
    log(`3. ${t}.document_type akan diperluas dengan 'Expense'`);
    changes++;
    if (APPLY) {
      await conn.query(
        `ALTER TABLE \`${t}\` MODIFY COLUMN \`document_type\` `
        + "ENUM('PR','PO','PayReq','Reimbursement','Expense') NOT NULL");
    }
  }

  // Repair: anything an earlier run of this script wrote before the ENUMs were
  // widened landed as ''. Those rows are unreachable by any lookup, so they are
  // cleared rather than left to be found later by somebody debugging a chain that
  // never seeds.
  for (const t of ENUM_TABLES) {
    const [[bad]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE document_type = ''`);
    if (!Number(bad.n)) continue;
    log(`   ${t}: ${bad.n} baris ber-document_type kosong akan dibuang (sisa percobaan sebelumnya)`);
    changes++;
    if (APPLY) await conn.query(`DELETE FROM \`${t}\` WHERE document_type = ''`);
  }

  // ---- 4. approval_routes untuk document_type 'Expense' ---------------------
  //
  // Copied from each entity's Reimbursement chain rather than hardcoded: the
  // entity ids differ between a seeded install and production, and the roles have
  // been renumbered once already.
  const [existing] = await conn.query(
    "SELECT COUNT(*) AS n FROM approval_routes WHERE document_type = 'Expense'");
  if (Number(existing[0].n)) {
    log(`4. approval_routes 'Expense' sudah ada (${existing[0].n} baris) — dilewati`);
  } else {
    const [src] = await conn.query(
      "SELECT entity_id, step_order, step_label, role_id, min_amount, max_amount"
      + " FROM approval_routes WHERE document_type = 'Reimbursement' ORDER BY entity_id, step_order");
    if (!src.length) {
      log("4. TIDAK ADA route 'Reimbursement' untuk disalin — periksa dulu, jangan lanjut");
    } else {
      const entities = [...new Set(src.map((r) => r.entity_id))];
      log(`4. approval_routes 'Expense' akan dibuat: ${src.length} baris untuk ${entities.length} entitas`
        + ` (disalin dari rantai Reimbursement)`);
      changes++;
      if (APPLY) {
        for (const r of src) {
          await conn.query(
            'INSERT INTO approval_routes (document_type, entity_id, step_order, step_label, role_id, min_amount, max_amount)'
            + " VALUES ('Expense', ?, ?, ?, ?, ?, ?)",
            [r.entity_id, r.step_order, r.step_label, r.role_id, r.min_amount, r.max_amount]);
        }
        log(`   ${src.length} baris ditulis`);
      }
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
