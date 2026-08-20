// Reading a Bank Mandiri e-statement export.
//
// The file is not a data feed; it is a document people read, exported to a
// spreadsheet. So the parser locates the table rather than assuming where it
// starts: banks put an account header, a logo and a blank row or two above it, and
// that preamble changes between exports. Everything is found by column *name*.
//
// The real layout, taken from an actual export rather than guessed at:
//
//   rows 1-14   letterhead, account holder, account number, period, and a summary
//               block (opening balance, totals in/out, closing balance)
//   row  16     Indonesian header: No | Tanggal | Keterangan | Dana Masuk (IDR) | ...
//   row  17     the same header in English: No | Date | Remarks | Incoming ...
//   rows 18+    two spreadsheet rows per transaction — the date on the first, the
//               clock time on the second, with the number, remark, amounts and
//               running balance repeated on both. Cells are merged across many
//               columns, so one value appears several times in a row.
//
// Reading it naively counts every transaction twice, which is exactly what the
// first version of this parser did.

import ExcelJS from 'exceljs';
import crypto from 'crypto';
import officecrypto from 'officecrypto-tool';
import JSZip from 'jszip';

export interface StatementRow {
  /** Row number as printed in the file's own "No" column, when it has one. */
  row_no: number | null;
  /** ISO date (YYYY-MM-DD) or null when the cell could not be read as a date. */
  date: string | null;
  /** The whole remark, with the bank's line breaks flattened to spaces. */
  remark: string;
  amount_in: number;
  amount_out: number;
  balance: number | null;
  /** Stable fingerprint of the line, so the same transfer is never counted twice. */
  hash: string;
}

/**
 * The block the bank prints above the table: whose account, which period, and its
 * own arithmetic. Every field is optional — an export that omits one is still
 * readable, it just cannot be cross-checked as thoroughly.
 */
export interface StatementSummary {
  account_number: string | null;
  period: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  total_in: number | null;
  total_out: number | null;
}

/**
 * What the file says about where it came from.
 *
 * A Mandiri e-statement names itself three times over: `Application` in
 * docProps/app.xml, and dc:creator / dc:title in docProps/core.xml, all naming
 * "PT. Bank Mandiri (Persero) Tbk" and "Electronic Statement Livin by Mandiri".
 *
 * `application` is the one that discriminates, and it took an experiment to learn
 * why: opening the file and saving it again keeps dc:creator and dc:title — they
 * travel with the document — but rewrites Application to the program that saved it
 * ("Microsoft Excel"). So a file whose creator still says Mandiri while its
 * Application says something else has been through an editor, and says so.
 *
 * None of this is proof. The properties are plain text inside the package and
 * anyone determined can write them back. They catch the careless, not the careful.
 */
export interface StatementIdentity {
  application: string | null;
  creator: string | null;
  title: string | null;
  /** The producing application names the bank. */
  looks_like_bank: boolean;
  /** Claims to be the bank's, but was last written by an editor. */
  resaved: boolean;
}

export interface ParsedStatement {
  rows: StatementRow[];
  /** Which header names were found, for the error message when they were not. */
  columns: Record<string, number>;
  summary: StatementSummary;
  identity: StatementIdentity;
}

export class StatementFormatError extends Error {}

// ── Header matching ───────────────────────────────────────────────────────────
// Both languages, because the export carries both, and the loose alternatives
// because "Debit"/"Withdrawal" show up in older exports of the same report.
const COLUMN_KEYS = {
  no: /^\s*no\b/i,
  date: /tanggal|^\s*date\b/i,
  remark: /keterangan|remark|description|uraian|berita/i,
  amount_in: /dana\s*masuk|incoming|credit|kredit|setoran/i,
  amount_out: /dana\s*keluar|outgoing|debit|debet|penarikan|withdraw/i,
  balance: /saldo|balance/i,
};

type ColumnKey = keyof typeof COLUMN_KEYS;

/** Flatten a cell to plain text: rich text, numbers, dates and formulas alike. */
function cellText(v: any): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (Array.isArray((v as any).richText)) return (v as any).richText.map((t: any) => t.text).join('');
    if ((v as any).text != null) return String((v as any).text);
    if ((v as any).result != null) return String((v as any).result);
    if ((v as any).hyperlink != null) return String((v as any).hyperlink);
    return '';
  }
  return String(v);
}

/**
 * Indonesian money as written by the bank: 69.795,00 — dots group thousands and
 * the comma is the decimal point, the reverse of the English convention. Getting
 * this backwards turns fifty thousand rupiah into fifty, so both conventions are
 * detected rather than assumed: whichever separator comes last is the decimal one.
 */
