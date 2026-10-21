// -----------------------------------------------------------------------------
// Migration: loan repayment deducted at the delivery (2026-10)
//
// The ledger books a pre-finance farmer's loan repayment on the delivery row
// itself — AML `Repayment Farmer Loan` = kilos × the plot's payback per kilo from
// `AML - Purchase Price Database` (the older sheet: `Jumlah Potongan Saprodi` +
// `Jumlah Potongan Tenaga Kerja`). Until now the system had the column for it
// (`pre_finance_installments.purchasing_id`) but no screen ever filled it: every
// installment was typed by hand, unlinked, and most deductions were never booked.
//
// This script:
//   1. creates `payback_rates` (DDL read from db/schema.sql);
//   2. makes `pre_finance_installments.purchasing_id` UNIQUE and its FK
//      ON DELETE CASCADE — one deduction per delivery, and it goes with it;
//   3. with --rates <xlsx>, loads the rates from the AML ledger's
//      `AML - Purchase Price Database` sheet.
//
// Rate rows are mapped like this:
//   Plot ID `GW012001`          → that plot, every grade
//   Plot ID `GE007002-OGA` etc. → plot `GE007002`, grade A / B / C / Non-Grade —
//                                 unless a plot with the full suffixed name exists
//                                 (Arifin's), which is then the plot itself
//   rows with no payback at all → skipped: nothing to deduct
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migratePaybackRates2026-10.js
//   node scripts/migratePaybackRates2026-10.js --apply
//   node scripts/migratePaybackRates2026-10.js --rates "../pre-finance data/[G-Sheet Format] Buku Besar - AML - Banana.xlsx" --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const ratesIdx = process.argv.indexOf('--rates');
const RATES_FILE = ratesIdx > 0 ? process.argv[ratesIdx + 1] : null;
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

function ddlFor(schema, table) {
  const head = 'CREATE TABLE `' + table + '` (';
  const i = schema.indexOf(head);
  if (i < 0) throw new Error(`DDL untuk \`${table}\` tidak ditemukan di db/schema.sql`);
  const tail = ') ENGINE=InnoDB;';
  const j = schema.indexOf(tail, i);
  if (j < 0) throw new Error(`Penutup DDL \`${table}\` tidak ditemukan di db/schema.sql`);
  return schema.slice(i, j + tail.length);
}

/** A cell's value, resolving formulas to their cached result. */
function cellValue(v) {
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result;
    if (v instanceof Date) return v;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
}

const ymd = (d) => {
  if (!(d instanceof Date)) return null;
  // Sheet dates are midnight UTC; the date part is the calendar date.
  return d.toISOString().slice(0, 10);
};

const GRADE_SUFFIX = { OGA: 'A', OGB: 'B', OGC: 'C', OGNG: 'Non-Grade' };

