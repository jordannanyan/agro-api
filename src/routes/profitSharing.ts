import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { crudRouter } from '../utils/crudFactory';
import { entityScope } from '../utils/entityScope';
import { ENTITY_COL, farmerRefScope } from '../utils/farmScope';
import { ROLE, WRITE_OVERRIDE_ROLES } from '../utils/roles';

export const router = Router();

// -----------------------------------------------------------------------------
// Who may open this module, and who may change it
//
// Both are now the same list, by decision of 2026-09-29: everyone in the business
// chain plus Finance Staff. A Field Admin records the purchasing and the stock that
// becomes a plot's investment, and a Project Manager answers for the field the
// numbers describe — they were being asked about figures they could not see, and
// then about figures they could see but not correct.
//
// That the two lists are equal does not make this guard idle. It still refuses the
// storekeeper and the HR, neither of whom has business here, and the Admin, who
// reads every operational module and writes to none (middleware/readOnly.ts).
//
// And it still has to exist at all, which is the part worth remembering: until
// 2026-09-29 every write below sat behind `authenticate` alone. Any signed-in
// account could have settled a sale by calling the endpoint directly; the module
// looked protected only because the menu was hidden from most roles. Widening who
// may write is a decision somebody made — it should not be something the API
// happens to allow because nobody said otherwise.
// -----------------------------------------------------------------------------
const PROFIT_SHARING_WRITERS: string[] = [
  ROLE.FIELD_ADMIN, ROLE.PROJECT_MANAGER, ROLE.PROCUREMENT,
  ROLE.FINANCE_MANAGER, ROLE.FINANCE_STAFF, ROLE.DIRECTOR,
  ...WRITE_OVERRIDE_ROLES,
];

router.use((req: Request, res: Response, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.user?.type === 'User' && PROFIT_SHARING_WRITERS.includes(req.user.roleCode || '')) {
    return next();
  }
  return res.status(403).json({
    message: 'Peran Anda tidak berhak mengubah data bagi hasil.',
  });
});

// -----------------------------------------------------------------------------
// How a sale is split.
//
// A processing batch is fed by many deposits, and a sale is of the batch, not of
// any one deposit. The whole file turns on one number: the share of the batch a
// plot put in.
//
//   share  = kg the plot contributed / kg the batch received
//
// The margin is the ledgers' own: revenue less the purchase paid to farmers, a
// harvesting charge per kg, and PNBP per kg. Saprodi and land cost are NOT in it
// — the ledgers hold those as the farmer's debt and use them to gate payout.
// Everything is multiplied by the share, so weight lost in processing and sales
// made in instalments are carried proportionally without special cases.
//
// `contrib` groups by (batch, plot) BEFORE anything is multiplied. That is the
// step the old query lacked: it joined the deposits straight onto the sale, so a
// plot that delivered to the same batch twice was credited twice, and every
// depositor was credited with the entire sale. On the August 2026 data that read
// Rp 1.134.207.766 against Rp 273.119.023 of actual sales.
// -----------------------------------------------------------------------------
const ALLOC = `
WITH batch AS (
  SELECT pp.processing_id,
         SUM(pp.volume_contributed) AS batch_volume,
         SUM(pp.volume_contributed * COALESCE(pu.price_per_unit, 0)) AS batch_purchase_value
  FROM processing_purchasings pp
  JOIN purchasing pu ON pu.id = pp.purchasing_id
  GROUP BY pp.processing_id
),
contrib AS (
  SELECT pp.processing_id, pu.plot_id,
         SUM(pp.volume_contributed) AS volume_share,
         SUM(pp.volume_contributed * COALESCE(pu.price_per_unit, 0)) AS plot_purchase_value
  FROM processing_purchasings pp
  JOIN purchasing pu ON pu.id = pp.purchasing_id
  -- Only deliveries made under profit sharing earn a share. A plot that was
  -- Pre-Finance before its profit-sharing season sold those kilos outright.
  WHERE pu.plot_id IS NOT NULL AND pu.scheme = 'ProfitSharing'
  GROUP BY pp.processing_id, pu.plot_id
),
sold AS (
  SELECT processing_id, SUM(accepted_volume) AS sold_volume
  FROM selling GROUP BY processing_id
),
-- The PT a batch belongs to, read from its largest contributor. The cost rates
-- differ per PT, so the batch has to name one before anything can be charged.
bent AS (
  SELECT c.processing_id,
         (SELECT k.entities_id
          FROM contrib c2
          JOIN plot pl2    ON pl2.id = c2.plot_id
          JOIN farmers f2  ON f2.id = pl2.farmer_id
          JOIN kth k       ON k.id = f2.kth_id
          WHERE c2.processing_id = c.processing_id
          ORDER BY c2.volume_share DESC LIMIT 1) AS entity_id
  FROM contrib c GROUP BY c.processing_id
),
-- Gross margin of one sale, exactly as the ledgers define it. frac spreads the
-- purchase-side charges over instalment sales so a batch sold twice is charged
-- once in total.
sale AS (
  SELECT s.id AS selling_id, s.date AS sale_date, s.processing_id,
         b.batch_volume, be.entity_id,
         s.accepted_volume / NULLIF(sv.sold_volume, 0) AS frac,
         b.batch_purchase_value * s.accepted_volume / NULLIF(sv.sold_volume, 0) AS cost_purchase,
         CASE WHEN e.harvest_cost_basis = 'Offtake'
              THEN COALESCE(e.harvest_cost_per_kg, 0) * s.accepted_volume
              ELSE COALESCE(e.harvest_cost_per_kg, 0) * b.batch_volume
                   * s.accepted_volume / NULLIF(sv.sold_volume, 0)
         END AS cost_harvest,
         COALESCE(e.pnbp_per_kg, 0) * b.batch_volume
           * s.accepted_volume / NULLIF(sv.sold_volume, 0) AS cost_pnbp,
         s.total_revenue
  FROM selling s
  JOIN batch b  ON b.processing_id = s.processing_id
  JOIN sold sv  ON sv.processing_id = s.processing_id
  JOIN bent be  ON be.processing_id = s.processing_id
  LEFT JOIN entities e ON e.id = be.entity_id
  WHERE b.batch_volume > 0
),
alloc AS (
  SELECT sa.selling_id, sa.sale_date, sa.entity_id, c.plot_id,
         c.volume_share, c.plot_purchase_value,
         c.volume_share / sa.batch_volume AS share,
         sa.total_revenue  * c.volume_share / sa.batch_volume AS revenue,
         sa.cost_purchase  * c.volume_share / sa.batch_volume AS cost_purchase,
         sa.cost_harvest   * c.volume_share / sa.batch_volume AS cost_harvest,
         sa.cost_pnbp      * c.volume_share / sa.batch_volume AS cost_pnbp
  FROM sale sa
  JOIN contrib c ON c.processing_id = sa.processing_id
)`;

