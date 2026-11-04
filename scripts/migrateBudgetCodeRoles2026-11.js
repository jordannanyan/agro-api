// -----------------------------------------------------------------------------
// Migration: who may use each budget code (2026-11)
//
// `260929_SPV_Budget Codes Master File - COA.csv`, column `Role`: each outflow code
// belongs to PPIC, Finance and/or HRD (the sheet writes "FInance"; read as Finance).
// The codes, main accounts, sub accounts and the other COA lists already match the
// system exactly (checked 2026-11-04) — only the role was missing.
//
//   1. budget_codes.roles  (DDL as in db/schema.sql) — "PPIC,Finance,HRD"
//   2. the 51 codes' roles, below
//
// Idempotent, dry-run by default.
//   node scripts/migrateBudgetCodeRoles2026-11.js [--apply]
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const ROLES = [
  ["01-Operational Expenditures - Commission-Offtake", "PPIC"],
  ["01-Operational Expenditures - Delivery Costs-Non-Offtake", "PPIC"],
  ["01-Operational Expenditures - Delivery Costs-Offtake", "PPIC"],
  ["01-Operational Expenditures - Labour-Non Offtake", "PPIC"],
  ["01-Operational Expenditures - Labour-Offtake", "PPIC"],
  ["01-Operational Expenditures - Maintenance", "PPIC"],
  ["01-Operational Expenditures - Material-Non-Offtake", "PPIC"],
  ["01-Operational Expenditures - Material-Offtake", "PPIC"],
  ["01-Operational Expenditures - Profit Sharing", "PPIC"],
  ["01-Operational Expenditures - Purchase-Offtake", "PPIC"],
  ["01-Operational Expenditures - Rental Expenses - Building", "PPIC"],
  ["01-Operational Expenditures - Socialisation Cost", "PPIC"],
  ["02-Investment Expenditures - Building Costs", "Finance"],
  ["02-Investment Expenditures - Fixed Asset - Office Equipment", "Finance"],
  ["02-Investment Expenditures - Fixed Asset - PP&E", "Finance"],
  ["02-Investment Expenditures - Fixed Asset - Vehicle", "Finance"],
  ["03-Financing Expenditures - Injection - Capital", "Finance"],
  ["03-Financing Expenditures - Injection - Equity", "Finance"],
  ["03-Financing Expenditures - Injection - Loan", "Finance"],
  ["04-Personnel Expenditures - Compensation", "HRD"],
  ["04-Personnel Expenditures - Net Salary", "HRD"],
  ["04-Personnel Expenditures - Religious Allowance", "HRD"],
  ["04-Personnel Expenditures - Social Security", "HRD"],
  ["05-Travel Expenditures - Rental Expenses - Car/Bike Rental", "PPIC,Finance,HRD"],
  ["05-Travel Expenditures - Travel Expenses - Accommodation", "PPIC,Finance,HRD"],
  ["05-Travel Expenditures - Travel Expenses - Bus/Travel Ticket", "PPIC,Finance,HRD"],
  ["05-Travel Expenditures - Travel Expenses - Flight Ticket", "PPIC,Finance,HRD"],
  ["05-Travel Expenditures - Travel Expenses - Food/Drink Consumption With External", "PPIC,Finance,HRD"],
  ["05-Travel Expenditures - Travel Expenses - Gasoline", "PPIC,Finance,HRD"],
  ["05-Travel Expenditures - Travel Expenses - Per Diem", "PPIC,Finance,HRD"],
  ["05-Travel Expenditures - Travel Expenses - Travel-Related Cost", "PPIC,Finance,HRD"],
  ["06-Administrative Expenditures - Bank Fee/Charge", "Finance,HRD"],
  ["06-Administrative Expenditures - Internal Cash Out", "Finance"],
  ["06-Administrative Expenditures - License", "Finance"],
  ["06-Administrative Expenditures - Medical Support", "Finance,HRD"],
  ["06-Administrative Expenditures - Office Expenses - Cleaning Service", "Finance,HRD"],
  ["06-Administrative Expenditures - Office Expenses - Equipments", "Finance,HRD"],
  ["06-Administrative Expenditures - Office Expenses - Supplies", "Finance,HRD"],
  ["06-Administrative Expenditures - Office Expenses - Utilities", "Finance,HRD"],
  ["06-Administrative Expenditures - Other G&A", "Finance,HRD"],
  ["06-Administrative Expenditures - Team Events", "Finance,HRD"],
  ["06-Administrative Expenditures - Training", "PPIC,Finance,HRD"],
  ["06-Administrative Expenditures - Vehicle Administration", "Finance,HRD"],
  ["07-External Services - Audit", "Finance,HRD"],
  ["07-External Services - Consulting", "Finance,HRD"],
  ["07-External Services - Service Fee Affiliate Companies", "Finance,HRD"],
  ["07-External Services - Tax/Legal Advise", "Finance,HRD"],
  ["08-Tax Expenditures - Income Tax - Expenses", "Finance,HRD"],
  ["08-Tax Expenditures - Income Tax Article 21", "Finance,HRD"],
  ["08-Tax Expenditures - Income Tax Article 23", "Finance,HRD"],
  ["08-Tax Expenditures - Income Tax Article 4 (2)", "Finance,HRD"]
];

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB}`);
  try {
    const [col] = await c.query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'budget_codes' AND COLUMN_NAME = 'roles'", [DB]);
    if (!col.length) {
      log('+ budget_codes.roles');
      if (APPLY) await c.query('ALTER TABLE budget_codes ADD COLUMN roles VARCHAR(60) NULL AFTER sub_account');
    } else log('= budget_codes.roles already there');
    const [codes] = await c.query(`SELECT id, code${col.length ? ', roles' : ', NULL AS roles'} FROM budget_codes WHERE is_active = 1`);
    const by = new Map(codes.map((x) => [x.code, x]));
    const missing = ROLES.filter(([code]) => !by.has(code)).map(([code]) => code);
    if (missing.length) throw new Error(`Kode aktif tidak ditemukan: ${missing.join(', ')}`);
    const extra = codes.filter((x) => !ROLES.some(([code]) => code === x.code)).map((x) => x.code);
    if (extra.length) log(`! kode aktif yang tidak ada di COA (dibiarkan tanpa role = semua): ${extra.join(', ')}`);
    let n = 0;
    for (const [code, roles] of ROLES) {
      if (by.get(code).roles === roles) continue;
      n++;
      if (APPLY) await c.query('UPDATE budget_codes SET roles = ?, updated_at = NOW() WHERE code = ?', [roles, code]);
    }
    const count = {}; ROLES.forEach(([, r]) => { count[r] = (count[r] || 0) + 1; });
    log(`roles: ${Object.entries(count).map(([r, k]) => `${r} ${k}`).join(' · ')}`);
    log(`${n} kode ${APPLY ? 'diperbarui' : 'akan diperbarui'}, ${ROLES.length - n} sudah sesuai`);
    log(APPLY ? 'done' : 'dry-run only; re-run with --apply');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
