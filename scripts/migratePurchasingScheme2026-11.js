// -----------------------------------------------------------------------------
// Migration + import: each delivery's scheme, and the Pre-Finance deliveries of
// the five JNBS profit-sharing plots (2026-11)
//
// The five plots of Mustari (GK006001, GK006002, GW006003), Eko Irawan
// (SM003002) and Yudis (SM019003) were Pre-Finance until 28 Aug 2025 and profit
// sharing after. Their deliveries were imported with the plot's current scheme,
// so the Pre-Finance ones — bought at Rp 2.850/kg with the loan deducted — sit
// in the system at price 0 with no deduction, and count towards the profit
// share. The JNBS "Farmer Loan Overview - Banana" reads them from
// `OLD_Buku Besar Banana Harvesting & Offtake Data 2025.xlsx`, sheet
// `Data Pembelian & Penjualan Pisang`:
//   D plot · F kg · G purchase value · J saprodi deducted · K labour deducted ·
//   M paid to the farmer · BX date
//
//   1. purchasing.scheme — the plot's scheme on the day of the delivery, like
//      pre_finance_distributions.scheme. The five plots are PreFinance up to and
//      including 28 Aug 2025: the sheet still buys and deducts on that day.
//   2. the same boundary for distributions: lines of 28 Aug 2025 on those plots
//      go back to PreFinance (migrateDistributionScheme2026-11.js now uses it).
//   3. every Pre-Finance delivery of those plots in the sheet: price = G / F, and
//      the deduction J + K booked as its installment (purchasing_id set), unless
//      the delivery already carries one. A sheet row matching no delivery — or
//      several — is listed and skipped.
//   4. the TK ledger (`02_FIN_Loan Ledger_TK`, imported 2026-08 as instalments
//      with no delivery, note "Cicilan hutang tenaga kerja") holds the SAME
//      labour deductions for these plots — same farmer, same day, same rupiah.
//      Once the delivery carries it, that copy is removed; one the sheet has no
//      delivery for stays.
//
// Idempotent. Dry-run by default (everything is written in a transaction and
// rolled back, so the report shows the result).
//
// Usage:
//   node scripts/migratePurchasingScheme2026-11.js --file "<OLD_Buku Besar ... .xlsx>" [--verbose]
//   node scripts/migratePurchasingScheme2026-11.js --file "<OLD_Buku Besar ... .xlsx>" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const FILE = arg('--file');
const DB = process.env.DB_NAME || 'agro_supply';
const SWITCHED = ['SM003002', 'SM019003', 'GK006001', 'GK006002', 'GW006003'];
const PF_UNTIL = '2025-08-28';        // last Pre-Finance day, inclusive
const SHEET = 'Data Pembelian & Penjualan Pisa';   // Excel cuts sheet names at 31
const log = (...a) => console.log(...a);
const rp = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
if (!FILE) { console.error('Usage: --file <OLD_Buku Besar ... .xlsx> [--apply] [--verbose]'); process.exit(2); }

const cv = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? (v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : null)) : v);
const num = (v) => { const x = cv(v); return typeof x === 'number' && isFinite(x) ? x : (x != null && String(x).trim() !== '' && isFinite(Number(x)) ? Number(x) : 0); };
// BX is a formula; its cached result is an Excel serial day number, not a Date.
const ymd = (v) => {
  const x = cv(v);
  if (x instanceof Date && !isNaN(x)) return x.toISOString().slice(0, 10);
  if (typeof x === 'number' && x > 30000 && x < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(x) * 86400000).toISOString().slice(0, 10);
  return null;
};
const col = (L) => [...L].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

async function readSheet() {
  const ExcelJS = require('exceljs');
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(FILE, { sharedStrings: 'cache', styles: 'cache', worksheets: 'emit' });
  for await (const ws of reader) {
    if (!ws.name.startsWith(SHEET)) { for await (const _ of ws) { /* skip */ } continue; }
    const rows = [];
    for await (const row of ws) {
      if (row.number < 5) continue;
      const v = []; row.eachCell({ includeEmpty: true }, (c, i) => { v[i - 1] = c.value; });
      const plot = String(cv(v[col('D')]) ?? '').trim();
      if (!SWITCHED.includes(plot)) continue;
      rows.push({ row: row.number, plot, date: ymd(v[col('BX')]), kg: num(v[col('F')]), buy: num(v[col('G')]),
        sap: num(v[col('J')]), tk: num(v[col('K')]), paid: num(v[col('M')]) });
    }
    return rows;
  }
  throw new Error(`Sheet "${SHEET}…" tidak ada`);
}

