#!/usr/bin/env node
/**
 * GTFS-Realtime trip-ID parity check.
 *
 * Fetches the live GTFS-RT vehicle_positions feed (default
 * `cluj-rt-feed.gtfs.ro`) and asserts that the `trip_id` on each
 * VehiclePosition entity matches the canonical CTP format that this
 * adapter emits:
 *
 *   /^[A-Za-z0-9]+_[01]_(LV|S|D|LD)_\d+_\d{4}$/
 *
 * If even one trip_id violates the pattern, exit 1 — we want a loud CI
 * failure, not silent rot, if the upstream RT feed changes its ID
 * scheme. This is what would otherwise be a known-limitation silent
 * JOIN break in the neary app.
 *
 * Configuration:
 *   RT_PARITY_URL          URL of the vehicle_positions.pb feed
 *                          (default: https://cluj-rt-feed.gtfs.ro/vehicle_positions.pb)
 *   RT_PARITY_FAIL_ON_FETCH_ERROR  if "1", exit 1 on network/parse error
 *                          (default: "0" — skip with warning)
 *   RT_PARITY_MAX_ENTITIES  cap on entities decoded (default: 50)
 *
 * Exit codes:
 *   0  all sampled trip_ids match the canonical pattern
 *   1  at least one mismatch — or fetch error when RT_PARITY_FAIL_ON_FETCH_ERROR=1
 *   2  configuration missing (RT_PARITY_URL not set, no default usable)
 */

import { argv, env, exit } from 'node:process';

const DEFAULT_URL = 'https://cluj-rt-feed.gtfs.ro/vehicle_positions.pb';
const CANONICAL_RE = /^[A-Za-z0-9]+_[01]_(LV|S|D|LD)_\d+_\d{4}$/;

async function main() {
  const url = env.RT_PARITY_URL || DEFAULT_URL;
  const failOnFetch = env.RT_PARITY_FAIL_ON_FETCH_ERROR === '1';
  const maxEntities = parseInt(env.RT_PARITY_MAX_ENTITIES || '50', 10);

  console.log(`[rt-parity] fetching ${url}`);
  let buf;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'cluj-napoca-gtfs-adapter/0.1 (rt-parity-check)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = await res.arrayBuffer();
  } catch (err) {
    const msg = `[rt-parity] fetch failed: ${err.message || err}`;
    if (failOnFetch) { console.error(msg); exit(1); }
    console.warn(`${msg} — skipping (set RT_PARITY_FAIL_ON_FETCH_ERROR=1 to fail here)`);
    exit(0);
  }

  let FeedMessage;
  try {
    const mod = await import('gtfs-realtime-bindings');
    FeedMessage = mod.transit_realtime?.FeedMessage ?? mod.default?.FeedMessage ?? mod.FeedMessage;
    if (!FeedMessage) throw new Error('FeedMessage not found in gtfs-realtime-bindings export');
  } catch (err) {
    console.error(`[rt-parity] could not load gtfs-realtime-bindings: ${err.message || err}`);
    exit(1);
  }

  let feed;
  try {
    feed = FeedMessage.decode(new Uint8Array(buf));
  } catch (err) {
    const msg = `[rt-parity] protobuf decode failed: ${err.message || err}`;
    if (failOnFetch) { console.error(msg); exit(1); }
    console.warn(`${msg} — skipping`);
    exit(0);
  }

  const sampled = [];
  let tripIdCount = 0;
  for (const entity of feed.entity ?? []) {
    if (!entity.vehicle?.trip?.tripId) continue;
    sampled.push(entity.vehicle.trip.tripId);
    tripIdCount++;
    if (sampled.length >= maxEntities) break;
  }

  if (sampled.length === 0) {
    console.warn(`[rt-parity] no VehiclePosition entities with tripId found in feed (decoded ${tripIdCount} total) — skipping`);
    exit(0);
  }

  const mismatches = sampled.filter((id) => !CANONICAL_RE.test(id));
  console.log(
    `[rt-parity] sampled ${sampled.length} trip_ids; ` +
    `${mismatches.length} mismatch(es) against canonical pattern`,
  );

  if (mismatches.length > 0) {
    console.error(`[rt-parity] MISMATCH — these trip_ids would break GTFS-RT JOIN in the neary app:`);
    for (const id of mismatches.slice(0, 20)) {
      console.error(`  - ${id}`);
    }
    if (mismatches.length > 20) {
      console.error(`  ... and ${mismatches.length - 20} more`);
    }
    console.error(`[rt-parity] fix: update makeTripId() in src/reconcile/trips.js to match the upstream format, then re-run.`);
    exit(1);
  }

  // Show a sample of compliant IDs for sanity.
  console.log(`[rt-parity] sample compliant trip_ids:`);
  for (const id of sampled.slice(0, 5)) console.log(`  ✓ ${id}`);
  console.log(`[rt-parity] OK — all sampled trip_ids match the canonical pattern.`);
  exit(0);
}

main().catch((err) => {
  console.error(`[rt-parity] unexpected error: ${err.stack || err.message || err}`);
  exit(1);
});

// Reference argv so unused-imports lints don't complain if we add flags later.
void argv;