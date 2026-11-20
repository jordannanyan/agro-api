// -----------------------------------------------------------------------------
// Import: the delivery costs of SNBS cocoa sales (2026-11)
//
// `Buku Besar - Sumber Jaya - Cocoa.xlsx`, sheets `Dried Bean - Data Entry` and
// `Fermented Bean - Data Entry`: every Delivery row carries what that shipment
// cost — Cost Packing, Cost Loading, Cost Transport, Cost Consumption, Cost
// Other (Total Delivery Cost). The import of the deliveries
// (importCocoaLedgerTail2026-11.js) wrote the sale but not these, so the
// dashboard's direct cost of cocoa had no packing or transport in it.
//
// Each cost becomes one `selling_costs` row on the sale it belongs to, matched
// the way the importer recognises its own sales: cocoa, same date, same
// delivered kilos. Rows carry the tag below; a re-run replaces its own rows and
// leaves a cost typed through the web alone.
//
// Idempotent. Dry-run by default (written in a transaction, rolled back).
//
// Usage:
//   node scripts/importCocoaDeliveryCosts2026-11.js --file "<Cocoa ledger xlsx>" [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const TAG = '· Buku Besar Kakao';
const SHEETS = ['Dried Bean - Data Entry', 'Fermented Bean - Data Entry'];
const COSTS = [['Cost Packing', 'Packing'], ['Cost Loading', 'Loading'], ['Cost Transport', 'Transport'],
               ['Cost Consumption', 'Konsumsi'], ['Cost Other', 'Lain-lain']];
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <xlsx> [--apply]'); process.exit(2); }

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = Number(cv(v)); return isFinite(x) ? x : 0; };
const ymd = (v) => {
  const x = cv(v);
  if (x instanceof Date && !isNaN(x)) return x.toISOString().slice(0, 10);
  if (typeof x === 'number' && x > 40000) return new Date(Math.round((x - 25569) * 864e5)).toISOString().slice(0, 10);
  return null;
};

async function readDeliveries() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  const out = [];
  for await (const ws of reader) {
    if (!SHEETS.includes(ws.name)) { for await (const _ of ws) { /* skip */ } continue; }
    let h = null;
    for await (const row of ws) {
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      if (!h) { h = v.map((x) => String(cv(x) ?? '').replace(/\s+/g, ' ').trim()); continue; }
      const g = (name) => { const i = h.indexOf(name); return i < 0 ? null : v[i]; };
      if (String(cv(g('Process')) ?? '').trim() !== 'Delivery') continue;
      const costs = COSTS.map(([col, label]) => ({ label, amount: num(g(col)) })).filter((x) => x.amount > 0);
      if (!costs.length) continue;
      out.push({ sheet: ws.name, line: row.number, entry: num(g(h[0])), date: ymd(g('Date')), vol: num(g('Volume')), costs });
    }
  }
  return out;
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const rows = await readDeliveries();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();
    const [[cocoa]] = await c.query("SELECT id FROM commodities WHERE commodities_name LIKE 'Cocoa%' LIMIT 1");
    const sells = await q(`SELECT s.id, DATE(s.date) d, s.delivered_volume v FROM selling s JOIN processing pr ON pr.id = s.processing_id
      WHERE pr.commodities_id = ?`, [cocoa.id]);
    const used = new Set();
    let n = 0, total = 0, replaced = 0;
    const missing = [];
    for (const r of rows) {
      const s = sells.find((x) => !used.has(x.id) && x.d === r.date && Math.abs(Number(x.v) - r.vol) < 0.0005);
      const sum = r.costs.reduce((a, x) => a + x.amount, 0);
      if (!s) { missing.push(`${r.sheet} baris ${r.line} (entri ${r.entry}) ${r.date} ${r.vol} kg: ${rp(sum)}`); continue; }
      used.add(s.id);
      const [del] = await c.query('DELETE FROM selling_costs WHERE selling_id = ? AND description LIKE ?', [s.id, `%${TAG}%`]);
      replaced += del.affectedRows;
      for (const x of r.costs) {
        await c.query(`INSERT INTO selling_costs (selling_id, pre_finance_type_id, description, amount, created_at, updated_at)
          VALUES (?, NULL, ?, ?, NOW(), NOW())`, [s.id, `${x.label} ${TAG} entri ${r.entry}`, Math.round(x.amount * 100) / 100]);
      }
      n++; total += sum;
      log(`   + penjualan #${s.id} ${r.date} ${r.vol} kg: ${r.costs.map((x) => `${x.label} ${rp(x.amount)}`).join(', ')}`);
    }
    log(`\n${n} pengiriman, biaya ${rp(total)} (baris lama diganti: ${replaced})`);
    if (missing.length) { log('\nTidak ketemu penjualannya:'); missing.forEach((m) => log('   ! ' + m)); }
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
