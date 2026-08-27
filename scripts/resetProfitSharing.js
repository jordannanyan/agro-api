// -----------------------------------------------------------------------------
// Reset: remove saved profit-sharing records (catatan bagi hasil)
//
// Puts the ledger back to "nothing has been settled yet". Only `profit_sharing`
// is touched — the settlement records themselves. Everything a settlement is
// COMPUTED FROM is left alone:
//
//   · selling / processing / purchasing   — the transactions
//   · profit_sharing_investments          — biaya lahan (TK + material)
//   · pre_finance_distributions           — saprodi / utang petani
//
// so re-running the settlement afterwards reproduces the same figures.
//
// Why a whole wipe rather than picking rows: each row carries the running
// balances (`cum_farmer` / `cum_company` / `cum_kth`) of everything settled
// before it, and the next settlement reads the LATEST row of the plot as its
// opening balance. Delete a row from the middle of a plot's chain and every
// later row still claims a balance that no longer adds up. `--entity` is the one
// safe filter: a plot belongs to exactly one farmer group and therefore to one
// PT, so a PT's chains are whole on their own.
//
// Dry run by default; nothing is written without --apply.
//
// Usage:
//   node scripts/resetProfitSharing.js                    # dry run, semua entitas
//   node scripts/resetProfitSharing.js --entity=1         # dry run, SNBS saja
//   node scripts/resetProfitSharing.js --apply
//   node scripts/resetProfitSharing.js --apply --force    # ikut hapus baris non-Draft
//
// Backup first — this is not reversible from inside the app:
//   mysqldump -u USER -p agro_supply profit_sharing > ~/backups/profit_sharing-$(date +%F).sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const entityArg = argv.find((a) => a.startsWith('--entity='));
const ENTITY = entityArg ? Number(entityArg.split('=')[1]) : null;

const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });

// A settlement reaches its PT the same way every farming record does: plot →
// farmer → KTH → entity. Rows with no plot (hand-entered legacy) have no PT and
// are only ever touched by a full reset.
const ENTITY_JOIN = `
  LEFT JOIN plot pl    ON pl.id = ps.plot_id
  LEFT JOIN farmers f  ON f.id = pl.farmer_id
  LEFT JOIN kth k      ON k.id = f.kth_id
`;

