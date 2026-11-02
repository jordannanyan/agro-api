// -----------------------------------------------------------------------------
// Migration: a land has one plot ID — subplots take their land's name (2026-11)
//
// "hapus tulisan LA atau SUW 1, id plot nya pokoknya cuma 1" (user, 2026-11-02).
// Every subplot is renamed "<land> · <commodity>", e.g. SUW 1 → "SJ0015 · Pisang",
// so the only plot ID anyone sees for that land is SJ0015. The old code is what
// the SJ Banana ledger writes, so it moves to plot.ledger_code instead of being
// lost (DDL as in db/schema.sql).
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateSubplotNames2026-11.js
//   node scripts/migrateSubplotNames2026-11.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
// Same rule as subplotName() in src/routes/plots.ts.
const short = (n) => (n ? (String(n).match(/\(([^)]+)\)/)?.[1] ?? String(n)) : '');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const [col] = await c.query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'plot' AND COLUMN_NAME = 'ledger_code'", [DB]);
    if (!col.length) {
      log('+ plot.ledger_code');
      if (APPLY) await c.query('ALTER TABLE plot ADD COLUMN ledger_code VARCHAR(100) NULL AFTER commodities_id');
    } else log('= plot.ledger_code already there');

    const [subs] = await c.query(
      `SELECT s.id, s.plot_name, ${col.length ? 's.ledger_code' : 'NULL AS ledger_code'}, p.plot_name AS land, co.commodities_name
       FROM plot s JOIN plot p ON p.id = s.parent_plot_id LEFT JOIN commodities co ON co.id = s.commodities_id
       WHERE s.parent_plot_id IS NOT NULL ORDER BY p.plot_name`);
    for (const s of subs) {
      if (!s.commodities_name) throw new Error(`subplot ${s.plot_name} tanpa komoditas — tidak bisa diberi nama`);
      const name = `${s.land} · ${short(s.commodities_name)}`;
      if (s.plot_name === name) { log(`= ${name} (kode buku besar: ${s.ledger_code ?? '-'})`); continue; }
      const code = s.ledger_code ?? s.plot_name;
      log(`~ ${s.plot_name} → ${name} (kode buku besar: ${code})`);
      if (APPLY) {
        await c.query('UPDATE plot SET plot_name = ?, ledger_code = ?, updated_at = NOW() WHERE id = ?', [name, code, s.id]);
      }
    }
    log(APPLY ? 'done' : 'dry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
