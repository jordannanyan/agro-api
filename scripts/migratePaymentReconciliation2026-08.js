// -----------------------------------------------------------------------------
// Migration: bank statement reconciliation (2026-08)
//
// Brings a POPULATED database up to the reconciliation model without dropping
// anything:
//   1. payment_requests — add payment_code + payment_code_issued_at (unique)
//   2. bank_statement_imports  — one row per uploaded statement file
//   3. bank_statement_lines    — one row per transaction line, with its verdict
//   4. backfill — issue a code to every payment request already approved and not
//      yet paid, because those are exactly the ones somebody is about to transfer
//
// Every step is idempotent, so the script can be re-run safely.
//
// Usage:
//   node scripts/migratePaymentReconciliation2026-08.js            # dry run
//   node scripts/migratePaymentReconciliation2026-08.js --apply    # write
//
// BACK UP FIRST:
//   mysqldump -u root -p agro_supply > backup-before-reconciliation-2026-08.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');

// Same alphabet and check character as src/utils/paymentCode.ts. Duplicated here
// on purpose: this script runs against a database, not through the app, and must
// not depend on the TypeScript build being present.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXY';
const MOD = ALPHABET.length;

function checkChar(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (i + 2);
  return ALPHABET[sum % MOD];
}

function generatePaymentCode(year) {
  let body = '';
  for (let i = 0; i < 4; i++) body += ALPHABET[Math.floor(Math.random() * MOD)];
  return `PAY${String(year % 100).padStart(2, '0')} ${body}${checkChar(body)}`;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column]);
  return rows.length > 0;
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`, [table]);
  return rows.length > 0;
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agro_supply',
    multipleStatements: true,
  });

  const todo = [];
  const say = (s) => console.log(s);
  say(APPLY ? '→ APPLY mode: perubahan akan ditulis\n' : '→ DRY RUN: tidak ada yang ditulis (pakai --apply)\n');

  // 1. payment_requests columns -------------------------------------------------
  const hasCode = await columnExists(conn, 'payment_requests', 'payment_code');
  if (!hasCode) {
    todo.push('payment_requests: tambah payment_code + payment_code_issued_at');
    if (APPLY) {
      // The unique key is left unnamed on purpose: MySQL then names it after the
      // column, which is exactly what the inline UNIQUE in schema.sql produces. A
      // migrated database and a clean install have to come out identical — naming
      // it here would leave the two differing by an index name forever.
      await conn.query(
        `ALTER TABLE payment_requests
           ADD COLUMN payment_code VARCHAR(16) NULL AFTER payreq_number,
           ADD COLUMN payment_code_issued_at DATETIME NULL AFTER payment_code,
           ADD UNIQUE (payment_code)`);
    }
  } else {
    say('✓ payment_requests.payment_code sudah ada');
  }

  // 2 & 3. reconciliation tables ------------------------------------------------
  if (!(await tableExists(conn, 'bank_statement_imports'))) {
    todo.push('buat tabel bank_statement_imports');
    if (APPLY) {
      await conn.query(`
        CREATE TABLE bank_statement_imports (
          id                  INT AUTO_INCREMENT PRIMARY KEY,
          file_name           VARCHAR(255) NOT NULL,
          file_path           VARCHAR(255) NULL,
          uploaded_by_user_id INT NULL,
          period_start        DATE NULL,
          period_end          DATE NULL,
          total_rows          INT NOT NULL DEFAULT 0,
          paid_count          INT NOT NULL DEFAULT 0,
          mismatch_count      INT NOT NULL DEFAULT 0,
          unmatched_count     INT NOT NULL DEFAULT 0,
          duplicate_count     INT NOT NULL DEFAULT 0,
          note                VARCHAR(255) NULL,
          created_at          DATETIME NULL,
          updated_at          DATETIME NULL,
          CONSTRAINT fk_bsi_user FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB`);
    }
  } else {
    say('✓ tabel bank_statement_imports sudah ada');
  }

  if (!(await tableExists(conn, 'bank_statement_lines'))) {
    todo.push('buat tabel bank_statement_lines');
    if (APPLY) {
      await conn.query(`
        CREATE TABLE bank_statement_lines (
          id                 INT AUTO_INCREMENT PRIMARY KEY,
          import_id          INT NOT NULL,
          row_no             INT NULL,
          tx_date            DATE NULL,
          remark             TEXT NULL,
          amount_in          DECIMAL(18,2) NOT NULL DEFAULT 0,
          amount_out         DECIMAL(18,2) NOT NULL DEFAULT 0,
          balance            DECIMAL(18,2) NULL,
          line_hash          CHAR(40) NOT NULL,
          detected_code      VARCHAR(16) NULL,
          payment_request_id INT NULL,
          match_status       VARCHAR(30) NOT NULL,
          fee_amount         DECIMAL(18,2) NOT NULL DEFAULT 0,
          match_note         VARCHAR(255) NULL,
          created_at         DATETIME NULL,
          KEY idx_bsl_hash (line_hash),
          KEY idx_bsl_status (match_status),
          CONSTRAINT fk_bsl_import FOREIGN KEY (import_id)          REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
          CONSTRAINT fk_bsl_payreq FOREIGN KEY (payment_request_id) REFERENCES payment_requests(id) ON DELETE SET NULL
        ) ENGINE=InnoDB`);
    }
  } else {
    say('✓ tabel bank_statement_lines sudah ada');
  }

  // 4. Backfill codes -----------------------------------------------------------
  //
  // Only for requests that are approved and unpaid. A draft or half-approved
  // request gets its code when its chain completes, and a paid one has nothing
  // left to reconcile — giving those a code would only invite somebody to quote
  // it on a transfer that has already happened.
  if (APPLY || hasCode) {
    const [pending] = await conn.query(
      `SELECT id, payreq_number, amount, updated_at FROM payment_requests
       WHERE status = 'Approved' AND (payment_code IS NULL OR payment_code = '')`);
    if (pending.length) {
      todo.push(`backfill kode untuk ${pending.length} payment request approved & belum dibayar`);
      if (APPLY) {
        for (const p of pending) {
          const year = new Date(p.updated_at || Date.now()).getFullYear();
          for (let attempt = 0; attempt < 10; attempt++) {
            const code = generatePaymentCode(year);
            try {
              await conn.query(
                'UPDATE payment_requests SET payment_code = ?, payment_code_issued_at = NOW() WHERE id = ?',
                [code, p.id]);
              say(`  ${p.payreq_number} → ${code}`);
              break;
            } catch (e) {
              if (e.code !== 'ER_DUP_ENTRY') throw e; // collision: draw again
            }
          }
        }
      }
    } else {
      say('✓ tidak ada payment request approved yang belum punya kode');
    }
  } else {
    say('· backfill kode dilewati pada dry run (kolomnya belum ada)');
  }

  await conn.end();

  console.log('');
  if (!todo.length) {
    console.log('✓ Database sudah sesuai — tidak ada yang perlu diubah.');
  } else if (APPLY) {
    console.log('✓ Selesai. Yang dikerjakan:');
    todo.forEach((t) => console.log('  -', t));
  } else {
    console.log('Yang AKAN dikerjakan (jalankan lagi dengan --apply):');
    todo.forEach((t) => console.log('  -', t));
  }
}

run().catch((e) => { console.error('✗ Migrasi gagal:', e.message); process.exit(1); });
