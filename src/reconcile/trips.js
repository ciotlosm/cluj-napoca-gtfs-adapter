/**
 * Trips + stop_times reconciliation.
 *
 * For each CSV departure `HH:MM` on a `(route, dir, service)` pattern:
 *   1. Resolve the pattern (seed → Tranzy → null; see `patterns.js`)
 *   2. Generate a canonical CTP-format trip_id
 *   3. Emit trips.txt row
 *   4. For each stop in the pattern, call `computeStopTimes()` to get
 *      arrival/departure seconds, then emit stop_times.txt row.
 *
 * Trip ID format (canonical CTP — matches `cluj-rt-feed.gtfs.ro`):
 *   `${route_id}_${dir}_${serviceId}_${seq}_${HHMMDigits}`
 *   e.g. `45_1_LV_9_0721`  (route 45, dir 1, LV service, 9th departure, 07:21)
 */

import { computeStopTimes } from '../lib/timing.js';

const DEFAULT_TIMING = {
  speedKmh: { peak: 14, offpeak: 22, night: 28 },
  peakWindows: [
    { from: '07:00', to: '09:30' },
    { from: '16:00', to: '19:00' },
  ],
  nightWindow: { from: '22:30', to: '05:30' },
  intermediateDwellSec: 20,
};

/**
 * @param {{
 *   byRouteService: Map<string, Map<string, {
 *     departures: { dir0: string[], dir1: string[] },
 *     inStopName: string,
 *     outStopName: string,
 *     routeLongName: string,
 *     warnings: any[],
 *   }>>,
 *   routesByRouteId: Map<string, { route_id, route_short_name, route_long_name, ... }>,
 *   stopsByStopId: Map<string, { stop_id, stop_lat, stop_lon, stop_name }>,
 *   seedPatterns: Map<string, { stops, shapeId, headsign, source }>,
 *   tranzyPatterns: Map<string, { stops, shapeId, headsign, source }>,
 *   shapesById: Map<string, Array<{lat, lon}>>,
 *   warnings: string[],
 *   timing?: typeof DEFAULT_TIMING,
 * }} input
 * @returns {{
 *   tripRows: Array<{route_id, service_id, trip_id, trip_headsign, direction_id, shape_id}>,
 *   stopTimeRows: Array<{trip_id, arrival_time, departure_time, stop_id, stop_sequence, shape_dist_traveled}>,
 *   tripDiagnostics: Array<{route_id, direction_id, service_id, count, bucket, speed_kmh}>,
 * }}
 */
