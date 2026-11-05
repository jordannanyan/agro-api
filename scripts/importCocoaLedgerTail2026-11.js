// -----------------------------------------------------------------------------
// Import: the SNBS cocoa ledger since the 2026-08 bulk import (2026-11)
//
// "[G-Sheet Format] Buku Besar - Sumber Jaya - Cocoa.xlsx" came in once, on
// 2026-08-10 (Data Operation/import_output_v2/_scripts/v2_2_transactions.py).
// Checked 2026-11-05 against the copy of 29 Oct 2026: every purchase up to
// 10 Aug 2026 is in the system (3.888 Dried Bean, 2 Fermented Bean, matched on
// date + kilos); what came after is not — Dried Bean entries 4040 onward
// (107 purchases, 3 processing batches, 4 deliveries) and Fermented Bean 10
// onward.
//
// The same rules as that import, replayed from the entry after the last batch the
// system holds, in ledger order:
//   Purchasing (volume > 0)  → purchasing (farmer plot or collector, grade Not
//                              Categorized, warehouse Sumber Jaya, paid, the
//                              ledger's price); a row already in the system is
//                              reused, not inserted again
//   Processing               → processing `<label>-<entry>`, holding every
//                              purchase since the previous batch
//   Delivery (volume > 0)    → selling on the latest batch; purchases still
//                              unbatched first go into a pass-through batch
//                              `<label>-PASS-<entry>`, as the import did
// Suppliers are resolved by the name the ledger already used for rows in the
// system. A name never seen before is a new small supplier: like the import, a
// farmer is created under "Non KTH SJ" with a plot NONSJ<next> (Beli Putus). A
// row with no name is listed and skipped. A date before 2020 is a year typo
// ("2016-08-28" between August 2026 rows) and takes the row before it.
// Loan repayments are NOT booked here — the ledger's "Farmer Loan Repayment"
// column came in through importSnbsCocoaLoans2026-10.js.
//
// Idempotent. Dry-run by default (writes in a transaction, then rolls back).
//
// Usage:
//   node scripts/importCocoaLedgerTail2026-11.js --file "<Cocoa xlsx>" [--verbose]
//   node scripts/importCocoaLedgerTail2026-11.js --file "<Cocoa xlsx>" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const COMM_COCOA = 1, WH_SJ = 1, GRADE_UNCAT = 8, ENTITY_SNBS = 1;
const SHEETS = [['Dried Bean - Data Entry', 'COC-DB'], ['Fermented Bean - Data Entry', 'COC-FB']];
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <Cocoa xlsx> [--apply] [--verbose]'); process.exit(2); }

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = Number(cv(v)); return isFinite(x) ? x : 0; };
const ymd = (v) => {
  const x = cv(v);
  if (x instanceof Date && !isNaN(x)) return x.toISOString().slice(0, 10);
  if (typeof x === 'number' && x > 30000 && x < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(x) * 86400000).toISOString().slice(0, 10);
  return null;
};
const norm = (s) => String(cv(s) ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const txt = (s) => { const x = cv(s); return x == null || String(x).trim() === '' ? null : String(x).trim(); };
const r3 = (n) => Math.round(n * 1000) / 1000;

async function readSheets() {
  const ExcelJS = require('exceljs');
  const want = new Map(SHEETS);
  const out = {};
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (!want.has(ws.name)) { for await (const _ of ws) { /* skip */ } continue; }
    let h = null; const rows = [];
    for await (const row of ws) {
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      if (!h) { h = v.map((x) => String(cv(x) ?? '').replace(/\s+/g, ' ').trim()); continue; }
      const g = (name) => { const i = h.indexOf(name); return i < 0 ? null : v[i]; };
      const process = txt(g('Process'));
      if (!process) continue;
      rows.push({ line: row.number, entry: num(g('Entry Number')), date: ymd(g('Date')), process, name: txt(g('Supplier/Offtaker Name')),
        receipt: txt(g('Receipt/Invoice')), vol: num(g('Volume')), price: num(g('Purchase Price/Kg')),
        netProc: num(g('Net Processing Volume')), procCost: num(g('Total Processing Cost')),
        netDel: num(g('Net Delivery Volume')), offPrice: num(g('Offtake Price/Kg')) });
    }
    out[want.get(ws.name)] = rows.sort((a, b) => a.entry - b.entry);
  }
  for (const [, l] of SHEETS) if (!out[l]) throw new Error(`sheet for ${l} missing`);
  return out;
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const sheets = await readSheets();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();
    const offs = await q('SELECT id, offtaker_name, entities_id FROM offtaker');
    const offBy = new Map();
    for (const o of offs) { const k = norm(o.offtaker_name); if (!offBy.has(k) || o.entities_id === ENTITY_SNBS) offBy.set(k, o.id); }
    const offtakerId = async (name) => {
      const k = norm(name);
      if (!k) return null;
      if (offBy.has(k)) return offBy.get(k);
      // The ledger's names are cut at 20 characters ("Grand Kakao Indonesi").
      const pre = [...offBy.keys()].find((x) => x.startsWith(k) || k.startsWith(x));
      if (pre) return offBy.get(pre);
      const [r] = await c.query('INSERT INTO offtaker (offtaker_name, entities_id, created_at, updated_at) VALUES (?,?,NOW(),NOW())', [name, ENTITY_SNBS]);
      offBy.set(k, r.insertId); log(`   + offtaker baru: ${name}`);
      return r.insertId;
    };

    const dbPur = await q(`SELECT pu.id, pu.date, pu.quantity, pu.plot_id, pu.collector_id, pu.is_process, pl.scheme
      FROM purchasing pu LEFT JOIN plot pl ON pl.id = pu.plot_id WHERE pu.commodities_id = ? ORDER BY pu.id`, [COMM_COCOA]);
    const pool = new Map();
    for (const p of dbPur) { const k = `${p.date}|${r3(Number(p.quantity))}`; if (!pool.has(k)) pool.set(k, []); pool.get(k).push(p); }
    const procs = await q(`SELECT id, processing_code, date FROM processing WHERE commodities_id = ?`, [COMM_COCOA]);
    const procBy = new Map(procs.map((p) => [p.processing_code, p]));
    const sells = await q(`SELECT s.id, s.date, s.delivered_volume, s.processing_id FROM selling s JOIN processing pr ON pr.id = s.processing_id
      WHERE pr.commodities_id = ?`, [COMM_COCOA]);

    // 1. ledger purchases ↔ system, in order; the names they carry → plot / collector
    const nameTo = new Map();
    const matchedEntry = new Map();
    for (const [label, rows] of Object.entries(sheets)) {
      let last = null;
      for (const r of rows) {
        if (r.date && r.date < '2020-01-01') { log(`   · ${label} entri ${r.entry}: tanggal ${r.date} salah ketik → ${last}`); r.date = last; }
        if (r.date) last = r.date; else r.date = last;
        if (r.process !== 'Purchasing' || !(r.vol > 0)) continue;
        const cand = (pool.get(`${r.date}|${r3(r.vol)}`) || []).shift();
        if (!cand) continue;
        matchedEntry.set(`${label}|${r.entry}`, cand);
        const k = norm(r.name);
        const m = nameTo.get(k) || new Map(); const key = `${cand.plot_id ?? ''}|${cand.collector_id ?? ''}`;
        m.set(key, (m.get(key) || 0) + 1); nameTo.set(k, m);
      }
    }
    const resolve = (name) => {
      const m = nameTo.get(norm(name));
      if (!m) return null;
      const [key] = [...m].sort((a, b) => b[1] - a[1])[0];
      const [pid, cid] = key.split('|');
      return { plot_id: pid ? Number(pid) : null, collector_id: cid ? Number(cid) : null };
    };
    const plotScheme = new Map((await q('SELECT id, scheme FROM plot')).map((p) => [p.id, p.scheme]));
    const [[nonSj]] = await c.query("SELECT id FROM kth WHERE kth_name = 'Non KTH SJ' LIMIT 1");
    const [[tpl]] = await c.query("SELECT inside_kth FROM plot WHERE plot_name LIKE 'NONSJ%' ORDER BY id DESC LIMIT 1");
    const [[mx]] = await c.query("SELECT MAX(CAST(SUBSTRING(plot_name, 6) AS UNSIGNED)) n FROM plot WHERE plot_name LIKE 'NONSJ%'");
    let nextNonSj = Number(mx.n || 0) + 1;
    const created = [];
    const newSupplier = async (name) => {
      const [f] = await c.query('INSERT INTO farmers (farmer_name, kth_id, created_at, updated_at) VALUES (?,?,NOW(),NOW())', [name, nonSj.id]);
      const code = `NONSJ${String(nextNonSj++).padStart(4, '0')}`;
      const [pl] = await c.query("INSERT INTO plot (plot_name, farmer_id, scheme, inside_kth, created_at, updated_at) VALUES (?,?, 'BeliPutus', ?, NOW(), NOW())",
        [code, f.insertId, tpl?.inside_kth ?? 0]);
      plotScheme.set(pl.insertId, 'BeliPutus');
      const who = { plot_id: pl.insertId, collector_id: null };
      const m = new Map([[`${pl.insertId}|`, 1]]); nameTo.set(norm(name), m);
      created.push(`${name} → ${code}`);
      return who;
    };

    // 2. replay each stream from the entry after the last batch in the system
    const stats = { pur: 0, purKg: 0, purRp: 0, reused: 0, proc: 0, pass: 0, sell: 0, sellKg: 0 };
    const problems = [];
    for (const [label, rows] of Object.entries(sheets)) {
      const have = procs.map((p) => p.processing_code).filter((x) => x.startsWith(`${label}-`))
        .map((x) => Number((x.match(/-(\d+)$/) || [])[1])).filter((n) => isFinite(n));
      const lastEntry = have.length ? Math.max(...have) : 0;
      const lastBatch = procs.filter((p) => p.processing_code.match(new RegExp(`^${label}-(PASS-)?${lastEntry}$`)))[0];
      let cur = lastBatch?.id ?? null; let pending = [];
      log(`\n── ${label}: batch terakhir di sistem ${lastBatch?.processing_code ?? '—'} → diputar ulang dari entri ${lastEntry + 1}`);
      for (const r of rows.filter((x) => x.entry > lastEntry)) {
        if (r.process === 'Purchasing') {
          if (!(r.vol > 0)) continue;   // repayment-only rows
          const m = matchedEntry.get(`${label}|${r.entry}`);
          if (m) { if (!Number(m.is_process)) pending.push({ id: m.id, qty: Number(m.quantity) }); stats.reused++; continue; }
          let who = resolve(r.name);
          if (!who && (!r.name || norm(r.name) === 'null')) { problems.push(`${label} entri ${r.entry} ${r.date}: tanpa nama pemasok — dilewati (${r.vol} kg)`); continue; }
          if (!who) who = await newSupplier(r.name);
          const scheme = who.collector_id ? 'BeliPutus' : (plotScheme.get(who.plot_id) || 'BeliPutus');
          const [res] = await c.query(`INSERT INTO purchasing (plot_id, collector_id, supplier_type, commodities_id, grade_id, warehouse_id, receipt_invoice,
              date, quantity, price_per_unit, scheme, payment_status, is_process, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?, 'paid', 0, NOW(), NOW())`,
            [who.collector_id ? null : who.plot_id, who.collector_id, who.collector_id ? 'collector' : 'farmer', COMM_COCOA, GRADE_UNCAT, WH_SJ,
             r.receipt ? r.receipt.slice(0, 100) : null, r.date, r3(r.vol), Math.round(r.price * 100) / 100, scheme]);
          pending.push({ id: res.insertId, qty: r3(r.vol) });
          stats.pur++; stats.purKg += r.vol; stats.purRp += r.vol * r.price;
          if (VERBOSE) log(`   + beli ${r.entry} ${r.date} ${r.name} ${r.vol} kg × ${r.price}`);
        } else if (r.process === 'Processing') {
          const code = `${label}-${r.entry}`;
          if (procBy.has(code)) { cur = procBy.get(code).id; pending = []; continue; }
          const [res] = await c.query(`INSERT INTO processing (processing_code, date, commodities_id, warehouse_id, volume_input, volume_output,
              total_processing_cost, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'closed', NOW(), NOW())`,
            [code, r.date, COMM_COCOA, WH_SJ, r3(r.vol), r3(r.netProc), Math.round(r.procCost * 100) / 100]);
          for (const p of pending) {
            await q('INSERT INTO processing_purchasings (processing_id, purchasing_id, volume_contributed) VALUES (?,?,?)', [res.insertId, p.id, p.qty]);
            await q('UPDATE purchasing SET is_process = 1 WHERE id = ?', [p.id]);
          }
          log(`   + olah ${code} ${r.date}: ${r.vol} kg → ${r.netProc} kg, ${pending.length} pembelian`);
          cur = res.insertId; pending = []; stats.proc++;
        } else if (r.process === 'Delivery') {
          if (!(r.vol > 0)) continue;
          if (pending.length) {
            const code = `${label}-PASS-${r.entry}`;
            const vin = r3(pending.reduce((s, p) => s + p.qty, 0));
            const [res] = await c.query(`INSERT INTO processing (processing_code, date, commodities_id, warehouse_id, volume_input, volume_output,
                total_processing_cost, status, created_at, updated_at) VALUES (?,?,?,?,?,?,0, 'closed', NOW(), NOW())`,
              [code, r.date, COMM_COCOA, WH_SJ, vin, vin]);
            for (const p of pending) {
              await q('INSERT INTO processing_purchasings (processing_id, purchasing_id, volume_contributed) VALUES (?,?,?)', [res.insertId, p.id, p.qty]);
              await q('UPDATE purchasing SET is_process = 1 WHERE id = ?', [p.id]);
            }
            log(`   + batch lewat ${code} ${r.date}: ${vin} kg dari ${pending.length} pembelian`);
            cur = res.insertId; pending = []; stats.pass++;
          }
          if (!cur) { problems.push(`${label} entri ${r.entry}: pengiriman tanpa batch sebelumnya — dilewati`); continue; }
          const dup = sells.find((s) => s.processing_id === cur && s.date === r.date && Math.abs(Number(s.delivered_volume) - r.vol) < 0.0005);
          if (dup) continue;
          const accepted = r.netDel ? Math.min(r.netDel, r.vol) : r.vol;
          await q(`INSERT INTO selling (processing_id, offtaker_id, warehouse_id, date, delivered_volume, accepted_volume, price_per_unit, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,NOW(),NOW())`, [cur, await offtakerId(r.name), WH_SJ, r.date, r3(r.vol), r3(accepted), Math.round(r.offPrice * 100) / 100]);
          log(`   + jual ${r.entry} ${r.date} ${r.name}: ${r.vol} kg × ${rp(r.offPrice)}`);
          stats.sell++; stats.sellKg += r.vol;
        }
      }
      if (pending.length) log(`   · ${pending.length} pembelian belum masuk batch olah (menunggu entri Processing berikutnya)`);
    }
    log(`\nPembelian baru: ${stats.pur} (${r3(stats.purKg)} kg, ${rp(stats.purRp)}) · sudah ada dipakai ulang: ${stats.reused}`);
    log(`Batch olah baru: ${stats.proc} · batch lewat: ${stats.pass} · penjualan baru: ${stats.sell} (${r3(stats.sellKg)} kg)`);
    if (created.length) log(`Pemasok baru (petani + lahan Non KTH SJ): ${created.length} — ${created.join(', ')}`);
    problems.forEach((p) => log(`! ${p}`));
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
