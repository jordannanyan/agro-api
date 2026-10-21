// -----------------------------------------------------------------------------
// Backfill: AML loan repayments onto the deliveries they were deducted from (2026-10)
//
// The AML ledger (`AML - Data Entry Banana`) books every pre-finance farmer's
// loan repayment on the delivery row: `Repayment Farmer Loan`. The deliveries
// themselves were imported into `purchasing` long ago, the repayments never were
// — so the farmers' outstanding in the system still reads as if nothing had been
// paid back.
//
// For each ledger row with Process = Purchasing and a repayment > 0, this finds
// the one `purchasing` row with the same plot, date and kilos and books the
// repayment on it as a `pre_finance_installments` row (purchasing_id set),
// split into Saprodi / Labor by the plot's rate in force that day
// (`payback_rates`, loaded by migratePaybackRates2026-10.js).
//
// The ledger's amount is the authority, not kilos × rate: it is what the farmer
// was actually paid less. Where the two differ the row is listed, and the split
// follows the rate's proportions.
//
// Never written:
//   - a ledger row matching no delivery, or more than one   → listed, skipped
//   - a delivery that already carries a deduction           → left as it is
//   - a farmer whose repayments would exceed the debt the system holds for them
//     → listed in the report; the rows are still booked, because the ledger says
//       the deduction happened. A negative outstanding then shows exactly where
//       the debt side (pre_finance_distributions) is missing something.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/backfillAmlRepayments2026-10.js --ledger "../pre-finance data/[G-Sheet Format] Buku Besar - AML - Banana.xlsx"
//   node scripts/backfillAmlRepayments2026-10.js --ledger "<xlsx>" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const li = process.argv.indexOf('--ledger');
const LEDGER = li > 0 ? process.argv[li + 1] : null;
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const SHEET = 'AML - Data Entry Banana';

if (!LEDGER) { console.error('Usage: --ledger <AML ledger .xlsx> [--apply] [--verbose]'); process.exit(2); }

function cellValue(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
}
const ymd = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null);
const round2 = (n) => Math.round(n * 100) / 100;
const rp = (n) => `Rp ${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 })}`;