// Operational Cost / investment per farmer+plot+period.
router.use('/investments', crudRouter({
  table: 'profit_sharing_investments',
  columns: ['period', 'farmer_id', 'plot_id', 'pre_finance_type_id', 'quantity', 'unit_id', 'amount', 'description'],
  required: ['period', 'farmer_id'],
  numeric: ['farmer_id', 'plot_id', 'pre_finance_type_id', 'quantity', 'unit_id', 'amount'],
  filterColumns: ['period', 'farmer_id', 'plot_id'],
  orderBy: 'period DESC, id DESC',
  label: 'Investment',
}));

// Settled profit-sharing records. Written by POST /settle; kept editable for the
// status field and for the rows entered before per-sale settlement existed.
router.use('/shares', crudRouter({
  table: 'profit_sharing',
  columns: ['period', 'selling_id', 'farmer_id', 'plot_id', 'commodities_id', 'volume_share', 'share_pct',
            'total_revenue', 'cost_purchase', 'cost_harvest', 'cost_pnbp',
            'cost_processing', 'cost_selling', 'cost_saprodi', 'cost_land',
            'total_investment', 'pct_farmer', 'pct_company', 'pct_kth',
            'value_farmer', 'value_company', 'value_kth',
            'cum_farmer', 'cum_company', 'cum_kth', 'status'],
  required: ['period', 'farmer_id'],
  numeric: ['selling_id', 'farmer_id', 'plot_id', 'commodities_id', 'volume_share', 'share_pct',
            'total_revenue', 'cost_purchase', 'cost_harvest', 'cost_pnbp',
            'cost_processing', 'cost_selling', 'cost_saprodi', 'cost_land',
            'total_investment', 'pct_farmer', 'pct_company', 'pct_kth',
            'value_farmer', 'value_company', 'value_kth',
            'cum_farmer', 'cum_company', 'cum_kth'],
  filterColumns: ['period', 'farmer_id', 'plot_id', 'selling_id', 'status'],
  orderBy: 'period DESC, id DESC',
  label: 'Profit sharing',
}));

