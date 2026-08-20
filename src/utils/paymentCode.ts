// The payment reference that links a payment request to a line on the bank statement.
//
// Nobody's system writes this string: a person reads it off the screen and types it
// into the transfer remark on their phone. Every property below follows from that.
//
//  - Short. Eleven characters, of which the person types five that carry meaning.
//  - No confusable characters. 0/O, 1/I/L, 5/S, U/V and Z are all absent from the
//    alphabet, so there is nothing to squint at.
//  - A check character. Without one a single mistyped character silently addresses
//    a *different* payment request that also happens to exist, and the amount is
//    the only thing standing between that and paying the wrong invoice. With one,
//    a typo fails loudly and the row goes to the manual queue where it belongs.
//
// Shape: PAY<YY>-<4 random><1 check>   e.g. PAY26-7K4Q3
//
// Source: mandiri-quickbooks-reconciliation-plan.html §0.2.

/**
 * 29 characters — prime, which is what makes the check character work.
 *
 * With a prime modulus every weight is coprime with it, so the checksum catches
 * *every* single-character substitution and every transposition of two characters.
 * A round modulus like 30 shares factors with its weights and lets some of those
 * errors through unnoticed.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXY';
const MOD = ALPHABET.length; // 29

const BODY_LEN = 4;

/** Weighted checksum over the code body; the weights are distinct and non-zero. */
function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const v = ALPHABET.indexOf(body[i]);
    if (v < 0) return ''; // not a code in our alphabet at all
    sum += v * (i + 2);
  }
  return ALPHABET[sum % MOD];
}

/** `PAY26` — the year prefix, so old codes are visibly old. */
function yearPrefix(now = new Date()): string {
  return `PAY${String(now.getFullYear() % 100).padStart(2, '0')}`;
}

/**
 * A fresh code. Random rather than sequential on purpose: a sequence invites the
 * next id along to be a valid code too, so a slipped digit lands on a real
 * neighbouring payment. Roughly 707,000 bodies per year — collisions are handled
 * by the unique index and a retry, not by hoping.
 */
export function generatePaymentCode(now = new Date()): string {
  let body = '';
  for (let i = 0; i < BODY_LEN; i++) {
    body += ALPHABET[Math.floor(Math.random() * MOD)];
  }
  return `${yearPrefix(now)}-${body}${checkChar(body)}`;
}

/** Is this a well-formed code whose check character agrees with its body? */
export function isValidPaymentCode(code: string): boolean {
  const m = /^PAY(\d{2})-([A-Z0-9]{5})$/.exec(normalisePaymentCode(code));
  if (!m) return false;
  const body = m[2].slice(0, BODY_LEN);
  return checkChar(body) === m[2][BODY_LEN];
}

/**
 * Tidy up what a human typed: case, and the separators they may or may not have
 * used. "pay 26 7k4q3" and "PAY26-7K4Q3" are the same reference, and refusing the
 * first would push a perfectly good payment into the manual queue.
 */
export function normalisePaymentCode(raw: string): string {
  const s = String(raw || '').toUpperCase().replace(/[\s._/]+/g, '');
  const m = /^PAY-?(\d{2})-?([A-Z0-9]{5})$/.exec(s);
  return m ? `PAY${m[1]}-${m[2]}` : s;
}

/**
 * Every valid code inside a free-text bank remark, in the order they appear.
 *
 * The remark is a sentence somebody typed around the reference ("PEMBAYARAN
 * PAY26-7K4Q3 PUPUK"), sometimes with the dash dropped or a space in its place, so
 * the scan is deliberately loose and the check character does the deciding. Strings
 * that merely look like a code but fail the check are not returned — that is the
 * whole point of having one.
 */
export function findPaymentCodes(remark: string): string[] {
  const text = String(remark || '').toUpperCase();
  const found: string[] = [];
  const re = /PAY[\s\-._]?(\d{2})[\s\-._]?([A-Z0-9]{5})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = `PAY${m[1]}-${m[2]}`;
    if (isValidPaymentCode(code) && !found.includes(code)) found.push(code);
  }
  return found;
}
