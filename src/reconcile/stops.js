/**
 * Stops reconciliation.
 *
 * **Tranzy is the primary catalog** (same rationale as routes.js: CTP
 * city hall promotes Tranzy; Tranzy covers ~880 stops vs Transitous's
 * ~750 — the missing ~130 are mostly newer metropolitan stops).
 *
 * In practice, Tranzy and Transitous use **different `stop_id`
 * namespaces**, so matching by id doesn't find overlap. We could
 * heuristic-match by name + coords proximity, but it's brittle and the
 * payoff is small — the existing iteration gives us the union of both
 * catalogs (which is what downstream apps actually want). So we keep
 * the iteration order but flip the **narrative**: Tranzy is the base,
 * Transitous fills remaining rows, and the warning text no longer
 * frames Tranzy as the secondary source.
 *
 * Quirk: CTP's `stop_code` (signage code) may be a Roman numeral —
 * we never parse it as Number.
 */

export function reconcileStops({ seed, tranzy, warnings }) {
  /** @type {Map<string, any>} */
  const byStopId = new Map();
  const stops = [];

  // ── Step 1: Tranzy is the base catalog. Iterate first; every row
  // becomes a candidate stop. Invalid coords are still surfaced (they
  // indicate real data quality issues), but we don't emit a warning
  // per stop — single summary at the end.
  let tranzyAdded = 0;
  let tranzySkipped = 0;
  if (tranzy && Array.isArray(tranzy.stops)) {
    for (const s of tranzy.stops) {
      const id = s.stop_id ? String(s.stop_id) : null;
      if (!id) continue;
      if (byStopId.has(id)) continue;
      const lat = parseFloat(s.stop_lat);
      const lon = parseFloat(s.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        tranzySkipped++;
        continue;
      }
      const row = {
        stop_id: id,
        stop_code: (s.stop_code ?? '').toString(),
        stop_name: s.stop_name ?? '',
        stop_lat: formatCoord(lat),
        stop_lon: formatCoord(lon),
        location_type: s.location_type ? String(s.location_type) : '0',
        parent_station: '',
        wheelchair_boarding: '',
      };
      byStopId.set(id, row);
      stops.push(row);
      tranzyAdded++;
    }
  }

  // ── Step 2: Transitous fills gaps Tranzy doesn't cover. Different
  // id namespaces mean we always add (no merging). Surface only a
  // single summary, not one warning per stop.
  let transitousAdded = 0;
  for (const s of seed.stops) {
    if (!s.stopId) continue;
    if (byStopId.has(s.stopId)) continue;
    const row = {
      stop_id: s.stopId,
      stop_code: '',
      stop_name: s.name ?? '',
      stop_lat: formatCoord(s.lat),
      stop_lon: formatCoord(s.lon),
      location_type: '0',
      parent_station: '',
      wheelchair_boarding: '',
    };
    byStopId.set(row.stop_id, row);
    stops.push(row);
    transitousAdded++;
  }

  // Single-line summaries. The previous per-stop warnings were so
  // noisy (~820 lines for the full network) that they drowned the
  // build log. Detail lives in stops.txt — grep if you need to audit.
  if (tranzyAdded > 0) {
    warnings.push(`stops: Tranzy primary catalog — ${tranzyAdded} stops from Tranzy`);
  }
  if (transitousAdded > 0) {
    warnings.push(`stops: ${transitousAdded} Transitous-only stops (not in Tranzy — usually Transitous mirror covers a few legacy stops Tranzy omits)`);
  }
  if (tranzySkipped > 0) {
    warnings.push(`stops: ${tranzySkipped} Tranzy stops skipped (invalid lat/lon)`);
  }

  return { stops, byStopId };
}

function formatCoord(n) {
  if (!Number.isFinite(Number(n))) return '';
  return Number(n).toFixed(6);
}

export function stopsToTxt(stops) {
  const headers = [
    'stop_id', 'stop_code', 'stop_name', 'stop_desc',
    'stop_lat', 'stop_lon', 'zone_id', 'stop_url',
    'location_type', 'parent_station', 'stop_timezone', 'wheelchair_boarding',
  ];
  const lines = [headers.join(',')];
  for (const s of stops) {
    lines.push([
      csvField(s.stop_id),
      csvField(s.stop_code ?? ''),
      csvField(s.stop_name ?? ''),
      '',
      csvField(s.stop_lat),
      csvField(s.stop_lon),
      '', '', '',
      csvField(s.location_type ?? '0'),
      csvField(s.parent_station ?? ''),
      '',
      csvField(s.wheelchair_boarding ?? ''),
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