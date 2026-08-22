// -----------------------------------------------------------------------------
// Inspect one bank statement file the way the import endpoint would.
//
// Same parser, same checks, same policy — no database, no upload, nothing
// written. It exists so a file can be answered for directly: "would this be
// accepted, and if not, which guardrail stops it?"
//
// The password is asked for on stdin rather than taken as an argument, because an
// argument ends up in the shell history and in the process list. It is used to
// open the file and then dropped, exactly as the endpoint does.
//
// Usage:
//   node scripts/checkStatementFile.js "path/to/e-Statement_....xlsx"
//   STATEMENT_PASSWORD=... node scripts/checkStatementFile.js file.xlsx   # unattended
// -----------------------------------------------------------------------------
require('dotenv').config();
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {
  parseStatement, checkStatement, applyStatementPolicy, inspectContainer, StatementFormatError,
} = require('../src/utils/statementParser.ts');

const file = process.argv.slice(2).find((a) => !a.startsWith('-'));
if (!file) {
  console.error('Usage: node scripts/checkStatementFile.js <file.xlsx>');
  process.exit(2);
}

const RULE = '─'.repeat(58);
const tick = (ok) => (ok ? '  OK  ' : ' FAIL ');
const pad = ' '.repeat(8);
const rp = (n) => (n == null ? '—' : `Rp ${Number(n).toLocaleString('id-ID')}`);

/** Read a password without echoing it. */
function askPassword() {
  // Defined-but-empty means "this file has no password", which is a different
  // answer from "ask me" — hence the undefined check rather than a truthiness one.
  if (process.env.STATEMENT_PASSWORD !== undefined) return Promise.resolve(process.env.STATEMENT_PASSWORD);
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const muted = !!process.stdin.isTTY;
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      if (muted) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    };
    process.stdout.write('Password file (kosongkan bila tidak terkunci): ');
    if (muted) rl.output.write = () => {};
    rl.question('', finish);
    rl.on('close', () => finish(''));   // stdin closed with nothing typed
  });
}

async function main() {
  const buffer = fs.readFileSync(file);

  console.log(`\nFile      : ${path.basename(file)}`);
  console.log(`Ukuran    : ${buffer.length.toLocaleString('id-ID')} byte`);
  console.log(`SHA-256   : ${crypto.createHash('sha256').update(buffer).digest('hex')}`);

  // Reported before the password is asked for: if the file is not the bank's kind
  // of file at all, that is already the answer, and there is no point making
  // somebody type a password to be told so.
  const container = inspectContainer(buffer, path.basename(file));
  console.log(`\n── Wadah file ${RULE}`);
  console.log(`[${tick(container.kind === 'encrypted-ooxml')}] jenis        : ${container.kind}`);
  if (container.crypto) {
    const c = container.crypto;
    console.log(`[${tick(container.crypto_profile_ok)}] enkripsi     : ${c.cipher}-${c.key_bits} `
      + `${c.chaining} / ${c.hash}, ${c.spin_count} spin${c.data_integrity ? ', dataIntegrity' : ''}`);
    console.log(`${pad} harapan      : AES-128 ChainingModeCBC / SHA1, 100000 spin, dataIntegrity`);
  }

  const password = await askPassword();

  let parsed;
  try {
    parsed = await parseStatement(buffer, path.basename(file), password || null);
  } catch (e) {
    if (e instanceof StatementFormatError) {
      console.log(`\n✗ Tidak bisa dibaca: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const checks = checkStatement(parsed);
  const knownAccounts = String(process.env.BANK_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const policy = applyStatementPolicy(checks, {
    strict: String(process.env.STATEMENT_STRICT ?? '1') !== '0',
    knownAccounts,
    previousImport: null,
  });

  console.log(`\n── Penanda penerbit ${RULE}`);
  console.log(`[${tick(checks.bank_identity.ok)}] Application  : ${checks.bank_identity.application || '(tidak ada)'}`);
  console.log(`${pad} dc:creator   : ${checks.bank_identity.creator || '(tidak ada)'}`);
  console.log(`${pad} dc:title     : ${checks.bank_identity.title || '(tidak ada)'}`);
  if (checks.bank_identity.resaved) console.log(`${pad} → file pernah dibuka dan disimpan ulang`);

  console.log(`\n── Isi ${RULE}`);
  const accountOk = !knownAccounts.length || knownAccounts.includes(checks.account_number || '');
  console.log(`[${tick(accountOk)}] rekening     : ${checks.account_number || '(tidak terbaca)'}`
    + `${knownAccounts.length ? '' : '   (BANK_ACCOUNTS kosong — tidak diperiksa)'}`);
  console.log(`${pad} periode      : ${parsed.summary.period || '(tidak terbaca)'}`);
  console.log(`${pad} transaksi    : ${parsed.rows.length} baris`);
  console.log(`[${tick(checks.totals.ok)}] total        : masuk ${rp(checks.totals.parsed_in)} / keluar ${rp(checks.totals.parsed_out)}`);
  console.log(`${pad} kata bank    : masuk ${rp(checks.totals.stated_in)} / keluar ${rp(checks.totals.stated_out)}`);
  console.log(`[${tick(checks.closing.ok)}] saldo akhir  : hitung ${rp(checks.closing.computed)} vs tertulis ${rp(checks.closing.stated)}`);
  console.log(`[${tick(checks.balance_chain.ok)}] rantai saldo : ${checks.balance_chain.ok
    ? `utuh di ${checks.balance_chain.checked} baris`
    : `putus di ${checks.balance_chain.breaks} baris (pertama baris ${checks.balance_chain.first_break_row})`}`);

  console.log(`\n── Keputusan ${RULE}`);
  if (!policy.findings.length) {
    console.log('✔ Diterima — file ini lolos semua guardrail.');
  } else {
    for (const f of policy.findings) {
      console.log(`${f.level === 'reject' ? '✗ TOLAK  ' : '! catatan'} ${f.title}\n${' '.repeat(11)}${f.message}`);
    }
    console.log(policy.ok ? '\n✔ Tetap diterima — tidak ada temuan yang menolak.' : '\n✗ Ditolak.');
  }
  console.log(`\nMode strict: ${policy.strict ? 'ya' : 'tidak (STATEMENT_STRICT=0)'}\n`);
  process.exit(policy.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
