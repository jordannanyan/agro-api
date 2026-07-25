import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { compressImages } from '../services/imageProcessor';
import { entityScope } from '../utils/entityScope';

export const router = Router();

const SCHEMES = ['BeliPutus', 'PreFinance', 'ProfitSharing'] as const;

// Explicit columns (avoid selecting the raw geometry blob); expose polygon as WKT.
const SELECT = `
  SELECT p.id, p.plot_name, p.land_area, p.number_of_plants, p.exp_cin_plants,
         p.latitude, p.longitude, p.farmer_id, p.scheme, p.created_at, p.updated_at,
         ST_AsText(p.polygon) AS polygon_wkt,
         f.farmer_name AS farmer__farmer_name, f.kth_id AS farmer__kth_id
  FROM plot p
  LEFT JOIN farmers f ON f.id = p.farmer_id
  LEFT JOIN kth k     ON k.id = f.kth_id
`;

function shape(row: any) {
  const out: any = {};
  const farmer: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('farmer__')) farmer[k.slice(8)] = row[k];
    else out[k] = row[k];
  }
  out.farmer = row.farmer_id ? { id: row.farmer_id, ...farmer } : null;
  return out;
}

// GET /api/plots?farmer_id=&scheme=&kth_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.farmer_id) { where.push('p.farmer_id = ?'); args.push(req.query.farmer_id); }
  if (req.query.scheme)    { where.push('p.scheme = ?'); args.push(req.query.scheme); }
  if (req.query.kth_id)    { where.push('f.kth_id = ?'); args.push(req.query.kth_id); }
  if (req.query.search)    { where.push('p.plot_name LIKE ?'); args.push(`%${req.query.search}%`); }
  const scope = entityScope(req);
  if (scope != null) { where.push('k.entities_id = ?'); args.push(scope); }
  const sql = SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY p.plot_name ASC';
  const [rows] = await pool.query(sql, args);
  return res.json({ data: (rows as any[]).map(shape) });
});

// Compatibility (Flutter app path-style filters).
// GET /api/plots/farmer/:farmer_id
router.get('/farmer/:farmer_id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE p.farmer_id = ? ORDER BY p.plot_name', [req.params.farmer_id]);
  return res.json({ data: (rows as any[]).map(shape) });
});
// GET /api/plots/kth/:kth_id
router.get('/kth/:kth_id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE f.kth_id = ? ORDER BY p.plot_name', [req.params.kth_id]);
  return res.json({ data: (rows as any[]).map(shape) });
});
// GET /api/plots/:id/polygon-points
router.get('/:id/polygon-points', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM plot_polygon_points WHERE plot_id = ? ORDER BY seq', [req.params.id]);
  return res.json({ data: rows });
});

