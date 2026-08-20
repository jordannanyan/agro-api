import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { crudRouter } from '../utils/crudFactory';
import { entityScope } from '../utils/entityScope';
import { ENTITY_COL, farmerRefScope } from '../utils/farmScope';

export const router = Router();

// -----------------------------------------------------------------------------
// How a sale is split.
//
// A processing batch is fed by many deposits, and a sale is of the batch, not of
// any one deposit. The whole file turns on one number: the share of the batch a
// plot put in.
//
//   share  = kg the plot contributed / kg the batch received
//
// Layer 1 — revenue, processing cost and selling cost are of the batch, so each
//           is multiplied by `share`. Weight lost in processing and sales made in
//           instalments are then carried proportionally by every depositor,
//           without either being handled as a special case.
// Layer 2 — saprodi and land cost belong to one plot and are not shared.
// Layer 3 — what remains is divided by the entity's percentage.
//
// `contrib` groups by (batch, plot) BEFORE anything is multiplied. That is the
// step the old query lacked: it joined the deposits straight onto the sale, so a
// plot that delivered to the same batch twice was credited twice, and every
// depositor was credited with the entire sale. On the August 2026 data that read
// Rp 1.134.207.766 against Rp 273.119.023 of actual sales.
// -----------------------------------------------------------------------------
const ALLOC = `
WITH batch AS (
  SELECT pp.processing_id, SUM(pp.volume_contributed) AS batch_volume
  FROM processing_purchasings pp
  GROUP BY pp.processing_id
),
contrib AS (
  SELECT pp.processing_id, pu.plot_id, SUM(pp.volume_contributed) AS volume_share
  FROM processing_purchasings pp
  JOIN purchasing pu ON pu.id = pp.purchasing_id
  WHERE pu.plot_id IS NOT NULL
  GROUP BY pp.processing_id, pu.plot_id
),
scost AS (
  SELECT selling_id, SUM(amount) AS amount FROM selling_costs GROUP BY selling_id
),
sold AS (
  SELECT processing_id, SUM(accepted_volume) AS sold_volume
  FROM selling GROUP BY processing_id
),
alloc AS (
  SELECT s.id AS selling_id, s.date AS sale_date, c.plot_id,
         c.volume_share,
         c.volume_share / b.batch_volume AS share,
         s.total_revenue * c.volume_share / b.batch_volume AS revenue,
         -- Processing cost belongs to the BATCH, not to a sale. Multiplying it by
         -- the plot's share alone would charge it again on every instalment: a
         -- batch sold twice would carry its processing twice. Spreading it over
         -- what has been sold charges it exactly once across all the instalments,
         -- and leaves the unsold part uncharged until it sells.
         COALESCE(pr.total_processing_cost, 0)
           * (s.accepted_volume / NULLIF(sv.sold_volume, 0))
           * c.volume_share / b.batch_volume AS cost_processing,
         -- Selling cost is already per-sale, so it only needs the plot's share.
         COALESCE(sc.amount, 0) * c.volume_share / b.batch_volume AS cost_selling
  FROM selling s
  JOIN processing pr ON pr.id = s.processing_id
  JOIN batch b       ON b.processing_id = pr.id
  JOIN contrib c     ON c.processing_id = pr.id
  JOIN sold sv       ON sv.processing_id = pr.id
  LEFT JOIN scost sc ON sc.selling_id = s.id
  WHERE b.batch_volume > 0
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
            'total_revenue', 'cost_processing', 'cost_selling', 'cost_saprodi', 'cost_land',
            'total_investment', 'carry_in', 'pct_farmer', 'pct_company', 'value_farmer', 'value_company', 'status'],
  required: ['period', 'farmer_id'],
  numeric: ['selling_id', 'farmer_id', 'plot_id', 'commodities_id', 'volume_share', 'share_pct',
            'total_revenue', 'cost_processing', 'cost_selling', 'cost_saprodi', 'cost_land',
            'total_investment', 'carry_in', 'pct_farmer', 'pct_company', 'value_farmer', 'value_company'],
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
              COALESCE(r.cost_processing, 0)  AS cost_processing,
              COALESCE(r.cost_selling, 0)     AS cost_selling,
              COALESCE(sap.amount, 0)         AS cost_saprodi,
              COALESCE(land.amount, 0)        AS cost_land,
              COALESCE(r.cost_processing, 0) + COALESCE(r.cost_selling, 0)
                + COALESCE(sap.amount, 0) + COALESCE(land.amount, 0) AS total_investment,
              COALESCE(r.total_revenue, 0)
                - COALESCE(r.cost_processing, 0) - COALESCE(r.cost_selling, 0)
                - COALESCE(sap.amount, 0) - COALESCE(land.amount, 0) AS net_profit,
              COALESCE(st.settled_farmer, 0)  AS settled_farmer
       FROM plot pl
       LEFT JOIN farmers f ON f.id = pl.farmer_id
       LEFT JOIN (
         SELECT plot_id, SUM(volume_share) AS volume_sold, SUM(revenue) AS total_revenue,
                SUM(cost_processing) AS cost_processing, SUM(cost_selling) AS cost_selling
         FROM alloc ${allocWhere} GROUP BY plot_id
       ) r ON r.plot_id = pl.id
       LEFT JOIN (
         SELECT plot_id, SUM(total_amount) AS amount
         FROM pre_finance_distributions
         WHERE plot_id IS NOT NULL ${sapWhere} GROUP BY plot_id
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
       LEFT JOIN (
         SELECT plot_id, SUM(value_farmer) AS settled_farmer
         FROM profit_sharing WHERE plot_id IS NOT NULL GROUP BY plot_id
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
// standing cost minus what earlier settlements already took. The remainder is
// carried to the next sale on its own, which is also what makes a loss behave:
// while a plot is under water the farmer's share is nil and the shortfall stays
// on the plot until later sales clear it.
//
// The farmer's share is floored at zero. Profit sharing shares profit; a farmer
// does not owe money back because a harvest sold for less than it cost. The
// company therefore absorbs a negative, which `value_company` records as such.
// -----------------------------------------------------------------------------
const SETTLE_SQL = `
${ALLOC}
SELECT a.plot_id, pl.plot_name, pl.farmer_id, f.farmer_name,
       a.volume_share, a.share * 100 AS share_pct,
       a.revenue, a.cost_processing, a.cost_selling,
       COALESCE(sap.amount, 0)  AS saprodi_total,
       COALESCE(land.amount, 0) AS land_total,
       COALESCE(ch.saprodi, 0)  AS saprodi_charged,
       COALESCE(ch.land, 0)     AS land_charged,
       COALESCE(prev.net_profit, 0) AS prev_net,
       done.id AS settled_id
