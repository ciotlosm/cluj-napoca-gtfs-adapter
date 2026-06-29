/**
 * Transitous seed fetcher — thin wrapper around `loadSeed` from
 * `src/lib/seed.js`. The seed URL defaults to the canonical
 * Cluj-Napoca mirror at `api.transitous.org`.
 *
 * Transitous serves feeds as `<iso>_<name>.gtfs.zip` where:
 *   - `<iso>` is the lowercased country ISO-3166-1 alpha-2 (`ro`)
 *   - `<name>` is the Transitous catalogue name (`Cluj-Napoca`)
 *
 * Source: https://github.com/public-transit/transitous
 * Catalog: `ro_Cluj-Napoca` → mdb-2121 (Mobility Database mirror)
 */

import { loadSeed } from '../lib/seed.js';

const DEFAULT_SEED_URL = 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip';

/**
 * @param {object} [opts]
 * @param {string} [opts.url]       override the seed URL (for tests)
 * @param {string} [opts.userAgent] override the HTTP UA (for tests)
 */
export async function loadTransitousSeed({ url = DEFAULT_SEED_URL, userAgent } = {}) {
  console.log(`[transitous] loading seed from ${url}`);
  const seed = await loadSeed(url, { userAgent });
  console.log(
    `[transitous] seed loaded: ${seed.routes.length} routes, ` +
    `${seed.stops.length} stops, ${seed.trips.length} trips`,
  );
  return { ...seed, source: url };
}

/**
 * Build a `patternByRouteDir` map from the seed's first trip per
 * `(route_id, direction_id)`. Same lookup `feeds/cluj-napoca/build.js`
 * does — and the one that fails for `neary-gtfs#13` (25N missing
 * dir=1) and `#15` (M26 missing dir=1). The reconciler falls back to
 * Tranzy when this returns nothing.
 *
 * @param {{trips: Array, stopTimes: Map<string, Array>}} seed
 * @returns {Map<string, {
 *   stops: Array<{stopId, sequence}>,
 *   shapeId: string,
 *   headsign: string,
 *   tripId: string,
 *   source: 'seed',
 * }>}
 */
export function seedPatternsByRouteDir(seed) {
  const out = new Map();
  for (const trip of seed.trips) {
    const key = `${trip.routeId}|${trip.directionId}`;
    if (out.has(key)) continue;
    const stops = seed.stopTimes.get(trip.tripId);
    if (!stops || stops.length === 0) continue;
    out.set(key, {
      stops,
      shapeId: trip.shapeId,
      headsign: trip.headsign,
      tripId: trip.tripId,
      source: 'seed',
    });
  }
  return out;
}

export const TRANSITOUS_SEED_URL = DEFAULT_SEED_URL;