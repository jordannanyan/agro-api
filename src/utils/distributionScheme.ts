// The scheme a new distribution line is booked under: its plot's scheme today.
//
// Stored on the line (`pre_finance_distributions.scheme`) instead of read from the
// plot at query time, because a plot can change scheme and what was issued before
// the change keeps the old one — the five JNBS plots were Pre-Finance until
// 28 Aug 2025 and profit sharing after. Whether the line is farmer debt
// (v_pre_finance_outstanding) or a profit-sharing cost (profitSharing.ts)
// follows from it.

type Db = { query: (sql: string, args?: any[]) => Promise<any> };

export async function plotScheme(db: Db, plotId: number | null | undefined): Promise<string | null> {
  if (!plotId) return null;
  const [rows] = await db.query('SELECT scheme FROM plot WHERE id = ? LIMIT 1', [plotId]);
  return (rows as any[])[0]?.scheme ?? null;
}
