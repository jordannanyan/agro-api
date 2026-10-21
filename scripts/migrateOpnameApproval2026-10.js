// -----------------------------------------------------------------------------
// Migration: penyesuaian stok dari opname butuh persetujuan PM (2026-10-22)
//
// Sampai sekarang siapa pun yang boleh menulis di gudang bisa menekan "Sesuaikan
// Stok" dan angka stok langsung berubah. Mulai rilis ini penyesuaian harus
// DIAJUKAN, dan baru terjadi saat Project Manager PT pemilik gudang menyetujuinya.
//
// Menambah ke `stock_opname`:
//   approval_status ENUM('Draft','Pending','Approved','Rejected') DEFAULT 'Draft'
//   submitted_by_user_id, submitted_at, reviewed_by_user_id, reviewed_at, review_note
//   + FK fk_opname_submitter / fk_opname_reviewer → users ON DELETE SET NULL
//
// Opname yang SUDAH diterapkan ditandai Approved, dengan review_note yang
// menyebut ia diterapkan sebelum aturan ini — reviewer-nya dibiarkan kosong,
// karena memang tidak ada PM yang menyetujuinya, dan itu tidak boleh dikarang.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateOpnameApproval2026-10.js
//   node scripts/migrateOpnameApproval2026-10.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

// Urutan dan definisinya sama persis dengan db/schema.sql.
const COLUMNS = [
  ['approval_status', "ENUM('Draft','Pending','Approved','Rejected') NOT NULL DEFAULT 'Draft'", 'applied_by_user_id'],
  ['submitted_by_user_id', 'INT NULL', 'approval_status'],
  ['submitted_at', 'DATETIME NULL', 'submitted_by_user_id'],
  ['reviewed_by_user_id', 'INT NULL', 'submitted_at'],
  ['reviewed_at', 'DATETIME NULL', 'reviewed_by_user_id'],
  ['review_note', 'TEXT NULL', 'reviewed_at'],
];
const FKS = [
  ['fk_opname_submitter', 'submitted_by_user_id'],
  ['fk_opname_reviewer', 'reviewed_by_user_id'],
];
const LEGACY_NOTE = 'Diterapkan sebelum persetujuan PM diwajibkan (2026-10-22).';

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`\n=== Migrasi persetujuan PM untuk stok opname — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');
  let changes = 0;

  const [cols] = await conn.query(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [DB, 'stock_opname']);
  const have = new Set(cols.map((r) => r.c));
  for (const [name, def, after] of COLUMNS) {
    if (have.has(name)) { log(`  kolom ${name} sudah ada — dilewati`); continue; }
    log(`  kolom ${name} akan ditambahkan`);
    changes++;
    if (APPLY) await conn.query(`ALTER TABLE stock_opname ADD COLUMN \`${name}\` ${def} AFTER \`${after}\``);
  }

  const [fks] = await conn.query(
    `SELECT CONSTRAINT_NAME AS n FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'stock_opname'`, [DB]);
  const haveFk = new Set(fks.map((r) => r.n));
  for (const [name, col] of FKS) {
    if (haveFk.has(name)) { log(`  FK ${name} sudah ada — dilewati`); continue; }
    log(`  FK ${name} akan ditambahkan`);
    changes++;
    if (APPLY) {
      await conn.query(
        `ALTER TABLE stock_opname ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`${col}\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL`);
    }
  }

  // Opname yang sudah menyesuaikan stok sebelum aturan ini ada.
  const ready = have.has('approval_status') || APPLY;
  if (ready) {
    const [rows] = await conn.query(
      `SELECT id, opname_number, applied_at FROM stock_opname
       WHERE applied_at IS NOT NULL AND approval_status <> 'Approved'`);
    for (const r of rows) log(`  ${r.opname_number}: sudah diterapkan ${String(r.applied_at)} → Approved`);
    if (rows.length) {
      changes += rows.length;
      if (APPLY) {
        await conn.query(
          `UPDATE stock_opname SET approval_status = 'Approved', review_note = ?
           WHERE applied_at IS NOT NULL AND approval_status <> 'Approved'`, [LEGACY_NOTE]);
      }
    }
  } else {
    const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM stock_opname WHERE applied_at IS NOT NULL');
    if (n.n) { log(`  ${n.n} opname yang sudah diterapkan akan ditandai Approved`); changes += n.n; }
  }

  const [[open]] = await conn.query('SELECT COUNT(*) AS n FROM stock_opname WHERE applied_at IS NULL');
  log(`  ${open.n} opname belum diterapkan — tetap Draft; penyesuaiannya sekarang lewat persetujuan PM`);

  log(`\n${changes ? `${changes} perubahan` : 'Tidak ada perubahan'}${APPLY ? ' diterapkan.' : ' — jalankan dengan --apply untuk menerapkan.'}`);
  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
