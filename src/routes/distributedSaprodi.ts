import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

// Saprodi distributed to plots (pre-finance in-kind). Read per plot by the
// mobile app: GET /api/distributed-sapropdi/plot/:plotId → { data: [ ... ] }
// with nested sapropdi / commodities / plot objects.
export const router = Router();

const SELECT = `
  SELECT d.id, d.date, d.plot_id, d.commodities_id, d.sapropdi_id, d.quantity,
         d.price_per_unit, d.total_price, d.upload_proof, d.created_at, d.updated_at,
         s.sapropdi_name AS sapropdi__sapropdi_name, s.unit AS sapropdi__unit,
         s.created_at AS sapropdi__created_at, s.updated_at AS sapropdi__updated_at,
         c.commodities_name AS commodities__commodities_name,
         c.created_at AS commodities__created_at, c.updated_at AS commodities__updated_at,
         p.plot_name AS plot__plot_name, p.land_area AS plot__land_area,
         p.number_of_plants AS plot__number_of_plants, p.latitude AS plot__latitude,
         p.longitude AS plot__longitude, p.farmer_id AS plot__farmer_id,
         p.created_at AS plot__created_at, p.updated_at AS plot__updated_at
  FROM distributed_sapropdi d
  LEFT JOIN sapropdi s    ON s.id = d.sapropdi_id
  LEFT JOIN commodities c ON c.id = d.commodities_id
  LEFT JOIN plot p        ON p.id = d.plot_id
`;

// Split flat `prefix__col` columns into nested objects.
function shape(row: any) {
  const out: any = {};
  const nested: Record<string, any> = { sapropdi: {}, commodities: {}, plot: {} };
  for (const k of Object.keys(row)) {
    const sep = k.indexOf('__');
    if (sep === -1) { out[k] = row[k]; continue; }
    const group = k.slice(0, sep);
    if (nested[group]) nested[group][k.slice(sep + 2)] = row[k];
  }
  out.sapropdi = row.sapropdi_id ? { id: row.sapropdi_id, ...nested.sapropdi } : null;
  out.commodities = row.commodities_id ? { id: row.commodities_id, ...nested.commodities } : null;
  out.plot = row.plot_id ? { id: row.plot_id, ...nested.plot } : null;
  return out;
}

// GET /api/distributed-sapropdi/plot/:plotId
router.get('/plot/:plotId', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE d.plot_id = ? ORDER BY d.date DESC, d.id DESC', [req.params.plotId]);
  return res.json({ data: (rows as any[]).map(shape) });
});

// GET /api/distributed-sapropdi/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE d.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Distributed saprodi not found' });
  return res.json({ data: shape(list[0]) });
});

export default router;
