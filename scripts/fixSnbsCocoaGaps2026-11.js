// -----------------------------------------------------------------------------
// Fix: two gaps in the SNBS cocoa data (2026-11)
//
// Checked 2026-11-09 against "Sumber Jaya Farmers Data (1).xlsx" (copy of 4 Nov
// 2026), sheets `Distribution` and `Farmers Data (SAPRODI)`:
//
// 1. Batch-3 loans missing. importSnbsCocoaLoans2026-10.js took the loans the
//    cocoa ledger knew on 21 May 2026; farmers who first borrowed after that and
//    have repaid nothing yet were left out — Alex (233 seedlings, Rp 2.330.000)
//    and Supri Cacing (200 seedlings, Rp 2.000.000), both 26 Oct 2025. Added the
//    way the others were: one line per material, the farmer's cocoa purchasing
//    plot (SJ00…), warehouse Sumber Jaya, no item (it must not move stock), the
//    same tag. Any farmer of the sheet with a loan and no line in the system is
//    added the same way; a material other than seedlings stops the run.
//
// 2. A supplier created twice. importCocoaLedgerTail2026-11.js made a new farmer
//    for every cocoa supplier name it had not seen on a purchase — but "Alex" is
//    the Sumber Jaya farmer of that name. The import of 2026-08 matched exact
//    farmer names first; the tail import now does too. Here the duplicate's
//    purchases move to the farmer's cocoa purchasing plot and the duplicate
//    farmer and plot are removed.
//
// Idempotent. Dry-run by default (written in a transaction, rolled back).
//
// Usage:
//   node scripts/fixSnbsCocoaGaps2026-11.js --farmers "<Sumber Jaya Farmers Data.xlsx>" [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('--farmers');
const DB = process.env.DB_NAME || 'agro_supply';
const TAG = '[SNBS-KAKAO-2026-10]';
const ENTITY_SNBS = 1, COMM_COCOA = 1, WH_SJ = 1;
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --farmers <xlsx> [--apply]'); process.exit(2); }

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = Number(cv(v)); return isFinite(x) ? x : 0; };
const ymd = (v) => { const x = cv(v); return x instanceof Date && !isNaN(x) ? x.toISOString().slice(0, 10) : null; };
const norm = (s) => String(cv(s) ?? '').replace(/\s+/g, ' ').trim();

