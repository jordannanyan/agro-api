import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { crudRouter } from '../utils/crudFactory';

// Standard CRUD for GIS tables.
export const treesRouter = crudRouter({
  table: 'trees',
  columns: ['plot_id', 'tree_code', 'commodities_id', 'latitude', 'longitude', 'planted_date', 'photo'],
  required: ['plot_id'],
  numeric: ['plot_id', 'commodities_id', 'latitude', 'longitude'],
  filterColumns: ['plot_id', 'commodities_id'],
  searchColumns: ['tree_code'],
  label: 'Tree',
});

export const treeMonitoringRouter = crudRouter({
  table: 'tree_monitoring',
  columns: ['tree_id', 'monitor_date', 'height_cm', 'diameter_cm', 'health_status', 'note', 'photo'],
  required: ['tree_id', 'monitor_date'],
  numeric: ['tree_id', 'height_cm', 'diameter_cm'],
  filterColumns: ['tree_id'],
  orderBy: 'monitor_date DESC',
  label: 'Tree monitoring',
});

export const polygonPointsRouter = crudRouter({
  table: 'plot_polygon_points',
  columns: ['plot_id', 'seq', 'latitude', 'longitude', 'photo'],
  required: ['plot_id', 'latitude', 'longitude'],
  numeric: ['plot_id', 'seq', 'latitude', 'longitude'],
  filterColumns: ['plot_id'],
  orderBy: 'plot_id ASC, seq ASC',
  label: 'Polygon point',
});

// Combined map payload for Map Monitoring: plots + polygon + trees.
export const mapRouter = Router();

mapRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.kth_id)    { where.push('f.kth_id = ?'); args.push(req.query.kth_id); }
  if (req.query.entity_id) { where.push('k.entities_id = ?'); args.push(req.query.entity_id); }
  if (req.query.scheme)    { where.push('p.scheme = ?'); args.push(req.query.scheme); }

  const [plots] = await pool.query(
    `SELECT p.id, p.plot_name, p.scheme, p.farmer_id, f.farmer_name, f.kth_id, k.entities_id
     FROM plot p
     LEFT JOIN farmers f ON f.id = p.farmer_id
     LEFT JOIN kth k     ON k.id = f.kth_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.plot_name`, args);

  const plotList = plots as any[];
  const ids = plotList.map((p) => p.id);
  let points: any[] = [];
  let trees: any[] = [];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const [pp] = await pool.query(
      `SELECT id, plot_id, seq, latitude, longitude FROM plot_polygon_points WHERE plot_id IN (${placeholders}) ORDER BY plot_id, seq`, ids);
    points = pp as any[];
    const [tr] = await pool.query(
      `SELECT id, plot_id, tree_code, latitude, longitude, commodities_id FROM trees WHERE plot_id IN (${placeholders})`, ids);
    trees = tr as any[];
  }
  const byPlotPoints = new Map<number, any[]>();
  points.forEach((pt) => { (byPlotPoints.get(pt.plot_id) || byPlotPoints.set(pt.plot_id, []).get(pt.plot_id))!.push(pt); });
  const byPlotTrees = new Map<number, any[]>();
  trees.forEach((t) => { (byPlotTrees.get(t.plot_id) || byPlotTrees.set(t.plot_id, []).get(t.plot_id))!.push(t); });

  const data = plotList.map((p) => ({
    ...p,
    polygon: byPlotPoints.get(p.id) || [],
    trees: byPlotTrees.get(p.id) || [],
  }));
  return res.json({ data });
});
