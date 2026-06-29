/**
 * Routes reconciliation.
 *
 * Seed (Transitous) is the source of truth. Tranzy fills gaps for any
 * route that's missing from the seed — typically newer routes CTP has
 * added since Transitous's last import.
 *
 * IDs are not remapped between sources. If a Tranzy route has a
 * different `route_id` than the seed's, it's emitted as a separate
 * row in `routes.txt` (the consumer app sees two rows and dedups at
 * query time, or we revisit later). This avoids the
 * mapping-table-trap called out in the project brief.
 */

import { parseCsv } from '../lib/csv.js';

/**
 * @param {{
 *   seed: { routes: Array<{routeId, shortName, longName, type, color}>, agencyTxt: string },
 *   tranzy: { routes: any[] } | null,
 *   warnings: string[],
 * }} input
 * @returns {{
 *   routes: Array<{route_id, agency_id, route_short_name, route_long_name, route_type, route_color, route_text_color, route_desc}>,
 *   byRouteId: Map<string, any>,
 * }}
 */
export function reconcileRoutes({ seed, tranzy, warnings }) {
  /** @type {Map<string, any>} */
  const byRouteId = new Map();
  const routes = [];

  // Seed wins — already curated by mdb-2121.
  for (const r of seed.routes) {
    if (!r.routeId) continue;
    const row = {
      route_id: r.routeId,
      agency_id: '2', // CTP Cluj-Napoca
      route_short_name: r.shortName ?? '',
      route_long_name: r.longName ?? '',
      route_type: r.type ? String(r.type) : '3',
      route_color: (r.color ?? '').replace(/^#?/, '').toUpperCase(),
      route_text_color: '',
      route_desc: '',
    };
    if (!byRouteId.has(row.route_id)) {
      byRouteId.set(row.route_id, row);
      routes.push(row);
    }
  }

  // Tranzy fills missing routes.
  if (tranzy && Array.isArray(tranzy.routes)) {
    for (const r of tranzy.routes) {
      const id = r.route_id ? String(r.route_id) : null;
      if (!id) continue;
      if (byRouteId.has(id)) continue; // seed wins
      // Tranzy returns route_color as "#RRGGBB" or null. Strip hash.
      const color = (r.route_color ?? '').toString().replace(/^#?/, '').toUpperCase();
      const row = {
        route_id: id,
        agency_id: '2',
        route_short_name: r.route_short_name ?? '',
        route_long_name: r.route_long_name ?? '',
        route_type: r.route_type ? String(r.route_type) : '3',
        route_color: color,
        route_text_color: (r.route_text_color ?? '').toString().replace(/^#?/, '').toUpperCase(),
        route_desc: r.route_desc ?? '',
      };
      warnings.push(`route ${id} (${row.route_short_name}) added from Tranzy (not in seed)`);
      byRouteId.set(id, row);
      routes.push(row);
    }
  }

  return { routes, byRouteId };
}

/**
 * Serialize routes rows to GTFS routes.txt body.
 *
 * @param {Array<object>} routes  output of `reconcileRoutes`
 * @returns {string}
 */
export function routesToTxt(routes) {
  const headers = [
    'route_id', 'agency_id', 'route_short_name', 'route_long_name',
    'route_desc', 'route_type', 'route_url', 'route_color', 'route_text_color',
  ];
  const lines = [headers.join(',')];
  for (const r of routes) {
    lines.push([
      csvField(r.route_id),
      csvField(r.agency_id ?? '2'),
      csvField(r.route_short_name),
      csvField(r.route_long_name),
      csvField(r.route_desc ?? ''),
      csvField(r.route_type),
      '', // route_url
      csvField(r.route_color),
      csvField(r.route_text_color ?? ''),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

/** Quote a field if it contains comma, quote, or newline. */
function csvField(v) {
  const s = (v ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export { parseCsv };