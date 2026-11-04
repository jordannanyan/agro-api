// Plot boundary geometry, in a local metre grid — enough for plot-sized shapes.
//
// Used when the field app sends a boundary (PUT /plots/:id/polygon-points): the
// outline is built in walking order around its centre when the corners as sent
// cross each other, and the boundary is judged — a sliver of bunched points or a
// triangle is flagged "ukur ulang" instead of being shown as if it were a plot.
// scripts/fixAppPolygons2026-11.js uses the same rules on the boundaries recorded
// before these checks existed.

export interface LatLng { lat: number; lng: number }

export const POLY_MIN_CORNERS = 4;
export const POLY_MIN_AREA_M2 = 100;      // 0.01 ha
export const POLY_WARN_ACCURACY_M = 15;

function local(pts: LatLng[]) {
  const lat0 = pts[0]?.lat ?? 0; const lng0 = pts[0]?.lng ?? 0;
  const k = Math.cos((lat0 * Math.PI) / 180);
  return pts.map((p) => ({ x: (p.lng - lng0) * 111320 * k, y: (p.lat - lat0) * 110540 }));
}

export function areaM2(pts: LatLng[]): number {
  const xy = local(pts);
  if (xy.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < xy.length; i++) { const a = xy[i]; const b = xy[(i + 1) % xy.length]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}

export function selfIntersects(pts: LatLng[]): boolean {
  const xy = local(pts); const n = xy.length;
  if (n < 4) return false;
  const o = (a: any, b: any, c: any) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const cross = (p1: any, p2: any, p3: any, p4: any) => {
    const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((i + 1) % n === j || (j + 1) % n === i) continue;
      if (cross(xy[i], xy[(i + 1) % n], xy[j], xy[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** The corners in walking order around their centre. */
export function orderAroundCentre<T extends LatLng>(pts: T[]): T[] {
  const xy = local(pts);
  const cx = xy.reduce((s, p) => s + p.x, 0) / xy.length; const cy = xy.reduce((s, p) => s + p.y, 0) / xy.length;
  return pts.map((p, i) => ({ p, a: Math.atan2(xy[i].y - cy, xy[i].x - cx) })).sort((u, v) => u.a - v.a).map((u) => u.p);
}

export interface BoundaryVerdict { ring: LatLng[]; status: string | null; note: string | null }

/**
 * The outline to store for these corners, and whether it can stand as the plot's
 * boundary. A crossing outline is re-ordered; too few corners, a sliver, or a
 * weak fix is marked for re-measurement.
 */
export function judgeBoundary(pts: (LatLng & { accuracy?: number | null })[]): BoundaryVerdict {
  let ring = pts;
  const notes: string[] = [];
  if (ring.length >= POLY_MIN_CORNERS && selfIntersects(ring)) {
    ring = orderAroundCentre(ring);
    notes.push('urutan titik dirapikan (garis menyilang)');
  }
  const problems: string[] = [];
  if (pts.length < POLY_MIN_CORNERS) problems.push(`hanya ${pts.length} titik`);
  const area = areaM2(ring);
  if (area < POLY_MIN_AREA_M2) problems.push(`luas ${Math.round(area)} m² — titik berdekatan`);
  const worst = Math.max(0, ...pts.map((p) => Number(p.accuracy || 0)));
  if (worst > POLY_WARN_ACCURACY_M) problems.push(`akurasi GPS ±${Math.round(worst)} m`);
  if (problems.length) return { ring, status: 'ukur_ulang', note: `Perlu ukur ulang: ${[...problems, ...notes].join('; ')}` };
  return { ring, status: null, note: notes.length ? notes.join('; ') : null };
}

export function ringWkt(ring: LatLng[]): string {
  const c = ring.map((p) => `${p.lng} ${p.lat}`);
  c.push(`${ring[0].lng} ${ring[0].lat}`);
  return `POLYGON((${c.join(', ')}))`;
}

/** "POLYGON((lng lat, …))" → corners (closing duplicate dropped). */
export function wktCorners(wkt: string | null | undefined): LatLng[] {
  const m = String(wkt || '').match(/POLYGON\s*\(\s*\(([^)]+)\)/i);
  if (!m) return [];
  const pts = m[1].split(',').map((s) => s.trim().split(/\s+/)).map(([lng, lat]) => ({ lat: Number(lat), lng: Number(lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length > 1 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lng === pts[pts.length - 1].lng) pts.pop();
  return pts;
}
