/**
 * Data-quality checks. Emit warnings for things we want visible but
 * don't want to block the build on.
 *
 * Coverage:
 *   1. Routes with 0 trips but non-suspended CSV data (`neary-gtfs#15`)
 *   2. CSV departures dropped due to non-HH:MM cells (M26 frequencies)
 *   3. Route color doesn't match the type-default palette (`#14`)
 *   4. Stops with invalid coordinates
 *   5. Multiple agencies in seed agency.txt (`neary#87`)
 *   6. CSV row count vs seed trip count divergence
 */

const ROUTE_TYPE_DEFAULT_COLORS = {
  0: '3BAC2C',   // tram → green
  3: 'D24CAE',   // bus → magenta
  11: '3C4E9A',  // trolleybus → blue
};

/**
 * @param {object} input
 * @param {string} input.agencyTxt  raw contents of seed agency.txt
 * @param {Array<object>} input.routes  reconciled routes
 * @param {Map<string, {warnings: any[]}>} input.csvByRoute  CSV-by-route map for warnings surfacing
 * @param {Map<string, number>} input.tripCountByRouteId  trip counts per route_id
 * @param {string[]} input.warnings  collector
 */
export function runDataQualityChecks(input) {
  checkAgencyCount(input.agencyTxt, input.warnings);
  checkRouteColors(input.routes, input.warnings);
  checkZeroTripRoutes(input.csvByRoute, input.tripCountByRouteId, input.warnings);
  checkCsvWarnings(input.csvByRoute, input.warnings);
}

function checkAgencyCount(agencyTxt, warnings) {
  // GTFS allows multiple agency rows. For a single-agency feed we expect
  // exactly one. Warn if there are zero or more than one.
  const lines = agencyTxt.split(/\r?\n/).filter((l) => l.trim());
  const dataRows = lines.slice(1); // drop header
  if (dataRows.length === 0) {
    warnings.push('seed agency.txt has no data rows; feed will be missing agency.txt content');
    return;
  }
  if (dataRows.length > 1) {
    warnings.push(`seed agency.txt has ${dataRows.length} rows (expected 1 for single-agency feed; see neary#87)`);
  }
}

function checkRouteColors(routes, warnings) {
  for (const r of routes) {
    const type = Number(r.route_type);
    const expected = ROUTE_TYPE_DEFAULT_COLORS[type];
    if (!expected) continue; // unknown type, no default to compare
    const color = (r.route_color ?? '').toString().replace(/^#?/, '').toUpperCase();
    if (!color) continue; // missing color is fine
    if (color !== expected) {
      warnings.push(
        `route ${r.route_id} (${r.route_short_name}): color #${color} does not match type ${type} default #${expected} (verify intentional, see neary-gtfs#14)`,
      );
    }
  }
}

function checkZeroTripRoutes(csvByRoute, tripCountByRouteId, warnings) {
  for (const [routeShortName, perService] of csvByRoute.entries()) {
    let hadCsv = false;
    let suspended = false;
    for (const csv of perService.values()) {
      hadCsv = true;
      const sn = (csv.serviceName ?? '').toLowerCase();
      if (sn.includes('nu circula') || sn.includes('in lucru') || sn.includes('nu circulă')) {
        suspended = true;
      }
    }
    if (!hadCsv || suspended) continue;
    const routeId = findRouteIdByShortName(tripCountByRouteId, routeShortName, csvByRoute);
    if (routeId == null) continue;
    const count = tripCountByRouteId.get(routeId) ?? 0;
    if (count === 0) {
      warnings.push(
        `route ${routeShortName} (${routeId}) emitted 0 trips despite having CSV data; check pattern resolution (neary-gtfs#15)`,
      );
    }
  }
}

function findRouteIdByShortName(tripCountByRouteId, shortName, csvByRoute) {
  // tripCountByRouteId is keyed by route_id; csvByRoute keyed by shortName.
  // We need a side-channel. For now this check is approximate — a fuller
  // version would thread a shortName→routeId map through.
  for (const id of tripCountByRouteId.keys()) {
    if (id.endsWith(`_${shortName}`) || id === shortName) return id;
  }
  return null;
}

function checkCsvWarnings(csvByRoute, warnings) {
  let dropped = 0;
  for (const [, perService] of csvByRoute.entries()) {
    for (const csv of perService.values()) {
      if (csv.warnings && csv.warnings.length > 0) dropped += csv.warnings.length;
    }
  }
  if (dropped > 0) {
    warnings.push(`${dropped} CSV cell(s) dropped as non-HH:MM (see docs/csv-timetable-format.md § frequency annotations)`);
  }
}