export function parseAmount(v: any): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && (v as any).result != null) return parseAmount((v as any).result);

  let s = cellText(v).replace(/\s|IDR|Rp\.?/gi, '').trim();
  if (!s) return 0;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()\-+]/g, '');

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the rightmost separates the decimals.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Only commas. Count the digits *after* the last one: two means it is the
    // decimal point the bank writes ("5,00" is five rupiah, not five hundred);
    // three means it is grouping thousands in the English style.
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    // Only dots. Same reasoning mirrored — "69.795" is thousands, "5.00" decimals.
    const decimals = s.length - lastDot - 1;
    if (decimals === 3 || s.split('.').length > 2) s = s.replace(/\./g, '');
  }

  const n = Number(s);
  if (!isFinite(n)) return 0;
  return negative ? -n : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, peb: 2, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7,
  aug: 8, agu: 8, ags: 8, sep: 9, okt: 10, oct: 10, nov: 11, des: 12, dec: 12,
};

/** "04 Aug 2026 11:21:35 WIB", a real Date, "04/08/2026" or "2026-08-04". */
export function parseDate(v: any): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);

  const s = cellText(v).trim();
  if (!s) return null;

  let m = /(\d{1,2})[\s\-/]+([A-Za-z]{3,})[\s\-/]+(\d{2,4})/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return iso(Number(m[3]), mo, Number(m[1]));
  }
  m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/.exec(s);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1])); // dd/mm/yyyy
  return null;
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Whitespace tidied, line breaks flattened — the remark is matched as one string. */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The fingerprint that makes re-uploading a file safe.
 *
 * A statement export overlaps the previous one more often than not — people export
 * "this month" twice, or a wider range to chase one missing transfer. Without an
 * identity per line the second upload re-reads transfers that were already
 * reconciled. The bank's own transaction number would be the right key, but this
 * export does not carry one, so the line's own content is the next best thing:
 * date, remark, both amounts and the running balance together are unique in
 * practice, because the balance moves with every transaction.
 */
function lineHash(r: Omit<StatementRow, 'hash'>): string {
  return crypto.createHash('sha1')
    .update([r.date ?? '', flatten(r.remark).toUpperCase(), r.amount_in, r.amount_out, r.balance ?? ''].join('|'))
    .digest('hex');
}

// ── Reading the sheet ─────────────────────────────────────────────────────────

/**
 * Undo the bank's password, if there is one.
 *
 * A Mandiri e-statement arrives from the bank encrypted — the password is a
 * convention the account holder knows, not a secret the system should hold. So it
 * is asked for at upload time, used here, and never written anywhere: not to the
 * database, not to the log, not into the stored copy of the file.
 *
 * Note the two different things people call "password protected". This handles the
 * one that encrypts the whole file (it will not open without the password). A
 * workbook merely *protected* against editing is not encrypted at all and has
 * always been readable — asking for a password there would only confuse.
 */
async function unlock(buffer: Buffer, password?: string | null): Promise<Buffer> {
  let encrypted = false;
  try {
    encrypted = officecrypto.isEncrypted(buffer);
  } catch {
    encrypted = false; // not an Office container at all (a CSV, say)
  }
  if (!encrypted) return buffer;

  if (!password) {
    throw new StatementFormatError(
      'File ini terkunci password. Masukkan password file di kolom yang tersedia, lalu unggah ulang.');
  }
  try {
    return await officecrypto.decrypt(buffer, { password });
  } catch {
    // The library's own message names the failure but not the file; be explicit,
    // and never echo the password back in any form.
    throw new StatementFormatError('Password file salah — file tidak bisa dibuka.');
  }
}

/** The file as a rectangle of raw cell values, whatever its type. */
async function toMatrix(buffer: Buffer, filename: string): Promise<any[][]> {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const wb = new ExcelJS.Workbook();

  if (ext === 'csv') {
    const text = buffer.toString('utf8');
    // Split on the delimiter the file actually uses: an Indonesian CSV export is
    // semicolon-delimited, because the comma is busy being a decimal point.
    const delim = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
    return text.split(/\r?\n/).map((line) => splitCsvLine(line, delim));
  }

  await wb.xlsx.load(buffer as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new StatementFormatError('File tidak berisi lembar kerja apa pun.');

  const matrix: any[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as any[]; // exceljs pads index 0
    matrix.push(values.slice(1));
  });
  return matrix;
}

const NO_IDENTITY: StatementIdentity = {
  application: null, creator: null, title: null, looks_like_bank: false, resaved: false,
};

