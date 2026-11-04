// -----------------------------------------------------------------------------
// Migration: a price on every received line, so Stock In can show value (2026-11)
//
// stock_in_items had quantities only; the Stock In screen could say what came in
// but not what it was worth. `unit_price` is filled from:
//   · the PO line it was received against (purchase_order_items.unit_price);
//   · for the ledger imports (SIH-JNBS-…, importJnbsSheets2026-11.js), the
//     nota total the import wrote into stock_in.notes ("… = Rp 16.467.000"),
//     divided by the quantity — the receipt holds one line.
// A line with neither stays NULL ("harga tidak tercatat").
//
// Idempotent: only fills NULL prices. Dry-run by default.
//
// Usage:
//   node scripts/migrateStockInPrice2026-11.js [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const [[col]] = await c.query(`SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = 'stock_in_items' AND COLUMN_NAME = 'unit_price'`, [DB]);
    if (!Number(col.n)) {
      log('+ stock_in_items.unit_price');
      if (APPLY) await c.query('ALTER TABLE stock_in_items ADD COLUMN `unit_price` DECIMAL(15,2) NULL AFTER `received_qty`');
    }
    const priceCol = Number(col.n) || APPLY ? 'sii.unit_price' : 'NULL';

    const [po] = await c.query(`SELECT sii.id, sii.received_qty, poi.unit_price FROM stock_in_items sii
      JOIN purchase_order_items poi ON poi.id = sii.po_item_id WHERE ${priceCol} IS NULL`);
    log(`1) dari harga PO: ${po.length} baris, ${rp(po.reduce((s, r) => s + Number(r.received_qty) * Number(r.unit_price), 0))}`);

    const [led] = await c.query(`SELECT sii.id, sii.received_qty, si.stock_in_number, si.notes,
        (SELECT COUNT(*) FROM stock_in_items y WHERE y.stock_in_id = si.id) AS lines_n
      FROM stock_in_items sii JOIN stock_in si ON si.id = sii.stock_in_id
      WHERE si.stock_in_number LIKE 'SIH-%' AND sii.po_item_id IS NULL AND ${priceCol} IS NULL`);
    const fromNota = []; const skipped = [];
    for (const r of led) {
      const m = String(r.notes || '').match(/= Rp ([\d.]+)/);
      const total = m ? Number(m[1].replace(/\./g, '')) : null;
      if (total == null || !(Number(r.received_qty) > 0) || Number(r.lines_n) !== 1) { skipped.push(r.stock_in_number); continue; }
      fromNota.push({ id: r.id, price: Math.round((total / Number(r.received_qty)) * 100) / 100, total });
    }
    log(`2) dari nota impor buku besar: ${fromNota.length} baris, ${rp(fromNota.reduce((s, r) => s + r.total, 0))}`
      + (skipped.length ? ` · dilewati ${skipped.length}: ${skipped.slice(0, 10).join(', ')}` : ''));
    const [[left]] = await c.query(`SELECT COUNT(*) n FROM stock_in_items sii LEFT JOIN stock_in si ON si.id = sii.stock_in_id
      WHERE ${priceCol} IS NULL AND sii.po_item_id IS NULL AND si.stock_in_number NOT LIKE 'SIH-%'`);
    log(`3) tanpa PO & bukan impor — harga tidak tercatat: ${left.n} baris`);

    if (!APPLY) { log('\ndry-run only; re-run with --apply'); return; }
    await c.beginTransaction();
    for (const r of po) await c.query('UPDATE stock_in_items SET unit_price = ? WHERE id = ? AND unit_price IS NULL', [r.unit_price, r.id]);
    for (const r of fromNota) await c.query('UPDATE stock_in_items SET unit_price = ? WHERE id = ? AND unit_price IS NULL', [r.price, r.id]);
    await c.commit();
    log('\ndone');
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
