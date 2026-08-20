// Bank statement reconciliation — how a payment request becomes Paid.
//
// agro-api never moves money: a person makes the transfer in the bank's own
// channel, quoting the request's payment code in the remark. Nothing here is
// evidence of that until the bank says so, which is what this module is for —
// finance uploads the statement export, each outgoing line is matched against the
// outstanding requests by code and amount, and the ones that agree are settled.
//
// Deliberately not a button. Marking a payment "done" by hand asserts something no
// record supports; matching against the statement is the only step that can detect
// a payment made for the wrong amount, a payment never made, or a debit nobody
// authorised. That is the control this replaces a checkbox with.
//
// Design: mandiri-quickbooks-reconciliation-plan.html §1.2 (tiered matching). Only
// tier 1 — reference in the remark, check character valid, amount agrees — settles
// automatically. Everything else is reported for a person to look at.

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import pool from '../db/connection';
import { authenticate, requireRole } from '../middleware/auth';
import { uploadStatement, STATEMENT_PATH } from '../middleware/upload';
import { PAYMENT_EXECUTOR_ROLES, WRITE_OVERRIDE_ROLES } from '../utils/roles';
import { findPaymentCodes } from '../utils/paymentCode';
import { parseStatement, StatementFormatError, StatementRow } from '../utils/statementParser';
import { settlePaymentRequest } from '../utils/payments';
import { respondList } from '../utils/pagination';

export const router = Router();

/** Finance executes payments; the break-glass account can stand in for them. */
const RECONCILERS = [...PAYMENT_EXECUTOR_ROLES, ...WRITE_OVERRIDE_ROLES];

/**
 * How much a statement line may fall short of the request and still count as paid.
 *
 * Banks deduct the transfer charge from the amount sent, so an exact-match rule
 * would leave a queue of payments that are short by the fee and correct in every
 * other respect — and a queue nobody can clear is a queue people stop reading.
 * Anything past this is reported as a mismatch rather than quietly accepted.
 */
const TOLERANCE = Number(process.env.PAYMENT_MATCH_TOLERANCE || 25000);

type MatchStatus =
  | 'matched'          // code valid, amount agrees exactly
  | 'matched_with_fee' // within tolerance; the difference is a bank charge
  | 'amount_mismatch'  // the code names a request, the amount does not agree
  | 'code_unknown'     // a well-formed code nobody issued
  | 'no_code'          // an outgoing payment with no reference in the remark
  | 'already_paid'     // seen before, settled already — a re-upload
  | 'not_approved'     // money moved before the chain finished
  | 'duplicate'        // this exact line was already imported
  | 'incoming';        // money in, not our business here

interface PayReqRow {
  id: number; payreq_number: string; payment_code: string; amount: number;
  status: string; entity_name: string | null; beneficiary_name: string | null;
}

interface LineVerdict {
  line: StatementRow;
  detected_code: string | null;
  payreq: PayReqRow | null;
  match_status: MatchStatus;
  fee_amount: number;
  match_note: string | null;
}

const SETTLES: MatchStatus[] = ['matched', 'matched_with_fee'];

/**
 * Decide what one statement line means.
 *
 * `seenHashes` carries lines already imported *and* lines seen earlier in this same
 * file, so a statement exported twice — or a range that overlaps the last one —
 * cannot pay the same request twice. `settledHere` does the same for the requests
 * themselves: two transfers quoting one code is a fact worth reporting, not two
 * payments.
 */
