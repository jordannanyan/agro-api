// -----------------------------------------------------------------------------
// Import: SNBS cocoa pre-finance loans and what has been paid back (2026-10)
//
// The cocoa farmers of KTH Sumber Jaya borrowed seedlings and inputs (MCC02,
// Fertiphos, Alika, Amistar Top, Kristalon, NPK, Bio Astral) and pay them back
// from their deliveries at a minimum of Rp 5.000/kg. None of it was in the
// system: the only SNBS distributions here are the Profit Sharing banana
// material, which deliberately does not count as debt.
//
// Sources
//   --ledger   Buku Besar - Sumber Jaya - Cocoa.xlsx
//              `SJ - Stakeholder Database`  F = Total Farmer Loan [21/05/2026]
//                                           G = repaid (SUMIF of the sheet below)
//              `Dried Bean - Data Entry`    M = Farmer Loan Repayment per row
//   --farmers  Sumber Jaya Farmers Data.xlsx
//              `Farmers Data (SAPRODI)`     the loan per material, per plot
//
// The ledger is the authority on amounts. The farmers file supplies the detail:
// one distribution per material with its date. Where the two totals differ (9
// farmers, Rp 3,7 jt net) one line `Penyesuaian ke Buku Besar` makes up the
// difference, so the debt here equals the ledger to the rupiah.
//
// Written
//   pre_finance_distributions  type Saprodi, counts_as_debt = 1, no warehouse
//     and no sapropdi_id: these goods never passed through a warehouse in this
//     system and must not move any stock card. Plot = the farmer's planted plot
//     (S0…/N0…), else the cocoa purchasing plot (SJ00…).
//   pre_finance_installments   each ledger repayment; tied to the purchasing row
//     with the same farmer, date and kilos when there is exactly one, otherwise a
//     cash repayment.
//
// Every row carries the tag below. A run that finds the tag already present
// changes nothing. Dry-run by default.
//
// Usage:
//   node scripts/importSnbsCocoaLoans2026-10.js --ledger <xlsx> --farmers <xlsx> [--verbose]
//   node scripts/importSnbsCocoaLoans2026-10.js --ledger <xlsx> --farmers <xlsx> --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const LEDGER = arg('--ledger');
const FARMERS = arg('--farmers');
const DB = process.env.DB_NAME || 'agro_supply';
const TAG = '[SNBS-KAKAO-2026-10]';
const SNAPSHOT = '2026-05-21';
const RATE_PER_KG = 5000;
const log = (...a) => console.log(...a);

if (!LEDGER || !FARMERS) {
  console.error('Usage: --ledger <Buku Besar Kakao .xlsx> --farmers <Sumber Jaya Farmers Data .xlsx> [--apply] [--verbose]');
  process.exit(2);
}

// Spelling differences between the two workbooks and the farmers table.
const ALIAS = {
  mansyurefendi: 'mansurefendi', sudariyanto: 'sudaryanto', nurkholis: 'nurcholis', amirmahmud: 'mamirmahmud',
  ahmadnururfauzi: 'ahmadnurulfauzi', tubi: 'kartubi', wawanekomaryadi: 'wawanekoyudimaryadi', supricaing: 'supricacing',
};
// `Paiman 2`, `Waris 3`: a second plot of the same farmer.
const key = (n) => { const k = String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, ''); return ALIAS[k] || k; };

