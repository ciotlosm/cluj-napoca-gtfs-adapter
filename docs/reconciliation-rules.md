# Reconciliation rules

> **Single source of truth** for the question: *"source A and source B
> disagree about the same field — which wins?"*
>
> If you change anything here, update `docs/known-limitations.md` to
> reflect the new gaps and `tests/reconcile.test.js` to cover the case.

## Inputs

The adapter pulls from three independent sources for the same operator
(CTP Cluj-Napoca, `agency_id=2`):

| Source | Endpoint / file | Strong on | Weak on |
|---|---|---|---|
| **Transitous seed** | `https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip` | Curated, mdb-validated structure. `mdb-2121` mirror. Has authoritative `stop_times.txt` for routes whose CTP CSV is missing. | Update cadence is irregular — sometimes weeks stale (`neary-gtfs#1`). Missing entire directions for some routes (`neary-gtfs#13` for 25N, `#15` for M26). |
| **Tranzy.ai static** | `https://api.tranzy.ai/v1/opendata/{routes,stops,trips,stop_times,shapes}` | Live-updated routes/stops/headsigns/shapes. Per-direction shapes (`<route>_<dir>` shape_id convention). | No `arrival_time` / `departure_time`. No `calendar.txt` for most agencies (404). IDs are internal to Tranzy, may differ from Transitous. |
| **CTP CSV timetables** | `https://ctpcj.ro/orare/csv/orar_<route>_<serviceKey>.csv` | Authoritative departure times per route × service day. Fresh (hours, not weeks). Terminal stop names. | Per-route per-service-day, no full network shape. Some routes publish nothing (63 of ~300 per `neary-gtfs#1`). The CSV's dir0 column sometimes carries frequency annotations instead of times (`neary-gtfs#15` M26). |

## Priority table

The rule is **"more curated wins for structure, more recent wins for
labels, only CSV wins for actual times."**

