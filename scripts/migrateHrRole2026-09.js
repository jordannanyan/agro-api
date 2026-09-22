// -----------------------------------------------------------------------------
// Migration: peran HR (2026-09)
//
// Dua payment request yang tidak berasal dari procurement — penggantian ke petani
// lewat KTH, dan penggantian uang yang ditalangi sendiri — sekarang berada di satu
// menu. Yang menandatanganinya sama persis (Project Manager → Finance Manager →
// Direktur); yang berbeda hanya siapa yang mengajukan dan untuk siapa.
//
// Selain Field Admin, HR di WLI juga mengajukan keduanya, dan ia melayani semua PT.
// Karena itu perannya lintas entitas: satu orang untuk seluruh grup.
//
// HR tidak menandatangani apa pun — tidak ada baris approval_routes untuknya, sama
// seperti peran Pegawai Gudang. Langkah "Requested" pada dokumen yang ia ajukan
// dipindahkan ke perannya oleh API saat dokumen dibuat (assignRequestedStepToFiler),
// bukan oleh rute approval, supaya alur persetujuan tetap satu untuk kedua peran.
//
// Menugaskan orangnya ke peran ini dilakukan terpisah lewat Settings → Users:
// siapa memegang peran apa bukan fakta skema.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateHrRole2026-09.js            # dry run
//   node scripts/migrateHrRole2026-09.js --apply
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

  log(`\n=== Migrasi peran HR — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  let changes = 0;

  const [rows] = await conn.query(
    "SELECT id, role_name, is_cross_entity FROM roles WHERE role_code = 'HR'");
  if (rows.length) {
    log(`  peran HR sudah ada (id ${rows[0].id}, "${rows[0].role_name}", `
      + `lintas entitas=${rows[0].is_cross_entity}) — dilewati`);
  } else {
    log("  peran HR akan dibuat — 'HR', lintas entitas");
    changes++;
    if (APPLY) {
      await conn.query(
        "INSERT INTO roles (role_code, role_name, is_cross_entity, created_at, updated_at)"
        + " VALUES ('HR', 'HR', 1, NOW(), NOW())");
      const [[r]] = await conn.query("SELECT id FROM roles WHERE role_code = 'HR'");
      log(`   dibuat dengan id ${r.id}`);
    }
  }

  // Disebut lantang karena setiap peran lain yang ditambahkan ke sistem ini punya
  // rantai approval; tidak adanya rantai di sini adalah keputusan, bukan kelupaan.
  const [[ar]] = await conn.query(
    "SELECT COUNT(*) AS n FROM approval_routes ar JOIN roles r ON r.id = ar.role_id"
    + " WHERE r.role_code = 'HR'");
  log(`  langkah approval untuk peran ini: ${ar.n} (memang nol — HR mengajukan, tidak menyetujui)`);

  // Rantai kedua klaim harus identik: itulah yang membuat keduanya boleh digabung
  // ke satu menu. Kalau suatu saat berbeda, gabungan itu berbohong.
  const [chains] = await conn.query(
    "SELECT ar.document_type, ar.step_order, ar.step_label, r.role_code"
    + " FROM approval_routes ar JOIN roles r ON r.id = ar.role_id"
    + " WHERE ar.document_type IN ('Reimbursement','Expense')"
    + " GROUP BY ar.document_type, ar.step_order, ar.step_label, r.role_code"
    + " ORDER BY ar.step_order");
  const sig = (t) => chains.filter((c) => c.document_type === t)
    .map((c) => `${c.step_order}:${c.step_label}:${c.role_code}`).join(' → ');
  const a = sig('Reimbursement'), b = sig('Expense');
  log(`\n  rantai Reimbursement : ${a || '(kosong)'}`);
  log(`  rantai Expense       : ${b || '(kosong)'}`);
  log(a && a === b
    ? '  → identik, seperti yang diandaikan menu gabungan.'
    : '  → PERHATIAN: kedua rantai TIDAK identik. Satu menu untuk keduanya jadi menyesatkan.');

  log('');
  if (!changes) log('Tidak ada yang perlu diubah — database sudah sesuai.');
  else if (!APPLY) log(`${changes} perubahan menunggu. Jalankan ulang dengan --apply untuk menerapkannya.`);
  else {
    log(`${changes} perubahan diterapkan.`);
    log('Langkah berikutnya, dan ini disengaja TIDAK otomatis: buat/pindahkan akun');
    log('HR (mis. Renita) ke peran ini lewat Settings → Users.');
  }

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