async function judge(
  line: StatementRow,
  seenHashes: Set<string>,
  settledHere: Set<number>,
): Promise<LineVerdict> {
  const base = { line, detected_code: null as string | null, payreq: null as PayReqRow | null, fee_amount: 0, match_note: null as string | null };

  if (line.amount_out <= 0) {
    return { ...base, match_status: 'incoming', match_note: line.amount_in > 0 ? 'Dana masuk — bukan pembayaran' : null };
  }
  // The code is read before the duplicate check so that a re-uploaded line still
  // shows which payment it refers to — "duplicate" with no code beside it reads as
  // though the system lost track of it.
  const codes = findPaymentCodes(line.remark);
  const code = codes[0] ?? null;

  if (seenHashes.has(line.hash)) {
    return { ...base, detected_code: code, match_status: 'duplicate', match_note: 'Baris ini sudah pernah diunggah sebelumnya' };
  }
  if (!code) {
    return { ...base, match_status: 'no_code', match_note: 'Tidak ada kode pembayaran yang sah di keterangan' };
  }

  const [rows] = await pool.query(
    `SELECT pay.id, pay.payreq_number, pay.payment_code, pay.amount, pay.status,
            pay.beneficiary_name, e.entities_name AS entity_name
     FROM payment_requests pay
     LEFT JOIN entities e ON e.id = pay.entity_id
     WHERE pay.payment_code = ? LIMIT 1`, [code]);
  const payreq = (rows as any[])[0] as PayReqRow | undefined;

  if (!payreq) {
    return { ...base, detected_code: code, match_status: 'code_unknown', match_note: `Kode ${code} tidak terdaftar` };
  }
  const found = { ...base, detected_code: code, payreq };

  if (settledHere.has(payreq.id)) {
    return { ...found, match_status: 'duplicate', match_note: `${payreq.payreq_number} sudah dilunasi oleh baris lain di file ini` };
  }
  if (payreq.status === 'Paid') {
    return { ...found, match_status: 'already_paid', match_note: `${payreq.payreq_number} sudah berstatus Paid` };
  }
  if (payreq.status !== 'Approved') {
    // Money left the account for a request the chain has not cleared. This is the
    // finding the whole exercise exists to produce, so it is never auto-settled.
    return { ...found, match_status: 'not_approved', match_note: `${payreq.payreq_number} masih berstatus ${payreq.status} — transfer mendahului approval` };
  }

  const diff = Number(line.amount_out) - Number(payreq.amount); // >0: bank debited more
  if (diff === 0) return { ...found, match_status: 'matched' };
  if (Math.abs(diff) <= TOLERANCE) {
    return {
      ...found, match_status: 'matched_with_fee', fee_amount: diff,
      match_note: diff < 0
        ? `Kurang ${fmt(-diff)} dari nominal — dianggap biaya transfer`
        : `Lebih ${fmt(diff)} dari nominal — dianggap biaya transfer`,
    };
  }
  return {
    ...found, match_status: 'amount_mismatch', fee_amount: 0,
    match_note: `Nominal beda ${fmt(Math.abs(diff))} (diminta ${fmt(Number(payreq.amount))}, keluar ${fmt(Number(line.amount_out))})`,
  };
}

const fmt = (n: number) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

/** Read the upload, parse it, and judge every line. Writes nothing. */
async function analyse(file: Express.Multer.File, password?: string | null) {
  const parsed = await parseStatement(file.buffer, file.originalname, password);

  // Lines already on record — one query rather than one per line.
  const hashes = parsed.rows.map((r) => r.hash);
  const seen = new Set<string>();
  if (hashes.length) {
    const [rows] = await pool.query(
      `SELECT line_hash FROM bank_statement_lines WHERE line_hash IN (?)`, [hashes]);
    (rows as any[]).forEach((r) => seen.add(r.line_hash));
  }

  const settledHere = new Set<number>();
  const verdicts: LineVerdict[] = [];
  for (const line of parsed.rows) {
    const v = await judge(line, seen, settledHere);
    if (SETTLES.includes(v.match_status) && v.payreq) settledHere.add(v.payreq.id);
    seen.add(line.hash); // a repeated line inside one file is still a repeat
    verdicts.push(v);
  }
  return { parsed, verdicts };
}

function summarise(verdicts: LineVerdict[]) {
  const count = (...st: MatchStatus[]) => verdicts.filter((v) => st.includes(v.match_status)).length;
  return {
    total_rows: verdicts.length,
    outgoing: verdicts.filter((v) => v.match_status !== 'incoming').length,
    will_pay: count('matched', 'matched_with_fee'),
    mismatch: count('amount_mismatch', 'not_approved'),
    unmatched: count('no_code', 'code_unknown'),
    duplicate: count('duplicate', 'already_paid'),
    incoming: count('incoming'),
    tolerance: TOLERANCE,
  };
}

