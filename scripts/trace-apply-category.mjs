/**
 * Real-orchestrator trace: run reconcile()'s applyRouteCategory pass
 * against the published feed's routes.txt + trips.txt + stop_times.txt
 * + stops.txt to get the actual INFO warning the build would emit.
 * Doesn't go through Tranzy/Transitous API — just exercises the
 * classification step with the published artifacts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { applyRouteCategory } from '../src/assemble/merge/routeCategory.js';

const feedDir = process.argv[2] || '/tmp/neary-trace';

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return {
    header,
    rows: lines.slice(1).map((line) => {
      const out = [];
      let cur = '', inQ = false;
      for (const c of line) {
        if (c === '"') inQ = !inQ;
        else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return Object.fromEntries(header.map((h, i) => [h, out[i] ?? '']));
    }),
  };
}

const routes = parseCsv(readFileSync(`${feedDir}/routes.txt`, 'utf8')).rows;
const trips = parseCsv(readFileSync(`${feedDir}/trips.txt`, 'utf8')).rows;
const stopTimes = parseCsv(readFileSync(`${feedDir}/stop_times.txt`, 'utf8')).rows;
const stops = parseCsv(readFileSync(`${feedDir}/stops.txt`, 'utf8')).rows;

const tripToRoute = new Map(trips.map((t) => [t.trip_id, t.route_id]));
const stopsByStopId = new Map(stops.map((s) => [s.stop_id, s]));

const warnings = [];
const result = applyRouteCategory({
  routes,
  allStopTimeRows: stopTimes,
  tripToRoute,
  stopsByStopId,
  warnings,
});

console.log('## Real orchestrator applyRouteCategory result');
console.log('');
console.log('Counts:');
console.log(JSON.stringify(result, null, 2));
console.log('');
console.log('Warnings emitted:');
for (const w of warnings) console.log(`  [${w.severity}] ${w.message}`);