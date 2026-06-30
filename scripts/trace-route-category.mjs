/**
 * Trace script: load the *published* yesterday's routes.txt as a
 * snapshot of the BEFORE state (Tranzy values, untouched by our
 * category pass), then re-run applyRouteCategory on a copy and show the
 * AFTER state. Print a markdown table per route showing
 * short_name, long_name, desc.
 *
 * Usage: node scripts/trace-route-category.mjs /tmp/neary-trace
 *
 * Output goes to stdout. No fixtures — reads from the unzipped
 * published feed directly so we see real CTP data.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  classifyRoute,
  cleanLongName,
  applyRouteCategory,
} from '../src/assemble/merge/routeCategory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const feedDir = process.argv[2] || '/tmp/neary-trace';
const routesTxtPath = resolve(feedDir, 'routes.txt');
const stopTimesTxtPath = resolve(feedDir, 'stop_times.txt');
const stopsTxtPath = resolve(feedDir, 'stops.txt');
const tripsTxtPath = resolve(feedDir, 'trips.txt');

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return { header, rows: lines.slice(1).map((line) => {
    const out = [];
    let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return Object.fromEntries(header.map((h, i) => [h, out[i] ?? '']));
  }) };
}

const routes = parseCsv(readFileSync(routesTxtPath, 'utf8')).rows;
const trips = parseCsv(readFileSync(tripsTxtPath, 'utf8')).rows;
const stopTimes = parseCsv(readFileSync(stopTimesTxtPath, 'utf8')).rows;
const stops = parseCsv(readFileSync(stopsTxtPath, 'utf8')).rows;

// Build trip→route + stops map.
const tripToRoute = new Map(trips.map((t) => [t.trip_id, t.route_id]));
const stopsByStopId = new Map(stops.map((s) => [s.stop_id, s]));

// Pick representative rows: one per category (using ORIGINAL short_name
// as the signal). These will get 1:many in the AFTER column.
const interesting = [
  { sn: 'TE1',  label: 'TE-prefix school bus' },
  { sn: 'TE14', label: 'TE-prefix school bus' },
  { sn: 'M76A', label: 'M7x school bus (1:many with metroline)' },
  { sn: 'M75A', label: 'M7x school bus (1:many with metroline)' },
  { sn: 'M26',  label: 'Pure metroline' },
  { sn: 'M11',  label: 'Pure metroline' },
  { sn: '25N',  label: 'Night (CSV-scheduled)' },
  { sn: '54N',  label: 'Night (CSV-scheduled)' },
  { sn: '4N',   label: 'Night (Tranzy fallback only)' },
  { sn: '30U',  label: 'Festival (Untold)' },
  { sn: 'M26U', label: 'Festival metroline (1:many)' },
  { sn: 'CS',   label: 'Cursa Speciala' },
  { sn: 'A1',   label: 'Airport Express' },
  { sn: 'D51',  label: 'Employee-only (no category)' },
  { sn: '1',    label: 'Regular urban (no category)' },
  { sn: '24B',  label: 'Regular urban branch' },
  { sn: '88A',  label: 'Floresti M21 variant' },
  { sn: 'TE-OG', label: 'TE-prefix special naming' },
];

// Snapshot the BEFORE state and clone to a fresh set of rows for AFTER.
const snapshots = interesting
  .map((sel) => {
    const row = routes.find((r) => r.route_short_name === sel.sn);
    return row ? { ...sel, before: row } : { ...sel, before: null };
  });

// Apply the cleanup + classification to a clone of each row.
const after = snapshots.map((sel) => {
  if (!sel.before) return { ...sel, after: null };
  const clone = { ...sel.before };
  applyRouteCategory({
    routes: [clone],
    allStopTimeRows: stopTimes,
    tripToRoute,
    stopsByStopId,
    warnings: [],
  });
  return { ...sel, after: clone };
});

// Also produce a global tally.
let cleanedCount = 0, derivedCount = 0, unresolvedCount = 0, multiNetCount = 0, classifiedCount = 0;
for (const row of routes) {
  const originalLongName = row.route_long_name ?? '';
  const cleaned = cleanLongName(row);
  if (cleaned !== originalLongName) cleanedCount++;
  const cats = classifyRoute(row);
  if (cats.length > 0) classifiedCount++;
  if (cats.length > 1) multiNetCount++;
}

console.log('## BEFORE / AFTER — representative routes\n');
console.log('Reading from', routesTxtPath);
console.log('');
console.log('| short_name | desc (before) | long_name (before) | desc (after) | long_name (after) | Δ |');
console.log('|---|---|---|---|---|---|');
for (const s of after) {
  if (!s.before || !s.after) {
    console.log(`| \`${s.sn}\` | ${s.before ? '...' : 'NOT IN routes.txt'} | | | | skipped |`);
    continue;
  }
  const beforeDesc = s.before.route_desc || '(empty)';
  const beforeLong = s.before.route_long_name || '(empty)';
  const afterDesc = s.after.route_desc || '(empty)';
  const afterLong = s.after.route_long_name || '(empty)';
  const changed = (beforeDesc !== afterDesc) || (beforeLong !== afterLong);
  const delta = changed ? '✏️ changed' : '—';
  console.log(`| \`${s.sn}\` | ${beforeDesc} | ${beforeLong} | ${afterDesc} | ${afterLong} | ${delta} |`);
}

console.log('');
console.log('## Global tally (all 168 routes from the published feed)');
console.log('');
console.log(`- Total routes:           ${routes.length}`);
console.log(`- Classified:             ${classifiedCount}`);
console.log(`- With multiple networks: ${multiNetCount}`);
console.log(`- long_name changed:      ${cleanedCount}`);