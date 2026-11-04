// -----------------------------------------------------------------------------
// Migration: what grows on each plot (2026-11)
//
// "cek setiap lahan dan komoditas apa yang di tanam disana, lalu sesuaikan di web"
// (user, 2026-11-04). One plot often carries several commodities, so they get
// their own table, plot_commodities (DDL from db/schema.sql). Filled from every
// source that says something about it, and each row names its sources:
//
//   penanaman   JNBS Database.xlsx, `ADM_Initial Plantation Summary` (Plot ID ×
//               Seedling Type, planted seedlings)
//   vegetasi    Sumber Jaya Farmers Data.xlsx, `vegetation` (per farmer: cocoa,
//               avocado, durian, petai, banana counts) → the farmer's planted plot
//               (S0…/N0…), else their Pre-Finance cocoa plot
//   pinjaman    pre_finance_distributions.commodities_id on the plot
//   panen       purchasing.commodities_id on the plot
//   pohon       trees.species on the plot (Kakao / Kopi / Alpukat)
//   subplot     plot.commodities_id
//
// Vegetation columns with no commodity in the master (coconut, nutmeg, jengkol,
// areca, papaya) are reported and skipped. "Kopi" (id 3) and "Coffee (Kopi)" are
// the same crop; this files both under "Coffee (Kopi)".
//
// Additive and idempotent: rows are created or have sources/plants merged; nothing
// is deleted. Dry-run by default.
//
// Usage:
//   node scripts/migratePlotCommodities2026-11.js --jnbs "<JNBS Database.xlsx>" --snbs "<Sumber Jaya Farmers Data.xlsx>"
//   … --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const JNBS = arg('--jnbs');
const SNBS = arg('--snbs');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

function cv(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
  }
  return v;
}
const norm = (s) => String(cv(s) ?? '').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const num = (v) => { const x = cv(v); return typeof x === 'number' && isFinite(x) ? x : Number(String(x ?? '').replace(/[^\d.]/g, '')) || 0; };

async function sheet(file, name) {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (ws.name !== name) { for await (const _ of ws) { /* skip */ } continue; }
    const rows = [];
    for await (const row of ws) { const v = []; row.eachCell({ includeEmpty: true }, (c, col) => { v[col - 1] = c.value; }); rows[row.number - 1] = v; }
    return rows;
  }
  throw new Error(`Sheet "${name}" tidak ada di ${path.basename(file)}`);
}

