# Known limitations

> What's still faked, approximated, or just plain missing. Each entry
> links to the upstream issue or source so we know what to track.

## 1. CSV frequency annotations are silently dropped

**Source:** [`neary-gtfs#15`](https://github.com/ciotlosm/neary-gtfs/issues/15) (M26)

The CTP CSV occasionally publishes cells that aren't `HH:MM` departure
times — they're headway / range annotations like `05:05-22:40` or
`10-20min`. The current parser matches `/^\d{1,2}:\d{2}$/` and ignores
anything else:

```
,04:44                  ← kept
,05:05                  ← kept
05:05-22:40,05:23       ← dropped (col 1 = time range)
10-20min,05:32          ← dropped (col 1 = frequency)
```

For M26 specifically this is the difference between "0 trips in the
output" and "a normal schedule". We emit a build warning per dropped
cell (see `reconciliation-rules.md` § data-quality check #2) but the
departures are not recovered.

**Real fix:** parse the range and frequency annotations and emit a
`frequencies.txt` row. Out of scope for the first cut — wanted for v0.2.

## 2. Routes without CSV data fall back to the (potentially stale) seed

**Source:** [`neary-gtfs#1`](https://github.com/ciotlosm/neary-gtfs/issues/1) (closed), `neary-gtfs#15` (M26)

CTP doesn't publish CSVs for ~63 of ~298 routes (per `neary-gtfs#1`'s
investigation). These break down as:

| Category | Examples | Expected behavior |
|---|---|---|
| School transport (TE*) | TE1–TE14, TE5B, TE8B, M75A–M80 | Seasonal, school-year only. Emit zero trips outside the school calendar. |
| Night routes (*N) | M26N, M41N, 4N | May use different naming. We currently miss them entirely. |
| Emerson shuttle (88*) | 88A–88L | Event/shift routes — depends on event calendar we don't have. |
| Special/seasonal | 30U (Untold festival), CS (CURSA SPECIALĂ), D51 | Festival-only; expected zero trips outside the event window. |
| Suspended | M35, 2, 39 CREIC, M12L, M34B, 40S, 87B, 8D, 8S, 39S, 52B, 101A | CSV says "Nu circula" / "In lucru". Zero trips is correct. |
| Active but no CSV | (none confirmed at the moment) | If the seed also has no pattern for these, we silently emit zero trips. |

For routes without CSV but with **seed pattern** (`routes.txt` has the
route, `trips.txt` has pattern trips, `stop_times.txt` has actual times
from the seed): we **pass through the seed's trip data unchanged**. This
matches what the existing `neary-gtfs/feeds/cluj-napoca/build.js` does
for `routesWithoutCsv`. The seed's trips may be weeks stale.

For routes without CSV **and** without seed pattern (silent zero-trip
output): we currently log a warning and emit zero trips. The Tranzy
fallback fixes a subset of these (cases where Tranzy has a
`(route_id, direction_id)` pattern the seed is missing — see `neary-gtfs#13`).
For the rest, the only fix is to discover that CTP publishes the route
under a different URL or schedule.

**Future:** add an "active routes without schedule" investigation
workflow. For each such route, check Tranzy's `/vehicles` to see if any
bus is currently on it. If yes, treat as a data-quality bug.

## 3. Synthetic arrival/departure times when shape is missing

**Source:** the original `ctp-gtfs-adapter` design (memory file)

When neither the Transitous seed nor Tranzy publish a shape for a pattern,
`computeStopTimes()` falls back to haversine between consecutive stops.
This produces monotonic but slightly inaccurate times — corner-cutting
through buildings, etc.

**Detection:** if `shape_dist_traveled` between consecutive stops is
~equal to the haversine distance (within 5%) across the whole trip, we're
in haversine fallback. Log a warning per affected trip.

**Fix:** nothing — the alternative is no schedule at all. Worth flagging
to the consumer app so it can show "approximate times" rather than "live".

## 4. Calendar is synthesized from the CSV service keys we actually scraped

**Source:** same as `neary-gtfs/feeds/cluj-napoca/build.js` lines 235–241.

If only `lv` succeeds for a route, that route's trips are tagged with
`service_id=LV` and won't appear in `S`/`D` views. The calendar's
`start_date` / `end_date` are derived from build date + `GTFS_CALENDAR_DAYS`
(default 180). Out-of-window trips are not currently generated.

**Implication:** the GTFS-Realtime feed (`cluj-rt-feed.gtfs.ro`) which our
trip IDs must match is **not** calendar-aware in the same way. We may need
to align `calendar.txt` with CTP's published service calendar — separate
investigation.

## 5. Tranzy `stop_code` is sometimes a Roman numeral

**Source:** empirical observation from the ctp-gtfs-adapter fixtures

CTP's `stop_code` field (the public-facing code on signage) can be `II`,
`IV`, etc. `Number("II")` returns `NaN`. The adapter treats `stop_code`
as an opaque string and passes it through. Downstream consumers should
do the same.

## 6. The Tranzy client throttles in-process only

`TRANZY_RATE_LIMIT_MS` is enforced via a "last-request timestamp" inside
each `TranzyClient` instance. If two reconciler invocations run in
parallel, both can race past the throttle. For our usage we run one
reconcile per minute (CI cron), so this is fine. If you ever fan out,
move throttling to a shared middleware.

## 7. The `agency.txt` timezone is hard-coded

**Source:** [`neary#87`](https://github.com/ciotlosm/neary/issues/87)

We write `agency_timezone=Europe/Bucharest` from config. The seed's
`agency.txt` may carry a different zone (or be missing). We currently
override it unconditionally. The neary#87 spec calls for a build-time
warning when a feed has multiple `agency.txt` rows with different
timezones — we implement that check but do not act on it (single-agency
feeds only).

## 8. `cluj-rt-feed.gtfs.ro` trip-id parity is a contract, not verified

We generate trip IDs in the canonical CTP format
`${route_id}_${dir}_${serviceId}_${seq}_${HHMM}` that matches what
`neary#108` documents for GTFS-RT JOIN. We do **not** have a live test
that fetches the RT feed and asserts equality — this is a manual
verification step. If the upstream RT feed changes its ID format
silently, our JOINs break.

**Future:** add a build-time probe that fetches the RT feed, picks a
random trip, and asserts that the trip_id pattern matches what we'd
generate. Skip the probe if the feed is unreachable.

## 9. README "limitations" section is the same as this doc

Once the README is finalized, this doc becomes the long-form version.
For now both exist and may drift.