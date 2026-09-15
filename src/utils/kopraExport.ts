// Building a Kopra by Mandiri bulk-transfer file out of approved payment requests.
//
// Finance approves a stack of payment requests and then re-keys every one of them
// into Kopra by hand. This builds the file Kopra takes instead — the same
// instructions, in the layout Mandiri publishes, with the payment code already in
// the remark so the statement that comes back settles them automatically.
//
// Two formats, because Mandiri ships two and different corporate accounts are
// enabled for different ones:
//
//   csv   Multiple Transfer by File Upload — Consolidated. The older MCM 2.0
//         layout: one `P` header naming the debit account, then one 41-field line
//         per transfer. Plain text, no quoting of any kind, so anything that could
//         contain a comma is stripped rather than escaped.
//
//   xlsx  The newer KOPRA template (templates/kopra-transfer-consolidated.xlsx),
//         22 columns and far easier for a person to check before uploading. Its own
//         first instruction is "do not change the header/record position, column,
//         row, and/or format", so the template is filled in rather than rebuilt.
//
// Both are *consolidated*: one debit account for the whole file. That is why an
// export is scoped to a single account — not merely a single entity. A PT runs
// several: SNBS pays wages from its operational account and buys fruit from the
// cacao and banana trading accounts. Which one a transfer leaves from is a decision
// somebody makes per file, and the file itself has room for exactly one answer.
//
// What this deliberately does not do is mark anything paid. Downloading a file is
// an instruction leaving the building, not money leaving the account; only a line
// on the bank statement settles a request. See utils/payments.ts and
// docs/payment-reconciliation.md.
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

/**
 * The per-transaction ceiling for BI FAST, above which the transfer has to go by
 * RTGS. Configurable because it is Bank Indonesia's number, not ours, and it has
 * been raised before.
 */
export const BI_FAST_LIMIT = Number(process.env.KOPRA_BI_FAST_LIMIT || 250_000_000);

/** Where the filled template is read from. */
const TEMPLATE_PATH = path.resolve(__dirname, '..', '..', 'templates', 'kopra-transfer-consolidated.xlsx');

export type KopraFormat = 'csv' | 'xlsx';

/** One payment request, as the export query returns it. */
export interface KopraPayreq {
  id: number;
  payreq_number: string;
  payment_code: string | null;
  payreq_kind: string;
  amount: number | string;
  beneficiary_name: string | null;
  bank_account: string | null;
  bank_name: string | null;
  bank_code: string | null;     // banks.bank_code — the BIC Kopra wants
  bank_is_self: number | null;  // banks.is_self — 1 = Bank Mandiri, i.e. In-House
  exported_at: Date | string | null;
}

/** The account the whole file debits. */
export interface KopraDebitAccount {
  id: number;
  entity_id: number;
  entity_name: string;
  /** OPERATIONAL, TRADING CACAO, … — what people call the account, not its number. */
  label: string;
  account_no: string;
  account_name: string | null;
}

/** A request that cannot be written into the file, and the reason in plain Indonesian. */
export interface KopraBlocker {
  id: number;
  payreq_number: string;
  reason: string;
}

/** A request resolved to the transfer it will become. */
export interface KopraLine {
  payreq: KopraPayreq;
  /** MCM 2.0 FT service code: IBU (in-house), BAU (BI FAST by account), RBU (RTGS). */
  service: 'IBU' | 'BAU' | 'RBU';
  /** The same choice spelled the way the new template's picklist spells it. */
  method: 'In-House' | 'BI FAST' | 'RTGS';
  /** Empty for In-House: a transfer inside Mandiri carries no beneficiary bank code. */
  bankCode: string;
  amount: number;
}

export interface KopraPlan {
  debit: KopraDebitAccount;
  transferDate: Date;
  format: KopraFormat;
  lines: KopraLine[];
  blockers: KopraBlocker[];
  total: number;
}

/** yyyyMMdd, the only date shape either format accepts. */
export function kopraDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * Make a value safe for a field in an unquoted CSV.
 *
 * The MCM 2.0 format has no quoting and no escape character, so a comma inside a
 * beneficiary name would not be mis-parsed so much as silently shift every later
 * field one place left — the amount would land in the remark and the bank code in
 * the amount. Stripping is the only safe answer; there is nothing to escape with.
 */