FROM alloc a
JOIN plot pl        ON pl.id = a.plot_id
LEFT JOIN farmers f ON f.id = pl.farmer_id
LEFT JOIN (
  SELECT plot_id, SUM(total_amount) AS amount FROM pre_finance_distributions
  WHERE plot_id IS NOT NULL GROUP BY plot_id
) sap ON sap.plot_id = pl.id
LEFT JOIN (
  SELECT plot_id, SUM(amount) AS amount FROM profit_sharing_investments
  WHERE plot_id IS NOT NULL GROUP BY plot_id
) land ON land.plot_id = pl.id
LEFT JOIN (
  SELECT plot_id, SUM(cost_saprodi) AS saprodi, SUM(cost_land) AS land
  FROM profit_sharing WHERE plot_id IS NOT NULL GROUP BY plot_id
) ch ON ch.plot_id = pl.id
-- The deficit carried in is the net of the plot's LAST settlement, not the sum of
-- them: each settlement's net already rolls up the one before it, so adding them
-- together would count the same shortfall again and again.
LEFT JOIN (
  SELECT p.plot_id, p.net_profit
  FROM profit_sharing p
  JOIN (SELECT plot_id, MAX(id) AS id FROM profit_sharing
        WHERE plot_id IS NOT NULL GROUP BY plot_id) last
    ON last.id = p.id
) prev ON prev.plot_id = pl.id
LEFT JOIN profit_sharing done ON done.selling_id = a.selling_id AND done.plot_id = a.plot_id
WHERE a.selling_id = ? AND pl.scheme = 'ProfitSharing'
ORDER BY pl.plot_name`;

const money = (n: number) => Math.round(n * 100) / 100;

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
  if (pct == null && sale.entity_id != null) {
    const [eRows] = await pool.query(
      'SELECT profit_share_farmer_pct FROM entities WHERE id = ? LIMIT 1', [sale.entity_id]);
    const v = (eRows as any[])[0]?.profit_share_farmer_pct;
    if (v != null) pct = Number(v);
  }

  const [rows] = await pool.query(SETTLE_SQL, [sellingId]);
  const lines = (rows as any[]).map((r) => {
    // Only the part not yet charged to an earlier settlement of this plot.
    const costSaprodi = money(Math.max(0, Number(r.saprodi_total) - Number(r.saprodi_charged)));
    const costLand = money(Math.max(0, Number(r.land_total) - Number(r.land_charged)));
    const revenue = money(Number(r.revenue));
    const costProcessing = money(Number(r.cost_processing));
    const costSelling = money(Number(r.cost_selling));
    const totalInvestment = money(costProcessing + costSelling + costSaprodi + costLand);
    // Only a shortfall follows the plot. A previous settlement that ended in
    // profit was already paid out, so carrying it forward would credit it twice.
    const carryIn = money(Math.min(0, Number(r.prev_net)));
    const net = money(revenue - totalInvestment + carryIn);
    const valueFarmer = pct == null ? 0 : money(Math.max(0, net) * (pct / 100));
    return {
      plot_id: r.plot_id, plot_name: r.plot_name,
      farmer_id: r.farmer_id, farmer_name: r.farmer_name,
      volume_share: Number(r.volume_share), share_pct: money(Number(r.share_pct)),
      total_revenue: revenue,
      cost_processing: costProcessing, cost_selling: costSelling,
      cost_saprodi: costSaprodi, cost_land: costLand,
      total_investment: totalInvestment,
      carry_in: carryIn,
      net_profit: net,
      pct_farmer: pct, pct_company: pct == null ? null : money(100 - pct),
      value_farmer: valueFarmer,
      value_company: money(net - valueFarmer),
      already_settled_id: r.settled_id ?? null,
    };
  });
  return { sale, pct, lines };
}

// GET /api/profit-sharing/settlement/:sellingId — preview, nothing is written.
router.get('/settlement/:sellingId', authenticate, async (req: Request, res: Response) => {
  try {
    const built = await buildSettlement(Number(req.params.sellingId));
    if ('error' in built) return res.status(404).json({ message: built.error });
    const { sale, pct, lines } = built;
    return res.json({
      data: {
        selling_id: sale.id, date: sale.date, total_revenue: Number(sale.total_revenue),
        entity_id: sale.entity_id, pct_farmer: pct,
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
            total_revenue, cost_processing, cost_selling, cost_saprodi, cost_land,
            total_investment, carry_in, pct_farmer, pct_company, value_farmer, value_company,
            status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [period, sellingId, l.farmer_id, l.plot_id, sale.commodities_id ?? null,
         l.volume_share, l.share_pct, l.total_revenue, l.cost_processing, l.cost_selling,
         l.cost_saprodi, l.cost_land, l.total_investment, l.carry_in, l.pct_farmer, l.pct_company,
         l.value_farmer, l.value_company, 'Draft', now, now]);
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

export default router;
