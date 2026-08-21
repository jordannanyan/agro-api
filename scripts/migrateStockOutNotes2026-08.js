// -----------------------------------------------------------------------------
// Migration: reword the generated stock-out notes (2026-08)
//
// The 443 `SOH-` documents were grouped out of the ledgers' own distribution
// lines rather than typed into the app, and both the list badge and the stored
// note said so in a way that read as a disclaimer — "bukan dokumen asli".
//
// The lines have since been checked against the source and they are the ledger's:
//
//   JNBS  ADM_Entry Data Pinjaman + ADM_Entry Bagi Hasil Panen
//         2.035 baris / Rp 602.955.401  =  database, to the rupiah
//   SNBS  Stock card
//         1.066 baris, selisih hanya 502 kg — tiga baris yang tujuannya gudang
//         SNBS sendiri, bukan lahan (import_output_v5/04_skipped.csv)
//
// So the note keeps the provenance and drops the disclaimer. What remains true —
// nobody issued these through the app — the empty `issued_by_user_id` already
// says, and the list shows it as an empty Petugas column.
//
// IMPORTANT: the opening words are deliberately unchanged. Both import bundles
// delete their own rows by matching on them:
//
//   IMPORT_V3_FINAL.sql        notes LIKE 'Dibuat otomatis dari distribusi%'
//   IMPORT_V5_SNBS_SAPRODI.sql notes LIKE 'Dibuat otomatis dari Stock card SNBS%'
//
// Rewriting the prefix would strand those rows and make the bundles insert
// duplicates. Re-running either bundle restores the old wording; just run this
// script again afterwards.
//
// Idempotent, and touches nothing but `stock_out.notes`.
//
// Usage:
//   node scripts/migrateStockOutNotes2026-08.js            # dry run
//   node scripts/migrateStockOutNotes2026-08.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

// old LIKE pattern -> new text. Prefixes match what the bundles look for.
const REWRITES = [
  {
    like: 'Dibuat otomatis dari distribusi%',
    to: 'Dibuat otomatis dari distribusi saprodi buku besar JNBS. '
      + 'Dikelompokkan per gudang dan tanggal.',
  },
  {
    like: 'Dibuat otomatis dari Stock card SNBS%',
    to: 'Dibuat otomatis dari Stock card SNBS Cavendish. '
      + 'Dikelompokkan per gudang dan tanggal.',
  },
];

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

  let touched = 0;
  for (const r of REWRITES) {
    const [rows] = await conn.query(
      'SELECT COUNT(*) n FROM stock_out WHERE notes LIKE ? AND notes <> ?', [r.like, r.to]);
    const n = Number(rows[0].n);
    const [done] = await conn.query('SELECT COUNT(*) n FROM stock_out WHERE notes = ?', [r.to]);
    if (!n) {
      log(`   · ${Number(done[0].n)} dokumen sudah memakai teks baru — tidak ada yang diubah`);
      continue;
    }
    log(`   ~ ${n} dokumen  →  "${r.to}"`);
    touched += n;
    if (APPLY) {
      await conn.query(
        'UPDATE stock_out SET notes = ?, updated_at = NOW() WHERE notes LIKE ? AND notes <> ?',
        [r.to, r.like, r.to]);
    }
  }

  // Nothing else should be relying on the old sentence.
  const [left] = await conn.query(
    "SELECT COUNT(*) n FROM stock_out WHERE notes LIKE '%bukan dokumen asli%'");
  log(`\n   sisa yang masih berbunyi "bukan dokumen asli": ${APPLY ? Number(left[0].n) : 'akan jadi 0'}`);
  log(`   total dokumen SOH-: ` +
      `${(await conn.query("SELECT COUNT(*) n FROM stock_out WHERE stock_out_number LIKE 'SOH-%'"))[0][0].n}`);

  await conn.end();
  log(APPLY
    ? `\n✓ Migration applied${touched ? ` — ${touched} catatan diperbarui.` : ' — tidak ada perubahan.'}`
    : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
