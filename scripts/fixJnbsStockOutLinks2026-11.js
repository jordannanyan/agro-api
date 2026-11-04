// -----------------------------------------------------------------------------
// Fix: put every saprodi issue on a Stock Out header, and give it its commodity (2026-11)
//
// Asked for by JNBS finance (2026-11-04): the Stock Out overview has to agree
// with the "Farmer Loan Overview - Banana / Mango / Coffee" sheets of
// `JNBS Database.xlsx`. Two things kept it from doing so:
//
//   1. 538 loans imported by importJnbsLoansUnnumbered2026-11.js got their item
//      and warehouse from importJnbsSheets2026-11.js — so they move stock — but
//      no Stock Out header, so the Stock Out screens never showed them. They go
//      on the reconstructed header of their (warehouse, date), SOH-YYYY-NNNN,
//      the same grouping backfillStockOutHeaders2026-08.js used; one is created
//      where that day has none.
//   2. Lines with no commodity drop out of every per-commodity figure. A ledger
//      loan ("Pinjaman saprodi no. N") takes it from its row in
//      `ADM_Entry Data Pinjaman`; any other line from its plot, when the plot
//      grows one commodity only. Anything else is listed and left alone.
//
// Idempotent. Dry-run by default.
//
// Usage:
//   node scripts/fixJnbsStockOutLinks2026-11.js --file "<JNBS Database.xlsx>"
//   node scripts/fixJnbsStockOutLinks2026-11.js --file "<JNBS Database.xlsx>" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const NOTE = 'Dibuat otomatis untuk pinjaman saprodi dari buku besar yang belum punya dokumen Stock Out. '
  + 'Pengelompokan berdasarkan gudang + tanggal, bukan dokumen asli.';
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <JNBS Database.xlsx> [--apply]'); process.exit(2); }

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const norm = (s) => String(cv(s) ?? '').replace(/\s+/g, ' ').trim();

async function loanCommodities() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (ws.name !== 'ADM_Entry Data Pinjaman') { for await (const _ of ws) { /* skip */ } continue; }
    let h = null; const out = new Map();
    for await (const row of ws) {
      const v = []; row.eachCell({ includeEmpty: true }, (c, col) => { v[col - 1] = c.value; });
      if (!h) { h = v.map(norm); continue; }
      const no = cv(v[h.indexOf('Loan In Kind Number (No. Pinjaman)')]);
      const com = norm(v[h.indexOf('Type of Commodity (Jenis Komoditi)')]);
      if (typeof no === 'number' && com) out.set(String(Math.trunc(no)), com);
    }
    return out;
  }
  throw new Error('Sheet ADM_Entry Data Pinjaman tidak ada');
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const byNo = await loanCommodities();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();

    // ── 1. headers
    const orphans = await q(`SELECT d.warehouse_id, d.date, COUNT(*) n, SUM(d.total_amount) v
      FROM pre_finance_distributions d JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
      WHERE t.type_name = 'Saprodi' AND d.stock_out_id IS NULL AND d.sapropdi_id IS NOT NULL AND d.warehouse_id IS NOT NULL
      GROUP BY d.warehouse_id, d.date ORDER BY d.date`);
    let made = 0; let reused = 0;
    for (const g of orphans) {
      const [h] = await q(`SELECT id FROM stock_out WHERE warehouse_id = ? AND stock_out_date = ? AND stock_out_number LIKE 'SOH-%' ORDER BY id LIMIT 1`,
        [g.warehouse_id, g.date]);
      let id = h?.id;
      if (id) reused++;
      else {
        const year = g.date.slice(0, 4);
        const [last] = await q(`SELECT MAX(CAST(SUBSTRING_INDEX(stock_out_number, '-', -1) AS UNSIGNED)) n FROM stock_out WHERE stock_out_number LIKE ?`, [`SOH-${year}-%`]);
        const [res] = await c.query(`INSERT INTO stock_out (stock_out_number, stock_out_date, warehouse_id, notes, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())`,
          [`SOH-${year}-${String(Number(last?.n || 0) + 1).padStart(4, '0')}`, g.date, g.warehouse_id, NOTE]);
        id = res.insertId; made++;
      }
      await q(`UPDATE pre_finance_distributions d JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
          SET d.stock_out_id = ?, d.updated_at = NOW()
        WHERE t.type_name = 'Saprodi' AND d.stock_out_id IS NULL AND d.sapropdi_id IS NOT NULL AND d.warehouse_id = ? AND d.date = ?`,
        [id, g.warehouse_id, g.date]);
    }
    log(`1) baris saprodi tanpa dokumen Stock Out: ${orphans.reduce((s, g) => s + Number(g.n), 0)} (${rp(orphans.reduce((s, g) => s + Number(g.v), 0))})`
      + ` → ${reused} dokumen SOH yang ada dipakai, ${made} dibuat`);

    // ── 2. commodity
    const coms = await q('SELECT id, commodities_name FROM commodities');
    const comId = (name) => coms.find((x) => x.commodities_name.toLowerCase() === name.toLowerCase())?.id ?? null;
    const blank = await q(`SELECT d.id, d.plot_id, p.plot_name, d.total_amount, d.description,
        (SELECT GROUP_CONCAT(pc.commodities_id) FROM plot_commodities pc WHERE pc.plot_id = d.plot_id) AS grown
      FROM pre_finance_distributions d LEFT JOIN plot p ON p.id = d.plot_id WHERE d.commodities_id IS NULL`);
    let set = 0; const left = [];
    for (const r of blank) {
      const m = String(r.description || '').match(/^Pinjaman saprodi no\. (\d+) /);
      const fromSheet = m && byNo.get(m[1]) ? comId(byNo.get(m[1])) : null;
      const grown = String(r.grown || '').split(',').filter(Boolean);
      const id = fromSheet ?? (grown.length === 1 ? Number(grown[0]) : null);
      if (!id) { left.push(r); continue; }
      await q('UPDATE pre_finance_distributions SET commodities_id = ?, updated_at = NOW() WHERE id = ?', [id, r.id]);
      log(`   ~ #${r.id} ${r.plot_name ?? '—'} ${rp(r.total_amount)} → ${coms.find((x) => x.id === id).commodities_name} (${fromSheet ? 'sheet' : 'komoditas lahan'})`);
      set++;
    }
    log(`2) baris tanpa komoditas: ${blank.length} → diisi ${set}, dibiarkan ${left.length}`);
    left.forEach((r) => log(`   · #${r.id} ${r.plot_name ?? '—'} ${rp(r.total_amount)} ${r.description ?? ''} (lahan menanam: ${r.grown || 'belum tercatat'})`));

    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