// Material blocks of `Farmers Data (SAPRODI)` (0-based columns). Checked: the
// value columns add up to `Loan Total` on every one of the 50 rows.
const BLOCKS = [
  { item: 'Bibit kakao MCC02', value: 19, qty: 20, dates: [13, 17], unit: 'batang' },
  { item: 'Fertiphos', value: 31, qty: 32, dates: [25, 29], unit: 'kg' },
  { item: 'Alika 247ZC', value: 51, qty: 52, dates: [37, 41, 45, 49], unit: 'ml' },
  { item: 'Amistar Top', value: 75, qty: 76, dates: [57, 61, 65, 69, 73], unit: 'ml' },
  { item: 'Kristalon', value: 91, qty: 92, dates: [81, 85, 89], unit: 'g' },
  { item: 'NPK 16-16-16', value: 99, qty: 100, dates: [97], unit: 'kg' },
  { item: 'Bio Astral', value: 107, qty: 108, dates: [105], unit: 'botol' },
];

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
const round2 = (n) => Math.round(n * 100) / 100;
const rp = (n) => `Rp ${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function sheetRows(file, names) {
  const ExcelJS = require('exceljs');
  const out = {};
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    const name = ws.name;
    if (!names.includes(name)) { for await (const _ of ws) { /* skip */ } continue; }
    const rows = [];
    for await (const row of ws) {
      const vals = [];
      row.eachCell({ includeEmpty: true }, (c, col) => { vals[col - 1] = c.value; });
      rows[row.number - 1] = vals;
    }
    out[name] = rows;
  }
  for (const n of names) if (!out[n]) throw new Error(`Sheet "${n}" tidak ada`);
  return out;
}

async function readLedger() {
  const s = await sheetRows(LEDGER, ['SJ - Stakeholder Database', 'Dried Bean - Data Entry']);
  const loans = new Map();
  for (const r of s['SJ - Stakeholder Database'].slice(1)) {
    if (!r || !norm(cv(r[1]))) continue;
    const loan = num(r[5]);
    if (!loan) continue;
    loans.set(key(cv(r[1])), { name: norm(cv(r[1])), loan, repaid: num(r[6]) });
  }
  const entry = s['Dried Bean - Data Entry'];
  const h = (entry[0] || []).map((c) => norm(cv(c)));
  const col = (label) => { const i = h.indexOf(label); if (i < 0) throw new Error(`Kolom "${label}" tidak ada di Dried Bean - Data Entry`); return i; };
  const C = {
    date: col('Date'), name: col('Supplier/Offtaker Name'), receipt: col('Receipt/Invoice'), vol: col('Volume'),
    rep: col('Farmer Loan Repayment'), repReceipt: col('Loan Repayment Receipt'),
  };
  const repayments = [];
  for (const r of entry.slice(1)) {
    if (!r) continue;
    const amount = num(r[C.rep]);
    if (!amount) continue;
    repayments.push({
      name: norm(cv(r[C.name])), key: key(cv(r[C.name])), date: ymd(r[C.date]), volume: num(r[C.vol]), amount,
      reference: norm(cv(r[C.repReceipt])) || norm(cv(r[C.receipt])) || null,
    });
  }
  return { loans, repayments };
}

async function readFarmers() {
  const s = await sheetRows(FARMERS, ['Farmers Data (SAPRODI)']);
  const lines = new Map();
  for (const r of s['Farmers Data (SAPRODI)'].slice(4)) {
    if (!r || typeof cv(r[0]) !== 'number' || !norm(cv(r[2]))) continue;
    const part = norm(cv(r[2]));
    const k = key(part);
    let total = 0;
    for (const b of BLOCKS) {
      const value = num(r[b.value]);
      total += value;
      if (!value) continue;
      const date = b.dates.map((d) => ymd(r[d])).find(Boolean) || null;
      const qty = num(r[b.qty]);
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k).push({ part, item: b.item, unit: b.unit, qty, value, date });
    }
    if (Math.abs(total - num(r[8])) > 1) throw new Error(`${part}: material ${total} ≠ Loan Total ${num(r[8])} — tata letak kolom berubah?`);
  }
  return lines;
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const [{ loans, repayments }, fdLines] = await Promise.all([readLedger(), readFarmers()]);
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  try {
    const [[already]] = await c.query(
      `SELECT (SELECT COUNT(*) FROM pre_finance_distributions WHERE description LIKE ?)
            + (SELECT COUNT(*) FROM pre_finance_installments WHERE notes LIKE ?) AS n`, [`%${TAG}%`, `%${TAG}%`]);
    if (already.n > 0) { log(`= sudah diimpor (${already.n} baris bertanda ${TAG}) — tidak ada perubahan`); return; }

    const [[saprodi]] = await c.query("SELECT id FROM pre_finance_types WHERE type_name = 'Saprodi'");
    const [[cocoa]] = await c.query("SELECT id FROM commodities WHERE commodities_name LIKE 'Cocoa%' LIMIT 1");
    const [farmers] = await c.query(
      `SELECT f.id, f.farmer_name FROM farmers f JOIN kth k ON k.id = f.kth_id JOIN entities e ON e.id = k.entities_id
       WHERE e.entities_name LIKE '%SNBS%'`);
    const byKey = new Map();
    for (const f of farmers) { const k = key(f.farmer_name); byKey.set(k, [...(byKey.get(k) || []), f]); }
    const [plots] = await c.query(
      `SELECT pl.id, pl.plot_name, pl.farmer_id, pl.scheme FROM plot pl WHERE pl.farmer_id IN (?) ORDER BY pl.id`,
      [farmers.map((f) => f.id)]);

    // ---- debt -------------------------------------------------------------
    const problems = [];
    const plan = [];
    const planted = (f) => plots.some((p) => p.farmer_id === f.id && p.scheme === 'PreFinance' && /^(S0|N0)/i.test(p.plot_name));
    const duplicates = [];
    for (const [k, L] of loans) {
      let hits = byKey.get(k) || [];
      // The same person entered twice (`wawan eko (maryadi)` beside `Wawan Eko
      // Yudi (Maryadi)`): the record holding the planted plot is the farmer.
      if (hits.length > 1 && hits.filter(planted).length === 1) {
        duplicates.push(`${L.name}: dipakai #${hits.find(planted).id}, duplikat ${hits.filter((f) => !planted(f)).map((f) => `#${f.id} "${f.farmer_name}"`).join(', ')}`);
        hits = hits.filter(planted);
      }
      if (hits.length !== 1) { problems.push(`${L.name}: ${hits.length} petani SNBS dengan nama ini`); continue; }
      const farmer = hits[0];
      const pf = plots.filter((p) => p.farmer_id === farmer.id && p.scheme === 'PreFinance');
      const plot = pf.find((p) => /^(S0|N0)/i.test(p.plot_name)) || pf.find((p) => /^(SJ00|NO1)/i.test(p.plot_name)) || pf[0];
      if (!plot) { problems.push(`${L.name}: tidak punya plot Pre-Finance`); continue; }
      const lines = (fdLines.get(k) || []).map((l) => ({ ...l }));
      const detail = round2(lines.reduce((s, l) => s + l.value, 0));
      const adjust = round2(L.loan - detail);
      plan.push({ farmer, plot, ledger: L, lines, detail, adjust });
    }
    const skipped = [...fdLines.keys()].filter((k) => !loans.has(k));
    if (problems.length) { problems.forEach((p) => log('!', p)); throw new Error('Pencocokan petani gagal — tidak ada yang ditulis'); }

    // ---- repayments -------------------------------------------------------
    const farmerOf = new Map(plan.map((p) => [key(p.ledger.name), p.farmer]));
    const [purch] = await c.query(
      `SELECT p.id, p.date, p.quantity, pl.farmer_id, (i.id IS NOT NULL) AS has_cut
       FROM purchasing p JOIN plot pl ON pl.id = p.plot_id
       LEFT JOIN pre_finance_installments i ON i.purchasing_id = p.id
       WHERE pl.farmer_id IN (?)`, [plan.map((p) => p.farmer.id)]);
    const used = new Set();
    const repPlan = [];
    for (const r of repayments) {
      const farmer = farmerOf.get(r.key);
      if (!farmer) { problems.push(`potongan ${r.date} ${r.name} ${rp(r.amount)}: petani tidak ada di daftar pinjaman`); continue; }
      const cand = r.volume > 0 ? purch.filter((p) => p.farmer_id === farmer.id && String(p.date).slice(0, 10) === r.date
        && Math.abs(Number(p.quantity) - r.volume) < 0.05 && !p.has_cut && !used.has(p.id)) : [];
      const p = cand.length === 1 ? cand[0] : null;
      if (p) used.add(p.id);
      repPlan.push({ ...r, farmer, purchasing: p, ambiguous: cand.length > 1 });
    }
    if (problems.length) { problems.forEach((p) => log('!', p)); throw new Error('Pencocokan potongan gagal — tidak ada yang ditulis'); }

    // ---- report -----------------------------------------------------------
    let tLoan = 0; let tDetail = 0; let tAdj = 0; let tPaid = 0;
    log('\nPetani                       Buku Besar     Rincian   Penyesuaian   Dibayar        Sisa   Plot');
    for (const p of plan.sort((a, b) => a.ledger.name.localeCompare(b.ledger.name))) {
      const paid = round2(repPlan.filter((r) => r.farmer.id === p.farmer.id).reduce((s, r) => s + r.amount, 0));
      tLoan += p.ledger.loan; tDetail += p.detail; tAdj += p.adjust; tPaid += paid;
      const warn = Math.abs(paid - p.ledger.repaid) > 1 ? `  (buku besar: dibayar ${rp(p.ledger.repaid)})` : '';
      log(`${p.ledger.name.padEnd(26).slice(0, 26)} ${rp(p.ledger.loan).padStart(13)} ${rp(p.detail).padStart(11)} ${rp(p.adjust).padStart(13)} ${rp(paid).padStart(9)} ${rp(p.ledger.loan - paid).padStart(11)}   ${p.plot.plot_name}${warn}`);
      if (VERBOSE) p.lines.forEach((l) => log(`      ${l.date || SNAPSHOT}  ${l.item} ${l.qty} ${l.unit}  ${rp(l.value)}  (${l.part})`));
    }
    log(`${'TOTAL'.padEnd(26)} ${rp(tLoan).padStart(13)} ${rp(tDetail).padStart(11)} ${rp(tAdj).padStart(13)} ${rp(tPaid).padStart(9)} ${rp(tLoan - tPaid).padStart(11)}`);
    const linked = repPlan.filter((r) => r.purchasing);
    log(`\nPotongan: ${repPlan.length} baris ${rp(tPaid)} — ${linked.length} ditautkan ke setoran, ${repPlan.length - linked.length} sebagai pembayaran tunai`
      + (repPlan.some((r) => r.ambiguous) ? ` (${repPlan.filter((r) => r.ambiguous).length} cocok ke >1 setoran → tunai)` : ''));
    if (VERBOSE) repPlan.forEach((r) => log(`      ${r.date} ${r.name.padEnd(22)} ${String(r.volume).padStart(6)} kg ${rp(r.amount).padStart(12)}  ${r.purchasing ? `→ purchasing #${r.purchasing.id}` : 'tunai'}`));
    if (skipped.length) log(`Dilewati (tidak ada di buku besar): ${skipped.map((k) => fdLines.get(k)[0].part).join(', ')}`);
    duplicates.forEach((d) => log(`Petani ganda — ${d}`));
    const distRows = plan.reduce((s, p) => s + p.lines.length + (Math.abs(p.adjust) > 0.5 ? 1 : 0), 0);
    log(`Akan ditulis: ${distRows} distribusi untuk ${plan.length} petani, ${repPlan.length} cicilan`);

    if (!APPLY) { log('\ndry-run only; re-run with --apply'); return; }

    // ---- write ------------------------------------------------------------
    await c.beginTransaction();
    const ins = (p, date, item, qty, unit, value, extra) => c.query(
      `INSERT INTO pre_finance_distributions
         (pre_finance_type_id, date, farmer_id, plot_id, commodities_id, sapropdi_id, warehouse_id, stock_out_id,
          quantity, price_per_unit, total_amount, counts_as_debt, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, 1, ?, NOW(), NOW())`,
      [saprodi.id, date, p.farmer.id, p.plot.id, cocoa?.id ?? null, qty || null,
       qty ? round2(value / qty) : null, value, `Pinjaman kakao SNBS · ${item}${qty ? ` ${qty} ${unit}` : ''}${extra} ${TAG}`]);
    for (const p of plan) {
      for (const l of p.lines) await ins(p, l.date || SNAPSHOT, l.item, l.qty, l.unit, l.value, ` · ${l.part} (Sumber Jaya Farmers Data)`);
      if (Math.abs(p.adjust) > 0.5) {
        await ins(p, SNAPSHOT, 'Penyesuaian ke Buku Besar', 0, '', p.adjust,
          ` · Total Farmer Loan [21/05/2026] ${rp(p.ledger.loan)} − rincian ${rp(p.detail)}`);
      }
    }
    for (const r of repPlan) {
      const manual = r.purchasing && Math.abs(r.amount - Number(r.purchasing.quantity) * RATE_PER_KG) > 0.5;
      const [res] = await c.query(
        `INSERT INTO pre_finance_installments
           (purchasing_id, farmer_id, date, reference_no, total_payment, notes, is_manual, manual_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [r.purchasing?.id ?? null, r.farmer.id, r.date, r.reference, r.amount,
         `${r.purchasing ? 'Potongan setoran' : 'Pembayaran tunai'} — Buku Besar Kakao ${TAG}`,
         manual ? 1 : 0, manual ? 'Impor Buku Besar Kakao: jumlah sesuai catatan lapangan' : null]);
      await c.query('INSERT INTO pre_finance_installment_details (installment_id, pre_finance_type_id, amount) VALUES (?,?,?)',
        [res.insertId, saprodi.id, r.amount]);
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
