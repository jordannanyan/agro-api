// -----------------------------------------------------------------------------
// Migration: menggabungkan baris ganda di master `sapropdi` (2026-09)
//
// Master saprodi memuat 11 pasang baris yang sebenarnya satu barang, hasil dua
// gelombang pengisian data: gelombang lama menyimpan satuan sebagai teks dan tanpa
// kategori, gelombang baru menyimpan kategori dan `unit_id` tapi membiarkan teks
// satuannya kosong. Namanya sama persis selain besar-kecil huruf.
//
// Akibatnya bukan cuma daftar yang kotor. Stok dihitung PER sapropdi_id, jadi satu
// barang yang punya dua id punya dua saldo terpisah — barang masuk tercatat di id
// yang satu, keluar di id yang lain, dan keduanya salah. Itu juga yang membuat
// impor spreadsheet lapangan berhenti pada "Gasoline": dua baris master bernama
// sama, dan menebak salah satunya berarti menaruh angka di tempat yang salah.
//
// Cara menggabungnya:
//   1. yang DIPERTAHANKAN adalah baris dengan rujukan terbanyak - memindahkan lebih
//      sedikit baris berarti lebih sedikit yang bisa salah. Seri -> id terkecil.
//   2. kolom yang kosong pada baris itu diisi dari saudaranya (kategori, satuan,
//      unit_id), supaya penggabungan tidak membuang data yang cuma ada di satu sisi.
//   3. kelima kolom yang menunjuk ke sapropdi dialihkan ke baris itu.
//   4. baris kembarannya baru dihapus.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateMergeSapropdiDuplicates2026-09.js            # dry run
//   node scripts/migrateMergeSapropdiDuplicates2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Semua kolom yang menunjuk ke sapropdi.
 *
 * `unique` menandai tabel yang tidak boleh punya dua baris untuk sapropdi yang
 * sama dalam satu induk - mengalihkan rujukan di situ bisa menabrak indeks unik,
 * jadi tabrakannya harus diperiksa lebih dulu, bukan ditemukan saat ALTER gagal
 * separuh jalan.
 */
