// Reading a Bank Mandiri e-statement export.
//
// The file is not a data feed; it is a document people read, exported to a
// spreadsheet. So the parser locates the table rather than assuming where it
// starts: banks put an account header, a logo and a blank row or two above it, and
// that preamble changes between exports. Everything is found by column *name*.
//
// Layout it is written for (bilingual, two lines per header cell):
//
//   No | Tanggal / Date | Keterangan / Remarks | Dana Masuk (IDR) | Dana Keluar (IDR) | Saldo (IDR)
//
// where a single transaction spans several visual lines — the date carries a time
// underneath it, and the remark runs to three or four lines naming the counterparty.

import ExcelJS from 'exceljs';
import crypto from 'crypto';
import officecrypto from 'officecrypto-tool';

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

export interface ParsedStatement {
  rows: StatementRow[];
  /** Which header names were found, for the error message when they were not. */
  columns: Record<string, number>;
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
async function toMatrix(buffer: Buffer, filename: string, password?: string | null): Promise<any[][]> {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const wb = new ExcelJS.Workbook();

  if (ext === 'csv') {
    const text = buffer.toString('utf8');
    // Split on the delimiter the file actually uses: an Indonesian CSV export is
    // semicolon-delimited, because the comma is busy being a decimal point.
    const delim = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
    return text.split(/\r?\n/).map((line) => splitCsvLine(line, delim));
  }

  await wb.xlsx.load((await unlock(buffer, password)) as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new StatementFormatError('File tidak berisi lembar kerja apa pun.');

  const matrix: any[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values as any[]; // exceljs pads index 0
    matrix.push(values.slice(1));
  });
  return matrix;
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
  const matrix = await toMatrix(buffer, filename, password);
  if (!matrix.length) throw new StatementFormatError('File kosong.');

  // ── Find the header row. Two columns have to agree before a row is believed:
  // the word "Keterangan" alone also appears in the account summary above the table.
  let headerIdx = -1;
  let columns: Partial<Record<ColumnKey, number>> = {};
  for (let r = 0; r < Math.min(matrix.length, 60); r++) {
    const found: Partial<Record<ColumnKey, number>> = {};
    matrix[r].forEach((cell, c) => {
      const text = flatten(cellText(cell));
      if (!text) return;
      (Object.keys(COLUMN_KEYS) as ColumnKey[]).forEach((key) => {
        if (found[key] === undefined && COLUMN_KEYS[key].test(text)) found[key] = c;
      });
    });
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

  const rows: StatementRow[] = [];
  for (let r = headerIdx + 1; r < matrix.length; r++) {
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

    // A continuation line: the bank wraps one transaction's remark over several
    // spreadsheet rows, and only the first carries the number and the amounts.
    // Joining them matters — the reference is often on the second or third line.
    const isContinuation = rowNo === null && !date && !amountIn && !amountOut && !!remark && rows.length > 0;
    if (isContinuation) {
      const prev = rows[rows.length - 1];
      prev.remark = flatten(`${prev.remark} ${remark}`);
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

  return { rows, columns: columns as Record<string, number> };
}
