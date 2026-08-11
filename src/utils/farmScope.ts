// -----------------------------------------------------------------------------
// Entity routing for the farming tables.
//
// Unlike the procurement documents, none of `purchasing` / `processing` /
// `selling` / `plot` carries an entity_id. What actually belongs to SNBS or JNBS
// is the farmer group: `kth.entities_id`. Every farming record reaches a KTH one
// way or another — through the plot's farmer, through the collector, or through
// the warehouse it moved into — and these fragments write that route down once so
// the dashboard KPIs and the transaction lists cannot drift apart.
//
// Every alias is prefixed `es_` (entity scope) so a fragment can be pasted into a
// query that already joins plot, farmers or warehouse under its own names. Use at
// most one fragment per query level; two would collide on `es_k`.
//
// Rows whose KTH cannot be resolved are excluded from a scoped result: with no
// farmer, collector or warehouse there is nothing that says whose record it is,
// and guessing would put another PT's figures on someone's dashboard.
// -----------------------------------------------------------------------------

/** The entity column every fragment below exposes. */
export const ENTITY_COL = 'es_k.entities_id';

/** A table that holds `kth_id` itself — `farmers`, and anything shaped like it. */
export function kthScope(alias: string): string {
  return `LEFT JOIN kth es_k ON es_k.id = ${alias}.kth_id`;
}

/** A table that points at a farmer — `plot`, `v_pre_finance_outstanding`. */
export function farmerRefScope(alias: string): string {
  return `
  LEFT JOIN farmers es_f ON es_f.id = ${alias}.farmer_id
  LEFT JOIN kth     es_k ON es_k.id = es_f.kth_id`;
}

/**
 * `purchasing`: a farmer purchase names a plot, a collector purchase names a
 * collector, and either may name the receiving warehouse. Read them in that order
 * — the plot is the most specific statement of where the goods came from.
 */
export function purchasingScope(alias = 'p'): string {
  return `
  LEFT JOIN plot       es_pl ON es_pl.id = ${alias}.plot_id
  LEFT JOIN farmers    es_f  ON es_f.id  = es_pl.farmer_id
  LEFT JOIN collectors es_c  ON es_c.id  = ${alias}.collector_id
  LEFT JOIN warehouse  es_w  ON es_w.id  = ${alias}.warehouse_id
  LEFT JOIN kth        es_k  ON es_k.id  = COALESCE(es_f.kth_id, es_c.kth_id, es_w.kth_id)`;
}

/**
 * The KTH behind a processing run, read from the purchases it consumed — the
 * largest contribution wins. `processing.warehouse_id` is nullable, and a run
 * entered without one would otherwise belong to nobody.
 */
function kthFromContributions(procAlias: string): string {
  return `(
    SELECT COALESCE(es_cf.kth_id, es_cc.kth_id, es_cw.kth_id)
    FROM processing_purchasings es_pp
    JOIN purchasing          es_cpu ON es_cpu.id = es_pp.purchasing_id
    LEFT JOIN plot           es_cpl ON es_cpl.id = es_cpu.plot_id
    LEFT JOIN farmers        es_cf  ON es_cf.id  = es_cpl.farmer_id
    LEFT JOIN collectors     es_cc  ON es_cc.id  = es_cpu.collector_id
    LEFT JOIN warehouse      es_cw  ON es_cw.id  = es_cpu.warehouse_id
    WHERE es_pp.processing_id = ${procAlias}.id
    ORDER BY es_pp.volume_contributed DESC
    LIMIT 1)`;
}

/** `processing`: its own warehouse, else the purchases it consumed. */
export function processingScope(alias = 'pr'): string {
  return `
  LEFT JOIN warehouse es_w ON es_w.id = ${alias}.warehouse_id
  LEFT JOIN kth       es_k ON es_k.id = COALESCE(es_w.kth_id, ${kthFromContributions(alias)})`;
}

/** `selling`: its own warehouse, else the processing run's, else that run's input. */
export function sellingScope(alias = 's'): string {
  return `
  LEFT JOIN processing es_pr ON es_pr.id = ${alias}.processing_id
  LEFT JOIN warehouse  es_w  ON es_w.id  = COALESCE(${alias}.warehouse_id, es_pr.warehouse_id)
  LEFT JOIN kth        es_k  ON es_k.id  = COALESCE(es_w.kth_id, ${kthFromContributions('es_pr')})`;
}

/** Join the given predicates into a WHERE clause, dropping the empty ones. */
export function whereClause(...parts: (string | null | undefined)[]): string {
  const list = parts.filter(Boolean) as string[];
  return list.length ? ` WHERE ${list.join(' AND ')}` : '';
}
