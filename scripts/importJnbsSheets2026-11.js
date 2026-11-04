// -----------------------------------------------------------------------------
// Import: JNBS profit-sharing saprodi, labour and stock receipts (2026-11)
//
// `JNBS Database.xlsx` (copy of 2026-11-05), three sheets:
//
//   ADM_Entry Bagi Hasil Panen   saprodi handed out on the five profit-sharing
//                                plots → pre_finance_distributions, scheme
//                                ProfitSharing (cost of the season, not debt)
//   ADM_Entry Hutang Tenaga Kerja labour → pre_finance_distributions type Labor.
//                                Pre-Finance debt for every farmer, EXCEPT the
//                                five plots of Mustari, Eko Irawan and Yudis from
//                                28 Aug 2025 on, which is profit-sharing cost.
//   ADM_Entry Stok Barang        goods received at the KTH AML warehouse →
//                                stock_in + stock_in_items (Posted)
//
// The sheets are the source. The 2026-08 import took an older copy; since then
// the field team re-numbered and re-dated the Bagi Hasil sheet and added rows to
// all three. So each section is a sync, not an append:
//   · Bagi Hasil — rows still in the sheet are kept (date / amount / number
//     corrected where the sheet now says otherwise); rows the sheet no longer
//     has are removed; new rows are added, each on the reconstructed Stock Out
//     header of its (warehouse, date) like every other historical issue.
//   · Labour — matched on (plot, start date, amount); new rows added, a row the
//     sheet does not have (a duplicate) removed.
//   · Stock — one receipt per sheet row, numbered SIH-JNBS-<Stock ID>; items not
//     yet in the master are created.
//
// Receipts dated before the 29 Sep 2026 opname change what the system thought
// was on the shelf that day. That opname is applied, so its adjustment is
// re-derived — counted − (in − out up to that day) — and the shelf stays at what
// was counted. The 28 Oct opname (not yet approved) gets its system quantity
// refreshed the same way.
//
// Requires migrateDistributionScheme2026-11.js. Idempotent. Dry-run by default.
//
// Usage:
//   node scripts/importJnbsSheets2026-11.js --file "<JNBS Database.xlsx>" [--verbose]
//   node scripts/importJnbsSheets2026-11.js --file "<JNBS Database.xlsx>" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const ENTITY_JNBS = 3;
const SWITCHED = ['SM003002', 'SM019003', 'GK006001', 'GK006002', 'GW006003'];
const PS_FROM = '2025-08-29';   // first profit-sharing day; 28 Aug was still bought and deducted (see migratePurchasingScheme2026-11.js)
const SHEET_BH = 'ADM_Entry Bagi Hasil Panen';
const SHEET_TK = 'ADM_Entry Hutang Tenaga Kerja';
const SHEET_ST = 'ADM_Entry Stok Barang';
const SIH = 'SIH-JNBS-';
const NOTE_SO = 'Dibuat otomatis dari impor sheet ADM_Entry Bagi Hasil Panen (JNBS Database.xlsx). '
  + 'Pengelompokan berdasarkan gudang + tanggal, bukan dokumen asli.';
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <JNBS Database.xlsx> [--apply] [--verbose]'); process.exit(2); }

// Sheet item names that are not spelled like the master. Everything else is
// matched on the exact name, or on what the existing lines of that name use.
const ALIAS = {
  PERTALITE: 'Gasoline (pertalite)',
  BIOASTRAL: 'BIO ASTRAL',
  BYCLEAN: 'BAYCLIN',
  'JARUM SUNTIK JANTUNG PISANG': 'JARUM SUNTIK PISANG',
  'SPRAYER MESIN': 'MACHINE SPRAYER',
};
// Items the master does not have yet: category for the new row.
const NEW_CATEGORY = {
  'BIBIT GMELINA': 'Seedlings',
  'BATERAI TIMBANGAN PISANG': 'Equipment', 'GARBU KEBUN': 'Equipment', 'KIPAS ANGIN INDUSTRI': 'Equipment',
  'SELANG TANKI SWAN': 'Equipment', 'SPRAYER ELECTRIK': 'Equipment', 'SPRINKLER PUTAR': 'Equipment',
  'JARING TANAMAN': 'Equipment', 'KERANJANG INDUSTRY': 'Equipment',
};
const UNIT_ALIAS = { kilogram: 'kg', liter: 'L', batang: 'btg', truk: null };
// Bagi Hasil lines with an empty Date cell, and the date they were given.
const UNDATED = {
  // Mustari, GK006002, 100 bambu. BAST "Mustari Bawah Jalan - October 2025"; the
  // next number (345, bambu for GK006001) is the October BAST, dated 1 Nov 2025.
  344: { date: '2025-11-01', why: 'diambil dari no. 345 (BAST Oktober 2025 yang sama)' },
};
const TAG_UNNUMBERED = '[JNBS-PINJAMAN-2026-11]';

