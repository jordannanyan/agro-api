// -----------------------------------------------------------------------------
// Import: SNBS expansion plots and the Sumber Jaya warehouse stock card (2026-11)
//
// Source: `Database Cavendish SNBS Lampung.xlsx` — sheets `plot id`, `Daily
// Update` (plot size and population) and `Stock card`.
//
//   A. The eleven Profit Sharing banana plots of the 10 ha expansion, SJ0067 …
//      SJ0077 (Oct–Nov 2026; the `Skema Petani SNBS` list). Farmers who already
//      exist (Joko Edi, M Amir Mahmud, Mulyono, Ahmad Nurul Fauzi, Susanto) get
//      the plot; Roji, Marcel, Muson and Sutaji are added to KTH Sumber Jaya.
//      The plot is named by its code — the code the ledgers use for it.
//
//   B. Stock IN. The stock card's receipts were never imported: SNBS stock so far
//      was issues only, corrected by the opname of 29 Sep 2026. Every receipt
//      (warehouse SNBS1, the expansion store SNBS2, and fuel bought straight for
//      a plot) becomes a Posted receipt of warehouse Sumber Jaya, one per date,
//      SIH-SNBS-####. Unit price from `Werehouse Purchasing` when the same item
//      was bought that day, else the last price the warehouse issued it at.
//
//   C. Stock OUT after the first import (19 Aug 2026): the card's issues to a plot
//      that the system does not have yet, written as before — one SOH-SNBS-####
//      per date, a pre_finance_distributions line per item, Profit Sharing,
//      counts_as_debt = 0 (the plot's cost is the Daily Update, not this).
//      Issues not to a plot (processing house, taken by a cocoa farmer) are
//      reported, not written.
//
//   D. Applied opnames of Sumber Jaya are re-based: system_qty becomes the stock
//      the records now give on the opname date, and adjustment = counted − that,
//      so stock after the opname is still exactly what was counted.
//
// Item names follow how the first import mapped them (learned from the lines both
// have); an item it never met is matched on the master's name. Idempotent.
// Dry-run by default (written in a transaction, rolled back).
//
// Usage:
//   node scripts/importSnbsExpansionStock2026-11.js --file "<Cavendish xlsx>" [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const ENTITY_SNBS = 1, WH_SJ = 1;
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <xlsx> [--apply]'); process.exit(2); }

