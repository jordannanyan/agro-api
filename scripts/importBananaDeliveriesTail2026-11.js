// -----------------------------------------------------------------------------
// Import: JNBS banana deliveries after the AML ledger's last day (2026-11)
//
// The AML ledger ("Buku Besar - AML - Banana", copy of 5 Nov 2026) stops at
// 19 Oct 2026 and the system matches it to the kilo. The purchasing sheet the
// field team keeps — "OLD_Buku Besar Banana Harvesting & Offtake Data 2025.xlsx",
// `Data Pembelian & Penjualan Pisang` — already has the deliveries of 2–3 Nov
// 2026. This brings in what that sheet has after the ledger (--after, default
// 2026-10-19):
//   D plot · F kg · G purchase value · J saprodi deducted · K labour deducted ·
//   P status · Q nota · BX date
// One purchasing row each (grade Not Categorized, warehouse KTH AML), scheme from
// the plot — profit-sharing plots at price 0 — and, for a Pre-Finance delivery,
// the sheet's deduction as its installment.
//
// receipt_invoice is `BAN-AML-<nota>`: syncAmlLedger2026-10.js matches the rows
// it does not know by date + plot + grade + kg among `BAN-AML-%` receipts, so
// when the AML ledger reaches these days it takes these rows over (and gives
// them their DO number) instead of adding them a second time.
//
// --rows 172,173 takes those sheet rows instead, whatever their date — for a
// delivery the AML ledger never had (GK006002, 14 Jun 2025: in the purchasing
// sheet and in the JNBS "Mustari Outstanding Debt" figures, nowhere else).
// The five plots that moved to profit sharing are Pre-Finance up to 28 Aug 2025
// (migratePurchasingScheme2026-11.js), whatever their scheme today.
//
// Idempotent (a delivery with the same plot, date and kg is skipped). Dry-run by
// default (written in a transaction, rolled back).
//
// Usage:
//   node scripts/importBananaDeliveriesTail2026-11.js --file "<OLD_Buku Besar …xlsx>" [--after 2026-10-19]
//   node scripts/importBananaDeliveriesTail2026-11.js --file "<…xlsx>" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('--file');
const AFTER = arg('--after') || '2026-10-19';
const ROWS = arg('--rows') ? new Set(arg('--rows').split(',').map(Number)) : null;
const SWITCHED = ['SM003002', 'SM019003', 'GK006001', 'GK006002', 'GW006003'];
const PF_UNTIL = '2025-08-28';
const DB = process.env.DB_NAME || 'agro_supply';
const SHEET = 'Data Pembelian & Penjualan Pisa';
const COMM_BANANA = 2, WH_AML = 2, GRADE_UNCAT = 8, ENTITY_JNBS = 3;
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <xlsx> [--after YYYY-MM-DD] [--apply]'); process.exit(2); }

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = Number(cv(v)); return isFinite(x) ? x : 0; };
const ymd = (v) => {
  const x = cv(v);
  if (x instanceof Date && !isNaN(x)) return x.toISOString().slice(0, 10);
  if (typeof x === 'number' && x > 30000 && x < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(x) * 86400000).toISOString().slice(0, 10);
  return null;
};
const col = (L) => [...L].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const r2 = (n) => Math.round(n * 100) / 100;