// GET /api/profit-sharing/revenue — one row per (sale, ProfitSharing plot),
// carrying that plot's share of the sale rather than the whole of it.
router.get('/revenue', authenticate, async (req: Request, res: Response) => {
  try {
    const where: string[] = ["pl.scheme = 'ProfitSharing'"];
    const args: any[] = [];
    if (req.query.period) { where.push("DATE_FORMAT(a.sale_date, '%Y-%m') = ?"); args.push(req.query.period); }
    const scope = entityScope(req);
    if (scope != null) { where.push(`${ENTITY_COL} = ?`); args.push(scope); }

    const [rows] = await pool.query(
      `${ALLOC}
       SELECT a.selling_id AS id, a.sale_date AS date,
              DATE_FORMAT(a.sale_date, '%Y-%m') AS period,
              f.id AS farmer_id, f.farmer_name, pl.id AS plot_id, pl.plot_name,
              o.offtaker_name AS customer,
              a.volume_share AS qty, ROUND(a.share * 100, 4) AS share_pct,
              s.price_per_unit, s.accepted_volume AS sale_volume,
              s.total_revenue AS sale_revenue,
              a.revenue AS total_revenue
       FROM alloc a
       JOIN plot pl        ON pl.id = a.plot_id
       JOIN selling s      ON s.id = a.selling_id
       LEFT JOIN offtaker o ON o.id = s.offtaker_id
       LEFT JOIN farmers f  ON f.id = pl.farmer_id
       ${farmerRefScope('pl')}
       WHERE ${where.join(' AND ')}
       ORDER BY a.sale_date DESC, pl.plot_name`, args);
    return res.json({ data: rows });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// GET /api/profit-sharing/pl — the standing position of every ProfitSharing plot.
//
// The unit is the plot, not the farmer. The scheme is a property of the plot, and
// a farmer may hold a Beli Putus plot and a Profit Sharing plot at once; grouping
// by farmer mixed the two together. It also let costs booked against a
// non-ProfitSharing plot appear here, which is how three Pre-Finance farmers used
// to show up on this page with an investment and no revenue at all.
//
// Plots that have not sold yet are kept, with revenue 0 — a plot carrying cost and
// no income is exactly the one worth looking at.
router.get('/pl', authenticate, async (req: Request, res: Response) => {
  try {
    const period = req.query.period ? String(req.query.period) : null;
    const args: any[] = [];
    // Each filter sits inside its own derived table, so the placeholders bind in
    // the order the subqueries appear below.
    const allocWhere = period ? "WHERE DATE_FORMAT(sale_date, '%Y-%m') = ?" : '';
    if (period) args.push(period);
    const sapWhere = period ? "AND DATE_FORMAT(date, '%Y-%m') = ?" : '';
    if (period) args.push(period);
    const landWhere = period ? 'AND period = ?' : '';
    if (period) args.push(period);

    const where: string[] = ["pl.scheme = 'ProfitSharing'"];
    const scope = entityScope(req);
    if (scope != null) { where.push(`${ENTITY_COL} = ?`); args.push(scope); }

    const [rows] = await pool.query(
      `${ALLOC}
       SELECT pl.id AS plot_id, pl.plot_name, f.id AS farmer_id, f.farmer_name,
              COALESCE(r.volume_sold, 0)      AS volume_sold,
              COALESCE(r.total_revenue, 0)    AS total_revenue,
              COALESCE(r.cost_purchase, 0)    AS cost_purchase,
              COALESCE(r.cost_harvest, 0)     AS cost_harvest,
              COALESCE(r.cost_pnbp, 0)        AS cost_pnbp,
              COALESCE(r.cost_purchase, 0) + COALESCE(r.cost_harvest, 0)
                + COALESCE(r.cost_pnbp, 0)    AS total_investment,
              COALESCE(r.total_revenue, 0)
                - COALESCE(r.cost_purchase, 0) - COALESCE(r.cost_harvest, 0)
                - COALESCE(r.cost_pnbp, 0)    AS net_profit,
              -- Debt, not cost: shown beside the margin because it decides whether
              -- anything may actually be paid out, never subtracted from it.
              --
              -- The two tables are added because they hold different things: the
              -- distributions are what was handed to the farmer, the investments
              -- are what was spent on the plot. They overlapped once — SNBS
              -- imported the same material spend into both, from the Cavendish
              -- Stock card and Daily Update sheets respectively, making this
              -- figure 77% too large. Those rows now carry counts_as_debt = 0 and
              -- drop out here while still counting against warehouse stock.
              -- See docs/rekonsiliasi-buku-besar-2026-08.md.
              --
              -- Only lines booked under ProfitSharing: a plot that was Pre-Finance
              -- before it became profit sharing keeps that earlier spend as the
              -- farmer's per-kg debt, not as a cost of this season.
              COALESCE(sap.amount, 0)         AS debt_saprodi,
              COALESCE(land.amount, 0)        AS debt_land,
              COALESCE(sap.amount, 0) + COALESCE(land.amount, 0) AS debt_total,
              COALESCE(st.settled_farmer, 0)  AS settled_farmer
       FROM plot pl
       LEFT JOIN farmers f ON f.id = pl.farmer_id
       LEFT JOIN (
         SELECT plot_id, SUM(volume_share) AS volume_sold, SUM(revenue) AS total_revenue,
                SUM(cost_purchase) AS cost_purchase, SUM(cost_harvest) AS cost_harvest,
                SUM(cost_pnbp) AS cost_pnbp
         FROM alloc ${allocWhere} GROUP BY plot_id
       ) r ON r.plot_id = pl.id
       LEFT JOIN (
         SELECT plot_id, SUM(total_amount) AS amount
         FROM pre_finance_distributions
         WHERE plot_id IS NOT NULL AND counts_as_debt = 1 AND scheme = 'ProfitSharing' ${sapWhere}
         GROUP BY plot_id
       ) sap ON sap.plot_id = pl.id
       LEFT JOIN (
         SELECT plot_id, SUM(amount) AS amount
         FROM profit_sharing_investments
         WHERE plot_id IS NOT NULL ${landWhere} GROUP BY plot_id
       ) land ON land.plot_id = pl.id
       -- Only the farmer side is summable. value_company absorbs the deficit
       -- carried between settlements, so the same shortfall appears on every one
       -- of a plot's rows; adding them up would count it once per sale. The
       -- company's true position is net_profit in this same row.
       -- What has actually been paid out to the farmer (Pre-Finance deduction
       -- included) — the end-of-season payouts, not the per-sale shares, which
       -- only build the balance.
       LEFT JOIN (
         SELECT plot_id, SUM(share_amount) AS settled_farmer
         FROM profit_sharing_payouts GROUP BY plot_id
       ) st ON st.plot_id = pl.id
       ${farmerRefScope('pl')}
       WHERE ${where.join(' AND ')}
       ORDER BY net_profit ASC, pl.plot_name`, args);
    return res.json({ data: rows });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Settlement of one sale.
//
// Layer 2 needs a rule the ledger cannot supply on its own: saprodi and land cost
// are standing balances per plot, while a sale is one event, and a plot usually
// sells several times. Charging the full standing cost to every sale would
// subtract it again and again.
//
// So a settlement charges what has NOT been charged yet — the plot's total
// standing cost minus what earlier settlements already took. Nothing is charged
// twice, and nothing is lost.
//
// The split follows the operational ledgers — "Buku Besar - SJ - Banana" and
// "Buku Besar - AML - Banana":
//
//   value_farmer  = pct_farmer x net
//   value_kth     = pct_kth x (100 - pct_farmer)% x net
//   value_company = net - value_farmer - value_kth
//
// The farmer takes his cut of the whole margin; the KTH takes its cut of what is
// LEFT — `entities.profit_share_kth_pct` is a slice of the company's portion, not
// of the base. For SNBS that is 7% of 70% = 4.9% of the margin, leaving 65.1%.
// Read off sheet `SJ - Data Entry Banana`, where every one of the 15 Delivery
// rows divides column BA into BE 30.00% / BD 4.90% / BC 65.10%.
//
// Sheet `SJ - Farmer Database` does show a plain 7% (column N is 7% of column L),
// but its base is not the margin: L is `Total Distributable Profit` — the
// cumulative margin already net of labour and material. Between 2026-08-21 and
// 2026-08-24 this code took the 7% from there and applied it to the gross margin,
// which is neither sheet's rule; the per-sale sheet governs a per-sale split.
// AML has no KTH cut at all: its farmer share is a plain 50%
// (`Total Profit Generated = K/0.5`).
//
// A LOSS is shared by the very same percentages — the sheet multiplies a negative
// NCF through unchanged, so a bad harvest lands 30% in the farmer's own balance
// rather than being absorbed entirely by the company. Nothing is floored here.
//
// What each party has actually earned is the running balance (`cum_*`). A
// positive balance is NOT enough to be paid, though: the plot has to have earned
// back what was spent on it. Both ledgers gate on that and they do it
// differently, so the rule lives on `entities.payout_rule` — see `payoutFarmer`.
// -----------------------------------------------------------------------------
const SETTLE_SQL = `
${ALLOC}
SELECT a.plot_id, pl.plot_name, pl.farmer_id, f.farmer_name,
       a.volume_share, a.share * 100 AS share_pct,
       a.revenue, a.cost_purchase, a.cost_harvest, a.cost_pnbp,
       a.plot_purchase_value, pl.inside_kth,
       COALESCE(sap.amount, 0)  AS saprodi_total,
       COALESCE(land.amount, 0) AS land_total,
       COALESCE(ch.saprodi, 0)  AS saprodi_charged,
       COALESCE(ch.land, 0)     AS land_charged,
       COALESCE(prev.cum_farmer, 0)  AS prev_cum_farmer,
       COALESCE(prev.cum_company, 0) AS prev_cum_company,
       COALESCE(prev.cum_kth, 0)     AS prev_cum_kth,
       COALESCE(po.paid_out, 0)      AS paid_out,
       done.id AS settled_id
FROM alloc a
JOIN plot pl        ON pl.id = a.plot_id
LEFT JOIN farmers f ON f.id = pl.farmer_id
-- Only cost incurred UP TO the day of this sale. A harvest cannot be charged
-- with money spent after it was sold; without the date bound the first
-- settlement swallowed every cost the plot would ever carry, and the sale it
-- belonged to read as a huge loss while later ones read as pure profit.
LEFT JOIN (
  SELECT plot_id, SUM(total_amount) AS amount FROM pre_finance_distributions
  WHERE plot_id IS NOT NULL AND counts_as_debt = 1 AND scheme = 'ProfitSharing' AND date <= ?
  GROUP BY plot_id
) sap ON sap.plot_id = pl.id
LEFT JOIN (
  SELECT plot_id, SUM(amount) AS amount FROM profit_sharing_investments
  WHERE plot_id IS NOT NULL AND period <= DATE_FORMAT(?, '%Y-%m') GROUP BY plot_id
) land ON land.plot_id = pl.id
LEFT JOIN (
  SELECT plot_id, SUM(cost_saprodi) AS saprodi, SUM(cost_land) AS land
  FROM profit_sharing x
  -- Only settlements BEFORE this sale's own row: re-opening a settled sale must
  -- show it as it stood when it was written, not counted against itself.
  WHERE plot_id IS NOT NULL
    AND x.id < COALESCE((SELECT o.id FROM profit_sharing o WHERE o.selling_id = ? AND o.plot_id = x.plot_id), 2147483647)
  GROUP BY plot_id
) ch ON ch.plot_id = pl.id
-- Opening balances = the closing balances of this plot's LAST settlement. Taken
-- from the latest row rather than summed, because each row already carries the
-- running total of everything before it.
LEFT JOIN (
  SELECT p.plot_id, p.cum_farmer, p.cum_company, p.cum_kth
  FROM profit_sharing p
  JOIN (SELECT plot_id, MAX(id) AS id FROM profit_sharing y
        WHERE plot_id IS NOT NULL
          AND y.id < COALESCE((SELECT o.id FROM profit_sharing o WHERE o.selling_id = ? AND o.plot_id = y.plot_id), 2147483647)
        GROUP BY plot_id) last
    ON last.id = p.id
) prev ON prev.plot_id = pl.id
LEFT JOIN (
  SELECT plot_id, SUM(share_amount) AS paid_out FROM profit_sharing_payouts GROUP BY plot_id
) po ON po.plot_id = pl.id
LEFT JOIN profit_sharing done ON done.selling_id = a.selling_id AND done.plot_id = a.plot_id
WHERE a.selling_id = ? AND pl.scheme = 'ProfitSharing'
ORDER BY pl.plot_name`;

const money = (n: number) => Math.round(n * 100) / 100;

// What has already gone to the farmer out of this plot's standing share — the
// ledgers' `Total Historic Profit Share`: the payouts (profit_sharing_payouts),
// Pre-Finance deduction included, since that too was the farmer's money.
const alreadyPaidToFarmer = (r: any) => money(Number(r.paid_out || 0));

/**
 * What may actually be handed to the farmer today.
 *
 * A positive running balance is not enough: the plot has to have earned back
 * what was spent on it first. Both ledgers gate on that, and they do it
 * differently — so the rule is a property of the PT, stored on `entities`.
 *
 *   NetSurplus — "Buku Besar - SJ - Banana", Farmer Database column P:
 *       =IF((J-E-F-Q) > 0, (J-E-F-Q) * 0.3, 0)
 *     The debt comes out of the base and the farmer gets his percentage of
 *     whatever is left. Verified: AG1 → Rp 1.007.953,75, AG2 → 0.
 *
 *   Gate — "Buku Besar - AML - Banana", Farmer Database column L:
 *       =IF((J-O) > 0, (K-Q), 0)
 *     The debt is only a switch. Once the plot's margin clears it, the farmer's
 *     whole standing share becomes payable. Verified: SM003002 → 0, because its
 *     Rp 83,7 juta debt still exceeds the Rp 53,6 juta the plot has generated.
 *
 * `cumNet` is the plot's cumulative margin — the three running balances add back
 * up to it — and `debt` is its whole standing debt, not the slice this
 * settlement charged.
 */
function payoutFarmer(
  rule: string, cumNet: number, debt: number, cumFarmer: number, paid: number, pct: number | null,
): number {
  if (pct == null) return 0;
  if (rule === 'NetSurplus') {
    const surplus = cumNet - debt - paid;
    return surplus > 0 ? money(surplus * (pct / 100)) : 0;
  }
  return cumNet - debt > 0 ? money(Math.max(0, cumFarmer - paid)) : 0;
}

/** Read the sale, the percentage in force, and the lines it would settle. */
async function buildSettlement(sellingId: number) {
  const [sRows] = await pool.query(
    `SELECT s.id, s.date, s.total_revenue, s.accepted_volume,
            s.profit_share_farmer_pct AS sale_pct,
            pr.commodities_id,
            (SELECT es_k.entities_id FROM processing_purchasings pp
               JOIN purchasing pu ON pu.id = pp.purchasing_id
               JOIN plot es_pl    ON es_pl.id = pu.plot_id
               JOIN farmers es_f  ON es_f.id = es_pl.farmer_id
               JOIN kth es_k      ON es_k.id = es_f.kth_id
              WHERE pp.processing_id = pr.id
              ORDER BY pp.volume_contributed DESC LIMIT 1) AS entity_id
     FROM selling s
     JOIN processing pr ON pr.id = s.processing_id
     WHERE s.id = ? LIMIT 1`, [sellingId]);
  const sale = (sRows as any[])[0];
  if (!sale) return { error: 'Selling not found' as const };

  let pct = sale.sale_pct != null ? Number(sale.sale_pct) : null;
  // The KTH cut has no per-sale override — it is a standing agreement of the PT.
  let pctKth = 0;
  // Which payout gate this PT's ledger uses. See `payoutFarmer` below.
  let payoutRule = 'Gate';
  if (sale.entity_id != null) {
    const [eRows] = await pool.query(
      'SELECT profit_share_farmer_pct, profit_share_kth_pct, payout_rule FROM entities WHERE id = ? LIMIT 1',
      [sale.entity_id]);
    const e = (eRows as any[])[0] || {};
    if (pct == null && e.profit_share_farmer_pct != null) pct = Number(e.profit_share_farmer_pct);
    if (e.profit_share_kth_pct != null) pctKth = Number(e.profit_share_kth_pct);
    if (e.payout_rule) payoutRule = String(e.payout_rule);
  }

  const saleDate = String(sale.date).slice(0, 10);
  const [rows] = await pool.query(SETTLE_SQL, [saleDate, saleDate, sellingId, sellingId, sellingId]);
  const lines = (rows as any[]).map((r) => {
    // Only the part not yet charged to an earlier settlement of this plot.
    const costSaprodi = money(Math.max(0, Number(r.saprodi_total) - Number(r.saprodi_charged)));
    const costLand = money(Math.max(0, Number(r.land_total) - Number(r.land_charged)));
    const revenue = money(Number(r.revenue));
    const costPurchase = money(Number(r.cost_purchase));
    const costHarvest = money(Number(r.cost_harvest));
    const costPnbp = money(Number(r.cost_pnbp));
    const totalInvestment = money(costPurchase + costHarvest + costPnbp);
    const net = money(revenue - totalInvestment);
    // A farmer already paid for the delivery earns no share of it — the ledger's
    // `x IF(purchase value <> 0, 0, 1)`. Saprodi and land stay out of the margin
    // entirely; they are the debt this settlement is measured against.
    const wasPaid = Number(r.plot_purchase_value) > 0;
    const insideKth = Number(r.inside_kth) !== 0;
    // Percentages are applied to `net` as it stands, sign included. A loss is
    // divided exactly like a profit, which is what the source model does.
    const valueFarmer = pct == null || wasPaid ? 0 : money(net * (pct / 100));
    // The KTH's percentage is a cut of the company's portion, so its share of the
    // base is `pctKth x (100 - pct_farmer)%` — 7% of 70% = 4.9% for SNBS. It is
    // taken off the nominal split, not off `valueFarmer`, so a plot whose farmer
    // was already paid still yields the KTH the same 4.9% the ledger gives it.
    const pctKthEff = pct == null ? 0 : money(((100 - pct) * pctKth) / 100);
    const valueKth = pct == null || !insideKth ? 0 : money(net * (pctKthEff / 100));
    const valueCompany = money(net - valueFarmer - valueKth);
    // Closing balances = opening balances plus this settlement's shares.
    const cumFarmer = money(Number(r.prev_cum_farmer) + valueFarmer);
    const cumKth = money(Number(r.prev_cum_kth) + valueKth);
    const cumCompany = money(Number(r.prev_cum_company) + valueCompany);
    return {
      plot_id: r.plot_id, plot_name: r.plot_name,
      farmer_id: r.farmer_id, farmer_name: r.farmer_name,
      volume_share: Number(r.volume_share), share_pct: money(Number(r.share_pct)),
      total_revenue: revenue,
      cost_purchase: costPurchase, cost_harvest: costHarvest, cost_pnbp: costPnbp,
      debt_saprodi: costSaprodi, debt_land: costLand,
      total_investment: totalInvestment,
      farmer_was_paid: wasPaid, inside_kth: insideKth,
      net_profit: net,
      pct_farmer: pct,
      pct_company: pct == null ? null : money(100 - pct - pctKthEff),
      // Effective share of the base, so `value_kth = net x pct_kth` holds for the
      // stored row. The agreed rate itself is `pct_kth_of_company`.
      pct_kth: pctKthEff,
      pct_kth_of_company: pctKth,
      value_farmer: valueFarmer,
      value_company: valueCompany,
      value_kth: valueKth,
      cum_farmer: cumFarmer,
      cum_company: cumCompany,
      cum_kth: cumKth,
      // The whole standing debt of the plot, which the payout gate measures the
      // plot's cumulative margin against. Not the slice charged by this
      // settlement — that is `debt_saprodi` + `debt_land` above.
      debt_total: money(Number(r.saprodi_total) + Number(r.land_total)),
      payout_rule: payoutRule,
      // What the payout rule would release if the plot were closed after this
      // sale — information only. Nothing is paid per sale: the farmer is paid
      // once, at the end, through POST /payouts.
      payable_farmer: money(Math.max(0, payoutFarmer(
        payoutRule,
        money(cumFarmer + cumKth + cumCompany),
        money(Number(r.saprodi_total) + Number(r.land_total)),
        cumFarmer,
        0,
        pct,
      ) - alreadyPaidToFarmer(r))),
      already_settled_id: r.settled_id ?? null,
    };
  });
  return { sale, pct, pctKth, lines };

}

// GET /api/profit-sharing/settlement/:sellingId — preview, nothing is written.
router.get('/settlement/:sellingId', authenticate, async (req: Request, res: Response) => {
  try {
    const built = await buildSettlement(Number(req.params.sellingId));
    if ('error' in built) return res.status(404).json({ message: built.error });
    const { sale, pct, pctKth, lines } = built;
    return res.json({
      data: {
        selling_id: sale.id, date: sale.date, total_revenue: Number(sale.total_revenue),
        entity_id: sale.entity_id, pct_farmer: pct,
        // Nominal rate (a cut of the company's portion) and what it works out to
        // against the margin — the page shows both.
        pct_kth: pctKth,
        pct_kth_effective: pct == null ? null : money(((100 - pct) * pctKth) / 100),
        settled: lines.some((l) => l.already_settled_id != null),
        lines,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// POST /api/profit-sharing/settle  { selling_id }
// Writes one profit_sharing row per ProfitSharing plot in the sale.
router.post('/settle', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const sellingId = Number(req.body?.selling_id);
    if (!sellingId) return res.status(422).json({ message: 'selling_id is required' });

    const built = await buildSettlement(sellingId);
    if ('error' in built) return res.status(404).json({ message: built.error });
    const { sale, pct, lines } = built;

    if (!lines.length) {
      return res.status(422).json({ message: 'This sale has no Profit Sharing plot in its batch.' });
    }
    if (pct == null) {
      return res.status(422).json({
        message: 'Persentase bagi hasil belum diatur. Isi "% Petani" pada entitas '
          + '(Settings → Entitas) atau pada penjualan ini sebelum menghitung bagi hasil.',
      });
    }
    const done = lines.filter((l) => l.already_settled_id != null);
    if (done.length) {
      return res.status(409).json({
        message: `Penjualan ini sudah dibagihasilkan untuk ${done.length} lahan. `
          + 'Hapus catatan bagi hasilnya dulu bila ingin menghitung ulang.',
      });
    }

    const period = String(sale.date).slice(0, 7);
    const now = new Date();
    await conn.beginTransaction();
    for (const l of lines) {
      await conn.query(
        `INSERT INTO profit_sharing
           (period, selling_id, farmer_id, plot_id, commodities_id, volume_share, share_pct,
            total_revenue, cost_purchase, cost_harvest, cost_pnbp,
            cost_saprodi, cost_land,
            total_investment, pct_farmer, pct_company, pct_kth,
            value_farmer, value_company, value_kth, cum_farmer, cum_company, cum_kth,
            status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [period, sellingId, l.farmer_id, l.plot_id, sale.commodities_id ?? null,
         l.volume_share, l.share_pct, l.total_revenue,
         l.cost_purchase, l.cost_harvest, l.cost_pnbp,
         l.debt_saprodi, l.debt_land, l.total_investment,
         l.pct_farmer, l.pct_company, l.pct_kth,
         l.value_farmer, l.value_company, l.value_kth,
         l.cum_farmer, l.cum_company, l.cum_kth, 'Draft', now, now]);
    }
    await conn.commit();
    return res.status(201).json({
      message: `Bagi hasil dihitung untuk ${lines.length} lahan.`,
      data: lines,
    });
  } catch (err: any) {
    await conn.rollback().catch(() => undefined);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

// -----------------------------------------------------------------------------
// Paying the profit share out — at the end, per plot.
//
// Business rule (2026-11-05): the farmer's share is paid once the plot's
// harvests are done (JNBS: 2027/2028), and only while the plot stands in
// profit — its cumulative margin above every profit-sharing cost (saprodi,
// labour, land). Of what the PT's payout rule then releases, the farmer's
// remaining Pre-Finance debt is kept back first (the loans from before the plot
// became profit sharing) and booked as a repayment; the rest is paid.
//
//   GET    /payouts/preview?plot_id=&date=   the position, nothing written
//   POST   /payouts { plot_id, date, notes }
//   GET    /payouts?plot_id=
//   DELETE /payouts/:id                       takes its repayment with it
// -----------------------------------------------------------------------------
async function payoutPosition(plotId: number, date: string) {
  const [pRows] = await pool.query(
    `SELECT pl.id, pl.plot_name, pl.scheme, pl.farmer_id, f.farmer_name, k.entities_id AS entity_id,
            e.payout_rule, e.profit_share_farmer_pct
       FROM plot pl LEFT JOIN farmers f ON f.id = pl.farmer_id LEFT JOIN kth k ON k.id = f.kth_id
       LEFT JOIN entities e ON e.id = k.entities_id WHERE pl.id = ? LIMIT 1`, [plotId]);
  const plot = (pRows as any[])[0];
  if (!plot) return { error: 'Plot not found' as const };

  // The balances as the last settlement left them.
  const [lRows] = await pool.query(
    `SELECT ps.id, ps.period, s.date AS sale_date, ps.pct_farmer, ps.cum_farmer, ps.cum_company, ps.cum_kth
       FROM profit_sharing ps LEFT JOIN selling s ON s.id = ps.selling_id
      WHERE ps.plot_id = ? ORDER BY ps.id DESC LIMIT 1`, [plotId]);
  const last = (lRows as any[])[0] || null;
  const [[cnt]] = await pool.query(
    'SELECT COUNT(*) AS n FROM profit_sharing WHERE plot_id = ?', [plotId]) as any;
  // Sales of this plot's profit-sharing kilos that were never settled: the
  // position would be incomplete without them.
  const [unsettled] = await pool.query(
    `SELECT DISTINCT s.id, s.date FROM selling s
       JOIN processing_purchasings pp ON pp.processing_id = s.processing_id
       JOIN purchasing pu ON pu.id = pp.purchasing_id
      WHERE pu.plot_id = ? AND pu.scheme = 'ProfitSharing' AND s.date <= ?
        AND NOT EXISTS (SELECT 1 FROM profit_sharing x WHERE x.selling_id = s.id AND x.plot_id = pu.plot_id)
      ORDER BY s.date`, [plotId, date]);
  const [[cost]] = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(total_amount), 0) FROM pre_finance_distributions
         WHERE plot_id = ? AND counts_as_debt = 1 AND scheme = 'ProfitSharing' AND date <= ?) AS saprodi_labour,
       (SELECT COALESCE(SUM(amount), 0) FROM profit_sharing_investments
         WHERE plot_id = ? AND period <= DATE_FORMAT(?, '%Y-%m')) AS land`, [plotId, date, plotId, date]) as any;
  const [[paid]] = await pool.query(
    'SELECT COALESCE(SUM(share_amount), 0) AS v FROM profit_sharing_payouts WHERE plot_id = ?', [plotId]) as any;

  const margin = last ? money(Number(last.cum_farmer) + Number(last.cum_company) + Number(last.cum_kth)) : 0;
  const psCost = money(Number(cost.saprodi_labour) + Number(cost.land));
  const farmerShare = last ? money(Number(last.cum_farmer)) : 0;
  const pct = last?.pct_farmer != null ? Number(last.pct_farmer)
    : plot.profit_share_farmer_pct != null ? Number(plot.profit_share_farmer_pct) : null;
  const rule = String(plot.payout_rule || 'Gate');
  const alreadyPaid = money(Number(paid.v));
  const releasable = money(Math.max(0, payoutFarmer(rule, margin, psCost, farmerShare, 0, pct) - alreadyPaid));

  // The farmer's remaining Pre-Finance debt, per type, comes out first — in
  // proportion to what is still owed of each.
  const [o] = await pool.query(
    `SELECT pre_finance_type_id, type_name, outstanding FROM v_pre_finance_outstanding
      WHERE farmer_id = ? AND outstanding > 0 ORDER BY pre_finance_type_id`, [plot.farmer_id]);
  const debt = (o as any[]).map((d) => ({ ...d, outstanding: Number(d.outstanding) }));
  const pfOutstanding = money(debt.reduce((s, d) => s + d.outstanding, 0));
  const take = money(Math.min(releasable, pfOutstanding));
  let left = take;
  const lines = take > 0 ? debt.map((d, i) => {
    const a = i === debt.length - 1 ? money(left) : money(take * (d.outstanding / pfOutstanding));
    left = money(left - a);
    return { pre_finance_type_id: d.pre_finance_type_id, type_name: d.type_name, outstanding: d.outstanding, amount: a };
  }).filter((x) => x.amount > 0) : [];

  let blocked: string | null = null;
  if (plot.scheme !== 'ProfitSharing') blocked = 'Lahan ini bukan lahan Profit Sharing.';
  else if (!Number(cnt.n)) blocked = 'Belum ada penjualan yang dibagihasilkan untuk lahan ini.';
  else if ((unsettled as any[]).length) blocked = `Masih ada ${(unsettled as any[]).length} penjualan yang belum dibagihasilkan — hitung dulu di atas.`;
  else if (margin - psCost <= 0) blocked = `Lahan masih minus: margin ${fmt(margin)} belum melampaui biaya bagi hasil ${fmt(psCost)}.`;
  else if (releasable <= 0) blocked = alreadyPaid > 0 ? 'Bagian petani lahan ini sudah dibayarkan.' : 'Tidak ada bagian petani yang bisa dibayarkan.';

  return {
    plot_id: plot.id, plot_name: plot.plot_name, farmer_id: plot.farmer_id, farmer_name: plot.farmer_name,
    date, payout_rule: rule, pct_farmer: pct,
    settlements: Number(cnt.n), last_sale_date: last?.sale_date ?? null,
    unsettled_sales: unsettled,
    margin_total: margin, ps_cost_total: psCost, position: money(margin - psCost),
    farmer_share_total: farmerShare, already_paid: alreadyPaid,
    share_amount: blocked ? 0 : releasable,
    pf_outstanding: pfOutstanding,
    pf_deduction: blocked ? 0 : take, pf_deduction_lines: blocked ? [] : lines,
    paid_amount: blocked ? 0 : money(releasable - take),
    blocked,
  };
}
const fmt = (n: number) => `Rp ${Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;

/** The plot is this caller's to see (same PT rule as the plot lists). */
async function plotInScope(req: Request, plotId: number) {
  const scope = entityScope(req);
  if (scope == null) return true;
  const [r] = await pool.query(
    `SELECT 1 FROM plot pl JOIN farmers f ON f.id = pl.farmer_id JOIN kth k ON k.id = f.kth_id
      WHERE pl.id = ? AND k.entities_id = ? LIMIT 1`, [plotId, scope]);
  return (r as any[]).length > 0;
}

router.get('/payouts/preview', authenticate, async (req: Request, res: Response) => {
  try {
    const plotId = Number(req.query.plot_id);
    if (!plotId) return res.status(422).json({ message: 'plot_id is required' });
    if (!(await plotInScope(req, plotId))) return res.status(404).json({ message: 'Plot not found' });
    const date = String(req.query.date || new Date().toISOString()).slice(0, 10);
    const p = await payoutPosition(plotId, date);
    if ('error' in p) return res.status(404).json({ message: p.error });
    return res.json({ data: p });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.get('/payouts', authenticate, async (req: Request, res: Response) => {
  try {
    const where: string[] = []; const args: any[] = [];
    if (req.query.plot_id) { where.push('po.plot_id = ?'); args.push(Number(req.query.plot_id)); }
    const scope = entityScope(req);
    if (scope != null) { where.push('k.entities_id = ?'); args.push(scope); }
    const [rows] = await pool.query(
      `SELECT po.*, pl.plot_name, f.farmer_name, u.name AS created_by_name, i.id AS installment_id
         FROM profit_sharing_payouts po
         JOIN plot pl ON pl.id = po.plot_id
         JOIN farmers f ON f.id = po.farmer_id LEFT JOIN kth k ON k.id = f.kth_id
         LEFT JOIN users u ON u.id = po.created_by_user_id
         LEFT JOIN pre_finance_installments i ON i.profit_sharing_payout_id = po.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY po.payout_date DESC, po.id DESC`, args);
    return res.json({ data: rows });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.post('/payouts', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const plotId = Number(req.body?.plot_id);
    if (!plotId) return res.status(422).json({ message: 'plot_id is required' });
    if (!(await plotInScope(req, plotId))) return res.status(404).json({ message: 'Plot not found' });
    const date = String(req.body?.date || new Date().toISOString()).slice(0, 10);
    const p = await payoutPosition(plotId, date);
    if ('error' in p) return res.status(404).json({ message: p.error });
    if (p.blocked) return res.status(422).json({ message: p.blocked, data: p });

    const now = new Date();
    const userId = req.user?.type === 'User' ? req.user.id : null;
    await conn.beginTransaction();
    // Two payouts of one plot at once would both release the same share.
    await conn.query('SELECT id FROM plot WHERE id = ? FOR UPDATE', [plotId]);
    const [ins] = await conn.query(
      `INSERT INTO profit_sharing_payouts (plot_id, farmer_id, payout_date, margin_total, ps_cost_total, farmer_share_total,
         share_amount, pf_deduction, paid_amount, notes, created_by_user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [plotId, p.farmer_id, date, p.margin_total, p.ps_cost_total, p.farmer_share_total,
       p.share_amount, p.pf_deduction, p.paid_amount, req.body?.notes ?? null, userId, now, now]);
    const payoutId = (ins as any).insertId;
    if (p.pf_deduction > 0) {
      const [inst] = await conn.query(
        `INSERT INTO pre_finance_installments (profit_sharing_payout_id, farmer_id, date, reference_no, total_payment, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [payoutId, p.farmer_id, date, `PSP-${payoutId}`, p.pf_deduction,
         `Dipotong dari bagi hasil lahan ${p.plot_name}`, now, now]);
      for (const l of p.pf_deduction_lines) {
        await conn.query('INSERT INTO pre_finance_installment_details (installment_id, pre_finance_type_id, amount) VALUES (?,?,?)',
          [(inst as any).insertId, l.pre_finance_type_id, l.amount]);
      }
    }
    await conn.commit();
    return res.status(201).json({
      message: `Bagi hasil ${p.plot_name} dibayarkan: ${fmt(p.paid_amount)} ke petani`
        + (p.pf_deduction > 0 ? `, ${fmt(p.pf_deduction)} dipotong untuk utang Pre-Finance.` : '.'),
      data: { id: payoutId, ...p },
    });
  } catch (err: any) {
    await conn.rollback().catch(() => undefined);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
});

router.delete('/payouts/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const [r] = await pool.query('SELECT plot_id FROM profit_sharing_payouts WHERE id = ? LIMIT 1', [req.params.id]);
    const row = (r as any[])[0];
    if (!row || !(await plotInScope(req, Number(row.plot_id)))) return res.status(404).json({ message: 'Payout not found' });
    await pool.query('DELETE FROM profit_sharing_payouts WHERE id = ?', [req.params.id]);
    return res.json({ message: 'Pembayaran bagi hasil dihapus, beserta potongan utangnya.' });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;
