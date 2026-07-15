import pool from '../db/connection';

// Generate a sequential document number like PREFIX-YYYY-0001.
// Counts existing rows in `table` whose `column` starts with PREFIX-YYYY-.
export async function nextDocNumber(table: string, column: string, prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` LIKE ?`,
    [like]
  );
  const n = Number((rows as any[])[0]?.n || 0) + 1;
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}
