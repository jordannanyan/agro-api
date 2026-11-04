// -----------------------------------------------------------------------------
// Import: JNBS saprodi loans the field team entered without a loan number (2026-11)
//
// `JNBS Database.xlsx`, sheet `ADM_Entry Data Pinjaman`. Rows 2–1832 carry a
// `Loan In Kind Number (No. Pinjaman)`, 1..1833, and every one of them is in
// pre_finance_distributions ("Pinjaman saprodi no. N - …") with the same date,
// plot and amount (checked 2026-11-04). From row 1833 on the number column is
// empty: 550 rows worth Rp 88.434.095 (Dec 2025 – Oct 2026) the 2026-08 import
// never took, because it matched by number. This brings them in.
//
// Written: one pre_finance_distributions row each — type Saprodi, counts_as_debt
// = 1, plot + farmer from `Plot ID`, commodity from `Type of Commodity`, quantity
// and price from the sheet. NO warehouse and NO sapropdi_id: the goods did leave
// KTH AML, but that stock was already set by the counts — the 29 Sep 2026 opname
// (applied) for everything before it, the 28 Oct one (awaiting the PM) for what
// came after, whose adjustment is taken when it is approved. Booking these as
// stock-outs too would take the same goods off the shelf twice.
//
// Skipped: rows with no quantity or no amount (planned, never filled in).
// Corrected: a date in the future is a year typo — 28 Dec 2026 between rows of
// 28 Dec 2025 — and is moved back one year; the original is kept in the text.
//
// Every row carries the tag below and the sheet row number; a re-run skips what
// is already there. Dry-run by default.
//
// Usage:
//   node scripts/importJnbsLoansUnnumbered2026-11.js --file "<JNBS Database.xlsx>" [--verbose]
//   node scripts/importJnbsLoansUnnumbered2026-11.js --file "<JNBS Database.xlsx>" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const SHEET = 'ADM_Entry Data Pinjaman';
const TAG = '[JNBS-PINJAMAN-2026-11]';
const ENTITY_JNBS = 3;
const log = (...a) => console.log(...a);
if (!FILE) { console.error('Usage: --file <JNBS Database.xlsx> [--apply] [--verbose]'); process.exit(2); }

