import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate, hashPassword } from '../middleware/auth';

export interface CrudConfig {
  table: string;
  /** Columns the client may insert/update. */
  columns: string[];
  /** Required columns on create. */
  required?: string[];
  /** Numeric columns (cast with Number()). */
  numeric?: string[];
  /** Boolean columns (cast to 0/1). */
  boolean?: string[];
  /** ORDER BY clause (without the words ORDER BY). Default: id DESC. */
  orderBy?: string;
  /** Columns searched by ?search=. */
  searchColumns?: string[];
  /** Columns usable as ?col=val exact filters. */
  filterColumns?: string[];
  /** Manage created_at / updated_at automatically. Default true. */
  timestamps?: boolean;
  /** Columns whose values must be bcrypt-hashed before storing (e.g. password). */
  hashColumns?: string[];
  /** Columns to strip from every response row (e.g. password). */
  hideColumns?: string[];
  /** Human label for messages. Default = table. */
  label?: string;
}

function sanitize(cfg: CrudConfig, row: any): any {
  if (!row || !cfg.hideColumns?.length) return row;
  const out = { ...row };
  for (const c of cfg.hideColumns) delete out[c];
  return out;
}

function coerce(cfg: CrudConfig, col: string, val: any): any {
  if (val === undefined) return undefined;
  if (val === null || val === '') return null;
  if (cfg.numeric?.includes(col)) return Number(val);
  if (cfg.boolean?.includes(col)) return val === true || val === 'true' || val === 1 || val === '1' ? 1 : 0;
  return val;
}

/**
 * Build a full CRUD router for a simple table.
 * Endpoints: GET /, GET /:id, POST /, PUT /:id, POST /:id (?_method=PUT), DELETE /:id
 */
export function crudRouter(cfg: CrudConfig): Router {
  const router = Router();
  const label = cfg.label || cfg.table;
  const timestamps = cfg.timestamps !== false;
  const orderBy = cfg.orderBy || 'id DESC';

  // LIST
  router.get('/', authenticate, async (req: Request, res: Response) => {
    try {
      const where: string[] = [];
      const args: any[] = [];

      if (cfg.filterColumns) {
        for (const col of cfg.filterColumns) {
          const v = req.query[col];
          if (v !== undefined && v !== '') { where.push(`\`${col}\` = ?`); args.push(v); }
        }
      }
      const search = (req.query.search as string) || '';
      if (search && cfg.searchColumns?.length) {
        const ors = cfg.searchColumns.map((c) => `\`${c}\` LIKE ?`);
        where.push(`(${ors.join(' OR ')})`);
        cfg.searchColumns.forEach(() => args.push(`%${search}%`));
      }

      const sql =
        `SELECT * FROM \`${cfg.table}\`` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${orderBy}`;
      const [rows] = await pool.query(sql, args);
      return res.json({ data: (rows as any[]).map((r) => sanitize(cfg, r)) });
    } catch (err: any) {
      return res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // DETAIL
  router.get('/:id', authenticate, async (req: Request, res: Response) => {
    const [rows] = await pool.query(`SELECT * FROM \`${cfg.table}\` WHERE id = ? LIMIT 1`, [req.params.id]);
    const list = rows as any[];
    if (!list.length) return res.status(404).json({ message: `${label} not found` });
    return res.json({ data: sanitize(cfg, list[0]) });
  });

  // CREATE
  router.post('/', authenticate, async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      for (const k of cfg.required || []) {
        if (b[k] === undefined || b[k] === null || b[k] === '') {
          return res.status(422).json({ message: `${k} is required` });
        }
      }
      const cols: Record<string, any> = {};
      for (const c of cfg.columns) {
        let v = coerce(cfg, c, b[c]);
        if (v !== undefined && v !== null && cfg.hashColumns?.includes(c)) v = await hashPassword(String(v));
        if (v !== undefined) cols[c] = v;
      }
      if (timestamps) { cols.created_at = new Date(); cols.updated_at = new Date(); }

      const keys = Object.keys(cols);
      if (!keys.length) return res.status(422).json({ message: 'No fields to insert' });
      const sql = `INSERT INTO \`${cfg.table}\` (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
      const [result] = await pool.query(sql, keys.map((k) => cols[k]));
      const id = (result as any).insertId;
      const [rows] = await pool.query(`SELECT * FROM \`${cfg.table}\` WHERE id = ? LIMIT 1`, [id]);
      return res.status(201).json({ message: `${label} created`, data: sanitize(cfg, (rows as any[])[0]) });
    } catch (err: any) {
      return res.status(500).json({ message: 'Server error', error: err.message });
    }
  });

  // UPDATE
  const update = async (req: Request, res: Response) => {
    try {
      const id = req.params.id;
      const [exists] = await pool.query(`SELECT id FROM \`${cfg.table}\` WHERE id = ? LIMIT 1`, [id]);
      if (!(exists as any[]).length) return res.status(404).json({ message: `${label} not found` });

      const b = req.body || {};
      const updates: Record<string, any> = {};
      for (const c of cfg.columns) {
        let v = coerce(cfg, c, b[c]);
        // For hashed columns, ignore empty string (means "don't change").
        if (cfg.hashColumns?.includes(c)) {
          if (b[c] === undefined || b[c] === '' || b[c] === null) continue;
          v = await hashPassword(String(b[c]));
        }
        if (v !== undefined) updates[c] = v;
      }
      const keys = Object.keys(updates);
      if (keys.length) {
        if (timestamps) { updates.updated_at = new Date(); keys.push('updated_at'); }
        const sql = `UPDATE \`${cfg.table}\` SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`;
        await pool.query(sql, [...keys.map((k) => updates[k]), id]);
      }
      const [rows] = await pool.query(`SELECT * FROM \`${cfg.table}\` WHERE id = ? LIMIT 1`, [id]);
      return res.json({ message: `${label} updated`, data: sanitize(cfg, (rows as any[])[0]) });
    } catch (err: any) {
      return res.status(500).json({ message: 'Server error', error: err.message });
    }
  };
  router.put('/:id', authenticate, update);
  router.post('/:id', authenticate, (req, res) => {
    if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
    return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
  });

  // DELETE
  router.delete('/:id', authenticate, async (req: Request, res: Response) => {
    try {
      const [result] = await pool.query(`DELETE FROM \`${cfg.table}\` WHERE id = ?`, [req.params.id]);
      if (!(result as any).affectedRows) return res.status(404).json({ message: `${label} not found` });
      return res.json({ message: `${label} deleted` });
    } catch (err: any) {
      return res.status(409).json({ message: 'Cannot delete (in use?)', error: err.message });
    }
  });

  return router;
}