function csvSafe(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[,;"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Rupiah has no cents, and a decimal point in the amount is one more thing to reject. */
function rupiah(amount: number | string): number {
  return Math.round(Number(amount || 0));
}

/**
 * Decide how each request would be transferred, and set aside the ones that cannot
 * be — with the reason, so the person exporting can fix it rather than guess.
 *
 * Nothing here is a warning to be clicked past. A row missing a bank code is not
 * exported as a blank field that Kopra will reject an hour later; it is held back
 * and named now.
 */
export function planExport(
  payreqs: KopraPayreq[],
  debit: KopraDebitAccount,
  format: KopraFormat,
  transferDate: Date,
): KopraPlan {
  const lines: KopraLine[] = [];
  const blockers: KopraBlocker[] = [];

  for (const p of payreqs) {
    const fail = (reason: string) => blockers.push({ id: p.id, payreq_number: p.payreq_number, reason });
    const amount = rupiah(p.amount);

    if (!p.payment_code) { fail('Kode pembayaran belum terbit — rantai approval belum selesai.'); continue; }
    if (amount <= 0) { fail('Nominal 0 — tidak ada yang bisa ditransfer.'); continue; }
    if (!p.bank_account) { fail('Nomor rekening tujuan kosong.'); continue; }
    if (!p.beneficiary_name) { fail('Nama penerima kosong.'); continue; }
    if (!p.bank_code) {
      fail(`Bank tujuan belum dipilih${p.bank_name ? ` (masih teks bebas "${p.bank_name}")` : ''} — pilih dari daftar bank.`);
      continue;
    }

    const self = Number(p.bank_is_self) === 1;
    if (self) {
      lines.push({ payreq: p, service: 'IBU', method: 'In-House', bankCode: '', amount });
      continue;
    }
    if (amount <= BI_FAST_LIMIT) {
      lines.push({ payreq: p, service: 'BAU', method: 'BI FAST', bankCode: p.bank_code, amount });
      continue;
    }
    // Over the BI FAST ceiling the transfer has to go by RTGS, and there the two
    // formats part company. The new template takes the same BIC for RTGS. The old
    // CSV wants Mandiri's 6-digit sandi code for RTGS and SKN, which is a different
    // list that is not published with these templates and that we therefore do not
    // hold. Emitting the BIC in that field would produce a file that either fails
    // at upload or, worse, addresses a bank nobody chose.
    if (format === 'xlsx') {
      lines.push({ payreq: p, service: 'RBU', method: 'RTGS', bankCode: p.bank_code, amount });
    } else {
      fail(
        `Rp ${amount.toLocaleString('id-ID')} di atas limit BI FAST (Rp ${BI_FAST_LIMIT.toLocaleString('id-ID')}), `
        + 'jadi harus lewat RTGS. Format CSV lama meminta kode sandi bank untuk RTGS, yang tidak ada di daftar '
        + 'Kopra — pakai format XLSX untuk transfer ini, atau input manual di Kopra.',
      );
    }
  }

  return {
    debit,
    transferDate,
    format,
    lines,
    blockers,
    total: lines.reduce((s, l) => s + l.amount, 0),
  };
}

/**
 * The 41 detail fields of a Consolidated record.
 *
 * Only nine carry anything for a domestic rupiah transfer; the rest are addresses,
 * notification and the remittance/instruction blocks that belong to international
 * transfers. Charge Instruction and Beneficiary Type (39 and 40) are left empty on
 * purpose: Mandiri's own example fills them for SKN and RTGS and leaves them blank
 * on the In-House and BI FAST rows, and the spec's default for the first is OUR
 * while the second applies to SKN only.
 */
function csvDetail(line: KopraLine): string {
  const f = new Array(41).fill('');
  f[0] = csvSafe(line.payreq.bank_account, 35);          // 1  Beneficiary Account No.
  f[1] = csvSafe(line.payreq.beneficiary_name, 70);      // 2  Beneficiary Account Name
  f[5] = 'IDR';                                          // 6  Transfer Amount Currency
  f[6] = String(line.amount);                            // 7  Transfer Amount
  f[7] = csvSafe(line.payreq.payment_code, 140);         // 8  Transaction Remark
  f[8] = csvSafe(line.payreq.payreq_number, 19);         // 9  Customer Reference Number
  f[9] = line.service;                                   // 10 FT Service
  f[10] = csvSafe(line.bankCode, 12);                    // 11 Beneficiary Bank Code
  return f.join(',');
}

/**
 * The whole Consolidated file.
 *
 * CRLF because it is what Mandiri's own example ships, and the totals in the header
 * are computed from the same lines that follow rather than passed in — the two
 * disagreeing is exactly the kind of thing an upload is rejected for.
 *
 * No trailing newline, for the same reason: Mandiri's example file ends on the last
 * detail record, with 8 line breaks for its 9 lines. The header states how many
 * detail records follow, so a parser that splits on the line break and counts what
 * it gets would see one more — an empty one — than the header admits to. Matching
 * the vendor's own bytes costs nothing and removes the question.
 */
export function buildCsv(plan: KopraPlan): Buffer {
  const header = [
    'P',
    kopraDate(plan.transferDate),
    csvSafe(plan.debit.account_no, 40),
    String(plan.lines.length),
    String(plan.total),
  ].join(',');
  const body = plan.lines.map(csvDetail);
  return Buffer.from([header, ...body].join('\r\n'), 'utf8');
}

// Where things live in templates/kopra-transfer-consolidated.xlsx. The template's
// first instruction is not to move any of it, so these are fixed points, not guesses.
const XLSX_SHEET = 'INPUT TRANSACTION HERE';
const XLSX_DATE_CELL = 'B14';
const XLSX_DEBIT_CELL = 'C14';
const XLSX_FIRST_DATA_ROW = 19;
/** The six worked examples shipped in the template, which have to go before ours do. */
const XLSX_EXAMPLE_ROWS = 6;
const XLSX_LAST_COL = 22; // V

/**
 * Fill Mandiri's own template rather than reproducing it.
 *
 * Rebuilding the sheet would mean reproducing the header block, the picklist and the
 * column positions from memory and hoping Kopra reads it the same way. Filling the
 * published file cannot drift from it.
 */
export async function buildXlsx(plan: KopraPlan): Promise<Buffer> {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template Kopra tidak ditemukan di ${TEMPLATE_PATH}`);
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const ws = wb.getWorksheet(XLSX_SHEET);
  if (!ws) throw new Error(`Sheet "${XLSX_SHEET}" tidak ada di template Kopra.`);

  // Kopra reads the date as text in yyyymmdd; a real date cell would be rendered by
  // whatever locale the reader happens to use.
  ws.getCell(XLSX_DATE_CELL).value = kopraDate(plan.transferDate);
  ws.getCell(XLSX_DEBIT_CELL).value = String(plan.debit.account_no);

  // The template ships six filled example rows. Left in place they would be uploaded
  // as six real transfers to Ivanto Bramantio.
  //
  // Column A is not cleared with the rest: the template numbers every row down the
  // sheet, so an unused row there holds its number and nothing else. Blanking it
  // would leave a hole in a sequence that runs on for thousands of rows below.
  const toClear = Math.max(XLSX_EXAMPLE_ROWS, plan.lines.length);
  for (let i = 0; i < toClear; i++) {
    const row = ws.getRow(XLSX_FIRST_DATA_ROW + i);
    row.getCell(1).value = i + 1;
    for (let c = 2; c <= XLSX_LAST_COL; c++) row.getCell(c).value = null;
    row.commit();
  }

  plan.lines.forEach((line, i) => {
    const row = ws.getRow(XLSX_FIRST_DATA_ROW + i);
    row.getCell(2).value = line.method;                            // B Transfer Method
    row.getCell(3).value = String(line.payreq.bank_account);       // C Destination Acc No.
    row.getCell(4).value = 'IDR';                                  // D Transfer Currency
    row.getCell(5).value = line.amount;                            // E Transfer Amount
    row.getCell(6).value = line.payreq.beneficiary_name;           // F Destination Acc Name
    row.getCell(8).value = line.bankCode || null;                  // H Destination Bank Code
    row.getCell(9).value = 'OUR';                                  // I Charge Instruction
    row.getCell(10).value = line.payreq.payreq_number;             // J Transaction Reference
    row.getCell(11).value = line.payreq.payment_code;              // K Remark
    // R Beneficiary Type: a reimbursement is paid to a farmer group's account, a
    // procurement to a supplier. Both are organisations rather than a person, but
    // the field only applies to SKN and RTGS, so it is set only where it is read.
    if (line.method === 'RTGS') {
      row.getCell(18).value = 2;
      row.getCell(19).value = 'Y'; // S resides in Indonesia
      row.getCell(20).value = 'Y'; // T citizen of Indonesia
      row.getCell(21).value = 'N'; // U remitter identical to beneficiary
      row.getCell(22).value = 'N'; // V remitter affiliated with beneficiary
    }
    row.commit();
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/**
 * `Kopra_SNBS-Lampung_TRADING-CACAO_20260904.csv` — readable in a downloads folder a
 * week later, and distinct per account: one PT can raise several files on one day,
 * one per account, and names that collide are names that get uploaded twice.
 */
export function kopraFilename(plan: KopraPlan): string {
  const slug = (v: string, max: number) => String(v || '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  const entity = slug(plan.debit.entity_name, 40) || 'entity';
  const label = slug(plan.debit.label, 24);
  return `Kopra_${entity}${label ? `_${label}` : ''}_${kopraDate(plan.transferDate)}.${plan.format}`;
}
