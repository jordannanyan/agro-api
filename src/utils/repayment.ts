import type { Pool, PoolConnection } from 'mysql2/promise';

// -----------------------------------------------------------------------------
// Loan repayment deducted from a pre-finance farmer's delivery.
//
// The ledger books it on the delivery row itself (AML `Repayment Farmer Loan`;
// the older sheet split it into `Jumlah Potongan Saprodi` + `Jumlah Potongan
// Tenaga Kerja`): kilos delivered × the plot's payback rate per kilo, taken
// from `payback_rates`. Here it becomes a `pre_finance_installments` row tied to
// the purchasing, with one detail per type, so the farmer's outstanding drops
// the moment the delivery is recorded — whichever client recorded it.
//
// The deduction never exceeds what the farmer still owes on that type: past the
// last rupiah of the loan there is nothing left to deduct, and booking it anyway
// would turn the farmer's debt into a debt owed to the farmer.
// -----------------------------------------------------------------------------

type Db = Pool | PoolConnection;

export class RepaymentError extends Error {
  status = 422;
}

export interface RepaymentInput { pre_finance_type_id: number; amount: number }

export interface RepaymentLine {
  pre_finance_type_id: number;
  type_name: string;
  per_kg: number;        // rate for this type, 0 when the rate does not cover it
  computed: number;      // quantity × per_kg, before the outstanding cap
  outstanding: number;   // what the farmer owes on this type, excluding this delivery
  amount: number;        // what is (or would be) deducted
}

