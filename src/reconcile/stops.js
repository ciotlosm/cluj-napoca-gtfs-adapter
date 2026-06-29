/**
 * Stops reconciliation.
 *
 * Seed (Transitous) is primary. Tranzy fills missing stops. Stops are
 * keyed on `stop_id`; coordinate resolution prefers seed > Tranzy.
 *
 * Quirk: CTP's `stop_code` (signage code) may be a Roman numeral —
 * we never parse it as Number.
 */

export function reconcileStops({ seed, tranzy, warnings }) {
  /** @type {Map<string, any>} */
  const byStopId = new Map();
  const stops = [];

  for (const s of seed.stops) {
    if (!s.stopId) continue;
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
    if (!byStopId.has(row.stop_id)) {
      byStopId.set(row.stop_id, row);
      stops.push(row);
    }
  }

  if (tranzy && Array.isArray(tranzy.stops)) {
    for (const s of tranzy.stops) {
      const id = s.stop_id ? String(s.stop_id) : null;
      if (!id) continue;
      if (byStopId.has(id)) continue;
      const lat = parseFloat(s.stop_lat);
      const lon = parseFloat(s.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        warnings.push(`Tranzy stop ${id} has invalid coords; skipping`);
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
      warnings.push(`stop ${id} (${row.stop_name}) added from Tranzy (not in seed)`);
      byStopId.set(id, row);
      stops.push(row);
    }
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