// PUT /api/plots/:id/polygon-points — replace all points for a plot (used by the
// Flutter offline outbox). Also keeps `plot.polygon` geometry in sync with the
// points so the map (which reads ST_AsText(p.polygon)) stays consistent.
router.put('/:id/polygon-points', authenticate, async (req: Request, res: Response) => {
  const plotId = Number(req.params.id);
  const points = Array.isArray(req.body?.points) ? req.body.points : [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM plot_polygon_points WHERE plot_id = ?', [plotId]);
    let auto = 0;
    for (const p of points) {
      await conn.query(
        `INSERT INTO plot_polygon_points
           (plot_id, seq, latitude, longitude, captured_at, accuracy_m, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
        [
          plotId,
          p.seq != null ? Number(p.seq) : ++auto,
          Number(p.latitude),
          Number(p.longitude),
          p.captured_at ? new Date(p.captured_at) : null,
          p.accuracy_m != null && p.accuracy_m !== '' ? Number(p.accuracy_m) : null,
          p.source || 'mobile',
        ]
      );
    }
    // Rebuild plot.polygon from the points (closed ring, x=lng y=lat) when there
    // are at least 3 vertices; otherwise clear it.
    if (points.length >= 3) {
      const ring = points.map((p: any) => `${Number(p.longitude)} ${Number(p.latitude)}`);
      ring.push(`${Number(points[0].longitude)} ${Number(points[0].latitude)}`);
      await conn.query('UPDATE plot SET polygon = ST_GeomFromText(?), updated_at = NOW() WHERE id = ?',
        [`POLYGON((${ring.join(', ')}))`, plotId]);
    } else {
      await conn.query('UPDATE plot SET polygon = NULL, updated_at = NOW() WHERE id = ?', [plotId]);
    }
    await conn.commit();
  } catch (e: any) {
    await conn.rollback();
    return res.status(500).json({ message: 'Server error', error: e.message });
  } finally {
    conn.release();
  }
  const [rows] = await pool.query('SELECT * FROM plot_polygon_points WHERE plot_id = ? ORDER BY seq', [plotId]);
  return res.json({ message: 'Polygon points replaced', data: rows });
});

// POST /api/plots/:id/polygon-points/:seq/photo — attach a photo to one vertex
// (multipart field `photo`), matching the Flutter per-point photo upload.
router.post('/:id/polygon-points/:seq/photo', authenticate, upload.single('photo'), async (req: Request, res: Response) => {
  try {
    const plotId = Number(req.params.id);
    const seq = Number(req.params.seq);
    const file = req.file as Express.Multer.File | undefined;
    if (!file) return res.status(422).json({ message: 'photo file is required' });
    await compressImages([file.path]);
    const photoPath = fileToPath(file);
    const [r] = await pool.query(
      'UPDATE plot_polygon_points SET photo_path = ?, updated_at = NOW() WHERE plot_id = ? AND seq = ?',
      [photoPath, plotId, seq]
    );
    if (!(r as any).affectedRows) {
      return res.status(404).json({ message: 'Polygon point not found for that plot/seq' });
    }
    return res.json({ message: 'Photo uploaded', data: { plot_id: plotId, seq, photo_path: photoPath } });
  } catch (e: any) {
    return res.status(500).json({ message: 'Server error', error: e.message });
  }
});

// GET /api/plots/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Plot not found' });
  const data = shape(list[0]);
  const [pts] = await pool.query('SELECT * FROM plot_polygon_points WHERE plot_id = ? ORDER BY seq', [req.params.id]);
  data.polygon_points = pts;
  return res.json({ data });
});

function validScheme(s: any) { return s === undefined || SCHEMES.includes(s); }

// POST /api/plots
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.plot_name || !b.farmer_id) return res.status(422).json({ message: 'plot_name and farmer_id are required' });
    if (!validScheme(b.scheme)) return res.status(422).json({ message: `Invalid scheme. Allowed: ${SCHEMES.join(', ')}` });
    const num = (v: any) => (v != null && v !== '' ? Number(v) : null);
    const cols: any = {
      plot_name: b.plot_name,
      farmer_id: Number(b.farmer_id),
      scheme: b.scheme || 'BeliPutus',
      land_area: num(b.land_area),
      number_of_plants: num(b.number_of_plants),
      exp_cin_plants: num(b.exp_cin_plants),
      latitude: num(b.latitude),
      longitude: num(b.longitude),
      created_at: new Date(),
      updated_at: new Date(),
    };
    // Polygon geometry arrives as a WKT string (e.g. POLYGON((lng lat, ...)))
    // from the mobile app. Store it via ST_GeomFromText so it reads back through
    // the SELECT's `ST_AsText(p.polygon) AS polygon_wkt`.
    const wkt = typeof b.polygon === 'string' && b.polygon.trim() ? b.polygon.trim() : null;
    const keys = Object.keys(cols);
    const colSql = keys.map((k) => `\`${k}\``).concat(wkt ? ['`polygon`'] : []).join(',');
    const valSql = keys.map(() => '?').concat(wkt ? ['ST_GeomFromText(?)'] : []).join(',');
    const vals = keys.map((k) => cols[k]).concat(wkt ? [wkt] : []);
    const [result] = await pool.query(
      `INSERT INTO plot (${colSql}) VALUES (${valSql})`,
      vals
    );
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [(result as any).insertId]);
    return res.status(201).json({ message: 'Plot created', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/plots/:id
const update = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    if (!validScheme(b.scheme)) return res.status(422).json({ message: `Invalid scheme. Allowed: ${SCHEMES.join(', ')}` });
    const [ex] = await pool.query('SELECT id FROM plot WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Plot not found' });
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('plot_name', b.plot_name);
    set('farmer_id', b.farmer_id != null ? Number(b.farmer_id) : undefined);
    set('scheme', b.scheme);
    set('land_area', b.land_area != null ? Number(b.land_area) : undefined);
    set('number_of_plants', b.number_of_plants != null ? Number(b.number_of_plants) : undefined);
    set('exp_cin_plants', b.exp_cin_plants != null ? Number(b.exp_cin_plants) : undefined);
    set('latitude', b.latitude != null ? Number(b.latitude) : undefined);
    set('longitude', b.longitude != null ? Number(b.longitude) : undefined);
    const keys = Object.keys(updates);
    const assignments = keys.map((k) => `\`${k}\` = ?`);
    const args: any[] = keys.map((k) => updates[k]);
    // Polygon WKT: absent → leave untouched; empty string → clear; else ST_GeomFromText.
    if (b.polygon !== undefined) {
      const wkt = typeof b.polygon === 'string' && b.polygon.trim() ? b.polygon.trim() : null;
      if (wkt === null) {
        assignments.push('`polygon` = NULL');
      } else {
        assignments.push('`polygon` = ST_GeomFromText(?)');
        args.push(wkt);
      }
    }
    if (assignments.length) {
      assignments.push('`updated_at` = ?'); args.push(new Date());
      await pool.query(`UPDATE plot SET ${assignments.join(', ')} WHERE id = ?`, [...args, id]);
    }
    const [rows] = await pool.query(SELECT + ' WHERE p.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Plot updated', data: shape((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};
router.put('/:id', authenticate, update);
router.post('/:id', authenticate, (req, res) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') return update(req, res);
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/plots/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM plot WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Plot not found' });
  return res.json({ message: 'Plot deleted' });
});

export default router;