(async () => {
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  const sheet = (await readSheet()).filter((r) => r.date && r.date <= PF_UNTIL && r.kg > 0);
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB, dateStrings: true,
  });
  const q = async (sql, a = []) => (await c.query(sql, a))[0];
  try {
    const debt = async () => q(`SELECT f.farmer_name, t.type_name, ROUND(o.outstanding) os FROM v_pre_finance_outstanding o
      JOIN farmers f ON f.id = o.farmer_id JOIN pre_finance_types t ON t.id = o.pre_finance_type_id
      WHERE o.farmer_id IN (SELECT farmer_id FROM plot WHERE plot_name IN (?)) ORDER BY 1, 2`, [SWITCHED]);
    const before = await debt();

    // ── 1. column
    const [[has]] = await c.query(`SELECT COUNT(*) n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'purchasing' AND COLUMN_NAME = 'scheme'`, [DB]);
    if (!Number(has.n)) {
      // DDL commits on its own — it runs before the transaction and only adds a column.
      if (APPLY) await c.query("ALTER TABLE purchasing ADD COLUMN `scheme` ENUM('BeliPutus','PreFinance','ProfitSharing') NOT NULL DEFAULT 'BeliPutus' AFTER `total_value`");
      else log('1) kolom purchasing.scheme belum ada — dry-run tidak bisa menampilkan sisa langkah tanpa kolom itu; laporan di bawah dihitung tanpa menulis');
    }
    await c.beginTransaction();
    const want = `CASE WHEN pu.supplier_type <> 'farmer' OR pl.id IS NULL THEN 'BeliPutus'
                       WHEN pl.plot_name IN (?) AND pu.date <= ? THEN 'PreFinance' ELSE pl.scheme END`;
    const plan = await q(`SELECT ${want} AS scheme, COUNT(*) n, ROUND(SUM(pu.quantity)) kg
      FROM purchasing pu LEFT JOIN plot pl ON pl.id = pu.plot_id GROUP BY 1 ORDER BY 1`, [SWITCHED, PF_UNTIL]);
    log('1) purchasing.scheme:');
    plan.forEach((r) => log(`   ${String(r.scheme).padEnd(14)} ${String(r.n).padStart(6)} setoran ${String(r.kg).padStart(10)} kg`));
    const sw = await q(`SELECT pl.plot_name, SUM(pu.date <= ?) pf, SUM(pu.date > ?) ps FROM purchasing pu JOIN plot pl ON pl.id = pu.plot_id
      WHERE pl.plot_name IN (?) GROUP BY 1 ORDER BY 1`, [PF_UNTIL, PF_UNTIL, SWITCHED]);
    sw.forEach((r) => log(`   ${r.plot_name}: ${r.pf} setoran Pre-Finance (s/d ${PF_UNTIL}), ${r.ps} profit sharing`));
    if (Number(has.n) || APPLY) {
      await q(`UPDATE purchasing pu LEFT JOIN plot pl ON pl.id = pu.plot_id SET pu.scheme = ${want}
        WHERE pu.scheme <> ${want}`, [SWITCHED, PF_UNTIL, SWITCHED, PF_UNTIL]);
    }

    // ── 2. distributions of the boundary day
    const edge = await q(`SELECT d.id, d.date, d.total_amount, d.description, p.plot_name FROM pre_finance_distributions d
      JOIN plot p ON p.id = d.plot_id WHERE p.plot_name IN (?) AND d.date = ? AND d.scheme = 'ProfitSharing'`, [SWITCHED, PF_UNTIL]);
    log(`2) distribusi tanggal ${PF_UNTIL} di lima lahan → PreFinance: ${edge.length} (${rp(edge.reduce((s, x) => s + Number(x.total_amount), 0))})`);
    for (const x of edge) {
      log(`   ~ #${x.id} ${x.plot_name} ${rp(x.total_amount)} ${x.description}`);
      const desc = String(x.description || '').replace(/^Tenaga kerja lahan bagi hasil/, 'Hutang tenaga kerja');
      await q("UPDATE pre_finance_distributions SET scheme = 'PreFinance', description = ?, updated_at = NOW() WHERE id = ?", [desc, x.id]);
    }

    // ── 3. the Pre-Finance deliveries
    const [[types]] = await c.query("SELECT MAX(IF(type_name='Saprodi', id, NULL)) sap, MAX(IF(type_name='Labor', id, NULL)) lab FROM pre_finance_types");
    const stats = { matched: 0, priced: 0, booked: 0, already: 0, none: 0, many: 0, sap: 0, tk: 0, dedup: 0, dedupRp: 0 };
    const problems = [];
    const used = new Set();
    for (const r of sheet) {
      const cands = (Number(has.n) || APPLY) ? await q(`SELECT pu.id, pu.quantity, pu.price_per_unit, pl.farmer_id,
          (SELECT i.id FROM pre_finance_installments i WHERE i.purchasing_id = pu.id) AS inst
        FROM purchasing pu JOIN plot pl ON pl.id = pu.plot_id
        WHERE pl.plot_name = ? AND pu.date = ? AND ABS(pu.quantity - ?) < 0.006 ORDER BY pu.id`, [r.plot, r.date, r.kg]) : [];
      const free = cands.filter((x) => !used.has(x.id));
      if (!free.length) { stats.none++; problems.push(`baris ${r.row} ${r.plot} ${r.date} ${r.kg} kg ${rp(r.buy)}: tidak ada setoran yang cocok`); continue; }
      if (free.length > 1) stats.many++;
      const pu = free[0]; used.add(pu.id); stats.matched++;
      if (r.tk > 0) {
        const [dup] = await q(`SELECT i.id, i.total_payment FROM pre_finance_installments i
          WHERE i.purchasing_id IS NULL AND i.farmer_id = ? AND i.date = ? AND ABS(i.total_payment - ?) < 1
            AND i.notes LIKE 'Cicilan hutang tenaga kerja%' ORDER BY i.id LIMIT 1`, [pu.farmer_id, r.date, r.tk]);
        if (dup) {
          await q('DELETE FROM pre_finance_installments WHERE id = ?', [dup.id]);
          stats.dedup++; stats.dedupRp += Number(dup.total_payment);
        }
      }
      const price = Math.round((r.buy / r.kg) * 100) / 100;
      if (Math.abs(Number(pu.price_per_unit) - price) > 0.005) {
        await q("UPDATE purchasing SET price_per_unit = ?, scheme = 'PreFinance', updated_at = NOW() WHERE id = ?", [price, pu.id]);
        stats.priced++;
      }
      if (pu.inst) { stats.already++; continue; }
      const total = Math.round((r.sap + r.tk) * 100) / 100;
      if (!(total > 0)) continue;
      const [ins] = await c.query(`INSERT INTO pre_finance_installments (purchasing_id, farmer_id, date, reference_no, total_payment, notes, created_at, updated_at)
        SELECT ?, ?, ?, receipt_invoice, ?, ?, NOW(), NOW() FROM purchasing WHERE id = ?`,
        [pu.id, pu.farmer_id, r.date, total, `Potongan setoran — Data Pembelian & Penjualan Pisang baris ${r.row}`, pu.id]);
      for (const [tid, amt] of [[types.sap, r.sap], [types.lab, r.tk]]) {
        if (amt > 0) await q('INSERT INTO pre_finance_installment_details (installment_id, pre_finance_type_id, amount) VALUES (?,?,?)',
          [ins.insertId, tid, Math.round(amt * 100) / 100]);
      }
      stats.booked++; stats.sap += r.sap; stats.tk += r.tk;
      if (VERBOSE) log(`   + baris ${r.row} ${r.plot} ${r.date} ${r.kg} kg × ${price} · saprodi ${rp(r.sap)} · TK ${rp(r.tk)}`);
    }
    log(`3) setoran Pre-Finance di sheet (s/d ${PF_UNTIL}): ${sheet.length} · ${rp(sheet.reduce((s, r) => s + r.buy, 0))} · potongan saprodi ${rp(sheet.reduce((s, r) => s + r.sap, 0))}, TK ${rp(sheet.reduce((s, r) => s + r.tk, 0))}`);
    log(`   cocok ${stats.matched} (harga diisi ${stats.priced}) · potongan dicatat ${stats.booked}: saprodi ${rp(stats.sap)}, TK ${rp(stats.tk)} · sudah ada ${stats.already} · tidak cocok ${stats.none}${stats.many ? ` · kandidat ganda ${stats.many}` : ''}`);
    problems.forEach((p) => log(`   ! ${p}`));
    log(`4) cicilan TK tanpa setoran yang kembar dengan potongan setoran — dihapus: ${stats.dedup} (${rp(stats.dedupRp)})`);
    const left = await q(`SELECT f.farmer_name, i.date, i.total_payment FROM pre_finance_installments i JOIN farmers f ON f.id = i.farmer_id
      WHERE i.purchasing_id IS NULL AND i.notes LIKE 'Cicilan hutang tenaga kerja%'
        AND i.farmer_id IN (SELECT farmer_id FROM plot WHERE plot_name IN (?)) ORDER BY 1, 2`, [SWITCHED]);
    left.forEach((x) => log(`   · tetap: ${x.farmer_name} ${x.date} ${rp(x.total_payment)} (tak ada setoran ber-potongan TK sama di sheet)`));

    const after = await debt();
    log('\nutang pre-finance:');
    for (const b of before) {
      const a = after.find((x) => x.farmer_name === b.farmer_name && x.type_name === b.type_name);
      log(`   ${b.farmer_name.padEnd(12)} ${b.type_name.padEnd(8)} ${rp(b.os).padStart(16)} → ${rp(a?.os).padStart(16)}`);
    }
    if (APPLY) { await c.commit(); log('\ndone'); } else { await c.rollback(); log('\ndry-run only; re-run with --apply'); }
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
