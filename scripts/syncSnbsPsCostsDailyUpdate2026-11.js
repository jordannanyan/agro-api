// -----------------------------------------------------------------------------
// Sync: SNBS Profit Sharing plot costs from the Cavendish `Daily Update` (2026-11)
//
// `Database Cavendish SNBS Lampung.xlsx`, sheet `Daily Update` — every labour
// and material cost of the SNBS banana plots, one row per activity. It was
// imported once on 2026-08-19 into profit_sharing_investments (a row with labour
// → type Labor, a row with material → type Other, period = the row's month), and
// matches it to the rupiah up to July 2026. This brings it up to date:
//
//   · rows of months ≥ --from (default 2026-08) are replaced by what the sheet
//     says now — August was imported half-way through the month;
//   · earlier months are only compared and reported, never touched;
//   · only rows the import wrote (created 2026-08-19) or this script wrote
//     (description ends "· Daily Update") are replaced — a cost someone entered
//     through the web stays.
//
// The sheet names plots by their SNBS land code (SJ0056 …); the system keeps the
// ledger codes (AG1 …). The mapping is the `Skema Petani SNBS` list. Rows of a
// plot the system does not have yet (SJ0067 … SJ0077, new in Oct–Nov 2026) are
// reported and skipped.
//
// Idempotent. Dry-run by default (written in a transaction, rolled back).
//
// Usage:
//   node scripts/syncSnbsPsCostsDailyUpdate2026-11.js --file "<Cavendish xlsx>" [--from 2026-08] [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const FILE = arg('--file');
const FROM = arg('--from') || '2026-08';
const DB = process.env.DB_NAME || 'agro_supply';
const SIGN = '· Daily Update';
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE || !/^\d{4}-\d{2}$/.test(FROM)) { console.error('Usage: --file <xlsx> [--from YYYY-MM] [--apply]'); process.exit(2); }

// SNBS land code (sheet) → plot name in the system (ledger code).
const PLOT = {
  SJ0056: 'AG1', SJ0057: 'AG2', NONSJ0276: 'AMA', SJ0005: 'ANF', SJ0009: 'SJ0009%Pisang', SJ0050: 'M2',
  SJ0011: 'NC', SJ0051: 'SU', NONSJ0275: 'SUM', SJ0015: 'SJ0015%Pisang', SJ0052: 'SUW 2', SJ0053: 'SUW 3',
  SJ0054: 'SUY', SJ0055: 'ZN',
};

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = Number(cv(v)); return isFinite(x) ? x : 0; };
const str = (v) => { const s = String(cv(v) ?? '').replace(/\s+/g, ' ').trim(); return s === 'nan' ? '' : s; };
const ymd = (v) => {
  const x = cv(v);
  if (x instanceof Date && !isNaN(x)) return x.toISOString().slice(0, 10);
  if (typeof x === 'number' && x > 40000) return new Date(Math.round((x - 25569) * 864e5)).toISOString().slice(0, 10);
  return null;
};