export function reconcileTripsAndStopTimes(input) {
  const timing = input.timing ?? DEFAULT_TIMING;
  const tripRows = [];
  const stopTimeRows = [];
  const tripDiagnostics = [];
  /** @type {string[]} */
  const localWarnings = [];

  for (const [routeShortName, byService] of input.byRouteService.entries()) {
    // Find the route row matching this short name (CSV uses short name; rows use route_id).
    const routeRow = findRouteByShortName(input.routesByRouteId, routeShortName);
    if (!routeRow) {
      localWarnings.push(`CSV for ${routeShortName} but no route in seed/Tranzy; skipping`);
      continue;
    }
    const routeId = routeRow.route_id;

    for (const [serviceId, csv] of byService.entries()) {
      const dirs = [
        { dir: 0, departures: csv.departures.dir0, csvHeadsign: csv.outStopName },
        { dir: 1, departures: csv.departures.dir1, csvHeadsign: csv.inStopName },
      ];
      for (const { dir, departures, csvHeadsign } of dirs) {
        if (!departures || departures.length === 0) continue;
        const key = `${routeId}|${dir}`;
        const seedPattern = input.seedPatterns.get(key);
        const tranzyPattern = input.tranzyPatterns.get(key);
        const pattern = seedPattern ?? tranzyPattern;
        if (!pattern || pattern.stops.length === 0) {
          localWarnings.push(`No pattern for ${routeShortName} (${routeId}) dir=${dir} — dropping ${departures.length} departures`);
          continue;
        }
        const orderedStops = pattern.stops
          .map((s) => {
            const stop = input.stopsByStopId.get(s.stopId);
            if (!stop) return null;
            const lat = parseFloat(stop.stop_lat);
            const lon = parseFloat(stop.stop_lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            return { stopId: stop.stop_id, lat, lon, name: stop.stop_name };
          })
          .filter(Boolean);
        if (orderedStops.length === 0) {
          localWarnings.push(`All stops for ${routeShortName} dir=${dir} missing coords; dropping`);
          continue;
        }
        const shape = (pattern.shapeId && input.shapesById.get(pattern.shapeId)) || [];

        const headsign = pattern.headsign || csvHeadsign || routeRow.route_long_name || routeShortName;

        for (let i = 0; i < departures.length; i++) {
          const depTime = departures[i];
          const tripId = makeTripId(routeId, dir, serviceId, i, depTime);
          const shapeId = pattern.shapeId || `${routeId}_${dir}`;
          tripRows.push({
            route_id: routeId,
            service_id: serviceId,
            trip_id: tripId,
            trip_headsign: headsign,
            direction_id: String(dir),
            shape_id: shapeId,
          });

          const startSec = hhmmToSeconds(depTime);
          const { arrivals, departures: stopDeps, shapeDistTraveledM, bucket, speedKmh } = computeStopTimes({
            startSec,
            stops: orderedStops,
            shape,
            timing,
          });
          for (let k = 0; k < orderedStops.length; k++) {
            stopTimeRows.push({
              trip_id: tripId,
              arrival_time: formatGtfsTime(arrivals[k]),
              departure_time: formatGtfsTime(stopDeps[k]),
              stop_id: orderedStops[k].stopId,
              stop_sequence: String(k),
              shape_dist_traveled: shapeDistTraveledM[k] != null ? String(shapeDistTraveledM[k]) : '',
            });
          }

          if (i === 0) {
            tripDiagnostics.push({
              route_id: routeId,
              direction_id: dir,
              service_id: serviceId,
              count: departures.length,
              bucket,
              speed_kmh: speedKmh,
              pattern_source: pattern.source ?? 'seed',
            });
          }
        }
      }
    }
  }

  input.warnings.push(...localWarnings);
  return { tripRows, stopTimeRows, tripDiagnostics };
}

function findRouteByShortName(routesByRouteId, shortName) {
  for (const r of routesByRouteId.values()) {
    if (r.route_short_name === shortName) return r;
  }
  return null;
}

/**
 * Canonical CTP trip ID — matches `cluj-rt-feed.gtfs.ro` GTFS-RT format.
 * e.g. route 45, dir 1, LV service, 9th departure at 07:21 → `45_1_LV_9_0721`.
 *
 * @param {string} routeId
 * @param {number} dir
 * @param {string} serviceId
 * @param {number} seq
 * @param {string} depTime  "HH:MM" or "HH:MM:SS" or "HH+24:MM"
 */
export function makeTripId(routeId, dir, serviceId, seq, depTime) {
  const hhmm = depTime.replace(':', '').replace('+24', '');
  return `${routeId}_${dir}_${serviceId}_${seq}_${hhmm}`;
}

function hhmmToSeconds(hhmm) {
  const parts = hhmm.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 3600 + m * 60;
}

function formatGtfsTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function tripsToTxt(tripRows) {
  const headers = ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'trip_short_name', 'direction_id', 'block_id', 'shape_id', 'wheelchair_accessible', 'bikes_allowed'];
  const lines = [headers.join(',')];
  for (const t of tripRows) {
    lines.push([
      csvField(t.route_id),
      csvField(t.service_id),
      csvField(t.trip_id),
      csvField(t.trip_headsign),
      '', // trip_short_name
      csvField(t.direction_id),
      '', // block_id
      csvField(t.shape_id),
      '', // wheelchair_accessible
      '', // bikes_allowed
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

export function stopTimesToTxt(stopTimeRows) {
  const headers = ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'stop_headsign', 'pickup_type', 'drop_off_type', 'continuous_pickup', 'continuous_drop_off', 'shape_dist_traveled', 'timepoint'];
  const lines = [headers.join(',')];
  for (const s of stopTimeRows) {
    lines.push([
      csvField(s.trip_id),
      csvField(s.arrival_time),
      csvField(s.departure_time),
      csvField(s.stop_id),
      csvField(s.stop_sequence),
      '', // stop_headsign
      '', '', '', '',
      csvField(s.shape_dist_traveled),
      '', // timepoint
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