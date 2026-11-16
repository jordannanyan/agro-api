// -----------------------------------------------------------------------------
// Import: the SNBS banana ledger after PO15 (2026-11)
//
// `[G-Sheet Format] Buku Besar - SJ - Banana.xlsx`, sheet `SJ - Data Entry Banana`
// — the Profit Sharing banana of Sumber Jaya. The system was filled from it up to
// PO15 (7 Aug 2026) and matches it row for row there; this adds every later
// Purchase Order the way PO1–15 were written:
//
//   · Purchasing rows → purchasing: the plot (ledger code AG1/AG2/…; LA and
//     SUW 1 are the subplots "SJ0009 · Pisang" / "SJ0015 · Pisang"), kilos,
//     price 0, scheme ProfitSharing, grade Not Categorized, warehouse Sumber
//     Jaya, receipt BAN-SJ-<PO>, paid, processed;
//   · the PO's Delivery row → processing BAN-SJ-PO<n> (input = the PO's kilos,
//     output = offtake volume, cost = washing cost invoiced) and one sale
//     (offtaker, offtake volume and value, invoice and DO numbers).
//
// Also fills the invoice and DO number on the sales of PO1–15 where empty, and
// reports any PO already in the system that no longer matches the ledger.
//
// Idempotent: a PO whose processing exists is not written again. Dry-run by
// default (written in a transaction, rolled back).
//
// Usage:
//   node scripts/importSjBananaLedgerTail2026-11.js --file "<SJ Banana xlsx>" [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const ENTITY_SNBS = 1, WH_SJ = 1, GRADE_NC = 8;
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <xlsx> [--apply]'); process.exit(2); }

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = Number(cv(v)); return isFinite(x) ? x : 0; };
const str = (v) => String(cv(v) ?? '').replace(/\s+/g, ' ').trim();
const ymd = (v) => {
  const x = cv(v);
  if (x instanceof Date && !isNaN(x)) return x.toISOString().slice(0, 10);
  if (typeof x === 'number' && x > 40000) return new Date(Math.round((x - 25569) * 864e5)).toISOString().slice(0, 10);
  return null;
};
// Ledger plot codes that are subplots in the system.
const SUBPLOT = { LA: 'SJ0009%Pisang', 'SUW 1': 'SJ0015%Pisang' };

