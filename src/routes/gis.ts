import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { compressImages } from '../services/imageProcessor';
import { entityScope } from '../utils/entityScope';

// =============================================================================
// Land & Tree management (used by app-traceability-fairventures).
//   /api/trees                         CRUD (multipart foto → photo_path)
//   /api/trees/:treeId/monitorings     list/create monitoring
//   /api/tree-monitorings              CRUD monitoring
//   /api/polygon-points                CRUD titik polygon lahan
//   /api/map                           gabungan plot + polygon + tree
// =============================================================================

// ── Trees ─────────────────────────────────────────────────────────────────────
export const treesRouter = Router();

const TREE_SELECT = `
  SELECT t.*, p.plot_name AS plot__plot_name, f.farmer_name AS farmer__farmer_name
  FROM trees t
  LEFT JOIN plot p     ON p.id = t.plot_id
  LEFT JOIN farmers f  ON f.id = t.farmer_id
  LEFT JOIN farmers pf ON pf.id = p.farmer_id
  LEFT JOIN kth pk     ON pk.id = pf.kth_id
`;
function shapeTree(row: any) {
  const out: any = {}; const plot: any = {}; const farmer: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('plot__')) plot[k.slice(6)] = row[k];
    else if (k.startsWith('farmer__')) farmer[k.slice(8)] = row[k];
    else out[k] = row[k];
  }
  out.plot = row.plot_id ? { id: row.plot_id, ...plot } : null;
  out.farmer = row.farmer_id ? { id: row.farmer_id, ...farmer } : null;
  return out;
}

treesRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = []; const args: any[] = [];
  if (req.query.plot_id)   { where.push('t.plot_id = ?'); args.push(req.query.plot_id); }
  if (req.query.farmer_id) { where.push('t.farmer_id = ?'); args.push(req.query.farmer_id); }
  if (req.query.search)    { where.push('(t.tree_name LIKE ? OR t.species LIKE ? OR t.qr_code LIKE ?)');
    args.push(`%${req.query.search}%`, `%${req.query.search}%`, `%${req.query.search}%`); }
  const scope = entityScope(req);
  if (scope != null) { where.push('pk.entities_id = ?'); args.push(scope); }
  const sql = TREE_SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY t.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: (rows as any[]).map(shapeTree) });
});

treesRouter.get('/:id', authenticate, async (req, res) => {
  const [rows] = await pool.query(TREE_SELECT + ' WHERE t.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Tree not found' });
  return res.json({ data: shapeTree(list[0]) });
});

const treeUpload = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'photo_path', maxCount: 1 }]);
function treeCols(b: any, f: any) {
  const photo = f?.photo?.[0] || f?.photo_path?.[0];
  const cols: any = {
    plot_id: b.plot_id != null && b.plot_id !== '' ? Number(b.plot_id) : null,
    farmer_id: b.farmer_id != null && b.farmer_id !== '' ? Number(b.farmer_id) : null,
    tree_name: b.tree_name ?? null,
    species: b.species ?? null,
    planting_date: b.planting_date || null,
    qr_code: b.qr_code ?? null,
    latitude: b.latitude != null && b.latitude !== '' ? Number(b.latitude) : null,
    longitude: b.longitude != null && b.longitude !== '' ? Number(b.longitude) : null,
    accuracy_m: b.accuracy_m != null && b.accuracy_m !== '' ? Number(b.accuracy_m) : null,
  };
  if (photo) cols.photo_path = fileToPath(photo);
  else if (typeof b.photo_path === 'string' && b.photo_path) cols.photo_path = b.photo_path;
  return cols;
}