async function readSheet() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (!ws.name.startsWith(SHEET)) { for await (const _ of ws) { /* skip */ } continue; }
    const rows = [];
    for await (const row of ws) {
      if (row.number < 5) continue;
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      const plot = String(cv(v[col('D')]) ?? '').trim().toUpperCase();
      const date = ymd(v[col('BX')]);
      if (!/^[A-Z]{2}\d{6}$/.test(plot) || !date) continue;
      if (ROWS ? !ROWS.has(row.number) : date <= AFTER) continue;
      rows.push({ row: row.number, date, plot, farmer: String(cv(v[col('C')]) ?? '').trim(), kg: num(v[col('F')]), buy: num(v[col('G')]),
        sap: num(v[col('J')]), tk: num(v[col('K')]), status: String(cv(v[col('P')]) ?? '').trim().toLowerCase(),
        nota: String(cv(v[col('Q')]) ?? '').replace(/\.pdf$/i, '').trim() });
    }
    return rows.filter((r) => r.kg > 0);
  }
  throw new Error(`Sheet "${SHEET}…" tidak ada`);
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB} · ${ROWS ? `baris ${[...ROWS].join(', ')}` : `setoran sesudah ${AFTER}`}`);
  const rows = await readSheet();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();
    const plots = await q(`SELECT pl.id, pl.plot_name, pl.scheme, pl.farmer_id FROM plot pl JOIN farmers f ON f.id = pl.farmer_id
      JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ?`, [ENTITY_JNBS]);
    const plotBy = new Map(plots.map((p) => [p.plot_name.toUpperCase(), p]));
    const [[types]] = await c.query("SELECT MAX(IF(type_name='Saprodi', id, NULL)) sap, MAX(IF(type_name='Labor', id, NULL)) lab FROM pre_finance_types");
    let n = 0, kg = 0, val = 0, ded = 0, skipped = 0;
    for (const r of rows) {
      const pl = plotBy.get(r.plot);
      if (!pl) { log(`! baris ${r.row}: plot ${r.plot} bukan plot JNBS — dilewati`); continue; }
      const [dup] = await q('SELECT id FROM purchasing WHERE plot_id = ? AND date = ? AND ABS(quantity - ?) < 0.006 LIMIT 1', [pl.id, r.date, r.kg]);
      if (dup) { skipped++; continue; }
      const scheme = SWITCHED.includes(r.plot) && r.date <= PF_UNTIL ? 'PreFinance' : pl.scheme;
      const ps = scheme === 'ProfitSharing';
      const price = ps ? 0 : r2(r.buy / r.kg);
      const invoice = `BAN-AML-${r.nota || `BARIS${r.row}`}`.slice(0, 100);
      const [res] = await c.query(`INSERT INTO purchasing (plot_id, supplier_type, commodities_id, grade_id, warehouse_id, receipt_invoice, date, quantity,
          price_per_unit, scheme, payment_status, is_process, created_at, updated_at) VALUES (?, 'farmer', ?,?,?,?,?,?,?,?,?, 0, NOW(), NOW())`,
        [pl.id, COMM_BANANA, GRADE_UNCAT, WH_AML, invoice, r.date, r.kg, price, scheme, r.status === 'paid' || ps ? 'paid' : 'unpaid']);
      const deduction = r2(r.sap + r.tk);
      if (!ps && scheme === 'PreFinance' && deduction > 0) {
        const [ins] = await c.query(`INSERT INTO pre_finance_installments (purchasing_id, farmer_id, date, reference_no, total_payment, notes, created_at, updated_at)
          VALUES (?,?,?,?,?,?,NOW(),NOW())`, [res.insertId, pl.farmer_id, r.date, invoice, deduction,
          `Potongan setoran — Data Pembelian & Penjualan Pisang baris ${r.row}`]);
        for (const [tid, amt] of [[types.sap, r.sap], [types.lab, r.tk]]) {
          if (amt > 0) await q('INSERT INTO pre_finance_installment_details (installment_id, pre_finance_type_id, amount) VALUES (?,?,?)', [ins.insertId, tid, r2(amt)]);
        }
        ded += deduction;
      }
      log(`   + ${r.date} ${r.plot.padEnd(9)} ${r.farmer.padEnd(15)} ${String(r.kg).padStart(7)} kg × ${price}${ps ? ' (bagi hasil)' : ''}${deduction > 0 && !ps ? ` · potong ${rp(deduction)}` : ''}`);
      n++; kg += r.kg; val += r.kg * price;
    }
    log(`\nSetoran baru: ${n} (${Math.round(kg * 100) / 100} kg, ${rp(val)}) · potongan cicilan ${rp(ded)} · sudah ada ${skipped}`);
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
