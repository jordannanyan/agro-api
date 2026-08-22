// -----------------------------------------------------------------------------
// Migration: Reimbursement — paying farmers through the KTH (2026-08)
//
// A reimbursement is a payment request that never had a purchase behind it. The
// money goes to the KTH's own bank account in one transfer, and the document
// carries the list of farmers that transfer is meant to settle, with an amount
// each.
//
// It reuses `payment_requests` rather than starting a table of its own, because
// everything that already surrounds a payment request is exactly what a
// reimbursement needs: the approval chain, the payment code issued when the chain
// closes, the bank-statement reconciliation that turns a code plus an amount into
// `Paid`, the attachments, the timeline. A parallel table would have meant a
// second copy of all of it, and a second chance for the two to disagree about
// what "paid" means.
//
// What separates them is `payreq_kind` and the approval route. The chain has the
// same shape as a PayReq's, with one difference the office asked for: a **Field
// Admin** files it, not Procurement. Nothing is being procured, and Field Admin
// is who deals with the KTH and its farmers.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateReimbursement2026-08.js            # dry run
//   node scripts/migrateReimbursement2026-08.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

const DOC_ENUM = "ENUM('PR','PO','PayReq','Reimbursement')";

/** Every table whose document_type has to learn the new word. */
const DOC_TYPE_TABLES = ['approval_routes', 'document_approvals', 'document_attachments', 'document_activities'];