const REFS = [
  { table: 'pre_finance_distributions', col: 'sapropdi_id' },
  { table: 'purchase_request_items', col: 'sapropdi_id' },
  { table: 'stock_in_items', col: 'sapropdi_id' },
  { table: 'saprodi_reorder_levels', col: 'sapropdi_id', unique: [] },
  { table: 'stock_opname_items', col: 'sapropdi_id', unique: ['stock_opname_id'] },
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

  log(`\n=== Migrasi: gabungkan baris ganda master sapropdi — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const [sap] = await conn.query('SELECT id, sapropdi_name, category, unit, unit_id FROM sapropdi ORDER BY id');
  const groups = new Map();
  for (const s of sap) {
    const k = norm(s.sapropdi_name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const dups = [...groups.values()].filter((v) => v.length > 1);

  if (!dups.length) {
    log('Tidak ada nama ganda — database sudah bersih.');
    await conn.end();
    return;
  }

  const countRefs = async (id) => {
    const per = {};
    let total = 0;
    for (const r of REFS) {
      const [[c]] = await conn.query(
        'SELECT COUNT(*) AS n FROM `' + r.table + '` WHERE `' + r.col + '` = ?', [id]);
      per[r.table] = Number(c.n);
      total += Number(c.n);
    }
    return { per, total };
  };

  let merges = 0;
  let blocked = 0;

  for (const group of dups) {
    const withRefs = [];
    for (const row of group) withRefs.push({ row, refs: await countRefs(row.id) });
    // Yang paling banyak dirujuk dipertahankan; seri dimenangkan id terkecil.
    withRefs.sort((a, b) => (b.refs.total - a.refs.total) || (a.row.id - b.row.id));
    const keep = withRefs[0];
    const drop = withRefs.slice(1);

    log(`\n"${keep.row.sapropdi_name}"`);
    log(`  DIPERTAHANKAN [${keep.row.id}] ${keep.refs.total} rujukan`
      + `  (kat: ${keep.row.category || '-'}, satuan: ${keep.row.unit || '-'}, unit_id: ${keep.row.unit_id || '-'})`);

    // Kolom yang kosong di baris yang dipertahankan, diisi dari saudaranya.
    const fill = {};
    for (const f of ['category', 'unit', 'unit_id']) {
      if (keep.row[f] == null || keep.row[f] === '') {
        const donor = drop.find((d) => d.row[f] != null && d.row[f] !== '');
        if (donor) fill[f] = donor.row[f];
      }
    }
    if (Object.keys(fill).length) {
      log(`  dilengkapi dari kembarannya: ${Object.entries(fill).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }

    let groupBlocked = false;
    for (const d of drop) {
      log(`  DIGABUNG     [${d.row.id}] ${d.refs.total} rujukan`
        + `  (kat: ${d.row.category || '-'}, satuan: ${d.row.unit || '-'}, unit_id: ${d.row.unit_id || '-'})`);
      for (const [t, n] of Object.entries(d.refs.per)) if (n) log(`      ${t}: ${n} baris akan dialihkan`);

      // Tabrakan indeks unik diperiksa lebih dulu.
      for (const r of REFS.filter((x) => x.unique)) {
        const keyCols = r.unique;
        const sel = keyCols.length
          ? `SELECT ${keyCols.join(',')} FROM \`${r.table}\` WHERE \`${r.col}\` = ?`
          : `SELECT 1 AS one FROM \`${r.table}\` WHERE \`${r.col}\` = ?`;
        const [mine] = await conn.query(sel, [d.row.id]);
        const [theirs] = await conn.query(sel, [keep.row.id]);
        if (!mine.length || !theirs.length) continue;
        const sig = (x) => (keyCols.length ? keyCols.map((k) => x[k]).join('|') : 'ALL');
        const theirSet = new Set(theirs.map(sig));
        const clash = mine.filter((x) => theirSet.has(sig(x)));
        if (clash.length) {
          log(`      DITAHAN: ${clash.length} baris ${r.table} akan menabrak indeks unik.`);
          log('      Gabungkan baris itu dengan tangan dulu; grup ini dilewati.');
          groupBlocked = true;
        }
      }
    }

    if (groupBlocked) { blocked++; continue; }

    merges += drop.length;
    if (!APPLY) continue;

    await conn.beginTransaction();
    try {
      if (Object.keys(fill).length) {
        const keys = Object.keys(fill);
        await conn.query(
          'UPDATE sapropdi SET ' + keys.map((k) => '`' + k + '` = ?').join(', ')
          + ', updated_at = NOW() WHERE id = ?',
          [...keys.map((k) => fill[k]), keep.row.id]);
      }
      for (const d of drop) {
        for (const r of REFS) {
          await conn.query(
            'UPDATE `' + r.table + '` SET `' + r.col + '` = ? WHERE `' + r.col + '` = ?',
            [keep.row.id, d.row.id]);
        }
        await conn.query('DELETE FROM sapropdi WHERE id = ?', [d.row.id]);
      }
      await conn.commit();
      log('  -> digabung');
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  }

  // Jumlah baris di v_saprodi_stock akan BERKURANG (satu barang tidak lagi punya
  // dua baris), tapi jumlah totalnya per barang harus bertambah benar, bukan hilang.
  const [[stock]] = await conn.query(
    'SELECT COUNT(*) AS baris, COALESCE(SUM(total_in), 0) AS masuk,'
    + ' COALESCE(SUM(total_out), 0) AS keluar FROM v_saprodi_stock');
  log(`\n  v_saprodi_stock sekarang: ${stock.baris} baris, total masuk ${stock.masuk}, total keluar ${stock.keluar}`);
  log('  (jumlah masuk dan keluar TIDAK boleh berubah karena penggabungan — hanya barisnya yang menyatu)');

  log('');
  if (blocked) log(`${blocked} grup ditahan karena tabrakan indeks unik.`);
  if (!merges) log('Tidak ada yang perlu digabung.');
  else if (!APPLY) log(`${merges} baris akan digabung. Jalankan ulang dengan --apply untuk menerapkannya.`);
  else log(`${merges} baris digabung.`);

  await conn.end();
})().catch((e) => {
  console.error('\nMigrasi GAGAL:', e.message);
  process.exit(1);
});