treesRouter.post('/', authenticate, treeUpload, async (req: Request, res: Response) => {
  try {
    const f = req.files as any;
    await compressImages([f?.photo?.[0]?.path, f?.photo_path?.[0]?.path]);
    const cols = { ...treeCols(req.body || {}, f), created_at: new Date(), updated_at: new Date() };
    if (!cols.plot_id) return res.status(422).json({ message: 'plot_id is required' });
    const keys = Object.keys(cols);
    const [r] = await pool.query(`INSERT INTO trees (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => (cols as any)[k]));
    const [rows] = await pool.query(TREE_SELECT + ' WHERE t.id = ? LIMIT 1', [(r as any).insertId]);
    return res.status(201).json({ message: 'Tree created', data: shapeTree((rows as any[])[0]) });
  } catch (e: any) { return res.status(500).json({ message: 'Server error', error: e.message }); }
});

const updateTree = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id FROM trees WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Tree not found' });
    const f = req.files as any;
    await compressImages([f?.photo?.[0]?.path, f?.photo_path?.[0]?.path]);
    const cols = treeCols(req.body || {}, f);
    // Drop nulls that weren't provided (keep it a partial update).
    const b = req.body || {};
    const updates: any = {};
    for (const k of Object.keys(cols)) {
      if (k === 'photo_path') { if (cols.photo_path) updates.photo_path = cols.photo_path; continue; }
      if (b[k] !== undefined) updates[k] = (cols as any)[k];
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE trees SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query(TREE_SELECT + ' WHERE t.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Tree updated', data: shapeTree((rows as any[])[0]) });
  } catch (e: any) { return res.status(500).json({ message: 'Server error', error: e.message }); }
};
treesRouter.put('/:id', authenticate, treeUpload, updateTree);
treesRouter.post('/:id', authenticate, treeUpload, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return updateTree(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});
treesRouter.delete('/:id', authenticate, async (req, res) => {
  const [r] = await pool.query('DELETE FROM trees WHERE id = ?', [req.params.id]);
  if (!(r as any).affectedRows) return res.status(404).json({ message: 'Tree not found' });
  return res.json({ message: 'Tree deleted' });
});

// ── Tree monitoring ───────────────────────────────────────────────────────────
const monUpload = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'photo_path', maxCount: 1 }]);
function monCols(b: any, f: any) {
  const photo = f?.photo?.[0] || f?.photo_path?.[0];
  const cols: any = {
    tree_id: b.tree_id != null && b.tree_id !== '' ? Number(b.tree_id) : null,
    measured_at: b.measured_at || null,
    circumference_cm: b.circumference_cm != null && b.circumference_cm !== '' ? Number(b.circumference_cm) : null,
    health_status: ['Sehat', 'Tidak Sehat', 'Mati'].includes(b.health_status) ? b.health_status : 'Sehat',
    health_desc: b.health_desc ?? null,
    latitude: b.latitude != null && b.latitude !== '' ? Number(b.latitude) : null,
    longitude: b.longitude != null && b.longitude !== '' ? Number(b.longitude) : null,
    accuracy_m: b.accuracy_m != null && b.accuracy_m !== '' ? Number(b.accuracy_m) : null,
    recorded_by_kth_id: b.recorded_by_kth_id != null && b.recorded_by_kth_id !== '' ? Number(b.recorded_by_kth_id) : null,
  };
  if (photo) cols.photo_path = fileToPath(photo);
  else if (typeof b.photo_path === 'string' && b.photo_path) cols.photo_path = b.photo_path;
  return cols;
}
async function insertMonitoring(treeId: number, b: any, f: any) {
  const cols = { ...monCols({ ...b, tree_id: treeId }, f), created_at: new Date(), updated_at: new Date() };
  const keys = Object.keys(cols);
  const [r] = await pool.query(`INSERT INTO tree_monitoring (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => (cols as any)[k]));
  const [rows] = await pool.query('SELECT * FROM tree_monitoring WHERE id = ? LIMIT 1', [(r as any).insertId]);
  return (rows as any[])[0];
}

// Sub-router: /api/trees/:treeId/monitorings
export const treeMonSubRouter = Router({ mergeParams: true });
treeMonSubRouter.get('/latest', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM tree_monitoring WHERE tree_id = ? ORDER BY measured_at DESC, id DESC LIMIT 1', [req.params.treeId]);
  return res.json({ data: (rows as any[])[0] ?? null });
});
treeMonSubRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM tree_monitoring WHERE tree_id = ? ORDER BY measured_at DESC, id DESC', [req.params.treeId]);
  return res.json({ data: rows });
});
treeMonSubRouter.post('/', authenticate, monUpload, async (req: Request, res: Response) => {
  try {
    const f = req.files as any;
    await compressImages([f?.photo?.[0]?.path, f?.photo_path?.[0]?.path]);
    const row = await insertMonitoring(Number(req.params.treeId), req.body || {}, f);
    return res.status(201).json({ message: 'Monitoring recorded', data: row });
  } catch (e: any) { return res.status(500).json({ message: 'Server error', error: e.message }); }
});

