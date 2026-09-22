// -----------------------------------------------------------------------------
// Migration: peran Pegawai Gudang (2026-09)
//
// Somebody was hired to run a warehouse and nothing else, and the only role that
// fitted was FIELD_ADMIN — which also files purchase requests, records purchasing,
// handles the KTH reimbursements and reads the executive dashboard. None of that is
// theirs, and a menu full of documents a person may not touch is how the ones they
// may touch get lost.
//
// So a role of its own: entity-bound (they belong to one PT, like the Field Admin
// they sit beside), no approval step anywhere, and — the part that matters — still
// on the receiving end of `goods_in_transit`, the notification that says a payment
// has gone out and a delivery is now coming. That is the one thing a storekeeper
// needs to know about a payment request.
//
// The role is created here; assigning a person to it is a separate, deliberate act
// done from Settings (or by hand), because who holds a role is not a schema fact.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateWarehouseStaffRole2026-09.js            # dry run
//   node scripts/migrateWarehouseStaffRole2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
  });

  log(`\n=== Migrasi peran Pegawai Gudang — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  let changes = 0;

  const [rows] = await conn.query(
    "SELECT id, role_name, is_cross_entity FROM roles WHERE role_code = 'WAREHOUSE_STAFF'");
  if (rows.length) {
    log(`  peran WAREHOUSE_STAFF sudah ada (id ${rows[0].id}, "${rows[0].role_name}") — dilewati`);
  } else {
    log("  peran WAREHOUSE_STAFF akan dibuat — 'Pegawai Gudang', terikat satu entitas");
    changes++;
    if (APPLY) {
      await conn.query(
        "INSERT INTO roles (role_code, role_name, is_cross_entity, created_at, updated_at)"
        + " VALUES ('WAREHOUSE_STAFF', 'Pegawai Gudang', 0, NOW(), NOW())");
      const [[r]] = await conn.query("SELECT id FROM roles WHERE role_code = 'WAREHOUSE_STAFF'");
      log(`   dibuat dengan id ${r.id}`);
    }
  }

  // No approval_routes rows: this role signs nothing. Said out loud because every
  // other role added to this system got a chain, and its absence here is a decision
  // rather than something forgotten.
  const [[ar]] = await conn.query(
    "SELECT COUNT(*) AS n FROM approval_routes ar JOIN roles r ON r.id = ar.role_id"
    + " WHERE r.role_code = 'WAREHOUSE_STAFF'");
  log(`  langkah approval untuk peran ini: ${ar.n} (memang nol — gudang tidak menandatangani apa pun)`);

  log('');
  if (!changes) log('Tidak ada yang perlu diubah — database sudah sesuai.');
  else if (!APPLY) log(`${changes} perubahan menunggu. Jalankan ulang dengan --apply untuk menerapkannya.`);
  else {
    log(`${changes} perubahan diterapkan.`);
    log('Langkah berikutnya, dan ini disengaja TIDAK otomatis: pindahkan orangnya ke');
    log('peran ini lewat Settings → Users, atau dengan UPDATE yang disebut eksplisit.');
  }

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