async function readLedger(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`Sheet "${SHEET}" tidak ada di file itu`);
  // By header text, newlines folded: the headers are wrapped ("Repayment \nFarmer Loan").
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const header = {};
  ws.getRow(1).eachCell((c, n) => { header[norm(cellValue(c.value))] = n; });
  const need = ['Date', 'Process', 'Plot ID', 'Purchase Volume', 'Repayment Farmer Loan'];
  for (const h of need) if (!header[h]) throw new Error(`Kolom "${h}" tidak ditemukan di header`);
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const g = (h) => cellValue(row.getCell(header[h]).value);
    if (String(g('Process') || '').trim() !== 'Purchasing') return;
    const repayment = Number(g('Repayment Farmer Loan')) || 0;
    if (repayment <= 0) return;
    out.push({
      line: n,
      date: ymd(g('Date')),
      plot: String(g('Plot ID') || '').trim(),
      qty: Number(g('Purchase Volume')) || 0,
      repayment: round2(repayment),
    });
  });
  return out;
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    dateStrings: true,
  });
  log(`\n=== Backfill potongan cicilan AML → purchasing — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const [[hasRates]] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'payback_rates'`, [DB]);
  if (!hasRates.n) { console.error('Tabel payback_rates belum ada — jalankan migratePaybackRates2026-10.js --apply dulu.'); process.exit(1); }

  const rows = await readLedger(LEDGER);
  log(`  ${rows.length} baris Purchasing dengan Repayment > 0 di "${SHEET}"`);

  const [types] = await conn.query("SELECT id, type_name FROM pre_finance_types WHERE type_name IN ('Saprodi','Labor')");
  const typeId = Object.fromEntries(types.map((t) => [t.type_name, t.id]));

  // `GE007002-OGA` = plot GE007002, grade A (same reading as the rates importer);
  // a plot that really has the suffix in its name is matched as itself.
  const GRADE_SUFFIX = { OGA: 'A', OGB: 'B', OGC: 'C', OGNG: 'Non-Grade' };
  const [plotRows] = await conn.query('SELECT UPPER(TRIM(plot_name)) AS n FROM plot');
  const plotNames = new Set(plotRows.map((p) => p.n));
  const resolve = (code) => {
    const up = code.toUpperCase();
    const m = up.match(/^(.+)-(OGA|OGB|OGC|OGNG)$/);
    if (!plotNames.has(up) && m && plotNames.has(m[1])) return { plot: m[1], grade: GRADE_SUFFIX[m[2]] };
    return { plot: up, grade: null };
  };

  const stats = { matched: 0, already: 0, none: 0, many: 0, noRate: 0, differs: 0, booked: 0, amount: 0 };
  const perFarmer = new Map();
  const problems = [];

  for (const r of rows) {
    const tag = `baris ${r.line} ${r.plot} ${r.date} ${r.qty} kg`;
    if (!r.date || !r.plot) { problems.push(`${tag}: tanggal/plot kosong`); stats.none++; continue; }
    // Kilos compared to 3 decimals, the precision `purchasing.quantity` keeps.
    const [cands] = await conn.query(
      `SELECT pu.id, pu.grade_id, pu.quantity, pl.id AS plot_id, pl.farmer_id, pl.scheme, f.farmer_name,
              (SELECT i.id FROM pre_finance_installments i WHERE i.purchasing_id = pu.id) AS installment_id
       FROM purchasing pu
       JOIN plot pl ON pl.id = pu.plot_id
       LEFT JOIN farmers f ON f.id = pl.farmer_id
       WHERE UPPER(TRIM(pl.plot_name)) = ? AND pu.date = ? AND ABS(pu.quantity - ?) < 0.0005
         AND (? IS NULL OR pu.grade_id = (SELECT id FROM grade WHERE grade_name = ?))`,
      [resolve(r.plot).plot, r.date, r.qty, resolve(r.plot).grade, resolve(r.plot).grade]);
    if (!cands.length) { problems.push(`${tag}: tidak ada purchasing yang cocok`); stats.none++; continue; }
    // Same plot, day and kilos twice: either a duplicate import or two genuine
    // deliveries. Take the ones without a deduction yet, oldest first, one per
    // ledger row — the ledger then has the same number of rows.
    const free = cands.filter((c) => !c.installment_id);
    if (!free.length) { stats.already++; continue; }
    if (cands.length > 1) stats.many++;
    const pu = free.sort((a, b) => a.id - b.id)[0];
    stats.matched++;

    const [[rate]] = await conn.query(
      `SELECT * FROM payback_rates WHERE plot_id = ? AND effective_date <= ? AND (grade_id IS NULL OR grade_id = ?)
       ORDER BY effective_date DESC, (grade_id IS NULL) ASC, id DESC LIMIT 1`, [pu.plot_id, r.date, pu.grade_id]);
    let saprodi, labor;
    const s = Number(rate?.saprodi_per_kg || 0), l = Number(rate?.labor_per_kg || 0);
    if (!rate || s + l === 0) {
      // No rate to split by: the ledger's sheet had only Input Payback before the
      // labour deductions began, so an unrated deduction is saprodi.
      stats.noRate++;
      problems.push(`${tag}: tidak ada tarif — dicatat sebagai Saprodi`);
      saprodi = r.repayment; labor = 0;
    } else {
      const expected = round2(r.qty * (s + l));
      if (Math.abs(expected - r.repayment) > 1) {
        stats.differs++;
        if (VERBOSE) problems.push(`${tag}: buku besar ${rp(r.repayment)} ≠ kg × tarif ${rp(expected)}`);
      }
      saprodi = round2(r.repayment * s / (s + l));
      labor = round2(r.repayment - saprodi);
    }

    const f = perFarmer.get(pu.farmer_id) || { name: pu.farmer_name, Saprodi: 0, Labor: 0 };
    f.Saprodi += saprodi; f.Labor += labor;
    perFarmer.set(pu.farmer_id, f);
    stats.amount += r.repayment;

    if (APPLY) {
      await conn.beginTransaction();
      try {
        const [ins] = await conn.query(
          `INSERT INTO pre_finance_installments (purchasing_id, farmer_id, date, reference_no, total_payment, notes, created_at, updated_at)
           SELECT ?, ?, ?, receipt_invoice, ?, ?, NOW(), NOW() FROM purchasing WHERE id = ?`,
          [pu.id, pu.farmer_id, r.date, r.repayment, `Potongan setoran — AML Data Entry baris ${r.line}`, pu.id]);
        const iid = ins.insertId;
        for (const [name, amt] of [['Saprodi', saprodi], ['Labor', labor]]) {
          if (amt > 0) {
            await conn.query(
              'INSERT INTO pre_finance_installment_details (installment_id, pre_finance_type_id, amount) VALUES (?,?,?)',
              [iid, typeId[name], amt]);
          }
        }
        await conn.commit();
        stats.booked++;
      } catch (e) { await conn.rollback(); throw e; }
    }
  }

  log(`  cocok ${stats.matched} · sudah ada potongan ${stats.already} · tidak ketemu ${stats.none}`
    + ` · kandidat ganda ${stats.many} · tanpa tarif ${stats.noRate} · beda dari kg × tarif ${stats.differs}`);
  log(`  total potongan ${APPLY ? 'dicatat' : 'yang akan dicatat'}: ${rp(stats.amount)}${APPLY ? ` (${stats.booked} cicilan)` : ''}`);

  // Debt check per farmer: what the system holds as owed vs what this books.
  log('\n  Per petani (utang di sistem vs potongan dari buku besar):');
  for (const [farmerId, f] of perFarmer) {
    const [o] = await conn.query(
      `SELECT type_name, distributed_total, paid_total FROM v_pre_finance_outstanding
       WHERE farmer_id = ? AND type_name IN ('Saprodi','Labor')`, [farmerId]);
    const by = Object.fromEntries(o.map((x) => [x.type_name, x]));
    for (const t of ['Saprodi', 'Labor']) {
      if (!f[t]) continue;
      const debt = Number(by[t]?.distributed_total || 0);
      // After --apply the view already includes these rows; before it, add them.
      const paid = Number(by[t]?.paid_total || 0) + (APPLY ? 0 : f[t]);
      const left = debt - paid;
      log(`   ${left < 0 ? '!' : ' '} ${f.name.padEnd(18)} ${t.padEnd(7)} utang ${rp(debt).padStart(18)} · dibayar ${rp(paid).padStart(18)} · sisa ${rp(left)}`);
    }
  }

  if (problems.length) {
    log(`\n  Catatan (${problems.length}):`);
    problems.slice(0, 80).forEach((p) => log(`   - ${p}`));
    if (problems.length > 80) log(`   … ${problems.length - 80} lagi`);
  }
  if (!VERBOSE && stats.differs) log(`\n  (${stats.differs} baris beda dari kg × tarif — tambah --verbose untuk melihatnya)`);
  log(APPLY ? '\nSelesai.' : '\nDRY RUN — jalankan dengan --apply untuk mencatat.');
  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