async function run() {
  if (entityArg && (!Number.isFinite(ENTITY) || ENTITY <= 0)) {
    throw new Error(`--entity harus angka, dapat "${entityArg.split('=')[1]}"`);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
  });

  const where = ENTITY != null ? 'WHERE k.entities_id = ?' : '';
  const args = ENTITY != null ? [ENTITY] : [];

  log(APPLY ? '▶ APPLY mode — catatan bagi hasil akan DIHAPUS.' : '▶ DRY RUN — tidak ada yang ditulis.');
  log(`  database: ${DB}`);
  log(`  lingkup : ${ENTITY != null ? `entitas #${ENTITY}` : 'semua entitas'}`);

  const [[sum]] = await conn.query(
    `SELECT COUNT(*) AS rows_n,
            COUNT(DISTINCT ps.selling_id) AS sellings,
            COUNT(DISTINCT ps.plot_id) AS plots,
            MIN(ps.period) AS from_p, MAX(ps.period) AS to_p,
            COALESCE(SUM(ps.value_farmer), 0)  AS v_farmer,
            COALESCE(SUM(ps.value_kth), 0)     AS v_kth,
            COALESCE(SUM(ps.value_company), 0) AS v_company
     FROM profit_sharing ps ${ENTITY_JOIN} ${where}`, args);

  if (!Number(sum.rows_n)) {
    log('\n   Tidak ada catatan bagi hasil. Sudah di titik awal.');
    await conn.end();
    return;
  }

  log(`\n   ${sum.rows_n} baris · ${sum.sellings} penjualan · ${sum.plots} lahan · periode ${sum.from_p} → ${sum.to_p}`);
  log(`   petani ${rupiah(sum.v_farmer)} · KTH ${rupiah(sum.v_kth)} · perusahaan ${rupiah(sum.v_company)}`);

  // Per PT, so a full wipe says out loud whose records are going.
  const [byEntity] = await conn.query(
    `SELECT COALESCE(e.entities_name, '(tanpa lahan/PT)') AS pt, COUNT(*) AS n,
            COALESCE(SUM(ps.value_farmer), 0) AS v_farmer
     FROM profit_sharing ps ${ENTITY_JOIN}
     LEFT JOIN entities e ON e.id = k.entities_id
     ${where}
     GROUP BY COALESCE(e.entities_name, '(tanpa lahan/PT)')
     ORDER BY n DESC`, args);
  for (const r of byEntity) log(`     · ${r.pt}: ${r.n} baris · petani ${rupiah(r.v_farmer)}`);

  const [rows] = await conn.query(
    `SELECT ps.id, ps.period, ps.selling_id, ps.plot_id, pl.plot_name, ps.status,
            ps.value_farmer, ps.created_at
     FROM profit_sharing ps ${ENTITY_JOIN} ${where}
     ORDER BY ps.id LIMIT 10`, args);
  log('\n   Contoh baris:');
  for (const r of rows) {
    log(`     #${r.id} ${r.period} · jual #${r.selling_id ?? '—'} · lahan ${r.plot_name || r.plot_id || '—'}`
      + ` · ${r.status} · petani ${rupiah(r.value_farmer)}`);
  }
  if (Number(sum.rows_n) > rows.length) log(`     … dan ${Number(sum.rows_n) - rows.length} baris lain`);

  // Anything past Draft has been through people, not just the calculator.
  const [notDraft] = await conn.query(
    `SELECT ps.status, COUNT(*) AS n FROM profit_sharing ps ${ENTITY_JOIN}
     ${where ? `${where} AND` : 'WHERE'} ps.status <> 'Draft' GROUP BY ps.status`, args);
  if (notDraft.length) {
    log('\n   ! Ada baris yang statusnya bukan Draft:');
    for (const r of notDraft) log(`     ${r.status}: ${r.n} baris`);
    if (!FORCE) {
      log('     Dihentikan. Jalankan ulang dengan --force kalau memang mau ikut dihapus.');
      await conn.end();
      process.exit(1);
    }
    log('     --force dipakai — ikut dihapus.');
  }

  if (!APPLY) {
    log('\n✓ Dry run selesai — jalankan ulang dengan --apply untuk menghapus.');
    log('  Ingat backup dulu: mysqldump ... agro_supply profit_sharing > ~/backups/…sql');
    await conn.end();
    return;
  }

  const [res] = await conn.query(
    ENTITY != null
      ? `DELETE ps FROM profit_sharing ps ${ENTITY_JOIN} WHERE k.entities_id = ?`
      : 'DELETE FROM profit_sharing',
    args);
  log(`\n   ${res.affectedRows} baris dihapus.`);

  const [[after]] = await conn.query('SELECT COUNT(*) AS n FROM profit_sharing');
  log(`   Sisa catatan bagi hasil: ${after.n}`);

  // What the settlement is computed from must still be there — if any of these
  // came back zero, the wrong thing was deleted.
  const [[keep]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM selling) AS selling,
            (SELECT COUNT(*) FROM profit_sharing_investments) AS investasi,
            (SELECT COUNT(*) FROM pre_finance_distributions) AS saprodi`);
  log(`   Data sumber utuh: ${keep.selling} penjualan · ${keep.investasi} biaya lahan · ${keep.saprodi} distribusi saprodi`);

  await conn.end();
  log('\n✓ Selesai — bagi hasil kembali ke titik awal, siap dihitung ulang.');
}

run().catch((e) => { console.error('\n✗ Gagal:', e.message); process.exit(1); });
