/**
 * Tranzy.ai open-data HTTP client.
 *
 * Pure network layer — returns raw JSON arrays from Tranzy's REST API.
 * Conversion to GTFS-shaped structures happens in `./transform.js`.
 *
 * Authentication: ``X-API-KEY`` header with a key from https://tranzy.dev/accounts.
 * Agency scoping: ``X-AGENCY-ID`` header set to the numeric agency id (CTP Cluj = 2).
 *
 * Ported from the Python adapter at ciotlosm/ctp-gtfs-adapter
 * (ctp_gtfs/client.py) on 2026-06-29. Same auth, same retry/backoff curve,
 * same 404-means-empty-list semantics. Differences from the Python version:
 *
 *   - Rate limit expressed in milliseconds (`rateLimitMs`) instead of seconds.
 *   - Uses the built-in `fetch` (Node >= 18) and `AbortSignal.timeout`.
 *   - No external HTTP deps.
 */

const USER_AGENT = 'cluj-napoca-gtfs-adapter/0.1 (+https://github.com/ciotlosm/cluj-napoca-gtfs-adapter)';

export class TranzyError extends Error {
  constructor(message, { endpoint, status, body } = {}) {
    super(message);
    this.name = 'TranzyError';
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

export class TranzyAuthError extends TranzyError {
  constructor(...args) {
    super(...args);
    this.name = 'TranzyAuthError';
  }
}

export class TranzyRateLimitError extends TranzyError {
  constructor(...args) {
    super(...args);
    this.name = 'TranzyRateLimitError';
  }
}

/**
 * Thin wrapper around the tranzy.ai opendata REST API.
 *
 * @param {object} opts
 * @param {string} opts.apiKey          API key from https://tranzy.dev/accounts
 * @param {number|string} opts.agencyId Numeric agency id (CTP Cluj = 2)
 * @param {string} [opts.baseUrl]       API root; defaults to production
 * @param {number} [opts.rateLimitMs]   Min delay between requests; 0 disables
 * @param {number} [opts.maxRetries]    Retries on 5xx / network; 0 disables
 * @param {number} [opts.timeoutMs]     Per-request timeout in ms
 * @param {typeof fetch} [opts.fetch]   Inject for tests
 */
export class TranzyClient {
  constructor({
    apiKey,
    agencyId,
    baseUrl = 'https://api.tranzy.ai/v1/opendata',
    rateLimitMs = 500,
    maxRetries = 3,
    timeoutMs = 30_000,
    fetch: fetchImpl = globalThis.fetch,
  }) {
    if (!apiKey) {
      throw new Error('apiKey is required (get one at https://tranzy.dev/accounts)');
    }
    if (!fetchImpl) {
      throw new Error('No fetch implementation available (need Node >= 18 or pass opts.fetch)');
    }

    this.apiKey = apiKey;
    this.agencyId = String(agencyId);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.rateLimitMs = Math.max(0, rateLimitMs);
    this.maxRetries = Math.max(0, maxRetries);
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl;

    this._rateLock = null; // promise-based mutex
    this._lastRequestAt = 0;
  }

  _throttle() {
    if (this.rateLimitMs <= 0) return Promise.resolve();
    const wait = this._lastRequestAt + this.rateLimitMs - Date.now();
    this._lastRequestAt = Date.now();
    return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
  }

  async _request(endpoint, params) {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers = {
      'X-API-KEY': this.apiKey,
      'X-AGENCY-ID': this.agencyId,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };

    const attempts = this.maxRetries + 1;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this._throttle();
      let res;
      try {
        res = await this._fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        lastErr = err;
        console.warn(`[tranzy] ${endpoint} failed (attempt ${attempt}/${attempts}): ${err.message || err}`);
        if (attempt < attempts) {
          const backoff = Math.min(2 ** (attempt - 1) * 1000, 8000);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new TranzyError(`Network error calling ${endpoint}: ${err.message || err}`, { endpoint });
      }

      if (res.status === 401 || res.status === 403) {
        throw new TranzyAuthError(
          `Tranzy rejected API key (HTTP ${res.status}). Check TRANZY_API_KEY and agency access permissions.`,
          { endpoint, status: res.status },
        );
      }

      if (res.status === 429) {
        if (attempt < attempts) {
          const backoff = Math.min(2 ** attempt * 1000, 16_000);
          console.warn(`[tranzy] rate-limit hit on ${endpoint}, backing off ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new TranzyRateLimitError(
          `Tranzy rate-limit hit on ${endpoint} after ${attempts} attempts`,
          { endpoint, status: res.status },
        );
      }

      if (res.status >= 500 && res.status < 600) {
        if (attempt < attempts) {
          const backoff = Math.min(2 ** attempt * 1000, 16_000);
          console.warn(`[tranzy] ${endpoint} returned ${res.status}, retrying in ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        const body = await safeBody(res);
        throw new TranzyError(
          `Tranzy ${endpoint} returned ${res.status}: ${body.slice(0, 300)}`,
          { endpoint, status: res.status, body },
        );
      }

      if (res.status === 404) {
        // 404 typically means the endpoint isn't supported by this agency.
        // Return an empty list so downstream pipelines can still proceed.
        // Special-case /calendar: Tranzy's docs explicitly say /calendar
        // is not exposed (https://tranzy.dev/) — silent, not a log line.
        if (endpoint !== '/calendar') {
          console.log(`[tranzy] ${endpoint} returned 404 — treating as empty`);
        }
        return [];
      }

      if (!res.ok) {
        const body = await safeBody(res);
        throw new TranzyError(
          `Tranzy ${endpoint} returned ${res.status}: ${body.slice(0, 300)}`,
          { endpoint, status: res.status, body },
        );
      }

      try {
        return await res.json();
      } catch (err) {
        const body = await safeBody(res);
        throw new TranzyError(
          `Tranzy ${endpoint} returned non-JSON body: ${body.slice(0, 300)}`,
          { endpoint, status: res.status, body },
        );
      }
    }

    throw new TranzyError(
      `Tranzy ${endpoint} failed: ${lastErr ? lastErr.message : 'unknown'}`,
      { endpoint },
    );
  }

  getRoutes() { return this._request('/routes'); }
  getStops() { return this._request('/stops'); }
  getTrips() { return this._request('/trips'); }
  getShapes() { return this._request('/shapes'); }
  getStopTimes() { return this._request('/stop_times'); }
  getCalendar() { return this._request('/calendar'); }
  getAgencies() { return this._request('/agencies'); }
  getVehicles(routeId) {
    const params = routeId !== undefined && routeId !== null ? { route_id: routeId } : undefined;
    return this._request('/vehicles', params);
  }

  /**
   * Fetch every static GTFS-style collection in one call.
   * Failures on optional endpoints (calendar / stop_times) are downgraded to
   * empty lists so a single missing endpoint doesn't kill the build.
   *
   * @returns {Promise<{routes: any[], stops: any[], trips: any[], shapes: any[], stop_times: any[], calendar: any[]}>}
   */
  async fetchAll() {
    const endpoints = [
      ['routes', () => this.getRoutes()],
      ['stops', () => this.getStops()],
      ['trips', () => this.getTrips()],
      ['shapes', () => this.getShapes()],
      ['stop_times', () => this.getStopTimes()],
      ['calendar', () => this.getCalendar()],
    ];
    const result = {};
    for (const [key, fn] of endpoints) {
      try {
        result[key] = await fn();
      } catch (err) {
        console.warn(`[tranzy] ${key} fetch failed, continuing with empty list: ${err.message || err}`);
        result[key] = [];
      }
    }
    return result;
  }
}

async function safeBody(res) {
  try { return await res.text(); } catch { return '<unreadable>'; }
}