async function readLoans() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (ws.name !== 'Farmers Data (SAPRODI)') { for await (const _ of ws) { /* skip */ } continue; }
    const rows = [];
    for await (const row of ws) {
      if (row.number < 6) continue;
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      const name = norm(v[2]);
      if (!name || /^total/i.test(name)) continue;
      // Columns as in the sheet: I loan total · K..V seedlings block
      // (L qty, N date, T total price) · later blocks carry their own Total Price.
      const otherPrices = [31, 51, 75, 91, 99, 107].map((i) => num(v[i])).reduce((s, x) => s + x, 0);
      rows.push({ row: row.number, name, loan: num(v[8]), seedQty: num(v[11]), seedDate: ymd(v[13]), seedPrice: num(v[19]), otherPrices });
    }
    return rows;
  }
  throw new Error('Sheet "Farmers Data (SAPRODI)" tidak ada');
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const loans = await readLoans();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();
    const farmers = await q(`SELECT f.id, f.farmer_name, k.kth_name FROM farmers f JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ?`, [ENTITY_SNBS]);
    const plotsOf = async (fid) => q('SELECT id, plot_name, scheme FROM plot WHERE farmer_id = ? ORDER BY id', [fid]);
    // The plot cocoa is bought on (SJ00…), else a planted one — as the loan import did.
    const cocoaPlot = (ps) => ps.find((p) => /^SJ00\d+$/.test(p.plot_name)) || ps.find((p) => /^[SN]0\d+/.test(p.plot_name)) || ps[0];

    // ── 1. loans the system does not have
    log('\n1) Pinjaman Farmers Data (SAPRODI) yang belum ada');
    const [[saprodi]] = await c.query("SELECT id FROM pre_finance_types WHERE type_name = 'Saprodi'");
    let added = 0;
    for (const r of loans.filter((x) => x.loan > 0)) {
      const base = r.name.replace(/\s+\d+$/, '');
      const f = farmers.find((x) => x.farmer_name.toLowerCase() === base.toLowerCase() && x.kth_name !== 'Non KTH SJ');
      if (!f) { log(`   ! baris ${r.row} ${r.name}: petani tidak ada di sistem`); continue; }
      const [[has]] = await c.query('SELECT COUNT(*) n FROM pre_finance_distributions WHERE farmer_id = ? AND description LIKE ?', [f.id, `%${TAG}%`]);
      if (Number(has.n)) continue;
      if (r.otherPrices > 0) throw new Error(`${r.name}: ada pinjaman selain bibit — tambahkan barangnya ke skrip ini dulu`);
      if (Math.abs(r.seedPrice - r.loan) > 1) throw new Error(`${r.name}: total pinjaman ${r.loan} ≠ harga bibit ${r.seedPrice}`);
      const plot = cocoaPlot(await plotsOf(f.id));
      await q(`INSERT INTO pre_finance_distributions (pre_finance_type_id, date, farmer_id, plot_id, commodities_id, sapropdi_id, warehouse_id,
          quantity, price_per_unit, total_amount, counts_as_debt, scheme, description, created_at, updated_at)
        VALUES (?,?,?,?,?,NULL,?,?,?,?,1,?,?,NOW(),NOW())`,
        [saprodi.id, r.seedDate, f.id, plot?.id ?? null, COMM_COCOA, WH_SJ, r.seedQty, r.seedPrice / r.seedQty, r.seedPrice,
         plot?.scheme ?? 'PreFinance', `Pinjaman kakao SNBS · Bibit kakao MCC02 ${r.seedQty} batang · ${f.farmer_name} (Sumber Jaya Farmers Data) ${TAG}`]);
      log(`   + ${f.farmer_name} · ${r.seedDate} · bibit kakao ${r.seedQty} batang · ${rp(r.seedPrice)} · lahan ${plot?.plot_name ?? '—'}`);
      added++;
    }
    if (!added) log('   · tidak ada');

    // ── 2. a supplier made twice
    log('\n2) Pemasok kakao yang dibuat dua kali');
    const dups = await q(`SELECT n.id AS dup_id, n.farmer_name, pn.id AS dup_plot, pn.plot_name, o.id AS farmer_id
      FROM farmers n JOIN kth kn ON kn.id = n.kth_id AND kn.kth_name = 'Non KTH SJ'
      JOIN plot pn ON pn.farmer_id = n.id AND pn.plot_name LIKE 'NONSJ%' AND pn.created_at >= '2026-11-05'
      JOIN farmers o ON LOWER(TRIM(o.farmer_name)) = LOWER(TRIM(n.farmer_name)) AND o.id <> n.id
      JOIN kth ko ON ko.id = o.kth_id AND ko.entities_id = ? AND ko.kth_name <> 'Non KTH SJ'`, [ENTITY_SNBS]);
    for (const d of dups) {
      const target = cocoaPlot(await plotsOf(d.farmer_id));
      const [mv] = await c.query('UPDATE purchasing SET plot_id = ?, scheme = ?, updated_at = NOW() WHERE plot_id = ?', [target.id, target.scheme, d.dup_plot]);
      const refs = await q(`SELECT (SELECT COUNT(*) FROM pre_finance_distributions WHERE farmer_id = ? OR plot_id = ?) +
        (SELECT COUNT(*) FROM pre_finance_installments WHERE farmer_id = ?) AS n`, [d.dup_id, d.dup_plot, d.dup_id]);
      if (Number(refs[0].n)) { log(`   ! ${d.farmer_name}: duplikat masih dipakai data lain — tidak dihapus`); continue; }
      await q('DELETE FROM plot WHERE id = ?', [d.dup_plot]);
      await q('DELETE FROM farmers WHERE id = ?', [d.dup_id]);
      log(`   ~ ${d.farmer_name}: ${mv.affectedRows} pembelian ${d.plot_name} → ${target.plot_name} (${target.scheme}); petani & lahan duplikat dihapus`);
    }
    if (!dups.length) log('   · tidak ada');

    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