const shape = (v: LineVerdict) => ({
  row_no: v.line.row_no,
  date: v.line.date,
  remark: v.line.remark,
  amount_in: v.line.amount_in,
  amount_out: v.line.amount_out,
  balance: v.line.balance,
  detected_code: v.detected_code,
  match_status: v.match_status,
  fee_amount: v.fee_amount,
  match_note: v.match_note,
  payment_request: v.payreq
    ? { id: v.payreq.id, payreq_number: v.payreq.payreq_number, amount: Number(v.payreq.amount),
        status: v.payreq.status, entity_name: v.payreq.entity_name, beneficiary_name: v.payreq.beneficiary_name }
    : null,
});

function rejectUpload(req: Request, res: Response): boolean {
  if (!req.file) {
    res.status(422).json({
      message: 'File tidak diterima. Unggah e-statement dalam format .xlsx, .xlsm atau .csv (maksimal 10 MB).',
    });
    return true;
  }
  return false;
}

// POST /api/bank-statements/preview — parse and judge, change nothing.
//
// Uploading straight into a settlement would ask people to trust a parser they
// cannot see. This shows exactly which lines will be paid and which will be left
// alone, before anything is written.
router.post('/preview', authenticate, requireRole(...RECONCILERS),
  uploadStatement.single('file'), async (req: Request, res: Response) => {
    if (rejectUpload(req, res)) return;
    try {
      // The password only ever lives in this request: it opens the file and is
      // never stored, logged, or written into the import record.
      const { parsed, verdicts } = await analyse(req.file!, req.body?.password);
      return res.json({
        message: 'Pratinjau rekonsiliasi',
        data: {
          file_name: req.file!.originalname,
          columns: parsed.columns,
          summary: summarise(verdicts),
          lines: verdicts.map(shape),
        },
      });
    } catch (err: any) {
      if (err instanceof StatementFormatError) return res.status(422).json({ message: err.message });
      return res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

// POST /api/bank-statements — parse, judge, and settle what matches.
router.post('/', authenticate, requireRole(...RECONCILERS),
  uploadStatement.single('file'), async (req: Request, res: Response) => {
    if (rejectUpload(req, res)) return;
    try {
      const user = req.user!;
      const { parsed, verdicts } = await analyse(req.file!, req.body?.password);
      const summary = summarise(verdicts);

      const dates = parsed.rows.map((r) => r.date).filter(Boolean).sort() as string[];

      // Keep the file itself: the statement is the evidence behind every payment
      // this import settles, and a reconciliation nobody can re-check is not one.
      // Stored exactly as it arrived — an encrypted export stays encrypted, because
      // the artefact behind a payment should be the bank's file, not our copy of it.
      // Re-opening it later needs the same password from the bank.
      fs.mkdirSync(STATEMENT_PATH, { recursive: true });
      const safe = path.basename(req.file!.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      const stored = `${Date.now()}_${safe}`;
      fs.writeFileSync(path.join(STATEMENT_PATH, stored), req.file!.buffer);

      const [ins] = await pool.query(
        `INSERT INTO bank_statement_imports
           (file_name, file_path, uploaded_by_user_id, period_start, period_end, total_rows,
            paid_count, mismatch_count, unmatched_count, duplicate_count, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,0,?,?,?,?,NOW(),NOW())`,
        [req.file!.originalname, `${process.env.PUBLIC_STATEMENT_BASE || '/storage/statements'}/${stored}`,
         user.id, dates[0] ?? null, dates[dates.length - 1] ?? null, verdicts.length,
         summary.mismatch, summary.unmatched, summary.duplicate, req.body?.note || null]);
      const importId = (ins as any).insertId;

      // Settle, line by line. A refusal from the settler (the chain moved under us
      // between the preview and now) demotes the line rather than failing the whole
      // import — the other twenty payments in the file are still correct.
      let paid = 0;
      const results: any[] = [];
      for (const v of verdicts) {
        let status: MatchStatus = v.match_status;
        let note = v.match_note;

        if (SETTLES.includes(status) && v.payreq) {
          const settled = await settlePaymentRequest(user, v.payreq.id, {
            released_pay_date: v.line.date,
            note: `Rekonsiliasi rekening koran ${req.file!.originalname}`
              + (v.fee_amount ? ` (selisih ${fmt(Math.abs(v.fee_amount))} dianggap biaya transfer)` : ''),
            fee_amount: v.fee_amount,
          });
          if (settled.ok) {
            paid++;
          } else {
            status = 'amount_mismatch';
            note = settled.message;
          }
        }

        await pool.query(
          `INSERT INTO bank_statement_lines
             (import_id, row_no, tx_date, remark, amount_in, amount_out, balance, line_hash,
              detected_code, payment_request_id, match_status, fee_amount, match_note, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
          [importId, v.line.row_no, v.line.date, v.line.remark, v.line.amount_in, v.line.amount_out,
           v.line.balance, v.line.hash, v.detected_code, v.payreq?.id ?? null, status,
           v.fee_amount, note]);

        results.push({ ...shape(v), match_status: status, match_note: note });
      }

      await pool.query('UPDATE bank_statement_imports SET paid_count = ?, updated_at = NOW() WHERE id = ?',
        [paid, importId]);

      return res.status(201).json({
        message: paid
          ? `${paid} payment request ditandai Paid dari rekening koran`
          : 'Tidak ada payment request yang cocok pada file ini',
        data: { id: importId, file_name: req.file!.originalname, summary: { ...summary, paid }, lines: results },
      });
    } catch (err: any) {
      if (err instanceof StatementFormatError) return res.status(422).json({ message: err.message });
      return res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

// GET /api/bank-statements — the upload history.
router.get('/', authenticate, requireRole(...RECONCILERS), async (req: Request, res: Response) => {
  const sql = `
    SELECT bsi.*, u.name AS uploaded_by_name
    FROM bank_statement_imports bsi
    LEFT JOIN users u ON u.id = bsi.uploaded_by_user_id
    ORDER BY bsi.id DESC`;
  return respondList(req, res, sql);
});

// GET /api/bank-statements/outstanding
//
// Approved, code issued, and no statement line has ever accounted for it. The plan
// calls this the aged instruction list, and it is the half of reconciliation that
// looking at bank rows cannot show you: a payment everybody signed off and nobody
// made leaves no trace at the bank at all, so only this list finds it.
router.get('/outstanding', authenticate, requireRole(...RECONCILERS), async (req: Request, res: Response) => {
  const [rows] = await pool.query(
    `SELECT pay.id, pay.payreq_number, pay.payment_code, pay.payment_code_issued_at,
            pay.amount, pay.beneficiary_name, pay.bank_name, pay.bank_account,
            pay.estimated_pay_date, e.entities_name AS entity_name,
            DATEDIFF(CURDATE(), COALESCE(pay.payment_code_issued_at, pay.updated_at)) AS age_days
     FROM payment_requests pay
     LEFT JOIN entities e ON e.id = pay.entity_id
     WHERE pay.status = 'Approved'
     ORDER BY age_days DESC, pay.id DESC`);
  return res.json({ data: rows });
});

// GET /api/bank-statements/:id — one import with every line and its verdict.
router.get('/:id', authenticate, requireRole(...RECONCILERS), async (req: Request, res: Response) => {
  const [imports] = await pool.query(
    `SELECT bsi.*, u.name AS uploaded_by_name
     FROM bank_statement_imports bsi
     LEFT JOIN users u ON u.id = bsi.uploaded_by_user_id
     WHERE bsi.id = ? LIMIT 1`, [req.params.id]);
  const data = (imports as any[])[0];
  if (!data) return res.status(404).json({ message: 'Import tidak ditemukan' });

  const [lines] = await pool.query(
    `SELECT bsl.*, pay.payreq_number, pay.amount AS payreq_amount, pay.status AS payreq_status,
            e.entities_name AS entity_name
     FROM bank_statement_lines bsl
     LEFT JOIN payment_requests pay ON pay.id = bsl.payment_request_id
     LEFT JOIN entities e           ON e.id = pay.entity_id
     WHERE bsl.import_id = ? ORDER BY bsl.id ASC`, [req.params.id]);
  data.lines = lines;
  return res.json({ data });
});

export default router;