export interface RepaymentSuggestion {
  applies: boolean;      // false: not a pre-finance farmer delivery
  farmer_id: number | null;
  rate: any | null;      // the payback_rates row used, if any
  lines: RepaymentLine[];
  total: number;
  capped: boolean;       // some line was limited by the outstanding debt
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The rate in force for a plot (and grade) on a date. */
export async function findPaybackRate(db: Db, plotId: number, gradeId: number | null, date: string) {
  // Latest effective date wins; on the same date a graded rate beats the general one.
  const [rows] = await db.query(
    `SELECT r.*, g.grade_name FROM payback_rates r
     LEFT JOIN grade g ON g.id = r.grade_id
     WHERE r.plot_id = ? AND r.effective_date <= ? AND (r.grade_id IS NULL OR r.grade_id = ?)
     ORDER BY r.effective_date DESC, (r.grade_id IS NULL) ASC, r.id DESC
     LIMIT 1`, [plotId, date, gradeId]);
  return (rows as any[])[0] ?? null;
}

/** Outstanding per type for a farmer, leaving out one delivery's own deduction. */
export async function outstandingByType(db: Db, farmerId: number, excludePurchasingId: number | null) {
  const [rows] = await db.query(
    `SELECT t.id AS pre_finance_type_id, t.type_name,
            COALESCE((SELECT SUM(d.total_amount) FROM pre_finance_distributions d
                      WHERE d.farmer_id = ? AND d.pre_finance_type_id = t.id AND d.counts_as_debt = 1), 0)
          - COALESCE((SELECT SUM(det.amount) FROM pre_finance_installments i
                      JOIN pre_finance_installment_details det ON det.installment_id = i.id
                      WHERE i.farmer_id = ? AND det.pre_finance_type_id = t.id
                        AND (i.purchasing_id IS NULL OR i.purchasing_id <> ?)), 0) AS outstanding
     FROM pre_finance_types t ORDER BY t.id`,
    [farmerId, farmerId, excludePurchasingId ?? 0]);
  return rows as { pre_finance_type_id: number; type_name: string; outstanding: number }[];
}

/** What a delivery would deduct, given its plot, grade, date and kilos. */
export async function suggestRepayment(db: Db, p: {
  plotId: number | null; gradeId: number | null; date: string; quantity: number;
  excludePurchasingId?: number | null;
}): Promise<RepaymentSuggestion> {
  const none: RepaymentSuggestion = { applies: false, farmer_id: null, rate: null, lines: [], total: 0, capped: false };
  if (!p.plotId) return none;
  const [plotRows] = await db.query('SELECT scheme, farmer_id FROM plot WHERE id = ? LIMIT 1', [p.plotId]);
  const plot = (plotRows as any[])[0];
  if (!plot || plot.scheme !== 'PreFinance' || !plot.farmer_id) return none;

  const rate = p.date ? await findPaybackRate(db, p.plotId, p.gradeId, p.date) : null;
  const perKg: Record<string, number> = {
    Saprodi: Number(rate?.saprodi_per_kg || 0),
    Labor: Number(rate?.labor_per_kg || 0),
  };
  const out = await outstandingByType(db, plot.farmer_id, p.excludePurchasingId ?? null);
  let capped = false;
  const lines = out.map((o) => {
    const per = perKg[o.type_name] ?? 0;
    const computed = round2(Number(p.quantity || 0) * per);
    const owed = Math.max(0, round2(Number(o.outstanding)));
    const amount = Math.min(computed, owed);
    if (amount < computed) capped = true;
    return {
      pre_finance_type_id: o.pre_finance_type_id, type_name: o.type_name,
      per_kg: per, computed, outstanding: round2(Number(o.outstanding)), amount,
    };
  });
  return {
    applies: true, farmer_id: plot.farmer_id, rate, lines, capped,
    total: round2(lines.reduce((s, l) => s + l.amount, 0)),
  };
}

/**
 * Read `repayment` from a request body.
 *   undefined / '' / 'auto' → compute from the rate
 *   an array (or its JSON) → exactly these amounts; `[]` means "deduct nothing"
 */
export function parseRepaymentBody(v: any): 'auto' | RepaymentInput[] {
  if (v === undefined || v === null || v === '' || v === 'auto') return 'auto';
  let arr = v;
  if (typeof v === 'string') {
    try { arr = JSON.parse(v); } catch { throw new RepaymentError('repayment must be "auto" or a JSON array'); }
  }
  if (!Array.isArray(arr)) throw new RepaymentError('repayment must be "auto" or an array');
  return arr.map((r: any) => ({ pre_finance_type_id: Number(r.pre_finance_type_id), amount: Number(r.amount || 0) }));
}

/**
 * Make a delivery's deduction match `mode`, inside the caller's transaction.
 * Creates, rewrites or removes the installment tied to the purchasing.
 */
export interface RepaymentResult {
  installment_id: number | null;
  total: number;
  capped: boolean;   // auto deduction limited by the outstanding debt
  no_rate: boolean;  // pre-finance delivery, but no payback rate covers it
}

export async function syncPurchasingRepayment(
  conn: PoolConnection, purchasingId: number, mode: 'auto' | RepaymentInput[],
): Promise<RepaymentResult> {
  const [pRows] = await conn.query(
    `SELECT p.id, p.plot_id, p.grade_id, p.date, p.quantity, p.receipt_invoice, p.supplier_type
     FROM purchasing p WHERE p.id = ? LIMIT 1`, [purchasingId]);
  const pu = (pRows as any[])[0];
  if (!pu) throw new RepaymentError('Purchasing not found');

  const [exRows] = await conn.query(
    'SELECT id FROM pre_finance_installments WHERE purchasing_id = ? LIMIT 1', [purchasingId]);
  const existingId: number | null = (exRows as any[])[0]?.id ?? null;
  const removeExisting = async (noRate = false): Promise<RepaymentResult> => {
    if (existingId) await conn.query('DELETE FROM pre_finance_installments WHERE id = ?', [existingId]);
    return { installment_id: null, total: 0, capped: false, no_rate: noRate };
  };

  const plotId = pu.supplier_type === 'farmer' ? pu.plot_id : null;
  if (!plotId) return removeExisting();

  // Serialise deductions per farmer: two deliveries saved at once must not both
  // take the last of the same outstanding.
  const [plotRows] = await conn.query('SELECT farmer_id FROM plot WHERE id = ? LIMIT 1', [plotId]);
  const farmerId = (plotRows as any[])[0]?.farmer_id;
  if (farmerId) await conn.query('SELECT id FROM farmers WHERE id = ? FOR UPDATE', [farmerId]);

  const s = await suggestRepayment(conn, {
    plotId, gradeId: pu.grade_id, date: String(pu.date).slice(0, 10),
    quantity: Number(pu.quantity), excludePurchasingId: purchasingId,
  });
  if (!s.applies) {
    if (mode !== 'auto' && mode.some((m) => m.amount > 0)) {
      throw new RepaymentError('A loan repayment can only be deducted from a Pre-Finance farmer delivery');
    }
    return removeExisting();
  }

  let lines: { pre_finance_type_id: number; amount: number }[];
  if (mode === 'auto') {
    lines = s.lines;
  } else {
    lines = [];
    for (const m of mode) {
      const l = s.lines.find((x) => x.pre_finance_type_id === m.pre_finance_type_id);
      if (!l) throw new RepaymentError(`Unknown pre_finance_type_id ${m.pre_finance_type_id}`);
      if (!(m.amount >= 0)) throw new RepaymentError(`Repayment for ${l.type_name} cannot be negative`);
      // Half a rupiah of slack for rounding between the screen and here.
      if (m.amount > Math.max(0, l.outstanding) + 0.5) {
        throw new RepaymentError(
          `Repayment ${l.type_name} Rp ${m.amount.toLocaleString('id-ID')} exceeds the outstanding `
          + `Rp ${Math.max(0, l.outstanding).toLocaleString('id-ID')}`);
      }
      lines.push({ pre_finance_type_id: m.pre_finance_type_id, amount: round2(m.amount) });
    }
  }
  lines = lines.filter((l) => l.amount > 0);
  if (!lines.length) return removeExisting(mode === 'auto' && !s.rate);

  const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  let id = existingId;
  if (id) {
    await conn.query(
      `UPDATE pre_finance_installments SET farmer_id = ?, date = ?, reference_no = ?, total_payment = ?, updated_at = NOW()
       WHERE id = ?`, [s.farmer_id, pu.date, pu.receipt_invoice || null, total, id]);
    await conn.query('DELETE FROM pre_finance_installment_details WHERE installment_id = ?', [id]);
  } else {
    const [r] = await conn.query(
      `INSERT INTO pre_finance_installments (purchasing_id, farmer_id, date, reference_no, total_payment, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,NOW(),NOW())`,
      [purchasingId, s.farmer_id, pu.date, pu.receipt_invoice || null, total, 'Potongan setoran']);
    id = (r as any).insertId;
  }
  for (const l of lines) {
    await conn.query(
      'INSERT INTO pre_finance_installment_details (installment_id, pre_finance_type_id, amount) VALUES (?,?,?)',
      [id, l.pre_finance_type_id, l.amount]);
  }
  return { installment_id: id, total, capped: mode === 'auto' && s.capped, no_rate: false };
}

/** The deduction already booked on a delivery, per type. */
export async function loadPurchasingRepayment(db: Db, purchasingId: number) {
  const [rows] = await db.query(
    `SELECT i.id AS installment_id, det.pre_finance_type_id, t.type_name, det.amount
     FROM pre_finance_installments i
     JOIN pre_finance_installment_details det ON det.installment_id = i.id
     JOIN pre_finance_types t ON t.id = det.pre_finance_type_id
     WHERE i.purchasing_id = ? ORDER BY t.id`, [purchasingId]);
  return rows as any[];
}
