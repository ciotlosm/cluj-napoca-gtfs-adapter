/**
 * Shapes reconciliation.
 *
 * Seed shapes win. Tranzy fills missing shape_ids (typically the
 * shapes for routes the seed is missing entirely — see `neary-gtfs#13`,
 * `#15`). When neither has a shape for a pattern, the build proceeds
 * without `shape_dist_traveled` values being meaningful (haversine
 * fallback in `lib/timing.js`).
 *
 * Tranzy returns shape points as `{ shape_id, shape_pt_lat, shape_pt_lon,
 * shape_pt_sequence, shape_dist_traveled }`. We group by shape_id and
 * emit rows ordered by sequence.
 */

export function reconcileShapes({ seed, tranzy, warnings }) {
  /** @type {Map<string, Array<{lat:number, lon:number, dist?:number}>>} */
  const byShapeId = new Map();

  // Seed (already grouped and sorted by lib/seed.js).
  for (const [shapeId, pts] of seed.shapesById.entries()) {
    if (!shapeId) continue;
    if (!byShapeId.has(shapeId)) byShapeId.set(shapeId, []);
    for (const p of pts) byShapeId.get(shapeId).push({ lat: p.lat, lon: p.lon });
  }

  // Tranzy fills.
  if (tranzy && Array.isArray(tranzy.shapes)) {
    /** @type {Map<string, Array<{lat, lon, seq, dist?}>>} */
    const grouped = new Map();
    for (const p of tranzy.shapes) {
      const id = p.shape_id;
      if (!id) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push({
        lat: parseFloat(p.shape_pt_lat),
        lon: parseFloat(p.shape_pt_lon),
        seq: parseInt(p.shape_pt_sequence, 10),
        dist: parseFloat(p.shape_dist_traveled),
      });
    }
    for (const [id, pts] of grouped.entries()) {
      pts.sort((a, b) => a.seq - b.seq);
      if (byShapeId.has(id)) continue; // seed wins
      const cleaned = pts
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map((p) => ({ lat: p.lat, lon: p.lon }));
      if (cleaned.length === 0) continue;
      byShapeId.set(id, cleaned);
      warnings.push(`shape ${id} added from Tranzy (not in seed)`);
    }
  }

  // Flatten to GTFS rows with fresh sequence numbers.
  /** @type {Array<{shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled}>} */
  const rows = [];
  for (const [shapeId, pts] of byShapeId.entries()) {
    let cum = 0;
    let prev = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (prev) {
        cum += haversineMeters(prev.lat, prev.lon, p.lat, p.lon);
      }
      rows.push({
        shape_id: shapeId,
        shape_pt_lat: p.lat.toFixed(6),
        shape_pt_lon: p.lon.toFixed(6),
        shape_pt_sequence: String(i + 1),
        shape_dist_traveled: i === 0 ? '' : Math.round(cum).toString(),
      });
      prev = p;
    }
  }

  return { shapesById: byShapeId, rows };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function shapesToTxt(rows) {
  const headers = ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      csvField(r.shape_id),
      csvField(r.shape_pt_lat),
      csvField(r.shape_pt_lon),
      csvField(r.shape_pt_sequence),
      csvField(r.shape_dist_traveled),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function csvField(v) {
  const s = (v ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}