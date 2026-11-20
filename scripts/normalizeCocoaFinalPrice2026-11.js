// -----------------------------------------------------------------------------
// Migration: SNBS cocoa deliveries to the final price (2026-11)
//
// A Pre-Finance delivery keeps the FINAL price — what the farmer is paid per kg
// after the loan deduction — so that purchasing.total_value is the cash paid and
// the deduction (pre_finance_installments) is the loan part. The AML banana
// ledger and every banana import do it that way, and so does the web form since
// 2026-11-18 (it takes the full price and stores full − deduction/kg).
//
// The cocoa imports did not: the cocoa ledger records the full price (Susanto,
// 13 May 2026: 17 kg × 51.000 = 867.000, 200.000 deducted, 667.000 paid), so a
// cocoa delivery with a deduction counted the deducted part twice — once in the
// purchase value, once as the loan it repaid. Decided 2026-11-20: make cocoa
// follow the same rule.
//
// For every cocoa delivery with a deduction tied to it, written before the form
// change (created before 2026-11-18 00:40): price := price − deduction / kg. The
// installment gets the mark below, so a re-run never subtracts twice — run it
// again after any later import ties a repayment to a cocoa delivery.
//
// Idempotent. Dry-run by default (written in a transaction, rolled back).
//
// Usage:
//   node scripts/normalizeCocoaFinalPrice2026-11.js [--apply] [--verbose]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const DB = process.env.DB_NAME || 'agro_supply';
const MARK = '[harga-akhir]';
const FORM_CHANGE = '2026-11-18 00:40:00';
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  try {
    await c.beginTransaction();
    const [[cocoa]] = await c.query("SELECT id FROM commodities WHERE commodities_name LIKE 'Cocoa%' LIMIT 1");
    const [rows] = await c.query(
      `SELECT p.id, p.date, p.quantity, p.price_per_unit, p.total_value, i.id AS inst_id, i.total_payment, f.farmer_name
       FROM purchasing p
       JOIN pre_finance_installments i ON i.purchasing_id = p.id
       LEFT JOIN plot pl ON pl.id = p.plot_id LEFT JOIN farmers f ON f.id = pl.farmer_id
       WHERE p.commodities_id = ? AND p.created_at < ? AND COALESCE(i.notes, '') NOT LIKE ?
       ORDER BY p.date, p.id`, [cocoa.id, FORM_CHANGE, `%${MARK}%`]);
    let n = 0, before = 0, after = 0, skipped = 0;
    for (const r of rows) {
      const kg = Number(r.quantity);
      if (!(kg > 0)) { skipped++; log(`   ! #${r.id}: kuantitas 0 — dilewati`); continue; }
      const price = Math.round((Number(r.price_per_unit) - Number(r.total_payment) / kg) * 100) / 100;
      if (price < 0) { skipped++; log(`   ! #${r.id} ${r.date} ${r.farmer_name}: potongan melebihi nilai — dilewati`); continue; }
      await c.query('UPDATE purchasing SET price_per_unit = ?, updated_at = NOW() WHERE id = ?', [price, r.id]);
      await c.query("UPDATE pre_finance_installments SET notes = TRIM(CONCAT(COALESCE(notes, ''), ' ', ?)) WHERE id = ?", [MARK, r.inst_id]);
      const [[x]] = await c.query('SELECT total_value FROM purchasing WHERE id = ?', [r.id]);
      before += Number(r.total_value); after += Number(x.total_value); n++;
      if (VERBOSE) log(`   ${r.date} ${String(r.farmer_name).padEnd(18)} ${kg} kg: ${r.price_per_unit} → ${price} (potong ${rp(r.total_payment)})`);
    }
    log(`\n${n} setoran kakao diubah ke harga akhir · nilai ${rp(before)} → ${rp(after)} (selisih ${rp(before - after)})`);
    if (skipped) log(`${skipped} dilewati`);
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
