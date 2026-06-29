/**
 * Tranzy → CTP shortName alias map.
 *
 * Tranzy sometimes shortens route names in a way that doesn't match CTP's
 * CSV URL convention. The known case today: Tranzy publishes route 186
 * as `39C`, but CTP's CSV is at `orar_39CREIC_lv.csv` (no space,
 * full "CREIC" suffix). Transitous carries it as `39 CREIC` (with space).
 *
 * We don't want to depend on Transitous for URL translation — Tranzy is
 * authoritative for what CTP operates. So: maintain a small explicit
 * map of Tranzy's shortName → CTP's CSV shortName.
 *
 * Add entries here when a Tranzy route's shortName 404s on CSV fetch.
 * The smoke stage's WAF-classified 404 list will surface them — wire
 * those findings into this map and the next build resolves cleanly.
 *
 * @type {Record<string, string>}
 */
export const TRANZY_TO_CTP_SHORTNAME = {
  // Tranzy: "39C" → CTP: "39CREIC" (route_id 186).
  // Verified 2026-06-29: `ctpcj.ro/orare/csv/orar_39CREIC_lv.csv` returns
  // a real CSV; `orar_39C_lv.csv` returns 404.
  '39C': '39CREIC',
};