function cv(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
  }
  return v;
}
const num = (v) => { const x = cv(v); return typeof x === 'number' && isFinite(x) ? x : 0; };
const ymd = (v) => { const x = cv(v); return x instanceof Date && !isNaN(x) ? x.toISOString().slice(0, 10) : null; };
const norm = (s) => String(cv(s) ?? '').replace(/\s+/g, ' ').trim();
const rp = (n) => `Rp ${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;

async function readSheet() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (ws.name !== SHEET) { for await (const _ of ws) { /* skip */ } continue; }
    let header = null; const rows = [];
    for await (const row of ws) {
      const v = []; row.eachCell({ includeEmpty: true }, (c, col) => { v[col - 1] = c.value; });
      if (!header) { header = v.map(norm); continue; }
      rows.push({ n: row.number, v });
    }
    const col = (label) => { const i = header.indexOf(label); if (i < 0) throw new Error(`Kolom "${label}" tidak ada`); return i; };
    const C = {
      date: col('Date'), no: col('Loan In Kind Number (No. Pinjaman)'), plot: col('Plot ID (ID Lahan)'),
      item: col('Production Input (Saprodi)'), price: col('Price per unit (Harga Saprodi per satuan)'),
      qty: col('Amount (Jumlah)'), unit: col('Unit (Satuan)'), total: col('Total Price (Total Harga)'),
      commodity: col('Type of Commodity (Jenis Komoditi)'),
    };
    return rows.map(({ n, v }) => ({
      row: n, date: ymd(v[C.date]), no: cv(v[C.no]), plot: norm(v[C.plot]), item: norm(v[C.item]),
      price: num(v[C.price]), qty: num(v[C.qty]), unit: norm(v[C.unit]), total: num(v[C.total]), commodity: norm(v[C.commodity]),
    }));
  }
  throw new Error(`Sheet "${SHEET}" tidak ada`);
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const all = await readSheet();
  const today = new Date().toISOString().slice(0, 10);
  const numbered = all.filter((r) => typeof r.no === 'number');
  const unnumbered = all.filter((r) => typeof r.no !== 'number' && (r.plot || r.total));
  const rows = unnumbered.filter((r) => r.total > 0 && r.qty > 0 && r.date && r.plot);
  const skipped = unnumbered.filter((r) => !(r.total > 0 && r.qty > 0 && r.date && r.plot));
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  try {
    // The numbered rows must already be here, exactly — otherwise this sheet is
    // not the one the system was built from and nothing should be added to it.
    const [have] = await c.query(
      `SELECT CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(description, 'no. ', -1), ' ', 1) AS UNSIGNED) AS no, SUM(total_amount) AS total
         FROM pre_finance_distributions WHERE description LIKE 'Pinjaman saprodi no. %' GROUP BY no`);
    const byNo = new Map(have.map((h) => [Number(h.no), Number(h.total)]));
    const off = numbered.filter((r) => Math.abs((byNo.get(r.no) ?? -1) - r.total) > 1);
    log(`Baris bernomor di sheet: ${numbered.length} (${rp(numbered.reduce((s, r) => s + r.total, 0))}) — tidak cocok dengan sistem: ${off.length}`);
    if (off.length) { off.slice(0, 20).forEach((r) => log(`  ! no. ${r.no} baris ${r.row}: sheet ${rp(r.total)}, sistem ${byNo.has(r.no) ? rp(byNo.get(r.no)) : '—'}`)); throw new Error('Baris bernomor tidak sama dengan sistem — berhenti'); }

    const [[saprodi]] = await c.query("SELECT id FROM pre_finance_types WHERE type_name = 'Saprodi'");
    const [plots] = await c.query(
      `SELECT pl.id, pl.plot_name, pl.farmer_id FROM plot pl JOIN farmers f ON f.id = pl.farmer_id JOIN kth k ON k.id = f.kth_id
        WHERE k.entities_id = ?`, [ENTITY_JNBS]);
    const plotBy = new Map(plots.map((p) => [p.plot_name, p]));
    const [coms] = await c.query('SELECT id, commodities_name FROM commodities');
    const comBy = (name) => coms.find((x) => x.commodities_name.toLowerCase() === name.toLowerCase())
      || coms.find((x) => x.commodities_name.split(' ')[0].toLowerCase() === name.split(' ')[0].toLowerCase()) || null;
    const [done] = await c.query('SELECT description FROM pre_finance_distributions WHERE description LIKE ?', [`%${TAG}%`]);
    const doneRows = new Set(done.map((d) => Number((d.description.match(/baris (\d+)/) || [])[1])));

    const problems = []; const plan = []; const fixed = [];
    for (const r of rows) {
      const plot = plotBy.get(r.plot);
      if (!plot) { problems.push(`baris ${r.row}: plot ${r.plot} bukan plot JNBS`); continue; }
      let date = r.date; let note = '';
      if (date > today) {
        const back = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
        fixed.push(`baris ${r.row}: ${date} → ${back}`); note = ` · tanggal di sheet ${date}`; date = back;
      }
      if (doneRows.has(r.row)) continue;
      plan.push({ ...r, date, note, plot, commodity_id: comBy(r.commodity)?.id ?? null });
    }
    if (problems.length) { problems.forEach((p) => log('!', p)); throw new Error('Ada baris yang tidak bisa dipetakan — tidak ada yang ditulis'); }

    const perFarmer = new Map();
    for (const p of plan) { const k = p.plot.plot_name; perFarmer.set(k, (perFarmer.get(k) || 0) + p.total); }
    log(`Baris tanpa nomor: ${unnumbered.length} — bernilai ${rows.length} (${rp(rows.reduce((s, r) => s + r.total, 0))}), dilewati ${skipped.length} (tanpa jumlah/nilai)`);
    if (doneRows.size) log(`Sudah diimpor sebelumnya: ${doneRows.size}`);
    fixed.forEach((f) => log(`Tanggal dikoreksi — ${f}`));
    log(`Akan ditulis: ${plan.length} distribusi, ${rp(plan.reduce((s, p) => s + p.total, 0))}`);
    for (const [k, v] of [...perFarmer].sort()) log(`  ${k.padEnd(10)} ${rp(v).padStart(14)}`);
    if (VERBOSE) plan.forEach((p) => log(`    baris ${p.row} ${p.date} ${p.plot.plot_name} ${p.item} ${p.qty} ${p.unit} ${rp(p.total)} ${p.commodity}`));
    if (!APPLY) { log('\ndry-run only; re-run with --apply'); return; }

    await c.beginTransaction();
    for (const p of plan) {
      await c.query(
        `INSERT INTO pre_finance_distributions
           (pre_finance_type_id, date, farmer_id, plot_id, commodities_id, sapropdi_id, warehouse_id, stock_out_id,
            quantity, price_per_unit, total_amount, counts_as_debt, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 1, ?, NOW(), NOW())`,
        [saprodi.id, p.date, p.plot.farmer_id, p.plot.id, p.commodity_id, p.qty, p.price || (p.total / p.qty), p.total,
         `Pinjaman saprodi (tanpa no., baris ${p.row}) - ${p.item} ${p.qty} ${p.unit}${p.note} ${TAG}`]);
    }
    await c.commit();
    log('\ndone');
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
