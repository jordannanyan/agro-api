// -----------------------------------------------------------------------------
// Migration: Fund Request → Budget → Actual, and the new budget codes (2026-10)
//
//   1. budget_codes gains main_account / sub_account / sort_order (code widened);
//      the 51 outflow codes of "260929_SPV_Budget Codes Master File.xlsx" are
//      upserted and every other code is made inactive — documents that already
//      point at an old code keep it, nobody can pick it any more.
//   2. finance_dimensions (Budget Purpose, Profit Center, Budget Inflow, Cash Flow
//      Type) — same file.
//   3. The Fund Request tables, read from db/schema.sql.
//   4. payment_requests.fund_request_line_id — a Paid payment request is the
//      Actual of the line it points at.
//   5. Role HQ; Sven Koenig & Paul Schuller move to it (read-only everywhere, they
//      sign the HQ stage); an account for Arim ([WLI] Director) is created with a
//      random password printed ONCE at the end.
//   6. Fund Request signers: Director = Rizky + Arim, HQ = Sven + Paul.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateFundRequest2026-10.js
//   node scripts/migrateFundRequest2026-10.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
function ddlFor(table) {
  const head = 'CREATE TABLE `' + table + '` (';
  const i = schema.indexOf(head);
  if (i < 0) throw new Error(`DDL untuk \`${table}\` tidak ditemukan di db/schema.sql`);
  const j = schema.indexOf(') ENGINE=InnoDB;', i);
  return schema.slice(i, j + ') ENGINE=InnoDB;'.length);
}

// The seed block of db/seed.sql is the single list of codes and dimensions; parsed
// from there so the two can never disagree.
const seed = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
function seedRows(table) {
  const i = seed.indexOf('INSERT INTO `' + table + '`');
  if (i < 0) throw new Error(`Seed ${table} tidak ditemukan`);
  const v = seed.indexOf('VALUES', i);
  // The statement ends at the first ';' that closes a line (the file may be CRLF).
  const end = v + seed.slice(v).search(/;\r?\n/);
  const body = seed.slice(v + 6, end);
  const rows = [];
  const re = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g; // allows one level of parentheses inside strings
  let m;
  while ((m = re.exec(body))) {
    const parts = [];
    const cell = /'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|NULL/g;
    let c;
    while ((c = cell.exec(m[1]))) parts.push(c[1] !== undefined ? c[1].replace(/''/g, "'") : c[2] !== undefined ? Number(c[2]) : null);
    rows.push(parts);
  }
  return rows;
}

