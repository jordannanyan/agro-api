import { Request, Response } from 'express';
import pool from '../db/connection';

// -----------------------------------------------------------------------------
// Opt-in pagination.
//
// A list endpoint pages *only* when the caller asks for a page. Without ?page or
// ?per_page the response is exactly what it always was — a bare { data: [...] } —
// so the Flutter land+tree app, the dashboards and every existing script keep
// working untouched while the web screens that opt in stop pulling everything.
//
// Why it was needed: /api/purchasing was returning 5,089 rows in a single 3.3 MB
// response, and the browser rendered every one of them. That is fine today and
// unworkable in a year.
// -----------------------------------------------------------------------------

const DEFAULT_PER_PAGE = 25;
const MAX_PER_PAGE = 200;

export interface PageRequest { page: number; perPage: number; offset: number }

/** The page the caller asked for, or null when they asked for the whole list. */
export function pageRequest(req: Request): PageRequest | null {
  const hasPage = req.query.page != null && req.query.page !== '';
  const hasPer = req.query.per_page != null && req.query.per_page !== '';
  if (!hasPage && !hasPer) return null;

  const perPage = Math.min(
    Math.max(1, Number(req.query.per_page) || DEFAULT_PER_PAGE),
    MAX_PER_PAGE);
  const page = Math.max(1, Number(req.query.page) || 1);
  return { page, perPage, offset: (page - 1) * perPage };
}

/**
 * Run a list query and answer either the full list or one page of it.
 *
 * `sql` is the finished query including ORDER BY; the total is counted by wrapping
 * it, so the count can never drift from the filters the list actually applied.
 *
 * `shape` maps a raw row to the response shape, for the routes that nest related
 * records (purchasing, processing, …).
 */
export async function respondList(
  req: Request,
  res: Response,
  sql: string,
  args: any[] = [],
  shape?: (row: any) => any,
  /**
   * Aggregates over the *whole* filtered set, e.g. 'SUM(quantity) AS qty'.
   * Column names are the list query's own output columns.
   *
   * The screens show totals above their tables. Summing one page instead would
   * quietly turn "Total Nilai" into "total of the 25 rows you happen to be
   * looking at" — a number that changes when you turn the page.
   */
  totals?: string,
) {
  const map = (rows: any[]) => (shape ? rows.map(shape) : rows);
  const pg = pageRequest(req);

  if (!pg) {
    const [rows] = await pool.query(sql, args);
    return res.json({ data: map(rows as any[]) });
  }

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS n${totals ? `, ${totals}` : ''} FROM (${sql}) AS paged_source`, args);
  const summary = (countRows as any[])[0] || {};
  const total = Number(summary.n || 0);

  // LIMIT/OFFSET as bound values: pool.query escapes them as numbers, and both are
  // already clamped above, so a caller cannot ask for an unbounded page.
  const [rows] = await pool.query(`${sql} LIMIT ? OFFSET ?`, [...args, pg.perPage, pg.offset]);

  return res.json({
    data: map(rows as any[]),
    meta: {
      page: pg.page,
      per_page: pg.perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / pg.perPage)),
      ...(totals ? { totals: omit(summary, 'n') } : {}),
    },
  });
}

/** A shallow copy without one key — used to lift the row count out of the totals. */
function omit(obj: Record<string, any>, key: string): Record<string, any> {
  const { [key]: _dropped, ...rest } = obj;
  return rest;
}
