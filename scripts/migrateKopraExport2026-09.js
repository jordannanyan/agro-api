// -----------------------------------------------------------------------------
// Migration: Kopra by Mandiri bulk-transfer export (2026-09)
//
// Finance approves a stack of payment requests and then re-types every one of them
// into Kopra by hand. This migration puts in place the three things an export file
// needs and the database did not have:
//
//   1. `banks` — the beneficiary bank codes Kopra expects (an 8-character BIC).
//      `bank_name` was free text: "BCA", "Mandiri", "BRI". None of those is a code
//      the bank will accept, and no amount of string matching makes one safely, so
//      the list is seeded from Mandiri's own (db/seed_banks.sql) and referenced.
//
//   2. `company_bank_accounts` — the PTs' own Mandiri accounts, which the header of
//      a Consolidated file debits. A table rather than a column on `entities`,
//      because a PT runs several: an operational account plus one per trading line.
//      Which account a transfer leaves from is a decision somebody makes per file.
//
//   3. `payment_requests.bank_id` plus `exported_at` / `exported_by_user_id`.
//      The export stamp is not a payment — only the bank statement settles one —
//      but it records that the instruction has left, which is what keeps an
//      approved request from being exported twice into two real transfers.
//
// `vendors.bank_id` and `kth.bank_id` come along because those are where a payment
// request's account details are copied from; without them the code would have to be
// re-picked on every document.
//
// Existing `bank_name` text is matched to the seeded list where it is unambiguous
// ("BCA" -> CENAIDJA). Anything that does not match is left NULL and reported: a
// guessed bank code is worse than a blank one, because a blank stops the export and
// a guess sends the money.
//
// Idempotent, dry-run by default.
//
// Usage:
//   node scripts/migrateKopraExport2026-09.js            # dry run
//   node scripts/migrateKopraExport2026-09.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

/**
 * How the free text already in the database maps onto a seeded bank.
 *
 * Only spellings that name exactly one bank are here. "Bank Syariah" is not: it
 * could be any of a dozen rows, and picking one would be inventing a fact about
 * where somebody's money should go.
 */
const NAME_ALIASES = {
  mandiri: 'BMRIIDJA',
  'bank mandiri': 'BMRIIDJA',
  bca: 'CENAIDJA',
  'bank bca': 'CENAIDJA',
  'bank central asia': 'CENAIDJA',
  bni: 'BNINIDJA',
  'bank bni': 'BNINIDJA',
  'bank negara indonesia': 'BNINIDJA',
  bri: 'BRINIDJA',
  'bank bri': 'BRINIDJA',
  'bank rakyat indonesia': 'BRINIDJA',
  btn: 'BTANIDJA',
  'bank btn': 'BTANIDJA',
  'bank tabungan negara': 'BTANIDJA',
  bsi: 'BSMDIDJA',
  'bank syariah indonesia': 'BSMDIDJA',
  'cimb niaga': 'BNIAIDJA',
  cimb: 'BNIAIDJA',
  permata: 'BBBAIDJA',
  'bank permata': 'BBBAIDJA',
  danamon: 'BDINIDJA',
  'bank danamon': 'BDINIDJA',
  mega: 'MEGAIDJA',
  'bank mega': 'MEGAIDJA',
  panin: 'PINBIDJA',
  'panin bank': 'PINBIDJA',
  'ocbc nisp': 'NISPIDJA',
  ocbc: 'NISPIDJA',
  maybank: 'IBBKIDJA',
  'maybank indonesia': 'IBBKIDJA',
  btpn: 'SUNIIDJA',
  'bank jago': 'JAGBIDJA',
  'bank lampung': 'PDLPIDJ1',
  'bank jateng': 'PDJGIDJ1',
  'bank jatim': 'PDJTIDJ1',
  'bank dki': 'BDKIIDJ1',
  'bank dki jakarta': 'BDKIIDJ1',
};

/** Tables that gain a `bank_id` pointing at the new list. */
const BANK_ID_TABLES = [
  { table: 'vendors', after: 'beneficiary_name', constraint: 'fk_vendors_bank' },
  { table: 'kth', after: 'bank_account_name', constraint: 'fk_kth_bank' },
  { table: 'payment_requests', after: 'beneficiary_name', constraint: 'fk_payreq_bank' },
];