// SNBS land code → plot name in the system.
const PLOT = {
  SJ0056: 'AG1', SJ0057: 'AG2', NONSJ0276: 'AMA', SJ0005: 'ANF', SJ0009: 'SJ0009%Pisang', SJ0050: 'M2',
  SJ0011: 'NC', SJ0051: 'SU', NONSJ0275: 'SUM', SJ0015: 'SJ0015%Pisang', SJ0052: 'SUW 2', SJ0053: 'SUW 3',
  SJ0054: 'SUY', SJ0055: 'ZN',
};
// The expansion plots: code → farmer (an existing SNBS farmer id, or a name to create).
const EXPANSION = [
  ['SJ0067', { id: 7 }, 'Joko Edi'], ['SJ0068', { name: 'Roji' }], ['SJ0069', { name: 'Marcel' }],
  ['SJ0070', { name: 'Muson' }], ['SJ0071', { id: 27 }, 'M Amir Mahmud'], ['SJ0072', { id: 27 }, 'M Amir Mahmud'],
  ['SJ0073', { id: 564 }, 'Mulyono'], ['SJ0074', { id: 3 }, 'Ahmad Nurul Fauzi'], ['SJ0075', { id: 24 }, 'Susanto'],
  ['SJ0076', { name: 'Sutaji' }], ['SJ0077', { name: 'Sutaji' }],
];
const MONTH = { januari: 1, january: 1, februari: 2, february: 2, maret: 3, march: 3, april: 4, mei: 5, may: 5, juni: 6, june: 6,
  juli: 7, july: 7, agustus: 8, august: 8, september: 9, oktober: 10, october: 10, november: 11, desember: 12, december: 12 };

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = Number(cv(v)); return isFinite(x) ? x : 0; };
const str = (v) => String(cv(v) ?? '').replace(/\s+/g, ' ').trim();
const ymd = (v) => {
  const x = cv(v);
  if (x instanceof Date && !isNaN(x)) return x.toISOString().slice(0, 10);
  if (typeof x === 'number' && x > 40000) return new Date(Math.round((x - 25569) * 864e5)).toISOString().slice(0, 10);
  return null;
};
const key = (s) => str(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const q3 = (n) => Math.round(Number(n) * 1000) / 1000;
const q2 = (n) => Math.round(Number(n) * 100) / 100;

async function readBook() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  const out = { card: [], du: {}, purchases: [] };
  for await (const ws of reader) {
    const want = ['Stock card', 'Daily Update', 'Werehouse Purchasing'].includes(ws.name);
    for await (const row of ws) {
      if (!want) continue;
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      if (ws.name === 'Stock card' && row.number > 1) {
        const m = MONTH[str(v[2]).toLowerCase()];
        const inQ = num(v[5]), outQ = num(v[6]);
        if (!m || !num(v[3]) || !num(v[1]) || (!inQ && !outQ)) continue;
        const date = `${num(v[3])}-${String(m).padStart(2, '0')}-${String(num(v[1])).padStart(2, '0')}`;
        out.card.push({ row: row.number, block: str(v[0]), date, item: str(v[4]), inQ, outQ, unit: str(v[7]), dest: str(v[8]), note: str(v[10]) });
      } else if (ws.name === 'Daily Update' && row.number > 1) {
        const code = str(v[1]);
        if (/^SJ00(6[7-9]|7\d)$/.test(code) && !out.du[code]) out.du[code] = { area: num(v[2]) || null, plants: num(v[3]) || null };
      } else if (ws.name === 'Werehouse Purchasing' && row.number > 4) {
        const d = ymd(v[8]);
        if (d && str(v[1]) && num(v[5])) out.purchases.push({ item: str(v[1]), date: d, price: num(v[5]) });
      }
    }
  }
  return out;
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const book = await readBook();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();
    const [[banana]] = await c.query("SELECT id FROM commodities WHERE commodities_name LIKE 'Banana%' LIMIT 1");
    const [[kthSj]] = await c.query("SELECT id FROM kth WHERE entities_id = ? AND kth_name = 'Sumber Jaya'", [ENTITY_SNBS]);
    const [[saprodiType]] = await c.query("SELECT id FROM pre_finance_types WHERE type_name = 'Saprodi'");

    // ── A. expansion plots
    log('\nA) Plot ekspansi Profit Sharing');
    const created = {};
    for (const [code, who] of EXPANSION) {
      const [have] = await q('SELECT id FROM plot WHERE plot_name = ?', [code]);
      if (have) continue;
      let farmerId = who.id;
      if (!farmerId) {
        const [f] = await q('SELECT f.id FROM farmers f JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ? AND LOWER(f.farmer_name) = LOWER(?) LIMIT 1', [ENTITY_SNBS, who.name]);
        if (f) farmerId = f.id;
        else if (created[who.name]) farmerId = created[who.name];
        else {
          const [r] = await c.query('INSERT INTO farmers (farmer_name, kth_id, created_at, updated_at) VALUES (?,?,NOW(),NOW())', [who.name, kthSj.id]);
          farmerId = created[who.name] = r.insertId;
          log(`   + petani ${who.name} (KTH Sumber Jaya)`);
        }
      } else {
        const [[f]] = await c.query('SELECT f.farmer_name, k.entities_id FROM farmers f JOIN kth k ON k.id = f.kth_id WHERE f.id = ?', [farmerId]);
        if (!f || f.entities_id !== ENTITY_SNBS) throw new Error(`${code}: petani #${farmerId} bukan petani SNBS`);
      }
      const du = book.du[code] || {};
      await c.query(`INSERT INTO plot (plot_name, ledger_code, farmer_id, scheme, inside_kth, commodities_id, land_area, number_of_plants, created_at, updated_at)
        VALUES (?,?,?, 'ProfitSharing', 1, ?, ?, ?, NOW(), NOW())`, [code, code, farmerId, banana.id, du.area ?? null, du.plants ?? null]);
      log(`   + plot ${code} · ${who.name || EXPANSION.find((e) => e[0] === code)[2]} · ${du.area ?? '?'} ha · ${du.plants ?? '?'} pohon`);
    }

    const plots = {};
    for (const [land, name] of [...Object.entries(PLOT), ...EXPANSION.map((e) => [e[0], e[0]])]) {
      const [p] = await q(`SELECT pl.id, pl.plot_name, pl.farmer_id FROM plot pl JOIN farmers f ON f.id = pl.farmer_id
        JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ? AND pl.plot_name LIKE ?`, [ENTITY_SNBS, name]);
      if (p) plots[land] = p;
    }

    // ── item names: learn the first import's mapping from the lines both have
    const dbOut = await q(`SELECT d.id, d.date, d.plot_id, d.quantity, d.sapropdi_id, d.price_per_unit FROM pre_finance_distributions d
      WHERE d.warehouse_id = ? AND d.stock_out_id IS NOT NULL ORDER BY d.date, d.id`, [WH_SJ]);
    const items = await q('SELECT id, sapropdi_name, unit_id FROM sapropdi');
    const plotIdOf = (dest) => plots[dest]?.id;
    const learned = {}; const votes = {};
    const byKey = new Map();
    for (const d of dbOut) { const k = `${d.date}|${d.plot_id}|${q2(d.quantity)}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(d); }
    const outs = book.card.filter((r) => r.outQ > 0);
    for (const r of outs) {
      const list = byKey.get(`${r.date}|${plotIdOf(r.dest)}|${q2(r.outQ)}`);
      if (list && list.length === 1) { const k = key(r.item); votes[k] = votes[k] || {}; votes[k][list[0].sapropdi_id] = (votes[k][list[0].sapropdi_id] || 0) + 1; }
    }
    for (const [k, v] of Object.entries(votes)) learned[k] = Number(Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]);
    const itemOf = (name) => learned[key(name)] ?? items.find((s) => key(s.sapropdi_name) === key(name))?.id
      ?? items.find((s) => key(s.sapropdi_name).startsWith(key(name)) || key(name).startsWith(key(s.sapropdi_name)))?.id;
    const lastPrice = {};
    for (const d of dbOut) if (Number(d.price_per_unit) > 0) lastPrice[d.sapropdi_id] = Number(d.price_per_unit);
    const priceOn = (name, date, sid) => book.purchases.find((p) => key(p.item) === key(name) && p.date === date)?.price
      ?? [...book.purchases].reverse().find((p) => key(p.item) === key(name) && p.date <= date)?.price ?? lastPrice[sid] ?? null;
    const unmapped = {};

    // ── B. stock in
    log('\nB) Barang masuk (stock card → Stock In Sumber Jaya)');
    const doneIn = new Set((await q("SELECT remarks FROM stock_in_items WHERE remarks LIKE 'Stock card baris %'")).map((r) => Number(r.remarks.match(/\d+/)[0])));
    const ins = book.card.filter((r) => r.inQ > 0 && !doneIn.has(r.row));
    const [[lastIn]] = await c.query("SELECT COALESCE(MAX(CAST(SUBSTRING(stock_in_number, 10) AS UNSIGNED)), 0) n FROM stock_in WHERE stock_in_number LIKE 'SIH-SNBS-%'");
    let nIn = Number(lastIn.n), inLines = 0, inValue = 0;
    for (const date of [...new Set(ins.map((r) => r.date))].sort()) {
      const day = ins.filter((r) => r.date === date);
      const lines = day.map((r) => ({ r, sid: itemOf(r.item) })).filter((x) => { if (!x.sid) unmapped[x.r.item] = (unmapped[x.r.item] || 0) + 1; return x.sid; });
      if (!lines.length) continue;
      const number = `SIH-SNBS-${String(++nIn).padStart(4, '0')}`;
      const [si] = await c.query(`INSERT INTO stock_in (stock_in_number, stock_in_date, warehouse_id, status, notes, created_at, updated_at)
        VALUES (?,?,?, 'Posted', ?, NOW(), NOW())`, [number, date, WH_SJ,
        `Impor Stock card SNBS Cavendish (barang masuk) — ${[...new Set(lines.map((x) => x.r.dest))].join(', ')}`]);
      for (const { r, sid } of lines) {
        const price = priceOn(r.item, date, sid);
        await c.query(`INSERT INTO stock_in_items (stock_in_id, sapropdi_id, received_qty, unit_price, item_condition, remarks)
          VALUES (?,?,?,?, 'Good', ?)`, [si.insertId, sid, r.inQ, price, `Stock card baris ${r.row} · ${r.item} ${r.inQ} ${r.unit} → ${r.dest}${r.note ? ` · ${r.note}` : ''}`]);
        inLines++; inValue += (price || 0) * r.inQ;
      }
    }
    log(`   ${inLines} baris dalam ${nIn - Number(lastIn.n)} penerimaan · nilai tercatat ${rp(inValue)}`);

    // ── C. stock out not in the system yet
    log('\nC) Barang keluar yang belum ada');
    const remaining = new Map(); for (const [k, v] of byKey) remaining.set(k, [...v]);
    let newOut = []; const notPlot = [];
    for (const r of outs) {
      const pid = plotIdOf(r.dest);
      if (!pid) { notPlot.push(r); continue; }
      const k = `${r.date}|${pid}|${q2(r.outQ)}`;
      if (remaining.get(k)?.length) { remaining.get(k).shift(); continue; }
      newOut.push(r);
    }
    // A line of the first import the card no longer has as it was — the card was
    // corrected afterwards (another quantity or day). The same plot and item
    // within a week on the card is that correction: the line is updated to it
    // instead of a second line being added beside it.
    const psPlotIds = new Set(Object.values(plots).map((p) => p.id));
    let corrected = 0;
    for (const d of [...remaining.values()].flat().filter((x) => psPlotIds.has(x.plot_id))) {
      const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
      const r = newOut.find((x) => plotIdOf(x.dest) === d.plot_id && itemOf(x.item) === d.sapropdi_id && days(x.date, d.date) <= 7);
      if (!r) continue;
      await c.query('UPDATE pre_finance_distributions SET date = ?, quantity = ?, total_amount = ROUND(? * price_per_unit, 2), updated_at = NOW() WHERE id = ?',
        [r.date, r.outQ, r.outQ, d.id]);
      log(`   ~ baris #${d.id} ${d.date} ${Number(d.quantity)} → ${r.date} ${r.outQ} (${r.item}, dikoreksi di stock card)`);
      newOut = newOut.filter((x) => x !== r);
      remaining.set(`${d.date}|${d.plot_id}|${q2(d.quantity)}`, remaining.get(`${d.date}|${d.plot_id}|${q2(d.quantity)}`).filter((x) => x !== d));
      corrected++;
    }
    // What is left of the first import's last weeks (from July 2026, when the card
    // was still being written) and is no longer on the card was taken off it: the
    // line goes too. Older lines are only reported.
    for (const [k, list] of remaining) {
      for (const d of list.filter((x) => psPlotIds.has(x.plot_id) && x.date >= '2026-07-01')) {
        await c.query('DELETE FROM pre_finance_distributions WHERE id = ?', [d.id]);
        log(`   - baris #${d.id} ${d.date} ${Number(d.quantity)} dihapus (sudah tidak ada di stock card)`);
        remaining.set(k, remaining.get(k).filter((x) => x !== d));
      }
    }
    const pool = new Map([...remaining].map(([k, v]) => [k, v.length]));
    const [[lastOut]] = await c.query("SELECT COALESCE(MAX(CAST(SUBSTRING(stock_out_number, 10) AS UNSIGNED)), 0) n FROM stock_out WHERE stock_out_number LIKE 'SOH-SNBS-%'");
    let nOut = Number(lastOut.n), outLines = 0, outValue = 0;
    const byMonth = {};
    for (const date of [...new Set(newOut.map((r) => r.date))].sort()) {
      const lines = newOut.filter((r) => r.date === date).map((r) => ({ r, sid: itemOf(r.item) }))
        .filter((x) => { if (!x.sid) unmapped[x.r.item] = (unmapped[x.r.item] || 0) + 1; return x.sid; });
      if (!lines.length) continue;
      const number = `SOH-SNBS-${String(++nOut).padStart(4, '0')}`;
      const [so] = await c.query(`INSERT INTO stock_out (stock_out_number, stock_out_date, warehouse_id, notes, created_at, updated_at)
        VALUES (?,?,?, ?, NOW(), NOW())`, [number, date, WH_SJ, 'Dibuat otomatis dari Stock card SNBS Cavendish. Dikelompokkan per gudang dan tanggal.']);
      for (const { r, sid } of lines) {
        const p = plots[r.dest];
        const it = items.find((s) => s.id === sid);
        const price = priceOn(r.item, date, sid);
        await c.query(`INSERT INTO pre_finance_distributions (pre_finance_type_id, date, farmer_id, plot_id, commodities_id, sapropdi_id, warehouse_id,
            stock_out_id, quantity, unit_id, price_per_unit, total_amount, counts_as_debt, scheme, description, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,'ProfitSharing',?,NOW(),NOW())`,
          [saprodiType.id, date, p.farmer_id, p.id, banana.id, sid, WH_SJ, so.insertId, r.outQ, it.unit_id, price ?? 0,
           Math.round(r.outQ * (price ?? 0) * 100) / 100, `Saprodi SNBS - ${r.item}${price == null ? ' (harga belum ada)' : ''}`]);
        outLines++; outValue += r.outQ * (price ?? 0);
        byMonth[date.slice(0, 7)] = (byMonth[date.slice(0, 7)] || 0) + 1;
      }
    }
    log(`   ${outLines} baris dalam ${nOut - Number(lastOut.n)} dokumen barang keluar · ${rp(outValue)} · per bulan ${JSON.stringify(byMonth)}`);
    const leftover = [...pool.entries()].filter(([, n]) => n > 0).reduce((s, [, n]) => s + n, 0);
    if (leftover) log(`   ! ${leftover} baris barang keluar di sistem tidak ditemukan di stock card (dibiarkan)`);
    if (notPlot.length) {
      log(`   · tidak ke plot (tidak ditulis): ${notPlot.length}`);
      notPlot.forEach((r) => log(`     - ${r.date} ${r.item} ${r.outQ} ${r.unit} → ${r.dest}${r.note ? ` (${r.note})` : ''}`));
    }
    if (Object.keys(unmapped).length) log(`   ! nama barang tanpa padanan master (dilewati): ${JSON.stringify(unmapped)}`);

    // ── D. re-base the applied opnames of Sumber Jaya
    log('\nD) Opname Sumber Jaya dihitung ulang');
    const opnames = await q("SELECT id, opname_number, opname_date FROM stock_opname WHERE warehouse_id = ? AND applied_at IS NOT NULL ORDER BY opname_date, id", [WH_SJ]);
    for (const o of opnames) {
      const its = await q('SELECT id, sapropdi_id, system_qty, counted_qty, adjustment FROM stock_opname_items WHERE stock_opname_id = ?', [o.id]);
      let changed = 0;
      for (const it of its) {
        const [[s]] = await c.query(`SELECT
            (SELECT COALESCE(SUM(sii.received_qty),0) FROM stock_in si JOIN stock_in_items sii ON sii.stock_in_id = si.id
              WHERE si.warehouse_id = ? AND sii.sapropdi_id = ? AND si.stock_in_date <= ? AND COALESCE(si.status,'') <> 'Draft') AS inq,
            (SELECT COALESCE(SUM(d.quantity),0) FROM pre_finance_distributions d JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
              WHERE d.warehouse_id = ? AND d.sapropdi_id = ? AND d.date <= ? AND t.type_name = 'Saprodi') AS outq,
            (SELECT COALESCE(SUM(oi.adjustment),0) FROM stock_opname x JOIN stock_opname_items oi ON oi.stock_opname_id = x.id
              WHERE x.warehouse_id = ? AND oi.sapropdi_id = ? AND x.applied_at IS NOT NULL
                AND (x.opname_date < ? OR (x.opname_date = ? AND x.id < ?))) AS adj`,
          [WH_SJ, it.sapropdi_id, o.opname_date, WH_SJ, it.sapropdi_id, o.opname_date, WH_SJ, it.sapropdi_id, o.opname_date, o.opname_date, o.id]);
        const sys = q3(Number(s.inq) - Number(s.outq) + Number(s.adj));
        const adj = q3(Number(it.counted_qty) - sys);
        if (Math.abs(sys - Number(it.system_qty)) > 0.0005 || Math.abs(adj - Number(it.adjustment ?? 0)) > 0.0005) {
          await c.query('UPDATE stock_opname_items SET system_qty = ?, adjustment = ?, updated_at = NOW() WHERE id = ?', [sys, adj, it.id]);
          changed++;
        }
      }
      log(`   ${o.opname_number} (${o.opname_date}): ${changed} dari ${its.length} barang disesuaikan — stok sesudah opname tetap = hitungan fisik`);
    }

    if (process.env.DEBUG_SNBS) {
      const top = await q(`SELECT s.sapropdi_name, u.unit_name, SUM(sii.received_qty) qty, MAX(sii.unit_price) price,
          SUM(sii.received_qty * COALESCE(sii.unit_price, 0)) val
        FROM stock_in_items sii JOIN stock_in si ON si.id = sii.stock_in_id JOIN sapropdi s ON s.id = sii.sapropdi_id
        LEFT JOIN units u ON u.id = s.unit_id WHERE si.stock_in_number LIKE 'SIH-SNBS-%' GROUP BY s.id ORDER BY val DESC LIMIT 15`);
      top.forEach((t) => log('   $', t.sapropdi_name, t.unit_name, Number(t.qty), Number(t.price), rp(t.val)));
      newOut.filter((r) => r.date < '2026-07-20').forEach((r) => log('   new', r.row, r.date, r.item, r.outQ, r.dest));
      for (const [k, n] of pool) if (n > 0) log('   left', k, n);
    }
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