const FR_TABLES = ['fund_requests', 'fund_request_groups', 'fund_request_lines', 'fund_request_signers',
  'fund_request_signatures', 'fund_request_sections', 'fund_request_reallocations', 'fund_request_realloc_lines',
  'fund_request_comments', 'fund_request_activities'];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
    multipleStatements: true, dateStrings: true,
  });
  log(`\n=== Migrasi Fund Request + budget code baru — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (menulis perubahan)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');
  let changes = 0;
  const step = (t) => log(`\n── ${t}`);
  const exists = async (table) => {
    const [[r]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [DB, table]);
    return r.n > 0;
  };
  const columns = async (table) => {
    const [r] = await conn.query('SELECT COLUMN_NAME AS c, CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [DB, table]);
    return new Map(r.map((x) => [x.c, x]));
  };
  const act = async (msg, sql, args) => { log(`  ${msg}`); changes++; if (APPLY) await conn.query(sql, args); };

  // 1. budget_codes columns
  step('1. Kolom budget_codes');
  const bc = await columns('budget_codes');
  if (Number(bc.get('code')?.len) < 160) await act('code → VARCHAR(160)', 'ALTER TABLE budget_codes MODIFY `code` VARCHAR(160) NOT NULL');
  if (!bc.has('main_account')) await act('+ main_account', 'ALTER TABLE budget_codes ADD COLUMN `main_account` VARCHAR(80) NULL AFTER `name`');
  if (!bc.has('sub_account')) await act('+ sub_account', 'ALTER TABLE budget_codes ADD COLUMN `sub_account` VARCHAR(120) NULL AFTER `main_account`');
  if (!bc.has('sort_order')) await act('+ sort_order', 'ALTER TABLE budget_codes ADD COLUMN `sort_order` INT NOT NULL DEFAULT 0 AFTER `sub_account`');

  // 2–3. new tables
  step('2. Tabel baru');
  for (const t of ['finance_dimensions', ...FR_TABLES]) {
    if (await exists(t)) { log(`  ${t} sudah ada`); continue; }
    await act(`buat ${t}`, ddlFor(t));
  }

  // 4. payment_requests.fund_request_line_id
  step('3. payment_requests.fund_request_line_id');
  const pc = await columns('payment_requests');
  if (!pc.has('fund_request_line_id')) {
    await act('+ fund_request_line_id', 'ALTER TABLE payment_requests ADD COLUMN `fund_request_line_id` INT NULL AFTER `budget_code_id`');
    await act('+ FK fk_payreq_frline', 'ALTER TABLE payment_requests ADD CONSTRAINT `fk_payreq_frline` FOREIGN KEY (`fund_request_line_id`) REFERENCES `fund_request_lines`(`id`) ON DELETE SET NULL');
  } else log('  sudah ada');

  // 5. budget codes
  step('4. Budget code (SPV Budget Codes Master File)');
  const codes = seedRows('budget_codes'); // [id, code, name, main, sub, sort, active]
  const ready = bc.has('main_account') || APPLY;
  const [cur] = await conn.query(`SELECT id, code, is_active${bc.has('main_account') ? ', main_account, sub_account, sort_order' : ''} FROM budget_codes`);
  const byCode = new Map(cur.map((r) => [r.code, r]));
  let ins = 0, upd = 0;
  for (const [, code, name, main, sub, sort] of codes) {
    const r = byCode.get(code);
    if (!r) { ins++; if (APPLY) await conn.query('INSERT INTO budget_codes (code, name, main_account, sub_account, sort_order, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,NOW(),NOW())', [code, name, main, sub, sort]); }
    else if (!ready || r.main_account !== main || r.sub_account !== sub || Number(r.sort_order) !== sort || !r.is_active) {
      upd++; if (APPLY) await conn.query('UPDATE budget_codes SET name = ?, main_account = ?, sub_account = ?, sort_order = ?, is_active = 1, updated_at = NOW() WHERE id = ?', [name, main, sub, sort, r.id]);
    }
  }
  const keep = new Set(codes.map((c) => c[1]));
  const legacy = cur.filter((r) => !keep.has(r.code) && r.is_active);
  log(`  baru ${ins}, diperbarui ${upd}, kode lama dinonaktifkan ${legacy.length}${legacy.length ? ` (${legacy.map((r) => r.code).join(', ')})` : ''}`);
  changes += ins + upd + legacy.length;
  if (APPLY && legacy.length) await conn.query('UPDATE budget_codes SET is_active = 0, sort_order = 1000 + id, updated_at = NOW() WHERE id IN (?)', [legacy.map((r) => r.id)]);

  step('5. Finance dimensions');
  const dims = seedRows('finance_dimensions'); // [type, name, sort, active]
  if (await exists('finance_dimensions') || APPLY) {
    let d = 0;
    for (const [type, name, sort] of dims) {
      const [[r]] = (await exists('finance_dimensions'))
        ? await conn.query('SELECT id FROM finance_dimensions WHERE dim_type = ? AND name = ?', [type, name]) : [[null]];
      if (r) continue;
      d++; if (APPLY) await conn.query('INSERT INTO finance_dimensions (dim_type, name, sort_order, is_active, created_at, updated_at) VALUES (?,?,?,1,NOW(),NOW())', [type, name, sort]);
    }
    log(`  ${d} dimensi baru`); changes += d;
  } else { log(`  ${dims.length} dimensi akan ditambahkan`); changes += dims.length; }

  // 6. HQ role and people
  step('6. Peran HQ, Sven & Paul, akun Arim');
  let [[hq]] = await conn.query("SELECT id FROM roles WHERE role_code = 'HQ'");
  if (!hq) {
    const [[nameTaken]] = await conn.query("SELECT id FROM roles WHERE role_name = 'HQ'");
    await act('buat role HQ', 'INSERT INTO roles (role_code, role_name, is_cross_entity, created_at, updated_at) VALUES (?,?,1,NOW(),NOW())',
      ['HQ', nameTaken ? 'HQ (Group)' : 'HQ']);
    if (APPLY) [[hq]] = await conn.query("SELECT id FROM roles WHERE role_code = 'HQ'");
  } else log('  role HQ sudah ada');
  for (const [username, position] of [['sven.koenig', '[HQ] Group COO'], ['paul.schuller', '[HQ] Director']]) {
    const [[u]] = await conn.query('SELECT u.id, r.role_code FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.username = ?', [username]);
    if (!u) { log(`  ! ${username} tidak ditemukan — tahap HQ perlu diatur manual`); continue; }
    if (u.role_code === 'HQ') { log(`  ${username} sudah HQ`); continue; }
    await act(`${username}: ${u.role_code} → HQ`, 'UPDATE users SET role_id = ?, position = ?, updated_at = NOW() WHERE id = ?', [hq?.id ?? null, position, u.id]);
  }
  let password = null;
  let [[arim]] = await conn.query("SELECT id FROM users WHERE username = 'arim' OR email = 'arim@wli.earth'");
  if (!arim) {
    const [[wli]] = await conn.query("SELECT id FROM entities WHERE entities_name LIKE '%WLI%' ORDER BY id LIMIT 1");
    password = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    await act('buat akun arim ([WLI] Director)',
      `INSERT INTO users (entity_id, role_id, name, username, email, password, position, is_active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,1,NOW(),NOW())`,
      [wli?.id ?? null, hq?.id ?? null, 'Arim', 'arim', 'arim@wli.earth', bcrypt.hashSync(password, 10), '[WLI] Director']);
    if (APPLY) [[arim]] = await conn.query("SELECT id FROM users WHERE username = 'arim'");
  } else log('  akun arim sudah ada');

  step('7. Penandatangan Fund Request');
  const want = [['director', 'rizky.sudirman', '[IDN] Director (Entity)', 1], ['director', 'arim', '[WLI] Director', 2],
    ['hq', 'sven.koenig', '[HQ] Group COO', 1], ['hq', 'paul.schuller', '[HQ] Director', 2]];
  for (const [stage, username, title, sort] of want) {
    const [[u]] = await conn.query('SELECT id FROM users WHERE username = ?', [username]);
    if (!u) { log(`  ${stage}: ${username} belum ada${APPLY ? ' — dilewati' : ' (dibuat di langkah 6)'}`); if (!APPLY) changes++; continue; }
    const has = (await exists('fund_request_signers'))
      ? (await conn.query('SELECT id FROM fund_request_signers WHERE stage = ? AND user_id = ? AND entity_id IS NULL', [stage, u.id]))[0].length : 0;
    if (has) { log(`  ${stage}: ${username} sudah ada`); continue; }
    await act(`${stage}: ${username}`, 'INSERT INTO fund_request_signers (stage, user_id, entity_id, title, sort_order, is_active, created_at, updated_at) VALUES (?,?,NULL,?,?,1,NOW(),NOW())',
      [stage, u.id, title, sort]);
  }

  log(`\n${changes ? `${changes} perubahan` : 'Tidak ada perubahan'}${APPLY ? ' diterapkan.' : ' — jalankan dengan --apply untuk menerapkan.'}`);
  if (APPLY && password) {
    log('\n  ┌──────────────────────────────────────────────────────────────');
    log(`  │ Akun baru: arim  /  password: ${password}`);
    log('  │ Dicetak SEKALI ini saja. Serahkan lewat kanal aman; minta ganti password.');
    log('  └──────────────────────────────────────────────────────────────');
  }
  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