async function column(conn, table, name) {
  const [r] = await conn.query(
    'SELECT COLUMN_TYPE FROM information_schema.COLUMNS'
    + ' WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [DB, table, name]);
  return r[0] || null;
}

async function tableExists(conn, table) {
  const [r] = await conn.query(
    'SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [DB, table]);
  return Number(r[0].n) > 0;
}

async function constraintExists(conn, table, name) {
  const [r] = await conn.query(
    'SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS'
    + ' WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [DB, table, name]);
  return Number(r[0].n) > 0;
}

/** Add a column only when it is missing; report either way. */
async function addColumn(conn, table, name, ddl) {
  if (await column(conn, table, name)) {
    log(`   · ${table}.${name} sudah ada`);
    return false;
  }
  log(`   + ${table}.${name}`);
  if (APPLY) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
  return true;
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written.');
  log('  database: ' + DB + '\n');

  // 1 -- the bank list itself
  log('1. tabel `banks`');
  const hasBanks = await tableExists(conn, 'banks');
  if (hasBanks) {
    log('   · tabel `banks` sudah ada');
  } else {
    log('   + CREATE TABLE `banks`');
    if (APPLY) {
      await conn.query(`
        CREATE TABLE \`banks\` (
          \`id\`         INT AUTO_INCREMENT PRIMARY KEY,
          \`bank_code\`  VARCHAR(11) NOT NULL UNIQUE,
          \`bank_name\`  VARCHAR(150) NOT NULL,
          \`is_self\`    TINYINT(1) NOT NULL DEFAULT 0,
          \`is_active\`  TINYINT(1) NOT NULL DEFAULT 1,
          \`created_at\` DATETIME NULL,
          \`updated_at\` DATETIME NULL
        ) ENGINE=InnoDB`);
    }
  }

  // 2 -- seed it from the same file a clean install uses, so the two cannot drift
  log('\n2. seed daftar bank (db/seed_banks.sql)');
  const seedPath = path.resolve(__dirname, '..', 'db', 'seed_banks.sql');
  if (!fs.existsSync(seedPath)) {
    log('   ! db/seed_banks.sql tidak ditemukan — dilewati');
  } else if (!APPLY && !hasBanks) {
    log('   + akan meng-insert daftar bank Kopra (tabel belum ada, jumlah baru terlihat saat --apply)');
  } else {
    const sql = fs.readFileSync(seedPath, 'utf8');
    const [before] = hasBanks
      ? await conn.query('SELECT COUNT(*) n FROM `banks`')
      : [[{ n: 0 }]];
    if (APPLY) {
      await conn.query(sql);
      const [after] = await conn.query('SELECT COUNT(*) n FROM `banks`');
      log(`   + ${Number(before[0].n)} → ${Number(after[0].n)} bank`);
    } else {
      log(`   · tabel berisi ${Number(before[0].n)} bank; seed akan menyegarkan nama & menambah yang kurang`);
    }
  }

  // 3 -- the PTs' own accounts, which the export header debits
  log('\n3. rekening debit perusahaan (`company_bank_accounts`)');
  if (await tableExists(conn, 'company_bank_accounts')) {
    log('   · tabel `company_bank_accounts` sudah ada');
  } else {
    log('   + CREATE TABLE `company_bank_accounts`');
    if (APPLY) {
      await conn.query(`
        CREATE TABLE \`company_bank_accounts\` (
          \`id\`           INT AUTO_INCREMENT PRIMARY KEY,
          \`entity_id\`    INT NOT NULL,
          \`label\`        VARCHAR(60) NOT NULL,
          \`account_no\`   VARCHAR(40) NOT NULL UNIQUE,
          \`account_name\` VARCHAR(150) NULL,
          \`is_default\`   TINYINT(1) NOT NULL DEFAULT 0,
          \`is_active\`    TINYINT(1) NOT NULL DEFAULT 1,
          \`created_at\`   DATETIME NULL,
          \`updated_at\`   DATETIME NULL,
          CONSTRAINT \`fk_cba_entity\` FOREIGN KEY (\`entity_id\`) REFERENCES \`entities\`(\`id\`) ON DELETE CASCADE,
          KEY \`idx_cba_entity\` (\`entity_id\`)
        ) ENGINE=InnoDB`);
    }
  }

  // An earlier cut of this same migration put a single account on `entities`. It was
  // never released, but a development database may still carry it — so anything
  // stored there is moved across before the columns go, rather than being dropped
  // along with them.
  const hadEntityAccount = await column(conn, 'entities', 'bank_account_no');
  if (hadEntityAccount) {
    log('   · membereskan kolom lama entities.bank_account_no');
    if (APPLY) {
      await conn.query(
        `INSERT IGNORE INTO \`company_bank_accounts\`
           (entity_id, label, account_no, account_name, is_default, is_active, created_at, updated_at)
         SELECT id, 'OPERATIONAL', bank_account_no, bank_account_name, 1, 1, NOW(), NOW()
         FROM \`entities\`
         WHERE bank_account_no IS NOT NULL AND bank_account_no <> ''`);
      await conn.query('ALTER TABLE `entities` DROP COLUMN `bank_account_no`');
      if (await column(conn, 'entities', 'bank_account_name')) {
        await conn.query('ALTER TABLE `entities` DROP COLUMN `bank_account_name`');
      }
      log('   - entities.bank_account_no / bank_account_name dihapus');
    }
  } else {
    log('   · entities tidak punya kolom rekening lama — tidak ada yang dipindah');
  }

  // Deliberately not seeded here. Account numbers are the company's, this file is in
  // a public repository, and the screen at Settings → Rekening Perusahaan is where
  // they belong.
  if (await tableExists(conn, 'company_bank_accounts')) {
    const [n] = await conn.query('SELECT COUNT(*) n FROM `company_bank_accounts`');
    if (!Number(n[0].n)) {
      log('   ! belum ada rekening perusahaan. Export tidak bisa jalan sampai diisi di');
      log('     Settings → Rekening Perusahaan (nomor rekening tidak di-seed dari repo).');
    } else {
      log(`   · ${Number(n[0].n)} rekening perusahaan terdaftar`);
    }
  }

  // 4 -- bank_id everywhere an account is held
  log('\n4. kolom `bank_id`');
  for (const t of BANK_ID_TABLES) {
    if (!(await tableExists(conn, t.table))) { log(`   ! tabel ${t.table} tidak ada — dilewati`); continue; }
    const anchor = (await column(conn, t.table, t.after)) ? ` AFTER \`${t.after}\`` : '';
    await addColumn(conn, t.table, 'bank_id', `\`bank_id\` INT NULL${anchor}`);
    if (await constraintExists(conn, t.table, t.constraint)) {
      log(`   · ${t.constraint} sudah ada`);
    } else {
      log(`   + ${t.constraint}`);
      if (APPLY) {
        await conn.query(
          `ALTER TABLE \`${t.table}\` ADD CONSTRAINT \`${t.constraint}\``
          + ' FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON DELETE SET NULL');
      }
    }
  }

  // 5 -- the export stamp
  log('\n5. jejak export (`payment_requests`)');
  await addColumn(conn, 'payment_requests', 'exported_at',
    '`exported_at` DATETIME NULL AFTER `bank_id`');
  await addColumn(conn, 'payment_requests', 'exported_by_user_id',
    '`exported_by_user_id` INT NULL AFTER `exported_at`');
  if (await constraintExists(conn, 'payment_requests', 'fk_payreq_exportedby')) {
    log('   · fk_payreq_exportedby sudah ada');
  } else {
    log('   + fk_payreq_exportedby');
    if (APPLY) {
      await conn.query(
        'ALTER TABLE `payment_requests` ADD CONSTRAINT `fk_payreq_exportedby`'
        + ' FOREIGN KEY (`exported_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL');
    }
  }

  // 6 -- match the free text already in the database against the seeded list
  log('\n6. backfill bank_id dari bank_name');
  if (!APPLY && !hasBanks) {
    log('   · daftar bank belum ada di database ini, backfill baru bisa dinilai setelah --apply');
  } else {
    const [bankRows] = await conn.query('SELECT id, bank_code FROM `banks`');
    const byCode = new Map(bankRows.map((b) => [b.bank_code, b.id]));
    for (const t of BANK_ID_TABLES) {
      if (!(await tableExists(conn, t.table))) continue;
      if (!(await column(conn, t.table, 'bank_id'))) { log(`   · ${t.table}: kolom belum ada (dry run)`); continue; }
      const [rows] = await conn.query(
        `SELECT id, bank_name FROM \`${t.table}\` WHERE bank_id IS NULL AND bank_name IS NOT NULL AND bank_name <> ''`);
      let hit = 0;
      const missed = new Map();
      for (const row of rows) {
        const key = String(row.bank_name).trim().toLowerCase().replace(/\s+/g, ' ');
        const code = NAME_ALIASES[key];
        const id = code ? byCode.get(code) : undefined;
        if (!id) { missed.set(row.bank_name, (missed.get(row.bank_name) || 0) + 1); continue; }
        hit++;
        if (APPLY) await conn.query(`UPDATE \`${t.table}\` SET bank_id = ? WHERE id = ?`, [id, row.id]);
      }
      log(`   · ${t.table}: ${hit}/${rows.length} baris cocok`);
      for (const [name, n] of missed) log(`     ! tidak dikenali: "${name}" (${n} baris) — isi manual lewat form`);
    }
  }

  log(APPLY ? '\n✓ Selesai.' : '\n(dry run selesai — jalankan lagi dengan --apply)');
  await conn.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
