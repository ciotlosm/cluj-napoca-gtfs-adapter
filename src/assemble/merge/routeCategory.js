/**
 * Route category classification + long_name cleanup.
 *
 * Single source of truth for which network each route belongs to and how
 * to clean up Tranzy's messy `route_long_name` into start-end format.
 * The classifier runs once at assemble time; consumers (neary) just read
 * the structured fields from `routes.txt` + `networks.txt` +
 * `route_networks.txt` and don't have to parse free-text signals.
 *
 * **Background**: see neary#125 for the design discussion. Briefly:
 *
 * - Tranzy exposes only basic route fields (no service-class column),
 *   so category info is buried as patterns in `route_short_name` (TE*,
 *   *N, *U, M*, CS, etc.) and trailing parentheticals in
 *   `route_long_name` / `route_desc` ("(untold)", "(traseu M21)").
 * - The adapter parses those patterns once here, writes the result as
 *   standard GTFS fields (`route_desc` for the human label,
 *   `networks.txt` + `route_networks.txt` for the structured mapping),
 *   and emits cleaned `route_long_name` in start-end format.
 * - `route_short_name` keeps Tranzy's value verbatim — the operator's
 *   chosen rider-facing identifier (e.g. `25N`, `TE1`, `M76A`) is the
 *   GTFS-spec way to carry service-class info, and we don't munge it.
 *
 * **Classification**: 1:1 with priority. Most-specific category wins.
 * `TE1` and `25N` are unambiguous (school / night respectively). Edge
 * cases (e.g. `M76A` whose `long_name` starts with `TE2 Floresti`) are
 * resolved by the school pattern's `long_name` check.
 *
 * **Calendar windows** (school-year-only, festival-only) are *not*
 * tracked here — they're a property of the schedule view, orthogonal to
 * the route's category. See neary#129 for the ingestion work.
 */

/**
 * Categories, ordered most-specific first. First match wins.
 *
 * Each entry: `{ id, label, match(s, l) }` where
 *   - `id` is the network_id (machine-readable, kebab-case-ish)
 *   - `label` is the human-readable string that goes into `route_desc`
 *     AND into `networks.txt` `network_name`. Keeping these aligned
 *     means consumers reading `route_desc` directly get the same string
 *     they'd get from joining `route_networks.txt` → `networks.txt`.
 *   - `match` is a predicate over (route_short_name, route_long_name)
 *
 * Add new categories at the END of this list so existing priorities stay
 * stable. Bumping a category earlier = behavior change for routes that
 * match multiple patterns.
 */
export const CATEGORIES = [
  {
    id: 'special',
    label: 'Cursa Speciala',
    match: (s, l) => s === 'CS' || /CURSA SPECIALA/i.test(l),
  },
  {
    id: 'school',
    label: 'Transport Elevi',
    // CTP uses two namings for school buses:
    //   - "TE1".."TE14" → the urban school bus series
    //   - "M75A".."M79C" → numbered with the M prefix because they go
    //     to Floresti, but `route_long_name` starts with "TE1 Floresti"
    //     .."TE5 Floresti" — school destination.
    // We check long_name too so M7x school buses are correctly tagged
    // even when their short_name doesn't carry a TE prefix.
    match: (s, l) =>
      /^TE/i.test(s) ||
      /^M7[5-9][A-Z]?$/.test(s) ||
      /^TE\d+\s+Floresti/i.test(l),
  },
  {
    id: 'festival',
    label: 'Untold',
    match: (s, l) => /U$/.test(s) || /untold/i.test(l),
  },
  {
    id: 'night',
    label: 'Night service',
    match: (s, l) => /N$/.test(s) || /noapte/i.test(l),
  },
  {
    id: 'airport',
    label: 'Aeroport Express',
    match: (s, l) => /^A\d/.test(s) || /aeroport/i.test(l),
  },
  {
    id: 'commuter',
    label: 'Commuter',
    match: (s) => /^D\d/.test(s),
  },
  {
    id: 'metroline',
    label: 'Metroline',
    match: (s) => /^M\d/.test(s),
  },
];

/**
 * Classify a single route. Returns `null` for regular urban routes that
 * don't fit any category.
 *
 * @param {{ route_short_name?: string, route_long_name?: string, route_desc?: string }} row
 * @returns {{ id: string, label: string } | null}
 */
