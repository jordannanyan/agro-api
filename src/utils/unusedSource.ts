// A picker that raises the next document in a chain — the PR behind a PO, the PO
// behind a payment request or a receipt, the batch behind a sale — should offer
// what is still free rather than the whole archive. `?unused_for=<successor>`
// narrows a list query to the sources nothing has been raised from yet.
//
// Two deliberate escapes, because "already used" is not always "finished":
//
//   * A **rejected** successor consumes nothing. An order that was turned down
//     leaves its request available again, so the rule ignores those rows.
//   * `?include_id=` keeps one row visible whatever the rule decides. A document
//     being edited has to show its own source, which by definition is used.
//
// The caller still holds the escape hatch of simply not sending `unused_for`:
// a request split across several vendors, or an order paid in two instalments,
// is legitimate and stays reachable from the form's "show used" switch.

import { Request } from 'express';

/**
 * Builds the WHERE fragment for `?unused_for=` / `?include_id=`.
 *
 * `rules` maps an accepted `unused_for` value to an EXISTS subquery written
 * against the outer query's alias. Both the alias and the subqueries are
 * compile-time literals from this codebase; the only request input that reaches
 * SQL is `include_id`, and that is bound.
 *
 * Returns null when the caller asked for no filter (or for an unknown one), which
 * leaves the list unchanged.
 */
export function unusedFilter(
  req: Request,
  idExpr: string,
  rules: Record<string, string>,
): { clause: string; args: any[] } | null {
  const key = String(req.query.unused_for || '');
  if (!key) return null;
  const subquery = rules[key];
  if (!subquery) return null;
  const notExists = `NOT EXISTS (${subquery})`;
  const keep = Number(req.query.include_id || 0);
  if (Number.isInteger(keep) && keep > 0) {
    return { clause: `(${notExists} OR ${idExpr} = ?)`, args: [keep] };
  }
  return { clause: notExists, args: [] };
}

/** Statuses that mean a successor document never happened, so it consumes nothing. */
export const DEAD_STATUS = `'Rejected'`;