const BANK_NAME = /bank\s*mandiri/i;
const BANK_TITLE = /e-?statement|electronic\s*statement/i;

/**
 * Read docProps out of the xlsx package.
 *
 * ExcelJS surfaces dc:creator and dc:title but not `Application`, which is the
 * field that actually distinguishes the bank's own export from a copy that has
 * been through a spreadsheet editor — so the package is opened directly for it.
 */
async function readIdentity(plain: Buffer): Promise<StatementIdentity> {
  try {
    const zip = await JSZip.loadAsync(plain);
    const read = async (name: string) => {
      const f = zip.file(name);
      return f ? await f.async('string') : '';
    };
    const app = await read('docProps/app.xml');
    const core = await read('docProps/core.xml');
    const pick = (xml: string, tag: string) => {
      const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`).exec(xml);
      return m ? m[1].trim() || null : null;
    };
    const application = pick(app, 'Application');
    const creator = pick(core, 'dc:creator');
    const title = pick(core, 'dc:title');
    const claimsBank = (!!creator && BANK_NAME.test(creator)) || (!!title && BANK_TITLE.test(title));
    const producedByBank = !!application && BANK_NAME.test(application);
    return {
      application, creator, title,
      looks_like_bank: producedByBank && claimsBank,
      resaved: claimsBank && !producedByBank,
    };
  } catch {
    return NO_IDENTITY; // unreadable package: the parser below will say so properly
  }
}

/** A CSV line, honouring quotes so a remark containing the delimiter survives. */
function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The block the bank prints above the table.
 *
 * Worth the trouble because it is the bank's own arithmetic over the same rows:
 * opening balance, the two totals, closing balance. Anyone who edits a transaction
 * has to correct all four to stay consistent, and they are the only figures in the
 * file that can contradict the rows underneath them.
 */
function readSummary(matrix: any[][], headerIdx: number): StatementSummary {
  const out: StatementSummary = {
    account_number: null, period: null,
    opening_balance: null, closing_balance: null, total_in: null, total_out: null,
  };

  // Cells are merged, so one logical value repeats across a run of columns. Reading
  // the distinct values left to right gives back the line as a person sees it.
  for (let r = 0; r < headerIdx; r++) {
    const cells: string[] = [];
    (matrix[r] || []).forEach((c) => {
      const t = flatten(cellText(c));
      if (t && t !== cells[cells.length - 1]) cells.push(t);
    });
    if (!cells.length) continue;

    // One printed line often carries two labelled fields side by side — the account
    // holder's name on the left and the period on the right. So a value is read
    // relative to *its own* label, never as "the first colon on the line": that
    // shortcut reported the account holder as the statement period.
    const labelAt = (re: RegExp) => cells.findIndex((c) => re.test(c));

    /** The text just past the colon that follows this label. */
    const textFor = (re: RegExp): string | null => {
      const i = labelAt(re);
      if (i < 0) return null;
      for (let j = i; j < Math.min(cells.length, i + 4); j++) {
        if (cells[j] === ':' || cells[j].endsWith(':')) return cells[j + 1] ?? null;
      }
      return cells[i + 1] ?? null;
    };

    /** The last number appearing after this label — the figure it introduces. */
    const numberFor = (re: RegExp): number | null => {
      const i = labelAt(re);
      if (i < 0) return null;
      for (let j = cells.length - 1; j > i; j--) {
        const n = parseAmount(cells[j]);
        if (n) return n;
      }
      return null;
    };

    const RE = {
      account: /nomor\s*rekening|account\s*number/i,
      period: /periode|^period$/i,
      opening: /saldo\s*awal|initial\s*balance/i,
      closing: /saldo\s*akhir|closing\s*balance/i,
      totalIn: /dana\s*masuk|incoming\s*transactions/i,
      totalOut: /dana\s*keluar|outgoing\s*transactions/i,
    };

    if (out.account_number === null) {
      const v = textFor(RE.account);
      out.account_number = v ? v.replace(/\s+/g, '') : null;
    }
    if (out.period === null) out.period = textFor(RE.period);
    if (out.opening_balance === null) out.opening_balance = numberFor(RE.opening);
    if (out.closing_balance === null) out.closing_balance = numberFor(RE.closing);
    if (out.total_in === null) out.total_in = numberFor(RE.totalIn);
    if (out.total_out === null) out.total_out = numberFor(RE.totalOut);
  }
  return out;
}

/**
 * Parse a statement export into transaction rows.
 *
 * `password` is only needed for the encrypted exports the bank e-mails out; it is
 * used to open the file and then dropped.
 *
 * Throws {@link StatementFormatError} with a message meant for the person who
 * uploaded the file — they can fix "the Keterangan column is missing" or "the
 * password is wrong", they cannot fix a stack trace.
 */
export async function parseStatement(
  buffer: Buffer,
  filename: string,
  password?: string | null,
): Promise<ParsedStatement> {
  const isCsv = (filename.split('.').pop() || '').toLowerCase() === 'csv';
  // Unlocked once and shared: decrypting twice would ask the same password to do
  // the same work, and the properties have to come from the same bytes as the rows.
  const plain = isCsv ? buffer : await unlock(buffer, password);
  const matrix = await toMatrix(plain, filename);
  const identity = isCsv ? NO_IDENTITY : await readIdentity(plain);
  if (!matrix.length) throw new StatementFormatError('File kosong.');

  // ── Find the header row. Two columns have to agree before a row is believed:
  // the word "Keterangan" alone also appears in the account summary above the table.
  const headerMatchesIn = (row: any[]) => {
    const found: Partial<Record<ColumnKey, number>> = {};
    (row || []).forEach((cell, c) => {
      const text = flatten(cellText(cell));
      if (!text) return;
      (Object.keys(COLUMN_KEYS) as ColumnKey[]).forEach((key) => {
        if (found[key] === undefined && COLUMN_KEYS[key].test(text)) found[key] = c;
      });
    });
    return found;
  };

  let headerIdx = -1;
  let columns: Partial<Record<ColumnKey, number>> = {};
  for (let r = 0; r < Math.min(matrix.length, 60); r++) {
    const found = headerMatchesIn(matrix[r]);
    if (found.remark !== undefined && (found.amount_out !== undefined || found.amount_in !== undefined)) {
      headerIdx = r;
      columns = found;
      break;
    }
  }

  if (headerIdx < 0) {
    throw new StatementFormatError(
      'Tidak menemukan tabel transaksi. Pastikan file adalah e-statement dengan kolom '
      + '"Keterangan/Remarks" dan "Dana Keluar/Outgoing Transactions".');
  }
  if (columns.amount_out === undefined) {
    throw new StatementFormatError('Kolom "Dana Keluar (IDR)" tidak ditemukan — pembayaran keluar tidak bisa dicocokkan.');
  }

  const at = (row: any[], key: ColumnKey) => (columns[key] === undefined ? undefined : row[columns[key]!]);

  // The header is printed twice, once per language. Without this the English row
  // becomes a transaction with no date and no amounts, which then reads as an
  // unexplained line in the reconciliation.
  let firstDataRow = headerIdx + 1;
  while (firstDataRow < matrix.length) {
    const again = headerMatchesIn(matrix[firstDataRow]);
    if (again.remark !== undefined && (again.amount_out !== undefined || again.amount_in !== undefined)) {
      firstDataRow++;
    } else break;
  }

  const rows: StatementRow[] = [];
  for (let r = firstDataRow; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || !row.length) continue;

    const remark = flatten(cellText(at(row, 'remark')));
    const amountIn = parseAmount(at(row, 'amount_in'));
    const amountOut = parseAmount(at(row, 'amount_out'));
    const balance = columns.balance !== undefined ? parseAmount(at(row, 'balance')) : null;
    const date = parseDate(at(row, 'date'));
    const noText = flatten(cellText(at(row, 'no')));
    const rowNo = /^\d+$/.test(noText) ? Number(noText) : null;

    const empty = !remark && !amountIn && !amountOut && !date;
    if (empty) continue;

    const prev = rows.length ? rows[rows.length - 1] : null;

    // One transaction, two spreadsheet rows: the date sits on the first and the
    // clock time on the second, while the number, remark, amounts and balance are
    // repeated on both. They are the same transaction, recognised by the number
    // the bank itself printed — adding the second one would double every total in
    // the file, which is precisely what the first version of this parser did.
    if (rowNo !== null && prev && prev.row_no === rowNo) {
      if (!prev.date && date) prev.date = date;
      if (prev.balance == null && balance != null) prev.balance = balance;
      if (!prev.amount_in && amountIn) prev.amount_in = amountIn;
      if (!prev.amount_out && amountOut) prev.amount_out = amountOut;
      // Only genuinely new text is appended: the second line usually repeats the
      // remark verbatim, and occasionally carries the tail of a long one.
      if (remark && !prev.remark.includes(remark)) prev.remark = flatten(`${prev.remark} ${remark}`);
      continue;
    }

    // A continuation line with no number of its own: the bank wraps one remark over
    // several rows. Joining them matters — the payment code is often on the second
    // or third line rather than the first.
    const isContinuation = rowNo === null && !date && !amountIn && !amountOut && !!remark && !!prev;
    if (isContinuation) {
      prev!.remark = flatten(`${prev!.remark} ${remark}`);
      continue;
    }

    // The totals strip under the table ("Total Transaksi", "Saldo Akhir") is not a
    // transaction; it has no date and would otherwise be matched against.
    if (!date && /total|saldo\s*(akhir|awal)|jumlah|opening|closing|ending\s*balance/i.test(remark)) continue;

    rows.push({ row_no: rowNo, date, remark, amount_in: amountIn, amount_out: amountOut, balance, hash: '' });
  }

  // Hash last: a continuation line changes the remark it belongs to.
  for (const r of rows) r.hash = lineHash(r);

  if (!rows.length) {
    throw new StatementFormatError('Tabel transaksi ditemukan tetapi tidak berisi baris apa pun.');
  }

  return {
    rows,
    columns: columns as Record<string, number>,
    summary: readSummary(matrix, headerIdx),
    identity,
  };
}

// ── Is this file what it claims to be? ────────────────────────────────────────
//
// It cannot be proven. The bank does not sign its export: the package carries no
// digital signature, and its encryption uses a password rather than a certificate,
// so nothing in it is bound to Mandiri's identity. Only the bank's own API feed can
// settle the question, and that is a later phase.
//
// What is possible is to make an edited file fail arithmetic. Every figure below is
// one the bank itself printed over the same rows, so tampering with a transaction
// means correcting the running balance on every row beneath it *and* the four
// summary figures above the table. That is a different proposition from changing one
// number in Excel, which is the realistic threat here.

export interface StatementChecks {
  /**
   * The producing application names the bank. Forgeable, but rewritten by any
   * editor that saves the file, so `resaved` catches the ordinary case.
   */
  bank_identity: { ok: boolean; resaved: boolean; application: string | null; creator: string | null; title: string | null };
  account_number: string | null;
  /** Rows add up to the totals the bank printed. */
  totals: { ok: boolean; parsed_in: number; parsed_out: number; stated_in: number | null; stated_out: number | null };
  /** Opening + in − out lands exactly on the closing balance. */
  closing: { ok: boolean; computed: number | null; stated: number | null };
  /** Every row's running balance follows from the row above it. */
  balance_chain: { ok: boolean; breaks: number; first_break_row: number | null; checked: number };
  /** True when the file's own arithmetic contradicts itself. */
  arithmetic_ok: boolean;
}

/** Two money figures agree, allowing for the cent the bank rounds. */
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

export function checkStatement(parsed: ParsedStatement): StatementChecks {
  const { rows, summary, identity } = parsed;

  const parsedIn = rows.reduce((s, r) => s + r.amount_in, 0);
  const parsedOut = rows.reduce((s, r) => s + r.amount_out, 0);
  const totalsOk =
    (summary.total_in == null || near(parsedIn, summary.total_in))
    && (summary.total_out == null || near(parsedOut, summary.total_out));

  const computed = summary.opening_balance == null ? null : summary.opening_balance + parsedIn - parsedOut;
  const closingOk = computed == null || summary.closing_balance == null || near(computed, summary.closing_balance);

  // The chain is walked from the opening balance when the file states one; without
  // it, each row is checked against the row above instead, which still catches an
  // edited amount anywhere but the first.
  let running = summary.opening_balance;
  let breaks = 0, firstBreak: number | null = null, checked = 0;
  rows.forEach((r, i) => {
    if (r.balance == null) return;
    if (running != null) {
      checked++;
      const expected = running + r.amount_in - r.amount_out;
      if (!near(expected, r.balance)) {
        breaks++;
        if (firstBreak === null) firstBreak = r.row_no ?? i + 1;
      }
    }
    running = r.balance; // resynchronise, so one bad row does not condemn the rest
  });

  return {
    bank_identity: {
      ok: identity.looks_like_bank, resaved: identity.resaved,
      application: identity.application, creator: identity.creator, title: identity.title,
    },
    account_number: summary.account_number,
    totals: { ok: totalsOk, parsed_in: parsedIn, parsed_out: parsedOut, stated_in: summary.total_in, stated_out: summary.total_out },
    closing: { ok: closingOk, computed, stated: summary.closing_balance },
    balance_chain: { ok: breaks === 0, breaks, first_break_row: firstBreak, checked },
    arithmetic_ok: totalsOk && closingOk && breaks === 0,
  };
}
