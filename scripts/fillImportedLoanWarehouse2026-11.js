// -----------------------------------------------------------------------------
// Fix: name the warehouse on the loans imported from the ledgers (2026-11)
//
// importJnbsLoansUnnumbered2026-11.js and importSnbsCocoaLoans2026-10.js left
// warehouse_id empty so the goods would not be taken off the stock a second time —
// the stock counts had already set it. That made "Gudang" read "—" on the debt
// lines, although the goods did leave a warehouse: KTH AML for JNBS, Sumber Jaya
// for SNBS (each PT's only one).
//
// The warehouse alone does not move stock: v_saprodi_stock and the stock card only
// count a line that also names its item (sapropdi_id), and these name it in the
// description instead. So this fills the warehouse and leaves the stock as it is.
//
// Idempotent, dry-run by default.
//   node scripts/fillImportedLoanWarehouse2026-11.js [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const SETS = [
  { tag: '[JNBS-PINJAMAN-2026-11]', warehouse: 'KTH AML' },
  { tag: '[SNBS-KAKAO-2026-10]', warehouse: 'Sumber Jaya' },
];

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const [[before]] = await c.query('SELECT COALESCE(SUM(remaining), 0) AS s, COUNT(*) AS n FROM v_saprodi_stock');
    for (const s of SETS) {
      const [w] = await c.query('SELECT id FROM warehouse WHERE warehouse_name = ?', [s.warehouse]);
      if (w.length !== 1) throw new Error(`Gudang "${s.warehouse}" ditemukan ${w.length} kali`);
      const [[cnt]] = await c.query(
        `SELECT COUNT(*) AS n, SUM(sapropdi_id IS NOT NULL) AS with_item FROM pre_finance_distributions
          WHERE description LIKE ? AND (warehouse_id IS NULL OR warehouse_id <> ?)`, [`%${s.tag}%`, w[0].id]);
      if (Number(cnt.with_item)) throw new Error(`${s.tag}: ${cnt.with_item} baris punya sapropdi_id — mengisi gudangnya akan mengubah stok`);
      log(`${Number(cnt.n) ? '~' : '='} ${s.tag}: ${cnt.n} baris → gudang ${s.warehouse} (#${w[0].id})`);
      if (APPLY && Number(cnt.n)) {
        await c.query(`UPDATE pre_finance_distributions SET warehouse_id = ?, updated_at = NOW()
                        WHERE description LIKE ? AND (warehouse_id IS NULL OR warehouse_id <> ?) AND sapropdi_id IS NULL`,
          [w[0].id, `%${s.tag}%`, w[0].id]);
      }
    }
    const [[after]] = await c.query('SELECT COALESCE(SUM(remaining), 0) AS s, COUNT(*) AS n FROM v_saprodi_stock');
    log(`stok (jumlah sisa seluruh gudang): sebelum ${before.s} · sesudah ${after.s} — ${Number(before.s) === Number(after.s) ? 'tidak berubah' : 'BERUBAH'}`);
    if (Number(before.s) !== Number(after.s)) throw new Error('Stok berubah — periksa');
    log(APPLY ? 'done' : 'dry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