function cv(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
  }
  return v;
}
const num = (v) => { const x = cv(v); if (typeof x === 'number' && isFinite(x)) return x; const n = Number(String(x ?? '').replace(/[^\d.-]/g, '')); return x != null && String(x).trim() !== '' && isFinite(n) ? n : 0; };
const ymd = (v) => { const x = cv(v); return x instanceof Date && !isNaN(x) ? x.toISOString().slice(0, 10) : null; };
const norm = (s) => String(cv(s) ?? '').replace(/\s+/g, ' ').trim();
const up = (s) => norm(s).toUpperCase();
const noStr = (v) => { const x = cv(v); return typeof x === 'number' ? String(Math.trunc(x)) : norm(x); };

async function readSheets() {
  const ExcelJS = require('exceljs');
  const want = new Set([SHEET_BH, SHEET_TK, SHEET_ST]);
  const out = {};
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (!want.has(ws.name)) { for await (const _ of ws) { /* skip */ } continue; }
    let header = null; const rows = [];
    for await (const row of ws) {
      const v = []; row.eachCell({ includeEmpty: true }, (c, col) => { v[col - 1] = c.value; });
      if (!header) { header = v.map(norm); continue; }
      rows.push({ n: row.number, v });
    }
    out[ws.name] = { header, rows };
  }
  for (const s of want) if (!out[s]) throw new Error(`Sheet "${s}" tidak ada`);
  const col = (s, label) => {
    const i = out[s].header.indexOf(label);
    if (i < 0) throw new Error(`${s}: kolom "${label}" tidak ada`);
    return i;
  };

  const B = out[SHEET_BH]; const cb = (l) => col(SHEET_BH, l);
  const bC = { date: cb('Date'), no: cb('Loan In Kind Number (No. Pinjaman)'), plot: cb('Plot ID (ID Lahan)'),
    item: cb('Production Input (Saprodi)'), price: cb('Price per unit (Harga Saprodi per satuan)'), qty: cb('Amount (Jumlah)'),
    unit: cb('Unit (Satuan)'), total: cb('Total Price (Total Harga)'), com: cb('Type of Commodity (Jenis Komoditi)'), link: cb('Link BAST') };
  const bh = B.rows.map(({ n, v }) => ({ row: n, date: ymd(v[bC.date]), no: noStr(v[bC.no]), plot: norm(v[bC.plot]), item: norm(v[bC.item]),
    price: num(v[bC.price]), qty: num(v[bC.qty]), unit: norm(v[bC.unit]), total: num(v[bC.total]), commodity: norm(v[bC.com]), link: norm(v[bC.link]) }))
    .filter((r) => r.plot || r.item);

  const T = out[SHEET_TK]; const ct = (l) => col(SHEET_TK, l);
  const tC = { start: ct('Starting Date'), end: ct('End Date'), plot: ct('Plot ID (ID Lahan)'), com: ct('Type of Commodity (Jenis Komoditi)'),
    n: ct('Number of Labourer ( Jumlah Tenaga Kerja)'), fee: ct('Biaya Tenaga Kerja per orang (Labour Fee per person)'),
    total: ct('Total Labour Fee (Total Biaya Tenaga Kerja)'), link: ct('Link'), farmer: ct("Farmer's Name (Nama Petani)") };
  const tk = T.rows.map(({ n, v }) => ({ row: n, start: ymd(v[tC.start]), end: ymd(v[tC.end]), plot: norm(v[tC.plot]), farmer: norm(v[tC.farmer]),
    commodity: norm(v[tC.com]), workers: num(v[tC.n]), fee: num(v[tC.fee]), total: num(v[tC.total]), link: norm(v[tC.link]) }))
    .filter((r) => r.plot && r.farmer);

  const K = out[SHEET_ST]; const ck = (l) => col(SHEET_ST, l);
  const kC = { date: ck('Date'), id: ck('Stock ID (ID Stock)'), item: ck('Production Input (Saprodi)'), price: ck('Price per Unit (Harga Satuan)'),
    qty: ck('Amount (Jumlah)'), unit: ck('Unit (Satuan)'), total: ck('Total Price (Total Harga)'), link: ck('Link Nota'),
    permit: ck('Permit name (Nama Permit)'), notes: ck('Notes') };
  const st = K.rows.map(({ n, v }) => ({ row: n, date: ymd(v[kC.date]), stockId: noStr(v[kC.id]), item: norm(v[kC.item]), price: num(v[kC.price]),
    qty: num(v[kC.qty]), unit: norm(v[kC.unit]), total: num(v[kC.total]), link: norm(v[kC.link]), permit: norm(v[kC.permit]), notes: norm(v[kC.notes]) }))
    .filter((r) => r.date && r.item);
  return { bh, tk, st };
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const { bh, tk, st } = await readSheets();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    const [hasScheme] = await q(`SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = 'pre_finance_distributions' AND COLUMN_NAME = 'scheme'`, [DB]);
    if (!Number(hasScheme.n)) throw new Error('Jalankan dulu scripts/migrateDistributionScheme2026-11.js --apply');

    // ---------------------------------------------------------------- masters
    const [wh] = await q("SELECT id FROM warehouse WHERE warehouse_name = 'KTH AML'");
    if (!wh) throw new Error('Gudang KTH AML tidak ada');
    const types = Object.fromEntries((await q('SELECT id, type_name FROM pre_finance_types')).map((t) => [t.type_name, t.id]));
    const plots = await q(`SELECT pl.id, pl.plot_name, pl.farmer_id, pl.scheme FROM plot pl
      JOIN farmers f ON f.id = pl.farmer_id JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ?`, [ENTITY_JNBS]);
    const plotBy = new Map(plots.map((p) => [p.plot_name, p]));
    const coms = await q('SELECT id, commodities_name FROM commodities');
    const comId = (name) => (coms.find((x) => x.commodities_name.toLowerCase() === String(name).toLowerCase())
      || coms.find((x) => x.commodities_name.split(' ')[0].toLowerCase() === String(name).split(' ')[0].toLowerCase()))?.id ?? null;
    const units = await q('SELECT id, unit_name, symbol FROM units');
    const unitId = (u) => {
      const k = String(u || '').toLowerCase(); const a = k in UNIT_ALIAS ? UNIT_ALIAS[k] : k;
      if (!a) return null;
      return units.find((x) => x.symbol.toLowerCase() === a.toLowerCase() || x.unit_name.toLowerCase() === a.toLowerCase())?.id ?? null;
    };
    let saps = await q('SELECT id, sapropdi_name, unit_id, unit FROM sapropdi');
    // What the lines already in the system call each item — the stock has to net
    // against the same master row the loans were booked on.
    const used = await q(`SELECT d.description, d.sapropdi_id FROM pre_finance_distributions d
      JOIN warehouse w ON w.id = d.warehouse_id WHERE w.id = ? AND d.sapropdi_id IS NOT NULL`, [wh.id]);
    const usedBy = new Map();
    for (const u of used) {
      const m = u.description && u.description.match(/^(?:Pinjaman saprodi no\. \S+|Saprodi lahan bagi hasil no\. \S+) - (.+)$/);
      if (!m) continue;
      const k = up(m[1]); const cnt = usedBy.get(k) || new Map();
      cnt.set(u.sapropdi_id, (cnt.get(u.sapropdi_id) || 0) + 1); usedBy.set(k, cnt);
    }
    const sapOf = (name) => {
      const k = up(name);
      const cnt = usedBy.get(k);
      if (cnt) return [...cnt].sort((a, b) => b[1] - a[1])[0][0];
      const target = up(ALIAS[k] || name);
      return saps.find((s) => up(s.sapropdi_name) === target)?.id ?? null;
    };

    // ======================================================== 1. BAGI HASIL
    log(`\n── 1. ${SHEET_BH}`);
    const dated = bh.map((r) => {
      if (r.date) return r;
      const fix = UNDATED[r.no];
      if (!fix) throw new Error(`Bagi Hasil baris ${r.row} no. ${r.no}: tanggal kosong`);
      return { ...r, date: fix.date, dateNote: ` · tanggal kosong di sheet, ${fix.why}` };
    });
    const bad = dated.filter((r) => !plotBy.has(r.plot) || !(r.total > 0));
    if (bad.length) { bad.forEach((r) => log(`  ! baris ${r.row}: ${r.plot} ${rp(r.total)}`)); throw new Error('Baris Bagi Hasil tidak bisa dipetakan'); }
    const existing = await q(`SELECT d.id, d.date, d.quantity, d.price_per_unit, d.total_amount, d.description, d.stock_out_id,
        d.sapropdi_id, d.warehouse_id, d.scheme, p.plot_name
      FROM pre_finance_distributions d JOIN plot p ON p.id = d.plot_id
      WHERE d.description LIKE 'Saprodi lahan bagi hasil no.%' AND p.plot_name IN (?)`, [SWITCHED]);
    const itemOf = (desc) => up(desc.replace(/^Saprodi lahan bagi hasil no\. \S+ - /, '').replace(/ · .*$/, ''));
    const descOf = (r) => `Saprodi lahan bagi hasil no. ${r.no} - ${r.item}${r.dateNote || ''}`;
    const pool = existing.slice();
    const take = (pred) => { const i = pool.findIndex(pred); return i < 0 ? null : pool.splice(i, 1)[0]; };
    const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) < tol;
    const keep = []; const fix = []; const add = [];
    const rest = [];
    for (const r of dated) {
      const hit = take((x) => x.date === r.date && x.plot_name === r.plot && itemOf(x.description) === up(r.item) && near(x.total_amount, r.total));
      if (hit) { (hit.description !== descOf(r) || !near(hit.quantity, r.qty, 0.001) ? fix : keep).push({ r, x: hit }); } else rest.push(r);
    }
    for (const r of rest) {
      // Same line, re-dated in the sheet; or same day, amount corrected.
      const hit = take((x) => x.plot_name === r.plot && itemOf(x.description) === up(r.item) && near(x.total_amount, r.total))
        || take((x) => x.date === r.date && x.plot_name === r.plot && itemOf(x.description) === up(r.item));
      if (hit) fix.push({ r, x: hit }); else add.push(r);
    }
    const drop = pool;
    const stockedIn = new Set((await q(`SELECT DISTINCT sii.sapropdi_id FROM stock_in si JOIN stock_in_items sii ON sii.stock_in_id = si.id
      WHERE si.warehouse_id = ?`, [wh.id])).map((x) => x.sapropdi_id));
    const sheetStocked = new Set(st.map((r) => up(r.item)));
    const sum = (a, f) => a.reduce((s, x) => s + Number(f(x) || 0), 0);
    log(`  sheet ${dated.length} baris ${rp(sum(dated, (r) => r.total))} · sistem ${existing.length} baris ${rp(sum(existing, (x) => x.total_amount))}`);
    log(`  tetap ${keep.length} · dikoreksi ${fix.length} · baru ${add.length} (${rp(sum(add, (r) => r.total))}) · dihapus (tak ada lagi di sheet) ${drop.length} (${rp(sum(drop, (x) => x.total_amount))})`);
    dated.filter((r) => r.dateNote).forEach((r) => log(`  tanggal kosong — baris ${r.row} no. ${r.no} → ${r.date}`));
    if (VERBOSE) {
      fix.forEach(({ r, x }) => log(`    ~ #${x.id} ${x.date} ${x.quantity} ${rp(x.total_amount)} → ${r.date} ${r.qty} ${rp(r.total)}  ${descOf(r)}`));
      drop.forEach((x) => log(`    - #${x.id} ${x.date} ${x.plot_name} ${x.quantity} ${rp(x.total_amount)} ${x.description}`));
    }
    const noSap = [...new Set(add.filter((r) => !sapOf(r.item)).map((r) => r.item))];
    if (noSap.length) throw new Error(`Barang Bagi Hasil tanpa master: ${noSap.join(', ')}`);

    // ======================================================== 2. LABOUR
    log(`\n── 2. ${SHEET_TK}`);
    const labourScheme = (plot, date) => (SWITCHED.includes(plot.plot_name) ? (date >= PS_FROM ? 'ProfitSharing' : 'PreFinance') : plot.scheme);
    const tkDesc = (scheme, s, e) => `${scheme === 'ProfitSharing' ? 'Tenaga kerja lahan bagi hasil' : 'Hutang tenaga kerja'} ${s} s/d ${e || '-'}`;
    const tkBad = tk.filter((r) => !plotBy.has(r.plot));
    if (tkBad.length) { tkBad.forEach((r) => log(`  ! baris ${r.row}: plot ${r.plot}`)); throw new Error('Plot tenaga kerja tidak dikenal'); }
    const lab = await q(`SELECT d.id, d.date, d.total_amount, d.description, d.scheme, p.plot_name
      FROM pre_finance_distributions d JOIN plot p ON p.id = d.plot_id
      JOIN farmers f ON f.id = d.farmer_id JOIN kth k ON k.id = f.kth_id
      WHERE d.pre_finance_type_id = ? AND k.entities_id = ?`, [types.Labor, ENTITY_JNBS]);
    const lpool = lab.slice();
    const ltake = (pred) => { const i = lpool.findIndex(pred); return i < 0 ? null : lpool.splice(i, 1)[0]; };
    const lkeep = []; const ladd = []; const lskip = [];
    for (const r of tk) {
      if (!(r.total > 0)) { lskip.push(r); continue; }
      const hit = r.start
        ? ltake((x) => x.plot_name === r.plot && x.date === r.start && near(x.total_amount, r.total))
        // No start date in the sheet: the row was entered by hand from its end date.
        : ltake((x) => x.plot_name === r.plot && x.description.endsWith(`s/d ${r.end}`) && near(x.total_amount, r.total));
      if (hit) { lkeep.push({ r, x: hit }); continue; }
      if (!r.start) { lskip.push(r); continue; }
      ladd.push(r);
    }
    const ldrop = lpool;
    // Only the leading words change — "Hutang" is wrong for a profit-sharing cost.
    const PREFIX_PF = 'Hutang tenaga kerja'; const PREFIX_PS = 'Tenaga kerja lahan bagi hasil';
    const relabelTo = (x, scheme) => {
      const want = scheme === 'ProfitSharing' ? PREFIX_PS : PREFIX_PF;
      const other = scheme === 'ProfitSharing' ? PREFIX_PF : PREFIX_PS;
      return x.description.startsWith(other) ? want + x.description.slice(other.length) : x.description;
    };
    const relabel = lkeep.filter(({ r, x }) => relabelTo(x, labourScheme(plotBy.get(r.plot), x.date)) !== x.description);
    log(`  sheet ${tk.length} baris ${rp(sum(tk, (r) => r.total))} · sistem ${lab.length} baris ${rp(sum(lab, (x) => x.total_amount))}`);
    log(`  tetap ${lkeep.length} · baru ${ladd.length} (${rp(sum(ladd, (r) => r.total))}) · dilewati ${lskip.length} (nilai 0 / tanpa tanggal) · dihapus ${ldrop.length} (${rp(sum(ldrop, (x) => x.total_amount))})`);
    ldrop.forEach((x) => log(`    - #${x.id} ${x.plot_name} ${x.date} ${rp(x.total_amount)} ${x.description} (tidak ada di sheet)`));
    const psNew = ladd.filter((r) => labourScheme(plotBy.get(r.plot), r.start) === 'ProfitSharing');
    log(`  baris baru bagi hasil (5 lahan, mulai ${PS_FROM}): ${psNew.length} ${rp(sum(psNew, (r) => r.total))}; pre-finance: ${ladd.length - psNew.length} ${rp(sum(ladd, (r) => r.total) - sum(psNew, (r) => r.total))}`);
    log(`  label diganti "Tenaga kerja lahan bagi hasil" / "Hutang tenaga kerja" sesuai skema: ${relabel.length}`);
    const straddle = tk.filter((r) => SWITCHED.includes(r.plot) && r.start && r.start < PS_FROM && r.end && r.end >= PS_FROM);
    straddle.forEach((r) => log(`  · minggu ${r.start} s/d ${r.end} (${r.plot}) melewati ${PS_FROM} — dihitung pre-finance (tanggal mulai)`));
    if (VERBOSE) ladd.forEach((r) => log(`    + baris ${r.row} ${r.plot} ${r.start}..${r.end} ${r.workers}×${r.fee} ${rp(r.total)}`));

    // ======================================================== 3. STOCK IN
    log(`\n── 3. ${SHEET_ST}`);
    const done = new Set((await q('SELECT stock_in_number FROM stock_in WHERE stock_in_number LIKE ?', [`${SIH}%`])).map((x) => x.stock_in_number));
    const numberOf = (r) => `${SIH}${String(r.stockId || `R${r.row}`).padStart(3, '0')}`;
    const dupNo = st.map(numberOf).filter((n, i, a) => a.indexOf(n) !== i);
    if (dupNo.length) throw new Error(`Stock ID ganda: ${dupNo.join(', ')}`);
    const stNew = st.filter((r) => !done.has(numberOf(r)));
    const create = [...new Set(stNew.filter((r) => !sapOf(r.item)).map((r) => r.item))];
    log(`  sheet ${st.length} penerimaan ${rp(sum(st, (r) => r.total))} (${st[0]?.date} – ${st.map((r) => r.date).sort().pop()}) · sudah ada ${st.length - stNew.length} · akan ditulis ${stNew.length}`);
    log(`  barang baru di master (${create.length}): ${create.join(', ') || '—'}`);
    if (VERBOSE) {
      const per = new Map();
      for (const r of st) { const k = `${r.item} [${sapOf(r.item) ?? 'baru'}]`; per.set(k, (per.get(k) || 0) + r.qty); }
      [...per].sort().forEach(([k, v]) => log(`    ${k.padEnd(48)} ${v}`));
    }

    // ======================================================== write
    // A dry run writes too, inside the transaction, and rolls it back at the end:
    // the opname figures below can only be shown from the stock as it would be.
    await c.beginTransaction();
    // -- new master items
    for (const name of create) {
      const r = stNew.find((x) => x.item === name);
      const u = unitId(r.unit);
      await q(`INSERT INTO sapropdi (sapropdi_name, category, unit_id, unit, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())`,
        [name, NEW_CATEGORY[up(name)] || 'Others', u, u ? null : r.unit]);
    }
    saps = await q('SELECT id, sapropdi_name, unit_id, unit FROM sapropdi');

    // -- stock in
    for (const r of stNew) {
      const notes = [`Impor ${SHEET_ST} (JNBS Database.xlsx) baris ${r.row} — Stock ID ${r.stockId}`,
        `${r.qty} ${r.unit} × ${rp(r.price)} = ${rp(r.total)}`, r.permit, r.notes].filter(Boolean).join(' · ');
      const [res] = await c.query(`INSERT INTO stock_in (stock_in_number, stock_in_date, warehouse_id, delivery_note_no, status, notes, created_at, updated_at)
        VALUES (?,?,?,?, 'Posted', ?, NOW(), NOW())`, [numberOf(r), r.date, wh.id, r.link ? r.link.slice(0, 100) : null, notes]);
      await q(`INSERT INTO stock_in_items (stock_in_id, sapropdi_id, received_qty, item_condition, remarks) VALUES (?,?,?, 'Good', ?)`,
        [res.insertId, sapOf(r.item), r.qty, r.link && r.link.length > 100 ? r.link : null]);
    }

    // -- bagi hasil
    const headerFor = async (date) => {
      const [h] = await q(`SELECT id FROM stock_out WHERE warehouse_id = ? AND stock_out_date = ? AND stock_out_number LIKE 'SOH-%' ORDER BY id LIMIT 1`, [wh.id, date]);
      if (h) return h.id;
      const year = date.slice(0, 4);
      const [last] = await q(`SELECT MAX(CAST(SUBSTRING_INDEX(stock_out_number, '-', -1) AS UNSIGNED)) n FROM stock_out WHERE stock_out_number LIKE ?`, [`SOH-${year}-%`]);
      const number = `SOH-${year}-${String(Number(last?.n || 0) + 1).padStart(4, '0')}`;
      const [res] = await c.query(`INSERT INTO stock_out (stock_out_number, stock_out_date, warehouse_id, notes, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())`,
        [number, date, wh.id, NOTE_SO]);
      return res.insertId;
    };
    const touched = new Set();
    for (const x of drop) {
      await q('DELETE FROM pre_finance_distributions WHERE id = ?', [x.id]);
      if (x.stock_out_id) touched.add(x.stock_out_id);
    }
    for (const { r, x } of fix) {
      const so = x.date === r.date ? x.stock_out_id : await headerFor(r.date);
      if (x.stock_out_id && so !== x.stock_out_id) touched.add(x.stock_out_id);
      await q(`UPDATE pre_finance_distributions SET date = ?, quantity = ?, price_per_unit = ?, total_amount = ?, description = ?,
          stock_out_id = ?, scheme = 'ProfitSharing', updated_at = NOW() WHERE id = ?`,
        [r.date, r.qty, r.price || r.total / r.qty, r.total, descOf(r), so, x.id]);
    }
    for (const r of add) {
      const plot = plotBy.get(r.plot);
      const sap = sapOf(r.item);
      // Bought and handed over on the spot (fuel), never through the warehouse:
      // no warehouse, so it does not take stock that was never received.
      const viaWh = stockedIn.has(sap) || sheetStocked.has(up(r.item));
      const so = viaWh ? await headerFor(r.date) : null;
      await q(`INSERT INTO pre_finance_distributions
          (pre_finance_type_id, date, farmer_id, plot_id, commodities_id, sapropdi_id, warehouse_id, stock_out_id,
           quantity, unit_id, price_per_unit, total_amount, counts_as_debt, scheme, description, upload_proof, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'ProfitSharing',?,?,NOW(),NOW())`,
        [types.Saprodi, r.date, plot.farmer_id, plot.id, comId(r.commodity), sap, viaWh ? wh.id : null, so,
         r.qty, unitId(r.unit), r.price || r.total / r.qty, r.total, descOf(r), r.link ? r.link.slice(0, 255) : null]);
    }
    for (const id of touched) {
      const [n] = await q('SELECT COUNT(*) n FROM pre_finance_distributions WHERE stock_out_id = ?', [id]);
      if (!Number(n.n)) await q('DELETE FROM stock_out WHERE id = ? AND stock_out_number LIKE ?', [id, 'SOH-%']);
    }

    // -- the unnumbered loans of 2026-11 get their item
    // importJnbsLoansUnnumbered2026-11.js left them without sapropdi_id: with no
    // receipts on record the shelf was known only from the opname counts, and
    // booking them as issues too would have taken the same goods off it twice.
    // With the receipt history in, the opname adjustment is re-derived below, so
    // every issue can now count — same rule as above: only items this warehouse
    // has ever received.
    log(`
── 1b. Pinjaman saprodi tanpa nomor ${TAG_UNNUMBERED} — dikaitkan ke master barang`);
    const un = await q(`SELECT id, date, quantity, description FROM pre_finance_distributions
      WHERE description LIKE ? AND sapropdi_id IS NULL AND warehouse_id = ?`, [`%${TAG_UNNUMBERED}%`, wh.id]);
    const linkBy = new Map(); const notLinked = new Map();
    for (const x of un) {
      const m = x.description.match(/^Pinjaman saprodi \(tanpa no\., baris \d+\) - (.+?) \S+ \S+(?: · .*)? \[/);
      const name = m ? m[1] : null; const sap = name ? sapOf(name) : null;
      const received = sap && (stockedIn.has(sap) || sheetStocked.has(up(name)));
      if (received) { await q('UPDATE pre_finance_distributions SET sapropdi_id = ?, updated_at = NOW() WHERE id = ?', [sap, x.id]); linkBy.set(name, (linkBy.get(name) || 0) + 1); }
      else notLinked.set(name || '?', (notLinked.get(name || '?') || 0) + 1);
    }
    log(`  dikaitkan ${[...linkBy.values()].reduce((a, b) => a + b, 0)} dari ${un.length} baris`);
    if (notLinked.size) log(`  tidak dikaitkan (barang tak pernah diterima gudang): ${[...notLinked].map(([k, v]) => `${k} ×${v}`).join(', ')}`);

    // -- labour
    for (const x of ldrop) await q('DELETE FROM pre_finance_distributions WHERE id = ?', [x.id]);
    for (const { r, x } of relabel) {
      await q('UPDATE pre_finance_distributions SET description = ?, updated_at = NOW() WHERE id = ?',
        [relabelTo(x, labourScheme(plotBy.get(r.plot), x.date)), x.id]);
    }
    for (const r of ladd) {
      const plot = plotBy.get(r.plot); const scheme = labourScheme(plot, r.start);
      await q(`INSERT INTO pre_finance_distributions
          (pre_finance_type_id, date, farmer_id, plot_id, commodities_id, sapropdi_id, warehouse_id, stock_out_id,
           quantity, unit_id, price_per_unit, total_amount, counts_as_debt, scheme, description, upload_proof, created_at, updated_at)
        VALUES (?,?,?,?,?,NULL,?,NULL,?,?,?,?,1,?,?,?,NOW(),NOW())`,
        [types.Labor, r.start, plot.farmer_id, plot.id, comId(r.commodity), wh.id, r.workers, unitId('hari'),
         r.fee || (r.workers ? r.total / r.workers : r.total), r.total, scheme, tkDesc(scheme, r.start, r.end), r.link ? r.link.slice(0, 255) : null]);
    }

    // ======================================================== 4. OPNAME
    log(`\n── 4. Stok opname gudang KTH AML — dihitung ulang dengan riwayat penerimaan`);
    const MARK = 'Dihitung ulang 2026-11-05 setelah impor riwayat ADM_Entry Stok Barang & Bagi Hasil Panen.';
    const ops = await q('SELECT id, opname_number, opname_date, applied_at, notes FROM stock_opname WHERE warehouse_id = ? ORDER BY opname_date, id', [wh.id]);
    for (const o of ops) {
      const items = await q(`SELECT oi.id, oi.sapropdi_id, s.sapropdi_name, oi.system_qty, oi.counted_qty, oi.adjustment
        FROM stock_opname_items oi JOIN sapropdi s ON s.id = oi.sapropdi_id WHERE oi.stock_opname_id = ? ORDER BY s.sapropdi_name`, [o.id]);
      log(`  ${o.opname_number} ${o.opname_date} ${o.applied_at ? 'diterapkan' : 'belum diterapkan'}`);
      log(`    ${'barang'.padEnd(30)} ${'sistem lama'.padStart(12)} ${'sistem baru'.padStart(12)} ${'fisik'.padStart(10)} ${'selisih lama'.padStart(12)} ${'selisih baru'.padStart(12)}`);
      for (const it of items) {
        const [m] = await q(`SELECT
            (SELECT COALESCE(SUM(sii.received_qty), 0) FROM stock_in si JOIN stock_in_items sii ON sii.stock_in_id = si.id
              WHERE si.warehouse_id = ? AND sii.sapropdi_id = ? AND COALESCE(si.status, '') <> 'Draft' AND si.stock_in_date <= ?) AS inq,
            (SELECT COALESCE(SUM(d.quantity), 0) FROM pre_finance_distributions d JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
              WHERE t.type_name = 'Saprodi' AND d.warehouse_id = ? AND d.sapropdi_id = ? AND d.date <= ?) AS outq,
            (SELECT COALESCE(SUM(oi2.adjustment), 0) FROM stock_opname o2 JOIN stock_opname_items oi2 ON oi2.stock_opname_id = o2.id
              WHERE o2.warehouse_id = ? AND oi2.sapropdi_id = ? AND o2.applied_at IS NOT NULL AND oi2.adjustment IS NOT NULL
                AND (o2.opname_date < ? OR (o2.opname_date = ? AND o2.id < ?))) AS adj`,
          [wh.id, it.sapropdi_id, o.opname_date, wh.id, it.sapropdi_id, o.opname_date, wh.id, it.sapropdi_id, o.opname_date, o.opname_date, o.id]);
        const sys = Math.round((Number(m.inq) - Number(m.outq) + Number(m.adj)) * 1000) / 1000;
        const adj = o.applied_at ? Math.round((Number(it.counted_qty) - sys) * 1000) / 1000 : null;
        log(`    ${it.sapropdi_name.slice(0, 30).padEnd(30)} ${String(Number(it.system_qty)).padStart(12)} ${String(sys).padStart(12)} ${String(Number(it.counted_qty)).padStart(10)} ${String(it.adjustment == null ? '—' : Number(it.adjustment)).padStart(12)} ${String(adj == null ? '—' : adj).padStart(12)}`);
        await q('UPDATE stock_opname_items SET system_qty = ?, adjustment = ?, updated_at = NOW() WHERE id = ?',
          [sys, o.applied_at ? adj : it.adjustment, it.id]);
      }
      if (!String(o.notes || '').includes(MARK)) {
        await q('UPDATE stock_opname SET notes = CONCAT(COALESCE(notes, \'\'), ?), updated_at = NOW() WHERE id = ?', [`\n${MARK}`, o.id]);
      }
    }
    const neg = await q(`SELECT sapropdi_name, unit_name, total_in, total_out, total_adjustment, remaining FROM v_saprodi_stock
      WHERE warehouse_id = ? AND remaining < 0 ORDER BY remaining`, [wh.id]);
    log(`  stok minus di KTH AML sesudahnya: ${neg.length}`);
    neg.forEach((n) => log(`    ${n.sapropdi_name.padEnd(36)} masuk ${Number(n.total_in)} · keluar ${Number(n.total_out)} · opname ${Number(n.total_adjustment)} = ${Number(n.remaining)} ${n.unit_name || ''}`));

    // ======================================================== result
    const [[os]] = await c.query(`SELECT ROUND(SUM(o.outstanding)) v FROM v_pre_finance_outstanding o
      JOIN farmers f ON f.id = o.farmer_id JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ?`, [ENTITY_JNBS]);
    const [psc] = await c.query(`SELECT p.plot_name, t.type_name, COUNT(*) n, ROUND(SUM(d.total_amount)) v
      FROM pre_finance_distributions d JOIN plot p ON p.id = d.plot_id JOIN pre_finance_types t ON t.id = d.pre_finance_type_id
      WHERE d.scheme = 'ProfitSharing' AND p.plot_name IN (?) GROUP BY 1, 2 ORDER BY 1, 2`, [SWITCHED]);
    log(`\n── Hasil`);
    log(`  utang petani JNBS (pre-finance): ${rp(os.v)}`);
    log('  biaya bagi hasil per lahan (mulai 28 Agu 2025):');
    psc.forEach((r) => log(`    ${r.plot_name} ${r.type_name.padEnd(8)} ${String(r.n).padStart(4)} baris ${rp(r.v).padStart(16)}`));

    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only (semua perubahan di atas di-rollback); re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