async function readRates(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('AML - Purchase Price Database');
  if (!ws) throw new Error('Sheet "AML - Purchase Price Database" tidak ada di file itu');
  // Columns are located by header, not by position: the sheet is a shared
  // Google Sheet and a column inserted on the left must not shift every rate.
  const header = {};
  ws.getRow(1).eachCell((c, n) => { header[String(cellValue(c.value) || '').trim()] = n; });
  const need = ['Plot ID', 'Effective Date', 'Full Purchase Price', 'Labour Payback', 'Input Payback'];
  for (const h of need) if (!header[h]) throw new Error(`Kolom "${h}" tidak ditemukan di header sheet`);
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const g = (h) => cellValue(row.getCell(header[h]).value);
    const plot = String(g('Plot ID') || '').trim();
    if (!plot) return;
    out.push({
      line: n,
      plot,
      farmer: header['Farmer Name'] ? row.getCell(header['Farmer Name']).text.trim() : '',
      date: ymd(g('Effective Date')),
      full: Number(g('Full Purchase Price')) || null,
      labor: Number(g('Labour Payback')) || 0,
      saprodi: Number(g('Input Payback')) || 0,
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
    multipleStatements: true,
  });

  log(`\n=== Migrasi potongan cicilan di setoran — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  let changes = 0;

  // 1. payback_rates
  const [[t]] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [DB, 'payback_rates']);
  if (t.n) log('  tabel `payback_rates` sudah ada — dilewati');
  else {
    log('  tabel `payback_rates` akan dibuat dari db/schema.sql');
    changes++;
    if (APPLY) { await conn.query(ddlFor(schema, 'payback_rates')); log('   dibuat'); }
  }

  // 2. one deduction per delivery, cascading with it
  const [[fk]] = await conn.query(
    `SELECT DELETE_RULE AS rule FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = 'fk_pfi_purchasing'`, [DB]);
  const [uq] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'pre_finance_installments' AND INDEX_NAME = 'uq_pfi_purchasing'`, [DB]);
  if (fk && fk.rule === 'CASCADE' && uq.length) {
    log('  pre_finance_installments.purchasing_id sudah UNIQUE + CASCADE — dilewati');
  } else {
    const [dups] = await conn.query(
      `SELECT purchasing_id, COUNT(*) AS n FROM pre_finance_installments
       WHERE purchasing_id IS NOT NULL GROUP BY purchasing_id HAVING n > 1`);
    if (dups.length) {
      log(`  ✗ ${dups.length} purchasing punya lebih dari satu cicilan — selesaikan dulu, UNIQUE tidak bisa dipasang:`);
      dups.slice(0, 20).forEach((d) => log(`     purchasing #${d.purchasing_id}: ${d.n} cicilan`));
      process.exit(1);
    }
    log(`  pre_finance_installments.purchasing_id → UNIQUE + ON DELETE CASCADE (sekarang: ${fk ? fk.rule : 'tanpa FK'})`);
    changes++;
    if (APPLY) {
      if (fk) await conn.query('ALTER TABLE pre_finance_installments DROP FOREIGN KEY fk_pfi_purchasing');
      // The FK's own index is redundant once the UNIQUE key exists, and a clean
      // install has none — keeping it would make the two schemas differ.
      const [ix] = await conn.query(
        `SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'pre_finance_installments' AND INDEX_NAME = 'fk_pfi_purchasing'`, [DB]);
      if (ix.length) await conn.query('ALTER TABLE pre_finance_installments DROP INDEX fk_pfi_purchasing');
      if (!uq.length) await conn.query('ALTER TABLE pre_finance_installments ADD UNIQUE KEY `uq_pfi_purchasing` (`purchasing_id`)');
      await conn.query(
        'ALTER TABLE pre_finance_installments ADD CONSTRAINT `fk_pfi_purchasing` FOREIGN KEY (`purchasing_id`) '
        + 'REFERENCES `purchasing`(`id`) ON DELETE CASCADE');
      log('   diubah');
    }
  }

  // 3. rates from the ledger
  if (RATES_FILE) {
    log(`\n  Tarif dari: ${RATES_FILE}`);
    const rows = await readRates(RATES_FILE);
    const [plots] = await conn.query('SELECT id, plot_name, scheme FROM plot');
    const plotByName = new Map(plots.map((p) => [p.plot_name.trim().toUpperCase(), p]));
    const [grades] = await conn.query('SELECT id, grade_name FROM grade');
    const gradeByName = new Map(grades.map((g) => [g.grade_name, g.id]));
    const tableReady = t.n || APPLY;
    let add = 0, same = 0, skip = 0;
    for (const r of rows) {
      const tag = `baris ${r.line} ${r.plot} ${r.date}`;
      if (!r.saprodi && !r.labor) { log(`   - ${tag}: tanpa payback — dilewati`); skip++; continue; }
      if (!r.date) { log(`   ✗ ${tag}: Effective Date kosong — dilewati`); skip++; continue; }
      let plot = plotByName.get(r.plot.toUpperCase());
      let gradeId = null;
      const m = r.plot.match(/^(.+)-(OGA|OGB|OGC|OGNG)$/i);
      if (!plot && m) {
        plot = plotByName.get(m[1].toUpperCase());
        gradeId = gradeByName.get(GRADE_SUFFIX[m[2].toUpperCase()]) ?? null;
        if (gradeId == null) { log(`   ✗ ${tag}: grade ${GRADE_SUFFIX[m[2].toUpperCase()]} tidak ada`); skip++; continue; }
      }
      if (!plot) { log(`   ✗ ${tag}: plot tidak ditemukan`); skip++; continue; }
      if (plot.scheme !== 'PreFinance') log(`   ! ${tag}: plot berskema ${plot.scheme}, tarif tetap dicatat`);
      if (tableReady && t.n) {
        const [ex] = await conn.query(
          'SELECT id FROM payback_rates WHERE plot_id = ? AND grade_id <=> ? AND effective_date = ? LIMIT 1',
          [plot.id, gradeId, r.date]);
        if (ex.length) { same++; continue; }
      }
      log(`   + ${tag} → plot #${plot.id}${gradeId ? ` grade #${gradeId}` : ''}: saprodi ${r.saprodi}/kg, labor ${r.labor}/kg, harga penuh ${r.full}`);
      add++;
      if (APPLY) {
        // The ledger lists some rows twice; the unique key makes the second a no-op.
        await conn.query(
          `INSERT IGNORE INTO payback_rates (plot_id, grade_id, effective_date, full_price, saprodi_per_kg, labor_per_kg, notes, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
          [plot.id, gradeId, r.date, r.full, r.saprodi, r.labor, `AML - Purchase Price Database baris ${r.line}`]);
      }
    }
    log(`  tarif: ${add} baru, ${same} sudah ada, ${skip} dilewati`);
    changes += add;
  }

  log(`\n${changes ? `${changes} perubahan` : 'Tidak ada perubahan'}${APPLY ? ' diterapkan.' : ' — jalankan dengan --apply untuk menerapkan.'}`);
  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
