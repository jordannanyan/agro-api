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
         p.parent_plot_id, pp.plot_name AS parent_plot_name,
         p.commodities_id, c.commodities_name AS commodity_name, p.ledger_code,
         -- What grows on the plot (plot_commodities), most plants first.
         (SELECT GROUP_CONCAT(pcc.commodities_name ORDER BY pc.plants IS NULL, pc.plants DESC SEPARATOR '|')
            FROM plot_commodities pc JOIN commodities pcc ON pcc.id = pc.commodities_id
           WHERE pc.plot_id = p.id) AS planted,
         ST_AsText(p.polygon) AS polygon_wkt,
         f.farmer_name AS farmer__farmer_name, f.kth_id AS farmer__kth_id
  FROM plot p
  LEFT JOIN farmers f     ON f.id = p.farmer_id
  LEFT JOIN kth k         ON k.id = f.kth_id
  LEFT JOIN plot pp       ON pp.id = p.parent_plot_id
  LEFT JOIN commodities c ON c.id = p.commodities_id
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
    // Replacing the points must not wipe the photos already uploaded for them.
    // Newer apps echo each point's `photo_path`; for older apps that don't,
    // carry the photo over from the old row at the same coordinate.
    const [oldRows] = await conn.query(
      'SELECT latitude, longitude, photo_path FROM plot_polygon_points WHERE plot_id = ? AND photo_path IS NOT NULL',
      [plotId]
    );
    const coordKey = (lat: any, lng: any) => `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
    const oldPhotos = new Map<string, string>();
    for (const r of oldRows as any[]) oldPhotos.set(coordKey(r.latitude, r.longitude), r.photo_path);
    const echoedPhoto = (v: any): string | null =>
      typeof v === 'string' && /^(\/storage\/|plot_polygon_points\/)[\w./-]+$/.test(v) && !v.includes('..') ? v : null;

    await conn.query('DELETE FROM plot_polygon_points WHERE plot_id = ?', [plotId]);
    let auto = 0;
    for (const p of points) {
      await conn.query(
        `INSERT INTO plot_polygon_points
           (plot_id, seq, latitude, longitude, photo_path, captured_at, accuracy_m, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [
          plotId,
          p.seq != null ? Number(p.seq) : ++auto,
          Number(p.latitude),
          Number(p.longitude),
          echoedPhoto(p.photo_path) ?? oldPhotos.get(coordKey(p.latitude, p.longitude)) ?? null,
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

/**
 * A land has one plot ID: a subplot is named "<land> · <commodity>" ("SJ0015 ·
 * Pisang"), never by a code of its own. Null when the plot is not a subplot.
 * Same rule as scripts/migrateSubplotNames2026-11.js.
 */
async function subplotName(parentId: number | null | undefined, commodityId: number | null | undefined) {
  if (!parentId || !commodityId) return null;
  const [[p]] = await pool.query('SELECT plot_name FROM plot WHERE id = ?', [parentId]) as any;
  const [[c]] = await pool.query('SELECT commodities_name FROM commodities WHERE id = ?', [commodityId]) as any;
  if (!p || !c) return null;
  const short = String(c.commodities_name).match(/\(([^)]+)\)/)?.[1] ?? c.commodities_name;
  return `${p.plot_name} · ${short}`;
}

/** After a land is renamed, its subplots follow. */
async function renameSubplots(landId: number) {
  const [kids] = await pool.query('SELECT id, commodities_id FROM plot WHERE parent_plot_id = ?', [landId]);
  for (const k of kids as any[]) {
    const name = await subplotName(landId, k.commodities_id);
    if (name) await pool.query('UPDATE plot SET plot_name = ?, updated_at = NOW() WHERE id = ?', [name, k.id]);
  }
}

const optNum = (v: any) => (v === undefined ? undefined : v === null || v === '' ? null : Number(v));

/**
 * A subplot lies on another plot of the SAME farmer, one level deep: the parent
 * is a land, not itself a subplot, and a plot that already has subplots cannot
 * become one. Returns an error message, or null.
 */
async function subplotError(selfId: number | null, farmerId: number, parentId: number | null) {
  if (parentId == null) return null;
  if (selfId != null && parentId === selfId) return 'Plot tidak bisa menjadi subplot dirinya sendiri.';
  const [rows] = await pool.query('SELECT id, farmer_id, parent_plot_id FROM plot WHERE id = ? LIMIT 1', [parentId]);
  const parent = (rows as any[])[0];
  if (!parent) return 'Lahan induk tidak ditemukan.';
  if (Number(parent.farmer_id) !== Number(farmerId)) return 'Lahan induk harus milik petani yang sama.';
  if (parent.parent_plot_id) return 'Lahan induk itu sendiri subplot — subplot hanya satu tingkat.';
  if (selfId != null) {
    const [kids] = await pool.query('SELECT 1 FROM plot WHERE parent_plot_id = ? LIMIT 1', [selfId]);
    if ((kids as any[]).length) return 'Plot ini sudah punya subplot, jadi tidak bisa menjadi subplot.';
  }
  return null;
}

// POST /api/plots
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const autoName = await subplotName(b.parent_plot_id != null && b.parent_plot_id !== '' ? Number(b.parent_plot_id) : null,
      b.commodities_id != null && b.commodities_id !== '' ? Number(b.commodities_id) : null);
    if (autoName) { if (b.plot_name && b.plot_name !== autoName) b.ledger_code = b.ledger_code ?? b.plot_name; b.plot_name = autoName; }
    if (!b.plot_name || !b.farmer_id) return res.status(422).json({ message: 'plot_name and farmer_id are required' });
    if (!validScheme(b.scheme)) return res.status(422).json({ message: `Invalid scheme. Allowed: ${SCHEMES.join(', ')}` });
    const num = (v: any) => (v != null && v !== '' ? Number(v) : null);
    const subErr = await subplotError(null, Number(b.farmer_id), num(b.parent_plot_id));
    if (subErr) return res.status(422).json({ message: subErr });
    const cols: any = {
      plot_name: b.plot_name,
      farmer_id: Number(b.farmer_id),
      scheme: b.scheme || 'BeliPutus',
      land_area: num(b.land_area),
      number_of_plants: num(b.number_of_plants),
      exp_cin_plants: num(b.exp_cin_plants),
      latitude: num(b.latitude),
      longitude: num(b.longitude),
      parent_plot_id: num(b.parent_plot_id),
      commodities_id: num(b.commodities_id),
      ledger_code: b.ledger_code || null,
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
    const [ex] = await pool.query('SELECT id, farmer_id, parent_plot_id, commodities_id, plot_name FROM plot WHERE id = ? LIMIT 1', [id]);
    if (!(ex as any[]).length) return res.status(404).json({ message: 'Plot not found' });
    const cur = (ex as any[])[0];
    const parentId = optNum(b.parent_plot_id);
    const farmerId = b.farmer_id != null ? Number(b.farmer_id) : Number(cur.farmer_id);
    // Checked whenever either side of the link could move: a new parent, or the
    // plot moving to another farmer while it is (or has) a subplot.
    if (parentId !== undefined || b.farmer_id != null) {
      const subErr = await subplotError(Number(id), farmerId, parentId === undefined ? cur.parent_plot_id : parentId);
      if (subErr) return res.status(422).json({ message: subErr });
    }
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
    set('parent_plot_id', parentId);
    set('commodities_id', optNum(b.commodities_id));
    set('ledger_code', b.ledger_code === undefined ? undefined : (b.ledger_code || null));
    // A subplot's name is its land's plus its commodity, whatever was sent.
    const finalParent = parentId === undefined ? cur.parent_plot_id : parentId;
    const finalCommodity = optNum(b.commodities_id) === undefined ? cur.commodities_id : optNum(b.commodities_id);
    const autoName = await subplotName(finalParent, finalCommodity);
    if (autoName) {
      if (!cur.parent_plot_id && autoName !== cur.plot_name && updates.ledger_code === undefined) {
        updates.ledger_code = cur.plot_name;
      }
      updates.plot_name = autoName;
    }
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
    if ('plot_name' in updates && !finalParent) await renameSubplots(Number(id));
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