function ddlFor(schema, table) {
  const head = 'CREATE TABLE `' + table + '` (';
  const i = schema.indexOf(head); const j = schema.indexOf(') ENGINE=InnoDB;', i);
  if (i < 0 || j < 0) throw new Error(`DDL ${table} tidak ada di db/schema.sql`);
  return schema.slice(i, j + ') ENGINE=InnoDB;'.length);
}

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const [t] = await c.query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plot_commodities'", [DB]);
    if (!t.length) {
      log('+ table plot_commodities');
      if (APPLY) await c.query(ddlFor(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'), 'plot_commodities'));
    } else log('= table plot_commodities already there');

    const [coms] = await c.query('SELECT id, commodities_name FROM commodities');
    const COFFEE = coms.find((x) => x.commodities_name === 'Coffee (Kopi)')?.id;
    const canon = (id) => (Number(id) === coms.find((x) => x.commodities_name === 'Kopi')?.id ? COFFEE : Number(id));
    const byWord = (w) => coms.find((x) => x.commodities_name.toLowerCase().includes(w.toLowerCase()))?.id ?? null;
    const comName = new Map(coms.map((x) => [x.id, x.commodities_name]));
    const [plots] = await c.query(
      `SELECT pl.id, pl.plot_name, pl.scheme, pl.farmer_id, pl.commodities_id, f.farmer_name, k.entities_id
         FROM plot pl LEFT JOIN farmers f ON f.id = pl.farmer_id LEFT JOIN kth k ON k.id = f.kth_id`);
    const plotBy = new Map(plots.map((p) => [p.plot_name, p]));

    // plot_id → commodity → { sources:Set, plants }
    const ev = new Map();
    const add = (plotId, comId, source, plants = null) => {
      if (!plotId || !comId) return;
      comId = canon(comId);
      if (!ev.has(plotId)) ev.set(plotId, new Map());
      const m = ev.get(plotId);
      if (!m.has(comId)) m.set(comId, { sources: new Set(), plants: null });
      const e = m.get(comId); e.sources.add(source);
      if (plants != null && plants > 0) e.plants = Math.max(e.plants ?? 0, Math.round(plants));
    };

    // database evidence
    for (const [sql, src] of [
      ['SELECT DISTINCT plot_id, commodities_id FROM pre_finance_distributions WHERE plot_id IS NOT NULL AND commodities_id IS NOT NULL', 'pinjaman'],
      ['SELECT DISTINCT plot_id, commodities_id FROM purchasing WHERE plot_id IS NOT NULL AND commodities_id IS NOT NULL', 'panen'],
      ['SELECT id AS plot_id, commodities_id FROM plot WHERE commodities_id IS NOT NULL', 'subplot'],
    ]) { const [r] = await c.query(sql); r.forEach((x) => add(x.plot_id, x.commodities_id, src)); }
    const [trees] = await c.query('SELECT plot_id, species, COUNT(*) n FROM trees WHERE plot_id IS NOT NULL AND species IS NOT NULL GROUP BY plot_id, species');
    for (const tr of trees) {
      const s = String(tr.species).toLowerCase();
      const id = s.includes('kakao') || s.includes('cacao') ? byWord('Cocoa') : s.includes('kopi') ? COFFEE : s.includes('alpukat') ? byWord('Avocado') : null;
      add(tr.plot_id, id, 'pohon', Number(tr.n));
    }

    const unknownPlots = new Set(); const skippedCrops = new Map();
    // JNBS planting records
    if (JNBS) {
      const R = await sheet(JNBS, 'ADM_Initial Plantation Summary');
      const h = (R[0] || []).map(norm);
      const iPlot = h.indexOf('Plot ID'); const iType = h.indexOf('Seedling Type'); const iQty = h.indexOf('Total Planted Seedlings');
      if (iPlot < 0 || iType < 0) throw new Error('Kolom Plot ID / Seedling Type tidak ada');
      for (const r of R.slice(1)) {
        if (!r) continue;
        const p = plotBy.get(norm(r[iPlot])); const type = norm(r[iType]);
        if (!norm(r[iPlot]) || !type) continue;
        if (!p) { unknownPlots.add(`JNBS ${norm(r[iPlot])}`); continue; }
        const id = coms.find((x) => x.commodities_name.toLowerCase() === type.toLowerCase())?.id ?? byWord(type.split(' ')[0]);
        add(p.id, id, 'penanaman', null);
        if (id) { const e = ev.get(p.id).get(canon(id)); e.plants = (e.plants ?? 0) + Math.round(num(r[iQty])); }
      }
    }
    // SNBS vegetation survey, per farmer
    if (SNBS) {
      const R = await sheet(SNBS, 'vegetation');
      const hi = R.findIndex((r) => r && norm(r[1]).startsWith('Name of Farmer'));
      const head = R[hi].map(norm);
      const crops = [];
      head.forEach((h, i) => { if (i >= 5 && h && !['Level', 'total plants (All ages)', 'Density', 'Unit'].includes(h)) crops.push([h, i]); });
      const CROP = { cocoa: 'Cocoa', avocado: 'Avocado', durian: 'Durian', petai: 'Petai', banana: 'Banana' };
      const farmers = new Map(plots.filter((p) => p.entities_id === 1).map((p) => [key(p.farmer_name), p.farmer_id]));
      for (const r of R.slice(hi + 2)) {
        if (!r || !norm(r[1]) || !(num(r[0]) > 0)) continue;
        // "Susanto 2", "Mat Sodikin 1": a farmer's second plot in the survey.
        const fid = farmers.get(key(r[1])) ?? farmers.get(key(r[1]).replace(/\d+$/, ''));
        if (!fid) { unknownPlots.add(`SNBS petani ${norm(r[1])}`); continue; }
        const own = plots.filter((p) => p.farmer_id === fid && p.scheme === 'PreFinance');
        const target = own.find((p) => /^(S0|N0|NO1)/i.test(p.plot_name)) || own.find((p) => /^SJ00/i.test(p.plot_name)) || own[0];
        if (!target) { unknownPlots.add(`SNBS petani ${norm(r[1])} tanpa plot Pre-Finance`); continue; }
        const totals = new Map();
        for (const [h, i] of crops) { const q = num(r[i]); if (q > 0) totals.set(h.trim(), (totals.get(h.trim()) || 0) + q); }
        for (const [h, q] of totals) {
          const word = CROP[key(h)];
          if (!word) { skippedCrops.set(h, (skippedCrops.get(h) || 0) + 1); continue; }
          add(target.id, byWord(word), 'vegetasi', q);
        }
      }
    }

    // compare with what is stored
    const [have] = t.length ? await c.query('SELECT plot_id, commodities_id, plants, sources FROM plot_commodities') : [[]];
    const stored = new Map(have.map((h) => [`${h.plot_id}|${h.commodities_id}`, h]));
    const plan = [];
    for (const [plotId, m] of ev) for (const [comId, e] of m) {
      const s = [...e.sources].sort().join(', ');
      const prev = stored.get(`${plotId}|${comId}`);
      const merged = prev ? [...new Set([...String(prev.sources || '').split(', ').filter(Boolean), ...e.sources])].sort().join(', ') : s;
      const plants = e.plants ?? prev?.plants ?? null;
      if (!prev || prev.sources !== merged || Number(prev.plants ?? -1) !== Number(plants ?? -1)) plan.push({ plotId, comId, sources: merged, plants, isNew: !prev });
    }

    const pById = new Map(plots.map((p) => [p.id, p]));
    const perEnt = new Map();
    for (const [plotId, m] of ev) {
      const ent = pById.get(plotId)?.entities_id ?? 0;
      const x = perEnt.get(ent) || { plots: 0, rows: 0, multi: 0 };
      x.plots++; x.rows += m.size; if (m.size > 1) x.multi++; perEnt.set(ent, x);
    }
    for (const [ent, x] of perEnt) log(`entitas ${ent}: ${x.plots} lahan, ${x.rows} lahan×komoditas, ${x.multi} lahan dengan >1 komoditas`);
    const byCom = new Map();
    for (const m of ev.values()) for (const comId of m.keys()) byCom.set(comId, (byCom.get(comId) || 0) + 1);
    log('per komoditas: ' + [...byCom].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${comName.get(id)} ${n}`).join(' · '));
    if (skippedCrops.size) log('dilewati (tidak ada di master komoditas): ' + [...skippedCrops].map(([h, n]) => `${h} (${n} petani)`).join(', '));
    if (unknownPlots.size) log('tidak ditemukan: ' + [...unknownPlots].join(', '));
    if (VERBOSE) {
      for (const [plotId, m] of [...ev].sort((a, b) => String(pById.get(a[0])?.plot_name).localeCompare(String(pById.get(b[0])?.plot_name)))) {
        const p = pById.get(plotId);
        log(`  ${String(p?.plot_name).padEnd(20)} ${String(p?.farmer_name ?? '').padEnd(22)} ${[...m].map(([id, e]) => `${comName.get(id)}${e.plants ? ` ${e.plants}` : ''} [${[...e.sources].join('+')}]`).join(' · ')}`);
      }
    }
    log(`akan ditulis: ${plan.filter((p) => p.isNew).length} baru, ${plan.filter((p) => !p.isNew).length} diperbarui`);
    if (!APPLY) { log('dry-run only; re-run with --apply'); return; }
    for (const p of plan) {
      await c.query(
        `INSERT INTO plot_commodities (plot_id, commodities_id, plants, sources, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE plants = VALUES(plants), sources = VALUES(sources), updated_at = NOW()`,
        [p.plotId, p.comId, p.plants, p.sources]);
    }
    log('done');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