| Field | Primary | Fallback 1 | Fallback 2 | Last resort |
|---|---|---|---|---|
| `agency` | Transitous seed | — | — | synthesized from config |
| `routes[].route_id` | Transitous seed | Tranzy | — | — |
| `routes[].route_short_name` | Transitous seed | Tranzy | CSV URL filename | — |
| `routes[].route_long_name` | Transitous seed | Tranzy | CSV row 0 `route_long_name` | `route_short_name` |
| `routes[].route_type` | Transitous seed | Tranzy | 3 (bus default) | — |
| `routes[].route_color` | Transitous seed | Tranzy | type-default palette | — |
| `routes[].route_text_color` | Transitous seed | Tranzy | FFFFFF | — |
| `stops[].stop_id` | Transitous seed | Tranzy | — | — |
| `stops[].stop_name` | Transitous seed | Tranzy | — | — |
| `stops[].stop_lat` / `stop_lon` | Transitous seed | Tranzy | — | — |
| `stops[].stop_code` | Transitous seed (sometimes Roman — see warning) | Tranzy | empty | — |
| `shapes[].shape_id` | Transitous seed (mdb-2121) | Tranzy (`<route>_<dir>` convention) | synthesized from stop sequence | — |
| `shapes[].shape_pt_*` | Transitous seed | Tranzy | haversine between consecutive stops | — |
| `trips[].trip_id` | **generated** — canonical CTP format `${route_id}_${dir}_${serviceId}_${seq}_${HHMM}` (matches `cluj-rt-feed.gtfs.ro` GTFS-RT) | — | — | — |
| `trips[].route_id` | CSV's URL filename (matches Transitous `route_short_name`) | Transitous seed | Tranzy | — |
| `trips[].direction_id` | CSV column index (0 = first col, 1 = second col) | — | — | — |
| `trips[].service_id` | CSV URL key mapped via `serviceIdMap` (`lv → LV`, `s → S`, `d → D`, `ld → LD`) | — | — | — |
| `trips[].trip_headsign` | Tranzy (live) | Transitous seed | CSV `out_stop_name` (dir0) / `in_stop_name` (dir1) | `route_long_name` |
| `trips[].shape_id` | Tranzy `<route>_<dir>` | Transitous seed | synthesized `${route_id}_${dir}` | empty |
| `stop_times[].stop_id` | pattern lookup (CSV's seed pattern OR Tranzy fallback) | — | — | — |
| `stop_times[].arrival_time` / `departure_time` | **synthesized** via `computeStopTimes()` from CSV's first departure time + `timing.js` | — | — | — |
| `stop_times[].stop_sequence` | pattern index (0-based) | — | — | — |
| `stop_times[].shape_dist_traveled` | `cumulativeShapeDistances()` from the chosen shape | — | — | — |
| `calendar[].service_id` | `LV` / `S` / `D` / `LD` derived from CSV keys actually scraped | — | Tranzy (if 200) | synthesized |
| `calendar[].start_date` / `end_date` | build date + `GTFS_CALENDAR_DAYS` (default 180) | Tranzy | today only | — |
| `calendar[].{mon..sun}` | hardcoded service-day table (LV = M-F, S = Sat, D = Sun, LD = all) | Tranzy | — | — |
| `feed_info` | static (publisher name, version = ISO date) | — | — | — |

## Pattern-resolution algorithm

For each `(route_id, direction_id)` pair that has CSV departures, we
need a stop sequence (the "pattern") to anchor the schedule:

```
function patternFor(routeId, directionId):
    seed = seedPatterns[routeId][directionId]    // Transitous seed
    if seed exists:
        return { stops: seed.stopSequence, shapeId: seed.shapeId, source: 'seed' }
    
    tranzy = tranzyPatterns[routeId][directionId]   // Tranzy shapes
    if tranzy exists:
        return { stops: tranzy.stopSequence, shapeId: tranzy.shapeId, source: 'tranzy' }
    
    // Last resort: synthesize by walking the stops along the shape from CSV's
    // in_stop_name/out_stop_name. This is what neary-gtfs#13 suggests as a
    // third option. For now we LOG a warning and skip.
    log.warn(`No pattern for ${routeId} dir=${directionId} — dropping departures`)
    return null
```

The Tranzy fallback is the **whole point** of this adapter — it directly
fixes `neary-gtfs#13` (25N direction=1) and `neary-gtfs#15` (M26 direction=1)
by providing the missing stop sequences.

### Trip-headsign resolution

When Tranzy publishes a more recent headsign than Transitous (e.g. a route
renamed a terminus), we prefer Tranzy. CSV's `in_stop_name` / `out_stop_name`
is the third fallback because it matches the literal text on the timetable
PDFs — useful as a tiebreaker when both seed and Tranzy headsign are empty.

### Schedule-generation algorithm

For each CSV departure `HH:MM` on pattern `P`:

```
startSec = hhmmToSeconds(HH:MM)
{ arrivals, departures, shapeDistTraveledM, bucket, speedKmh } =
    computeStopTimes({
        startSec,
        stops: P.stops.map(s => ({ stopId: s.stopId, lat: stopCoords[s.stopId].lat, lon: ... })),
        shape: shapesById[P.shapeId] ?? [],
        timing: TIMING,   // peak/offpeak/night + dwell config
    })

for (i = 0; i < P.stops.length; i++) {
    yield {
        trip_id: `${routeId}_${directionId}_${serviceId}_${seq}_${HHMMDigits}`,
        arrival_time: formatGtfsTime(arrivals[i]),
        departure_time: formatGtfsTime(departures[i]),
        stop_id: P.stops[i].stopId,
        stop_sequence: i,
        shape_dist_traveled: shapeDistTraveledM[i],
    }
}
```

The `bucket` / `speedKmh` returned by `computeStopTimes` are diagnostic —
logged per-route per-service-day so we can verify the time-of-day model
later.

## Data-quality checks (build warnings)

These don't block the build but emit `WARN` lines that should be reviewed
before merging the daily artifact:

1. **Routes with 0 emitted trips but CSV had non-suspended data** —
   surfaces the class of bug behind `neary-gtfs#15` (M26).
   *Suspended* = CSV row 0 starts with `"Nu circula"` or `"In lucru"` —
   explicit signals that zero trips is correct.

2. **CSV departures dropped due to non-`HH:MM` cells** — surfaces
   `neary-gtfs#15` M26's `05:05-22:40` / `10-20min` annotations. Currently
   we drop silently and warn; full frequency-annotation parsing
   (`frequencies.txt`) is a future feature.

3. **Route color doesn't match the type-default palette** — surfaces
   `neary-gtfs#14` (Route 22 orange). Expected palette:
   - `route_type=0` (tram) → `#3BAC2C`
   - `route_type=3` (bus) → `#D24CAE`
   - `route_type=11` (trolleybus) → `#3C4E9A`
   - Any other color → warn "verify intentional exception"

4. **Stop with empty `stop_lat` / `stop_lon`** — Tranzy occasionally
   returns stops with coordinates as empty strings. Drop the stop from
   the patterns it's referenced in, or skip the route. Don't emit a
   trip whose stop sequence has a missing coordinate.

5. **Multiple agencies in `agency.txt`** — surfaces `neary#87`'s
   validator concern. Single-agency feeds (like ours) should have exactly
   one row in `agency.txt`. Warn if not.

6. **CSV row count mismatch with seed trip count** — if the seed
   publishes `N` trips for `(route, dir)` and CSV publishes `M` very
   different departure times, log both for visibility. We don't reconcile
   to the seed's count — CSV wins for trip count.

## Out of scope (deliberately)

- **Reconciling agency_id** — Transitous and Tranzy both treat CTP as
  agency `2`; CSV has no agency concept. No reconciliation needed.
- **Cross-source `route_id` remapping** — we use Transitous's `route_id`
  everywhere; Tranzy's IDs that don't match are added as supplementary
  routes (different `route_short_name`) rather than merged. This avoids
  the mapping-table-trap that the user explicitly called out.
- **`feed_publisher_name`** — always `cluj-napoca-gtfs-adapter`. We do
  not impersonate Transitous or CTP.
- **License attribution** — preserved as-is from the seed (`CC-BY` to
  CTP). Our `feed_info.txt` adds our publisher but does not strip the
  upstream attribution.