// Flat: /api/tree-monitorings
export const treeMonitoringRouter = Router();
treeMonitoringRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = []; const args: any[] = [];
  if (req.query.tree_id) { where.push('tree_id = ?'); args.push(req.query.tree_id); }
  const [rows] = await pool.query(`SELECT * FROM tree_monitoring ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY measured_at DESC, id DESC`, args);
  return res.json({ data: rows });
});
treeMonitoringRouter.get('/:id', authenticate, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM tree_monitoring WHERE id = ? LIMIT 1', [req.params.id]);
  if (!(rows as any[]).length) return res.status(404).json({ message: 'Monitoring not found' });
  return res.json({ data: (rows as any[])[0] });
});
treeMonitoringRouter.post('/', authenticate, monUpload, async (req: Request, res: Response) => {
  try {
    const f = req.files as any;
    if (!req.body?.tree_id) return res.status(422).json({ message: 'tree_id is required' });
    await compressImages([f?.photo?.[0]?.path, f?.photo_path?.[0]?.path]);
    const row = await insertMonitoring(Number(req.body.tree_id), req.body, f);
    return res.status(201).json({ message: 'Monitoring recorded', data: row });
  } catch (e: any) { return res.status(500).json({ message: 'Server error', error: e.message }); }
});
const updateMonitoring = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [ex] = await pool.query('SELECT id FROM tree_monitoring WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Monitoring not found' });
    const f = req.files as any;
    await compressImages([f?.photo?.[0]?.path, f?.photo_path?.[0]?.path]);
    const cols = monCols(req.body || {}, f);
    const b = req.body || {};
    const updates: any = {};
    for (const k of Object.keys(cols)) {
      if (k === 'tree_id') continue;
      if (k === 'photo_path') { if (cols.photo_path) updates.photo_path = cols.photo_path; continue; }
      if (b[k] !== undefined) updates[k] = (cols as any)[k];
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      updates.updated_at = new Date(); keys.push('updated_at');
      await pool.query(`UPDATE tree_monitoring SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => updates[k]), id]);
    }
    const [rows] = await pool.query('SELECT * FROM tree_monitoring WHERE id = ? LIMIT 1', [id]);
    return res.json({ message: 'Monitoring updated', data: (rows as any[])[0] });
  } catch (e: any) { return res.status(500).json({ message: 'Server error', error: e.message }); }
};
treeMonitoringRouter.put('/:id', authenticate, monUpload, updateMonitoring);
treeMonitoringRouter.post('/:id', authenticate, monUpload, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return updateMonitoring(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});
treeMonitoringRouter.delete('/:id', authenticate, async (req, res) => {
  const [r] = await pool.query('DELETE FROM tree_monitoring WHERE id = ?', [req.params.id]);
  if (!(r as any).affectedRows) return res.status(404).json({ message: 'Monitoring not found' });
  return res.json({ message: 'Monitoring deleted' });
});

// ── Polygon points ────────────────────────────────────────────────────────────
export const polygonPointsRouter = Router();
polygonPointsRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = []; const args: any[] = [];
  if (req.query.plot_id) { where.push('plot_id = ?'); args.push(req.query.plot_id); }
  const [rows] = await pool.query(`SELECT * FROM plot_polygon_points ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY plot_id, seq`, args);
  return res.json({ data: rows });
});
polygonPointsRouter.post('/', authenticate, upload.single('photo_path'), async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.plot_id || b.latitude == null || b.longitude == null) return res.status(422).json({ message: 'plot_id, latitude, longitude required' });
    const cols: any = {
      plot_id: Number(b.plot_id), seq: b.seq != null ? Number(b.seq) : 0,
      latitude: Number(b.latitude), longitude: Number(b.longitude),
      photo_path: fileToPath(req.file) ?? (b.photo_path || null),
      captured_at: b.captured_at || null,
      accuracy_m: b.accuracy_m != null && b.accuracy_m !== '' ? Number(b.accuracy_m) : null,
      source: ['mobile', 'web', 'import'].includes(b.source) ? b.source : 'web',
      created_at: new Date(), updated_at: new Date(),
    };
    const keys = Object.keys(cols);
    const [r] = await pool.query(`INSERT INTO plot_polygon_points (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => cols[k]));
    const [rows] = await pool.query('SELECT * FROM plot_polygon_points WHERE id = ? LIMIT 1', [(r as any).insertId]);
    return res.status(201).json({ message: 'Point added', data: (rows as any[])[0] });
  } catch (e: any) { return res.status(500).json({ message: 'Server error', error: e.message }); }
});
polygonPointsRouter.delete('/:id', authenticate, async (req, res) => {
  const [r] = await pool.query('DELETE FROM plot_polygon_points WHERE id = ?', [req.params.id]);
  if (!(r as any).affectedRows) return res.status(404).json({ message: 'Point not found' });
  return res.json({ message: 'Point deleted' });
});
// Replace all points of a plot in one call: { plot_id, points:[{seq,latitude,longitude}] }
polygonPointsRouter.post('/bulk', authenticate, async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const b = req.body || {};
    if (!b.plot_id || !Array.isArray(b.points)) return res.status(422).json({ message: 'plot_id and points[] required' });
    await conn.beginTransaction();
    await conn.query('DELETE FROM plot_polygon_points WHERE plot_id = ?', [b.plot_id]);
    let seq = 0;
    for (const p of b.points) {
      await conn.query('INSERT INTO plot_polygon_points (plot_id, seq, latitude, longitude, source, created_at, updated_at) VALUES (?,?,?,?,?,NOW(),NOW())',
        [b.plot_id, p.seq ?? seq++, Number(p.latitude), Number(p.longitude), 'web']);
    }
    await conn.commit();
    const [rows] = await pool.query('SELECT * FROM plot_polygon_points WHERE plot_id = ? ORDER BY seq', [b.plot_id]);
    return res.json({ message: 'Polygon saved', data: rows });
  } catch (e: any) { await conn.rollback(); return res.status(500).json({ message: 'Server error', error: e.message }); }
  finally { conn.release(); }
});

