import { percentile } from './percentile.js';

const DEFAULT_SAMPLES_PER_ROUTE = 200;
const DEFAULT_MAX_ROUTES = 200;

/**
 * Bounded per-route duration recorder (ring buffer per route key).
 *
 * @param {{ samplesPerRoute?: number, maxRoutes?: number }} [options]
 */
export function createRouteTimings(options = {}) {
  const samplesPerRoute = options.samplesPerRoute || DEFAULT_SAMPLES_PER_ROUTE;
  const maxRoutes = options.maxRoutes || DEFAULT_MAX_ROUTES;
  /** @type {Map<string, { ring: number[], next: number, count: number }>} */
  const routes = new Map();

  /**
   * @param {string} key e.g. "GET /api/health"
   * @param {number} durationMs
   */
  function record(key, durationMs) {
    if (!key || !Number.isFinite(durationMs) || durationMs < 0) return;
    let entry = routes.get(key);
    if (!entry) {
      if (routes.size >= maxRoutes) return;
      entry = { ring: [], next: 0, count: 0 };
      routes.set(key, entry);
    }
    if (entry.ring.length < samplesPerRoute) entry.ring.push(durationMs);
    else entry.ring[entry.next] = durationMs;
    entry.next = (entry.next + 1) % samplesPerRoute;
    entry.count += 1;
  }

  /**
   * @param {{ top?: number }} [opts]
   * @returns {{ route: string, count: number, p95: number }[]} Slowest p95 first.
   */
  function summarize(opts = {}) {
    const rows = [];
    for (const [route, entry] of routes) {
      rows.push({ route, count: entry.count, p95: Math.round(percentile(entry.ring, 95) * 10) / 10 });
    }
    rows.sort((a, b) => b.p95 - a.p95);
    return rows.slice(0, opts.top || 10);
  }

  /**
   * Passive Express middleware: observes `finish`, never alters the response.
   * The key uses the matched route pattern, so ids do not explode the key space.
   *
   * @returns {import('express').RequestHandler}
   */
  function middleware() {
    return (req, res, next) => {
      const startedAt = process.hrtime.bigint();
      res.on('finish', () => {
        const pattern = req.route?.path;
        const path = typeof pattern === 'string' ? `${req.baseUrl || ''}${pattern}` : '';
        if (!path.startsWith('/api/')) return;
        record(`${req.method} ${path}`, Number(process.hrtime.bigint() - startedAt) / 1e6);
      });
      next();
    };
  }

  return { record, summarize, middleware, reset: () => routes.clear() };
}
