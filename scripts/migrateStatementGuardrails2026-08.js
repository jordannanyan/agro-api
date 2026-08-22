// -----------------------------------------------------------------------------
// Migration: guardrails on bank statement uploads (2026-08)
//
// Adds one column. `bank_statement_imports.file_hash` is the SHA-256 of the file
// as uploaded, so the same export cannot be imported twice.
//
// The per-line hashes already stopped a line from paying twice, but they answer
// the question one row at a time and only after the file has been read: a
// re-uploaded statement came back as "every line duplicate", which reads like a
// fault rather than "you already did this one". The digest answers it up front.
//
// Retained files are hashed to backfill the column. They are stored exactly as
// they arrived — still encrypted — so no password is needed to hash them, and an
// import whose file is missing simply keeps a NULL and is never matched against.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateStatementGuardrails2026-08.js            # dry run
//   node scripts/migrateStatementGuardrails2026-08.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const STATEMENT_PATH = process.env.STATEMENT_PATH || './storage/statements';
const log = (...a) => console.log(...a);

async function hasColumn(conn, table, column) {
  const [r] = await conn.query(
    `SELECT COUNT(*) n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [DB, table, column]);
  return Number(r[0].n) > 0;
}

async function hasIndex(conn, table, index) {
  const [r] = await conn.query(
    `SELECT COUNT(*) n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`, [DB, table, index]);
  return Number(r[0].n) > 0;
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written.');
  log(`  database: ${DB}\n`);

  // 1 ── the column
  if (await hasColumn(conn, 'bank_statement_imports', 'file_hash')) {
    log('   · bank_statement_imports.file_hash sudah ada');
  } else {
    log('   + bank_statement_imports.file_hash CHAR(64) NULL AFTER file_path');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `bank_statement_imports` ADD COLUMN `file_hash` CHAR(64) NULL AFTER `file_path`');
    }
  }

  // 2 ── the index it is looked up by
  if (await hasIndex(conn, 'bank_statement_imports', 'idx_bsi_file_hash')) {
    log('   · idx_bsi_file_hash sudah ada');
  } else {
    log('   + idx_bsi_file_hash (file_hash)');
    if (APPLY) {
      await conn.query('ALTER TABLE `bank_statement_imports` ADD KEY `idx_bsi_file_hash` (`file_hash`)');
    }
  }

  // 3 ── backfill from the retained copies
  let rows = [];
  if (await hasColumn(conn, 'bank_statement_imports', 'file_hash')) {
    const [r] = await conn.query(
      'SELECT id, file_name, file_path FROM bank_statement_imports WHERE file_hash IS NULL');
    rows = r;
  } else {
    const [r] = await conn.query('SELECT id, file_name, file_path FROM bank_statement_imports');
    rows = r;
    if (rows.length) log('   (kolom belum ada — daftar di bawah adalah yang akan di-backfill saat --apply)');
  }

  let hashed = 0, missing = 0;
  for (const row of rows) {
    // file_path is the public URL of the retained copy; the file itself sits in
    // STATEMENT_PATH under the same basename.
    const local = path.join(STATEMENT_PATH, path.basename(row.file_path || ''));
    if (!row.file_path || !fs.existsSync(local)) {
      missing++;
      log(`   ! impor #${row.id} "${row.file_name}" — berkasnya tidak ada di ${STATEMENT_PATH}, file_hash dibiarkan NULL`);
      continue;
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
    hashed++;
    log(`   ~ impor #${row.id} → ${digest.slice(0, 16)}…`);
    if (APPLY) {
      await conn.query('UPDATE bank_statement_imports SET file_hash = ? WHERE id = ?', [digest, row.id]);
    }
  }

  log(`\n  ${hashed} impor di-hash, ${missing} tanpa berkas tersimpan.`);
  log(APPLY ? '✔ Selesai.' : '✔ Dry run selesai — jalankan lagi dengan --apply untuk menulis.');
  await conn.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