async function column(conn, table, name) {
  const [r] = await conn.query(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS'
    + ' WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [DB, table, name]);
  return r[0] || null;
}

async function tableExists(conn, table) {
  const [r] = await conn.query(
    'SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [DB, table]);
  return Number(r[0].n) > 0;
}

async function constraintExists(conn, table, name) {
  const [r] = await conn.query(
    'SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS'
    + ' WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [DB, table, name]);
  return Number(r[0].n) > 0;
}

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
  log('  database: ' + DB + '\n');

  // 1 -- document_type learns 'Reimbursement'
  log('1. document_type ENUM');
  for (const table of DOC_TYPE_TABLES) {
    const col = await column(conn, table, 'document_type');
    if (!col) { log('   ! ' + table + '.document_type tidak ada — dilewati'); continue; }
    if (col.COLUMN_TYPE.indexOf("'Reimbursement'") >= 0) {
      log('   · ' + table + ".document_type sudah memuat 'Reimbursement'");
      continue;
    }
    log('   ~ ' + table + '.document_type → ' + DOC_ENUM);
    if (APPLY) {
      await conn.query('ALTER TABLE `' + table + '` MODIFY `document_type` ' + DOC_ENUM + ' NOT NULL');
    }
  }

  // 2 -- the KTH's own bank account, as master data
  //
  // It has never been recorded anywhere: farmers have `no_rek`, the KTH had
  // nothing. Typing it per document would have meant a different transcription of
  // the same account on every reimbursement.
  log('\n2. rekening KTH');
  const KTH_COLS = [
    ['bank_name', 'VARCHAR(80) NULL', 'partnership_period'],
    ['bank_account', 'VARCHAR(60) NULL', 'bank_name'],
    ['bank_account_name', 'VARCHAR(150) NULL', 'bank_account'],
  ];
  for (const [name, type, after] of KTH_COLS) {
    if (await column(conn, 'kth', name)) { log('   · kth.' + name + ' sudah ada'); continue; }
    log('   + kth.' + name + ' ' + type);
    if (APPLY) {
      await conn.query('ALTER TABLE `kth` ADD COLUMN `' + name + '` ' + type + ' AFTER `' + after + '`');
    }
  }

  // 3 -- payment_requests: which kind, which KTH, and who filed it
  log('\n3. payment_requests');
  const PAYREQ_COLS = [
    ['payreq_kind', "ENUM('Procurement','Reimbursement') NOT NULL DEFAULT 'Procurement'", 'payment_code_issued_at'],
    ['kth_id', 'INT NULL', 'entity_id'],
    // A PayReq never recorded its author, so guardDelete fell back to "whoever
    // holds the requester role". With three Field Admins per PT that let one of
    // them throw away another's draft; the column closes it for reimbursements and
    // for ordinary payment requests alike.
    ['requested_by_user_id', 'INT NULL', 'person_in_charge'],
  ];
  for (const [name, type, after] of PAYREQ_COLS) {
    if (await column(conn, 'payment_requests', name)) {
      log('   · payment_requests.' + name + ' sudah ada');
      continue;
    }
    log('   + payment_requests.' + name + ' ' + type);
    if (APPLY) {
      await conn.query('ALTER TABLE `payment_requests` ADD COLUMN `' + name + '` ' + type + ' AFTER `' + after + '`');
    }
  }

  const FKS = [
    ['fk_payreq_kth', 'kth_id', '`kth`(`id`)'],
    ['fk_payreq_requester', 'requested_by_user_id', '`users`(`id`)'],
  ];
  for (const [name, col, ref] of FKS) {
    if (await constraintExists(conn, 'payment_requests', name)) { log('   · ' + name + ' sudah ada'); continue; }
    log('   + ' + name + ' (' + col + ')');
    if (APPLY) {
      await conn.query('ALTER TABLE `payment_requests` ADD CONSTRAINT `' + name + '`'
        + ' FOREIGN KEY (`' + col + '`) REFERENCES ' + ref + ' ON DELETE SET NULL');
    }
  }

  // 4 -- the farmer lines
  log('\n4. reimbursement_items');
  if (await tableExists(conn, 'reimbursement_items')) {
    log('   · reimbursement_items sudah ada');
  } else {
    log('   + reimbursement_items');
    if (APPLY) {
      await conn.query([
        'CREATE TABLE `reimbursement_items` (',
        '  `id`                 INT AUTO_INCREMENT PRIMARY KEY,',
        '  `payment_request_id` INT NOT NULL,',
        '  `farmer_id`          INT NULL,',
        '  `farmer_name`        VARCHAR(255) NOT NULL,',
        '  `description`        VARCHAR(255) NULL,',
        '  `amount`             DECIMAL(18,2) NOT NULL DEFAULT 0,',
        '  `created_at`         DATETIME NULL,',
        '  `updated_at`         DATETIME NULL,',
        '  CONSTRAINT `fk_ri_payreq` FOREIGN KEY (`payment_request_id`) REFERENCES `payment_requests`(`id`) ON DELETE CASCADE,',
        '  CONSTRAINT `fk_ri_farmer` FOREIGN KEY (`farmer_id`) REFERENCES `farmers`(`id`) ON DELETE SET NULL',
        ') ENGINE=InnoDB',
      ].join('\n'));
    }
  }

  // 5 -- the approval route, derived rather than typed
  //
  // Copied from each entity's own PayReq chain so the two cannot drift apart, with
  // step 1 handed to the Field Admin. An entity with no PayReq route of its own is
  // left alone: it falls back to the entity-agnostic rows exactly as a PayReq does.
  log('\n5. approval_routes untuk Reimbursement');
  const [roleRows] = await conn.query("SELECT id FROM roles WHERE role_code = 'FIELD_ADMIN' LIMIT 1");
  const fieldAdminId = roleRows[0] && roleRows[0].id;
  if (!fieldAdminId) {
    log('   ! role FIELD_ADMIN tidak ditemukan — rute tidak bisa dibuat');
  } else {
    const [src] = await conn.query(
      'SELECT entity_id, step_order, step_label, role_id, min_amount, max_amount'
      + " FROM approval_routes WHERE document_type = 'PayReq' ORDER BY entity_id, step_order");
    const [existing] = await conn.query(
      "SELECT entity_id, step_order FROM approval_routes WHERE document_type = 'Reimbursement'");
    const have = new Set(existing.map((r) => r.entity_id + '|' + r.step_order));

    let added = 0;
    for (const r of src) {
      if (have.has(r.entity_id + '|' + r.step_order)) continue;
      const first = Number(r.step_order) === 1;
      const roleId = first ? fieldAdminId : r.role_id;
      const label = first ? 'Requested' : r.step_label;
      log('   + entitas ' + (r.entity_id == null ? '(semua)' : r.entity_id)
        + ' langkah ' + r.step_order + ' ' + label + ' role ' + roleId
        + (first ? '   ← Field Admin, bukan Procurement' : ''));
      added++;
      if (APPLY) {
        await conn.query(
          'INSERT INTO approval_routes (document_type, entity_id, step_order, step_label, role_id, min_amount, max_amount, created_at, updated_at)'
          + " VALUES ('Reimbursement', ?, ?, ?, ?, ?, ?, NOW(), NOW())",
          [r.entity_id, r.step_order, label, roleId, r.min_amount, r.max_amount]);
      }
    }
    if (!added) log('   · seluruh rute Reimbursement sudah ada');
  }

  log('\n' + (APPLY ? '✔ Selesai.' : '✔ Dry run selesai — jalankan lagi dengan --apply untuk menulis.'));
  await conn.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