async function readLedger() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (ws.name !== 'SJ - Data Entry Banana') { for await (const _ of ws) { /* skip */ } continue; }
    const out = [];
    for await (const row of ws) {
      if (row.number < 2) continue;
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      const process = str(v[7]);
      if (process !== 'Purchasing' && process !== 'Delivery') continue;
      out.push({
        row: row.number, entry: num(v[0]), date: ymd(v[5]), po: num(v[6]), process,
        plot: str(v[8]), farmer: str(v[9]), kg: num(v[14]),
        offtaker: str(v[15]), doNo: str(v[16]), invoice: str(v[17]), status: str(v[18]),
        reject: num(v[43]), offtakeKg: num(v[45]), offtakeValue: num(v[46]), washing: num(v[48]),
      });
    }
    return out;
  }
  throw new Error('Sheet "SJ - Data Entry Banana" tidak ada');
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const rows = await readLedger();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();
    const [[banana]] = await c.query("SELECT id FROM commodities WHERE commodities_name LIKE 'Banana%' LIMIT 1");
    const plots = await q(`SELECT pl.id, pl.plot_name, pl.scheme FROM plot pl JOIN farmers f ON f.id = pl.farmer_id
      JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ?`, [ENTITY_SNBS]);
    const plotOf = (code) => {
      const like = SUBPLOT[code];
      if (like) { const re = new RegExp('^' + like.replace('%', '.*') + '$'); return plots.find((p) => re.test(p.plot_name)); }
      return plots.find((p) => p.plot_name === code);
    };
    const offtakers = await q('SELECT id, offtaker_name FROM offtaker');
    const offtakerOf = (n) => offtakers.find((o) => o.offtaker_name.toLowerCase() === n.toLowerCase());

    const pos = [...new Set(rows.map((r) => r.po))].filter(Boolean).sort((a, b) => a - b);
    let addP = 0, addKg = 0, addSales = 0, addValue = 0, filled = 0;
    const problems = [];
    for (const po of pos) {
      const pur = rows.filter((r) => r.po === po && r.process === 'Purchasing' && r.kg > 0);
      const dlv = rows.filter((r) => r.po === po && r.process === 'Delivery');
      const code = `BAN-SJ-PO${po}`;
      const [proc] = await q('SELECT id FROM processing WHERE processing_code = ?', [code]);
      if (proc) {
        // Already in: check it still matches, and fill the invoice header if empty.
        const [[have]] = await c.query(`SELECT COUNT(*) n, COALESCE(SUM(quantity),0) kg FROM purchasing WHERE receipt_invoice = ?`, [`BAN-SJ-${po}`]);
        const kg = pur.reduce((s, r) => s + r.kg, 0);
        if (Number(have.n) !== pur.length || Math.abs(Number(have.kg) - kg) > 0.01) {
          problems.push(`${code}: sistem ${have.n} setoran ${Number(have.kg).toFixed(2)} kg ≠ ledger ${pur.length} setoran ${kg.toFixed(2)} kg`);
        }
        if (dlv[0]) {
          const [s] = await q('SELECT id, invoice_number, do_number, accepted_volume, total_revenue FROM selling WHERE processing_id = ?', [proc.id]);
          if (s && Math.abs(Number(s.total_revenue) - dlv[0].offtakeValue) > 50) {
            problems.push(`${code}: nilai jual sistem ${rp(s.total_revenue)} ≠ ledger ${rp(dlv[0].offtakeValue)}`);
          }
          if (s && !s.invoice_number && (dlv[0].invoice || dlv[0].doNo)) {
            await q('UPDATE selling SET invoice_number = ?, do_number = ?, updated_at = NOW() WHERE id = ?',
              [dlv[0].invoice.slice(0, 100) || null, dlv[0].doNo.slice(0, 100) || null, s.id]);
            filled++;
          }
        }
        continue;
      }
      if (!dlv.length) { log(`   · ${code}: ${pur.length} setoran tanpa baris Delivery — menunggu (tidak ditulis)`); continue; }
      const d = dlv[0];
      if (dlv.length > 1) problems.push(`${code}: ${dlv.length} baris Delivery — hanya yang pertama dipakai`);
      const off = offtakerOf(d.offtaker);
      if (!off) throw new Error(`${code}: offtaker "${d.offtaker}" belum ada di sistem`);
      const now = new Date();
      const ids = [];
      for (const r of pur) {
        const p = plotOf(r.plot);
        if (!p) throw new Error(`${code} entri ${r.entry}: plot "${r.plot}" (${r.farmer}) tidak ada di sistem`);
        if (p.scheme !== 'ProfitSharing') problems.push(`${code} entri ${r.entry}: plot ${p.plot_name} skemanya ${p.scheme}`);
        const [res] = await c.query(`INSERT INTO purchasing (plot_id, supplier_type, commodities_id, grade_id, warehouse_id, receipt_invoice,
            date, quantity, price_per_unit, scheme, payment_status, is_process, created_at, updated_at)
          VALUES (?, 'farmer', ?, ?, ?, ?, ?, ?, 0, 'ProfitSharing', 'paid', 1, ?, ?)`,
          [p.id, banana.id, GRADE_NC, WH_SJ, `BAN-SJ-${po}`, r.date, r.kg, now, now]);
        ids.push({ id: res.insertId, kg: r.kg });
        addP++; addKg += r.kg;
      }
      const vin = ids.reduce((s, x) => s + x.kg, 0);
      const [pr] = await c.query(`INSERT INTO processing (processing_code, date, commodities_id, warehouse_id, volume_input, volume_output,
          total_processing_cost, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'closed', ?, ?)`,
        [code, d.date, banana.id, WH_SJ, Math.round(vin * 1000) / 1000, d.offtakeKg, d.washing, now, now]);
      for (const x of ids) {
        await c.query('INSERT INTO processing_purchasings (processing_id, purchasing_id, volume_contributed) VALUES (?,?,?)', [pr.insertId, x.id, x.kg]);
      }
      const price = d.offtakeKg > 0 ? Math.round((d.offtakeValue / d.offtakeKg) * 100) / 100 : 0;
      await c.query(`INSERT INTO selling (processing_id, offtaker_id, warehouse_id, invoice_number, do_number, date, delivered_volume,
          accepted_volume, price_per_unit, invoice_total, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [pr.insertId, off.id, WH_SJ, d.invoice.slice(0, 100) || null, d.doNo.slice(0, 100) || null, d.date,
         d.offtakeKg + d.reject, d.offtakeKg, price, d.offtakeValue, now, now]);
      addSales++; addValue += d.offtakeValue;
      log(`   + ${code} ${d.date} · ${pur.length} setoran ${vin.toFixed(2)} kg → ${d.offtaker} ${d.offtakeKg} kg ${rp(d.offtakeValue)}${d.status && d.status !== 'Paid' ? ` (${d.status})` : ''}`);
    }
    log(`\nSetoran baru: ${addP} (${addKg.toFixed(2)} kg) · penjualan baru: ${addSales} (${rp(addValue)}) · no. invoice diisi: ${filled}`);
    if (problems.length) { log('\nPerlu dicek:'); problems.forEach((p) => log('   ! ' + p)); }
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