export function classifyRoute(row) {
  const s = (row.route_short_name ?? '').toString();
  const l = (row.route_long_name ?? '').toString();
  const d = (row.route_desc ?? '').toString();
  for (const cat of CATEGORIES) {
    if (cat.match(s, l, d)) {
      return { id: cat.id, label: cat.label };
    }
  }
  return null;
}

/**
 * Clean `route_long_name` into "Start - End" format.
 *
 * Operations, in order:
 *
 *   1. CURSA SPECIALA (`CS`) → empty. No fixed endpoints — calling it
 *      "CURSA SPECIALA" in `route_long_name` is noise that consumers
 *      shouldn't have to special-case.
 *   2. Strip trailing parenthetical annotations: "(untold)", "(traseu
 *      M21)", "(traseu M21) (something else)". These are free-text
 *      notes Tranzy puts in; they belong in `route_desc` (as the
 *      category label, not the annotation) or nowhere.
 *   3. Strip "Transport Elevi -" / "Transport Elevi " prefix for school
 *      routes whose Tranzy `route_long_name` describes the service
 *      class rather than the endpoints ("Transport Elevi Manastur" →
 *      "Manastur"). For richer start-end extraction (e.g. "Primaverii
 *      - Onisifor Ghibu" for TE1) the CTP website source is required —
 *      tracked in neary#129.
 *   4. Strip remaining "TE\d+" / "TE-OG" prefix noise.
 *
 * @param {{ route_short_name?: string, route_long_name?: string }} row
 * @returns {string} cleaned long_name (may be empty)
 */
export function cleanLongName(row) {
  const s = (row.route_short_name ?? '').toString();
  let l = (row.route_long_name ?? '').toString().trim();

  if (s === 'CS') return '';

  // Strip one or more trailing parentheticals. Examples:
  //   "Floresti Cetate - Emerson (traseu M21)" → "Floresti Cetate - Emerson"
  //   "Uzinei Electrice - Floresti / Cetate (untold)" → "Uzinei Electrice - Floresti / Cetate"
  // Greedy on the right edge; nested parens aren't expected in CTP data.
  l = l.replace(/\s*\([^)]*\)\s*$/g, '').trim();

  // "Transport Elevi -" / "Transport Elevi " prefix.
  //   "Transport Elevi Manastur" → "Manastur"
  //   "Transport Elevi-Manastur - Kogalniceanu" → "Manastur - Kogalniceanu"
  l = l.replace(/^Transport Elevi[- ]+/i, '');

  // "TE\d+ Floresti" prefix from Tranzy for the M7x school-bus family.
  // MUST run BEFORE the generic TE-prefix strip below — otherwise the
  // generic regex eats "TE2 " and leaves "Floresti ..." behind.
  //   "TE2 Floresti str. Somesului..." → "str. Somesului..."
  l = l.replace(/^TE\d+\s+Floresti\s*/i, '');

  // "TE\d+" / "TE-OG" leftover prefix (anything TE* that survived the
  // Floresti-specific strip above).
  //   "TE1 Manastur" → "Manastur"
  //   "TE-OG Sala Sporturilor" → "Sala Sporturilor"
  l = l.replace(/^TE-?[A-Z0-9]+[- ]+/i, '');

  return l.trim();
}

/**
 * Apply classification + long_name cleanup to a route row in place.
 * Mutates the row and returns a summary of what changed.
 *
 * @param {{ route_short_name?: string, route_long_name?: string, route_desc?: string }} row
 * @returns {{ category: { id: string, label: string } | null, longNameChanged: boolean, originalLongName: string }}
 */
export function applyCategory(row) {
  const originalLongName = row.route_long_name ?? '';
  const cleanedLongName = cleanLongName(row);
  row.route_long_name = cleanedLongName;
  const longNameChanged = originalLongName !== cleanedLongName;

  // Recompute category against the *cleaned* long_name so the school
  // predicate (which checks `^TE\d+\s+Floresti` in long_name) sees the
  // post-cleanup value. The order matters: clean first, then classify.
  const category = classifyRoute(row);
  row.route_desc = category?.label ?? '';

  return { category, longNameChanged, originalLongName };
}

/**
 * Get the canonical category list — for `networks.txt` emission in the
 * `emit/networks.js` module.
 */
export function getAllCategories() {
  return CATEGORIES.map(({ id, label }) => ({ id, label }));
}