async function readDailyUpdate() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (ws.name !== 'Daily Update') { for await (const _ of ws) { /* skip */ } continue; }
    const out = [];
    for await (const row of ws) {
      if (row.number < 2) continue;
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      const date = ymd(v[6]);
      const labor = num(v[15]), material = num(v[16]);
      if (!date || (!labor && !material)) continue;
      out.push({ row: row.number, land: str(v[1]), date, period: date.slice(0, 7), activity: str(v[9]), material: str(v[10]),
                 category: str(v[11]), volume: num(v[12]), labor, materialCost: material });
    }
    return out;
  }
  throw new Error('Sheet "Daily Update" tidak ada');
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB} · bulan ≥ ${FROM} diganti dari Daily Update`);
  const rows = await readDailyUpdate();
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    await c.beginTransaction();
    const [[labor]] = await c.query("SELECT id FROM pre_finance_types WHERE type_name = 'Labor'");
    const [[other]] = await c.query("SELECT id FROM pre_finance_types WHERE type_name = 'Other'");
    const plots = {};
    for (const [land, name] of Object.entries(PLOT)) {
      const [p] = await q(`SELECT pl.id, pl.plot_name, pl.farmer_id, pl.scheme FROM plot pl JOIN farmers f ON f.id = pl.farmer_id
        JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = 1 AND pl.plot_name LIKE ?`, [name]);
      if (!p) throw new Error(`plot ${name} (${land}) tidak ada`);
      if (p.scheme !== 'ProfitSharing') throw new Error(`plot ${p.plot_name} bukan Profit Sharing`);
      plots[land] = p;
    }
    const ids = Object.values(plots).map((p) => p.id);

    // 1. earlier months: compare only
    const sheet = {}; const skipped = {};
    for (const r of rows) {
      if (!plots[r.land]) { const k = r.land || '(kosong)'; skipped[k] = (skipped[k] || 0) + r.labor + r.materialCost; continue; }
      const k = `${r.period}|${r.labor ? 'L' : ''}`;
      sheet[`${r.period}|L`] = (sheet[`${r.period}|L`] || 0) + r.labor;
      sheet[`${r.period}|O`] = (sheet[`${r.period}|O`] || 0) + r.materialCost;
      void k;
    }
    const db = await q(`SELECT period, pre_finance_type_id t, SUM(amount) a FROM profit_sharing_investments
      WHERE plot_id IN (?) GROUP BY period, pre_finance_type_id`, [ids]);
    const dbv = {}; for (const r of db) dbv[`${r.period}|${r.t === labor.id ? 'L' : r.t === other.id ? 'O' : 'X'}`] = Number(r.a);
    log('\n1) Bulan sebelum ' + FROM + ' (hanya dibandingkan)');
    let earlyDiff = 0;
    for (const m of [...new Set(Object.keys(sheet).map((k) => k.split('|')[0]))].sort().filter((m) => m < FROM)) {
      for (const t of ['L', 'O']) {
        const d = (sheet[`${m}|${t}`] || 0) - (dbv[`${m}|${t}`] || 0);
        if (Math.abs(d) > 1) { log(`   ! ${m} ${t === 'L' ? 'tenaga kerja' : 'material'}: sheet − sistem = ${rp(d)}`); earlyDiff++; }
      }
    }
    if (!earlyDiff) log('   · cocok semua');

    // 2. months ≥ FROM: replace
    const [del] = await c.query(`DELETE FROM profit_sharing_investments WHERE plot_id IN (?) AND period >= ?
        AND (DATE(created_at) = '2026-08-19' OR description LIKE ?)`, [ids, FROM, `%${SIGN}`]);
    const [[kept]] = await c.query('SELECT COUNT(*) n, COALESCE(SUM(amount),0) a FROM profit_sharing_investments WHERE plot_id IN (?) AND period >= ?', [ids, FROM]);
    const now = new Date();
    const add = {};
    for (const r of rows.filter((x) => plots[x.land] && x.period >= FROM)) {
      const p = plots[r.land];
      const desc = `${r.activity}${r.material ? ` - ${r.material}` : ''} (${r.category}) ${SIGN}`;
      for (const [amount, type] of [[r.labor, labor.id], [r.materialCost, other.id]]) {
        if (!amount) continue;
        await c.query(`INSERT INTO profit_sharing_investments (period, farmer_id, plot_id, pre_finance_type_id, quantity, amount, description, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, [r.period, p.farmer_id, p.id, type, r.volume || null, amount, desc, now, now]);
        const k = `${r.period} ${type === labor.id ? 'tenaga kerja' : 'material'}`;
        add[k] = (add[k] || 0) + amount;
      }
    }
    log(`\n2) Bulan ≥ ${FROM}: ${del.affectedRows} baris lama dihapus, diganti:`);
    for (const k of Object.keys(add).sort()) log(`   + ${k}: ${rp(add[k])}`);
    log(`   total ${rp(Object.values(add).reduce((s, x) => s + x, 0))}`);
    if (Number(kept.n)) log(`   · ${kept.n} baris input web dipertahankan (${rp(kept.a)})`);
    if (Object.keys(skipped).length) {
      log('\n3) Lahan yang belum ada di sistem (dilewati):');
      for (const [k, v] of Object.entries(skipped)) if (v) log(`   ! ${k}: ${rp(v)}`);
    }
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