// ── Combined map payload ──────────────────────────────────────────────────────
export const mapRouter = Router();
mapRouter.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const where: string[] = []; const args: any[] = [];
    if (req.query.kth_id)    { where.push('f.kth_id = ?'); args.push(req.query.kth_id); }
    if (req.query.scheme)    { where.push('p.scheme = ?'); args.push(req.query.scheme); }
    const scope = entityScope(req);
    if (scope != null) { where.push('k.entities_id = ?'); args.push(scope); }
    const [plots] = await pool.query(
      `SELECT p.id, p.plot_name, p.scheme, p.latitude, p.longitude, p.land_area, p.farmer_id,
              f.farmer_name, f.kth_id, k.entities_id
       FROM plot p LEFT JOIN farmers f ON f.id = p.farmer_id LEFT JOIN kth k ON k.id = f.kth_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.plot_name`, args);
    const list = plots as any[];
    const ids = list.map((p) => p.id);
    let points: any[] = [], trees: any[] = [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      points = (await pool.query(`SELECT id, plot_id, seq, latitude, longitude FROM plot_polygon_points WHERE plot_id IN (${ph}) ORDER BY plot_id, seq`, ids))[0] as any[];
      trees = (await pool.query(`SELECT id, plot_id, tree_name, species, qr_code, latitude, longitude FROM trees WHERE plot_id IN (${ph})`, ids))[0] as any[];
    }
    const byPoints = new Map<number, any[]>(); points.forEach((pt) => { if (!byPoints.has(pt.plot_id)) byPoints.set(pt.plot_id, []); byPoints.get(pt.plot_id)!.push(pt); });
    const byTrees = new Map<number, any[]>(); trees.forEach((t) => { if (!byTrees.has(t.plot_id)) byTrees.set(t.plot_id, []); byTrees.get(t.plot_id)!.push(t); });
    return res.json({ data: list.map((p) => ({ ...p, polygon: byPoints.get(p.id) || [], trees: byTrees.get(p.id) || [] })) });
  } catch (e: any) { return res.status(500).json({ message: 'Server error', error: e.message }); }
});
