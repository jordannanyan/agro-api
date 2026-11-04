// -----------------------------------------------------------------------------
// Fix: the plot boundaries recorded with the field app (2026-11)
//
// 42 plots carry a boundary walked with the phone (plot_polygon_points, source
// 'mobile'). None of them read as a plot's shape. Decided with the user
// 2026-11-04, plot by plot:
//
//   uji coba    recorded far from the plot — Palangka Raya, Adelaide, the
//               Android emulator's Mountain View — or a sample plot ('tes', '1').
//               The test vertices are deleted. Where the HKm Sumber Jaya survey
//               (--survey snbs_lampung.geojson, same shapes as the March 2026
//               shapefile) has the plot, its surveyed boundary goes back —
//               the test recording had overwritten it. Otherwise the plot has no
//               boundary again and is marked ukur_ulang.
//   dirapikan   ≥ 4 vertices and ≥ 0.01 ha: the boundary becomes a rectangle of
//               the same area, on the recording's own minimum rotated rectangle
//               (vertices walked out of order are put in order first).
//   perkiraan   unusable (3 vertices, bunched, ~0 ha) but the plot has a recorded
//               area: a square of that area at the vertices' centre, aligned with
//               them. Marked so — it is not a measurement.
//   ukur_ulang  unusable and no recorded area: left as it is, marked.
//
// The recorded vertices (and their photos) are kept, except the test ones. Every
// replaced shape and deleted vertex goes to plot_polygon_backups first.
// Schema (plot.polygon_status / polygon_note, plot_polygon_backups) as in
// db/schema.sql. Idempotent, dry-run by default.
//
// Usage:
//   node scripts/fixAppPolygons2026-11.js --survey "<snbs_lampung.geojson>" [--verbose]
//   … --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const SURVEY = arg('--survey');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
const MIN_CORNERS = 4;
const MIN_AREA_M2 = 100;
const SAMPLE_PLOTS = ['tes', '1'];
// Where each PT's plots are. A recording whose centre falls outside is a test.
const REGION = {
  1: { name: 'Lampung', lat: [-6.0, -4.5], lng: [105.0, 106.5] },
  3: { name: 'Tulungagung', lat: [-8.6, -7.8], lng: [111.4, 112.2] },
};
const PLACES = [
  { name: 'Palangka Raya', lat: [-2.6, -1.8], lng: [113.5, 114.3] },
  { name: 'Adelaide (Australia)', lat: [-35.2, -34.5], lng: [138.3, 139.0] },
  { name: 'Mountain View (lokasi bawaan emulator Android)', lat: [37.3, 37.5], lng: [-122.2, -122.0] },
];

// ---- geometry, in a local metre grid ------------------------------------------
function toLocal(pts, o) {
  const k = Math.cos((o.lat * Math.PI) / 180);
  return pts.map((p) => ({ x: (p.lng - o.lng) * 111320 * k, y: (p.lat - o.lat) * 110540 }));
}
function toLatLng(xy, o) {
  const k = Math.cos((o.lat * Math.PI) / 180);
  return xy.map((p) => ({ lat: o.lat + p.y / 110540, lng: o.lng + p.x / (111320 * k) }));
}
const area = (xy) => Math.abs(xy.reduce((s, a, i) => { const b = xy[(i + 1) % xy.length]; return s + a.x * b.y - b.x * a.y; }, 0)) / 2;
const centre = (xy) => ({ x: xy.reduce((s, p) => s + p.x, 0) / xy.length, y: xy.reduce((s, p) => s + p.y, 0) / xy.length });
function hull(xy) {
  const p = [...xy].sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = []; for (const q of [...p].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** Minimum-area rectangle around the points: { angle, cx, cy, w, h }. */
function minRect(xy) {
  const h = hull(xy);
  if (h.length < 2) return { angle: 0, cx: xy[0].x, cy: xy[0].y, w: 0, h: 0 };
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const t = Math.atan2(b.y - a.y, b.x - a.x); const c = Math.cos(t), s = Math.sin(t);
    const r = h.map((p) => ({ u: p.x * c + p.y * s, v: -p.x * s + p.y * c }));
    const u0 = Math.min(...r.map((q) => q.u)), u1 = Math.max(...r.map((q) => q.u));
    const v0 = Math.min(...r.map((q) => q.v)), v1 = Math.max(...r.map((q) => q.v));
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) {
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      best = { A, angle: t, cx: uc * c - vc * s, cy: uc * s + vc * c, w: u1 - u0, h: v1 - v0 };
    }
  }
  return best;
}
function rectCorners({ angle, cx, cy, w, h }) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
    .map(([u, v]) => ({ x: cx + u * c - v * s, y: cy + u * s + v * c }));
}
function selfIntersects(xy) {
  const n = xy.length; if (n < 4) return false;
  const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const X = (p1, p2, p3, p4) => { const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)); };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if ((i + 1) % n === j || (j + 1) % n === i) continue;
    if (X(xy[i], xy[(i + 1) % n], xy[j], xy[(j + 1) % n])) return true;
  }
  return false;
}
function aroundCentre(xy) { const c = centre(xy); return [...xy].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x)); }
const wkt = (ll) => `POLYGON((${[...ll, ll[0]].map((p) => `${p.lng.toFixed(7)} ${p.lat.toFixed(7)}`).join(', ')}))`;
const inBox = (c, b) => c.lat >= b.lat[0] && c.lat <= b.lat[1] && c.lng >= b.lng[0] && c.lng <= b.lng[1];
const maxShift = (a, b) => Math.max(...a.map((p) => Math.min(...b.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))));

