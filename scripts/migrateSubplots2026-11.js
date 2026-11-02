// -----------------------------------------------------------------------------
// Migration: subplots — one land, one plot per scheme and commodity (2026-11)
//
// Two farmers grow cocoa and banana on the same land under different schemes:
//   Ladiono   SJ0009 cocoa  Pre-Finance   ← land
//             LA     banana Profit Sharing ← subplot of SJ0009
//   Suwanto   SJ0015 cocoa  Pre-Finance   ← land
//             SUW 1  banana Profit Sharing ← subplot of SJ0015
// (user, 2026-11-02). The ledgers already keep them as separate plot codes; this
// only records that they are one land, and which commodity each one is for.
//
//   1. plot.parent_plot_id, plot.commodities_id (DDL as in db/schema.sql)
//   2. the links and commodities above
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateSubplots2026-11.js
//   node scripts/migrateSubplots2026-11.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

const LANDS = [
  { land: 'SJ0009', landCommodity: 'Cocoa', subplot: 'LA', subCommodity: 'Banana' },
  { land: 'SJ0015', landCommodity: 'Cocoa', subplot: 'SUW 1', subCommodity: 'Banana' },
];

async function hasColumn(c, col) {
  const [r] = await c.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plot' AND COLUMN_NAME = ?",
    [DB, col]);
  return r.length > 0;
}

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    // 1. columns
    if (!(await hasColumn(c, 'parent_plot_id'))) {
      log('+ plot.parent_plot_id, plot.commodities_id (+ FK)');
      if (APPLY) {
        await c.query(
          `ALTER TABLE plot
             ADD COLUMN parent_plot_id INT NULL AFTER inside_kth,
             ADD COLUMN commodities_id INT NULL AFTER parent_plot_id,
             ADD CONSTRAINT fk_plot_parent FOREIGN KEY (parent_plot_id) REFERENCES plot(id) ON DELETE SET NULL,
             ADD CONSTRAINT fk_plot_commodity FOREIGN KEY (commodities_id) REFERENCES commodities(id) ON DELETE SET NULL`);
      }
    } else log('= columns already there');
    const cols = APPLY || (await hasColumn(c, 'parent_plot_id'));
    const hasCode = await hasColumn(c, 'ledger_code');

    // 2. links
    const commodity = async (prefix) => {
      const [r] = await c.query('SELECT id, commodities_name FROM commodities WHERE commodities_name LIKE ?', [`${prefix}%`]);
      if (r.length !== 1) throw new Error(`Komoditas "${prefix}…" ditemukan ${r.length} kali`);
      return r[0];
    };
    for (const L of LANDS) {
      const [rows] = await c.query(
        `SELECT p.id, p.plot_name, p.scheme, p.farmer_id, f.farmer_name
              ${cols ? ', p.parent_plot_id, p.commodities_id' : ''}${hasCode ? ', p.ledger_code' : ''}
         FROM plot p LEFT JOIN farmers f ON f.id = p.farmer_id
         WHERE p.plot_name IN (?, ?)${hasCode ? ' OR p.ledger_code = ?' : ''}`, [L.land, L.subplot, L.subplot]);
      // After migrateSubplotNames2026-11.js the subplot is called "SJ0015 · Pisang"
      // and its ledger code lives in ledger_code.
      const land = rows.find((r) => r.plot_name === L.land);
      const sub = rows.find((r) => r.plot_name === L.subplot || r.ledger_code === L.subplot);
      if (!land || !sub || rows.length !== 2) throw new Error(`${L.land} / ${L.subplot}: plot tidak ditemukan tepat satu kali`);
      if (land.farmer_id !== sub.farmer_id) throw new Error(`${L.land} dan ${L.subplot} beda petani`);
      if (land.scheme !== 'PreFinance' || sub.scheme !== 'ProfitSharing') {
        throw new Error(`${L.land}=${land.scheme}, ${L.subplot}=${sub.scheme} — skema tidak seperti yang diharapkan`);
      }
      const lc = await commodity(L.landCommodity);
      const sc = await commodity(L.subCommodity);
      const todo = [];
      if (land.commodities_id !== lc.id) todo.push([`UPDATE plot SET commodities_id = ?, updated_at = NOW() WHERE id = ?`, [lc.id, land.id]]);
      if (sub.commodities_id !== sc.id || sub.parent_plot_id !== land.id) {
        todo.push([`UPDATE plot SET commodities_id = ?, parent_plot_id = ?, updated_at = NOW() WHERE id = ?`, [sc.id, land.id, sub.id]]);
      }
      log(`${todo.length ? '~' : '='} ${land.farmer_name}: ${L.land} (${lc.commodities_name}, ${land.scheme}) ← ${L.subplot} (${sc.commodities_name}, ${sub.scheme})`);
      if (APPLY) for (const [sql, args] of todo) await c.query(sql, args);
    }
    log(APPLY ? 'done' : 'dry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