function readSurvey(file) {
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = new Map();
  for (const f of g.features || []) {
    if (!f.geometry || f.geometry.type !== 'Polygon') continue;
    const ring = f.geometry.coordinates[0].map(([lng, lat]) => ({ lat, lng }));
    if (ring.length > 1 && ring[0].lat === ring[ring.length - 1].lat && ring[0].lng === ring[ring.length - 1].lng) ring.pop();
    out.set(String(f.properties.plot_name).trim(), ring);
  }
  return out;
}

(async () => {
  if (!SURVEY) { console.error('Usage: --survey <snbs_lampung.geojson> [--apply] [--verbose]'); process.exit(2); }
  const survey = readSurvey(SURVEY);
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: DB,
  });
  log(`${APPLY ? 'APPLY' : 'DRY-RUN'} on ${DB} — survei: ${survey.size} polygon`);
  try {
    // ---- schema ------------------------------------------------------------
    const has = async (t, col) => (await c.query(
      `SELECT 1 FROM information_schema.${col ? 'COLUMNS' : 'TABLES'} WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?${col ? ' AND COLUMN_NAME = ?' : ''}`,
      col ? [DB, t, col] : [DB, t]))[0].length > 0;
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    if (!(await has('plot', 'polygon_status'))) {
      log('+ plot.polygon_status, plot.polygon_note');
      if (APPLY) await c.query('ALTER TABLE plot ADD COLUMN polygon_status VARCHAR(20) NULL AFTER ledger_code, ADD COLUMN polygon_note VARCHAR(255) NULL AFTER polygon_status');
    }
    if (!(await has('plot_polygon_backups'))) {
      log('+ table plot_polygon_backups');
      const i = schema.indexOf('CREATE TABLE `plot_polygon_backups` ('); const j = schema.indexOf(') ENGINE=InnoDB;', i);
      if (APPLY) await c.query(schema.slice(i, j + ') ENGINE=InnoDB;'.length));
    }
    const statusCol = APPLY || (await has('plot', 'polygon_status'));

    // ---- the recordings ----------------------------------------------------
    const [plots] = await c.query(
      `SELECT pl.id, pl.plot_name, pl.land_area, f.farmer_name, k.entities_id, ST_AsText(pl.polygon) AS wkt
              ${statusCol ? ', pl.polygon_status' : ', NULL AS polygon_status'}
         FROM plot pl LEFT JOIN farmers f ON f.id = pl.farmer_id LEFT JOIN kth k ON k.id = f.kth_id
        WHERE EXISTS (SELECT 1 FROM plot_polygon_points pp WHERE pp.plot_id = pl.id AND pp.source = 'mobile')
        ORDER BY pl.plot_name`);
    const [pts] = await c.query(
      `SELECT * FROM plot_polygon_points WHERE plot_id IN (?) ORDER BY plot_id, seq`, [plots.length ? plots.map((p) => p.id) : [0]]);
    const byPlot = new Map();
    for (const p of pts) byPlot.set(p.plot_id, [...(byPlot.get(p.plot_id) || []), p]);

    const plan = [];
    for (const pl of plots) {
      if (pl.polygon_status) continue; // already handled by an earlier run
      const vs = byPlot.get(pl.id) || [];
      const ll = vs.map((v) => ({ lat: Number(v.latitude), lng: Number(v.longitude) }));
      const ctr = { lat: ll.reduce((s, p) => s + p.lat, 0) / ll.length, lng: ll.reduce((s, p) => s + p.lng, 0) / ll.length };
      const region = REGION[pl.entities_id];
      const place = PLACES.find((b) => inBox(ctr, b));
      const sample = SAMPLE_PLOTS.includes(String(pl.plot_name).trim());
      const testing = sample || (region && !inBox(ctr, region));
      const o = ll[0];
      let xy = toLocal(ll, o);
      const base = { pl, vs, where: place?.name || (testing && !sample ? 'di luar wilayah PT' : null) };
      if (testing) {
        const surveyed = survey.get(String(pl.plot_name).trim());
        const ok = surveyed && region && inBox({ lat: surveyed.reduce((s, p) => s + p.lat, 0) / surveyed.length,
          lng: surveyed.reduce((s, p) => s + p.lng, 0) / surveyed.length }, region);
        plan.push(ok
          ? { ...base, kind: 'uji coba → survei dikembalikan', polygon: wkt(surveyed), status: null, deletePoints: true,
              note: `Polygon survei HKm SJ dikembalikan; rekaman uji${place ? ` di ${place.name}` : ''} dihapus (2026-11-04)`,
              ha: area(toLocal(surveyed, surveyed[0])) / 1e4 }
          : { ...base, kind: sample ? 'data contoh → dihapus' : 'uji coba → dihapus', polygon: null, status: 'ukur_ulang', deletePoints: true,
              note: sample ? 'Polygon data contoh dihapus (2026-11-04)' : `Rekaman uji${place ? ` di ${place.name}` : ''} dihapus; belum ada polygon survei — perlu diukur (2026-11-04)` });
        continue;
      }
      const reordered = xy.length >= MIN_CORNERS && selfIntersects(xy);
      if (reordered) xy = aroundCentre(xy);
      const A = area(xy);
      if (xy.length >= MIN_CORNERS && A >= MIN_AREA_M2) {
        const r = minRect(xy); const k = Math.sqrt(A / (r.w * r.h));
        const sq = rectCorners({ ...r, w: r.w * k, h: r.h * k });
        plan.push({ ...base, kind: 'dirapikan', polygon: wkt(toLatLng(sq, o)), status: 'dirapikan', deletePoints: false,
          note: `Dirapikan jadi persegi panjang (luas sama) dari ${vs.length} titik GPS${reordered ? ', urutan titik diperbaiki' : ''}; sudut bergeser maks ${maxShift(sq, xy).toFixed(0)} m`,
          ha: A / 1e4 });
      } else if (Number(pl.land_area) > 0) {
        const side = Math.sqrt(Number(pl.land_area) * 1e4);
        const r = xy.length >= 2 ? minRect(xy) : { angle: 0 };
        const cc = centre(xy);
        const sq = rectCorners({ angle: r.angle || 0, cx: cc.x, cy: cc.y, w: side, h: side });
        plan.push({ ...base, kind: 'perkiraan', polygon: wkt(toLatLng(sq, o)), status: 'perkiraan', deletePoints: false,
          note: `Perkiraan: persegi ${Number(pl.land_area)} ha di tengah ${vs.length} titik GPS (rekaman tidak bisa dipakai: luas ${A.toFixed(0)} m²) — perlu ukur ulang`,
          ha: Number(pl.land_area) });
      } else {
        plan.push({ ...base, kind: 'ukur ulang (tanpa luas tercatat)', polygon: undefined, status: 'ukur_ulang', deletePoints: false,
          note: `Perlu ukur ulang: ${vs.length} titik GPS, luas ${A.toFixed(0)} m², luas lahan belum tercatat` });
      }
    }

    const count = {};
    plan.forEach((p) => { count[p.kind] = (count[p.kind] || 0) + 1; });
    log(`rekaman aplikasi: ${plots.length} lahan — ${Object.entries(count).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
    for (const p of plan) {
      if (VERBOSE || p.kind !== 'dirapikan') {
        log(`  ${String(p.pl.plot_name).padEnd(18)} ${String(p.pl.farmer_name || '').padEnd(16)} ${p.kind.padEnd(32)} ${p.ha != null ? `${p.ha.toFixed(3)} ha` : ''}${p.where ? `  [${p.where}]` : ''}`);
        if (VERBOSE) log(`      ${p.note}`);
      }
    }
    if (!APPLY) { log('dry-run only; re-run with --apply'); return; }

    await c.beginTransaction();
    for (const p of plan) {
      await c.query('INSERT INTO plot_polygon_backups (plot_id, polygon_wkt, points_json, reason, created_at) VALUES (?,?,?,?,NOW())',
        [p.pl.id, p.pl.wkt, JSON.stringify(p.vs), `fixAppPolygons2026-11: ${p.kind}`]);
      if (p.deletePoints) await c.query("DELETE FROM plot_polygon_points WHERE plot_id = ? AND source = 'mobile'", [p.pl.id]);
      if (p.polygon === undefined) {
        await c.query('UPDATE plot SET polygon_status = ?, polygon_note = ?, updated_at = NOW() WHERE id = ?', [p.status, p.note, p.pl.id]);
      } else if (p.polygon === null) {
        await c.query('UPDATE plot SET polygon = NULL, polygon_status = ?, polygon_note = ?, updated_at = NOW() WHERE id = ?', [p.status, p.note, p.pl.id]);
      } else {
        await c.query('UPDATE plot SET polygon = ST_GeomFromText(?), polygon_status = ?, polygon_note = ?, updated_at = NOW() WHERE id = ?',
          [p.polygon, p.status, p.note, p.pl.id]);
      }
    }
    await c.commit();
    log('done');
  } catch (e) {
    await c.rollback().catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
