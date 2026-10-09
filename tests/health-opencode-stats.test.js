/**
 * `GET /api/diagnostics/server` exposes the OpenCode instance counter and the
 * opt-in cap as `opencode: { live, pending, limit }`, and never fails the whole
 * endpoint when the manager getter throws or is missing.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { registerHealthRoutes } from '../lib/routes/health-routes.js';

/**
 * @returns {{ routes: Map<string, Function>, app: { get: (path: string, handler: Function) => void } }}
 */
function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    app: {
      get(path, handler) {
        routes.set(path, handler);
      },
    },
  };
}

/**
 * @param {Record<string, unknown>} [overrides]
 */
function createCtx(overrides = {}) {
  return {
    serverInstanceToken: 'test-instance',
    serverStartedAt: 1,
    serverDiagnostics: {
      snapshot: () => ({ event: 'current' }),
      readRecent: () => [],
    },
    readMonitorAlerts: () => [],
    ...overrides,
  };
}

/**
 * @returns {{ statusCode: number, body: Record<string, unknown> | null, status: (code: number) => any, json: (payload: Record<string, unknown>) => any }}
 */
function createFakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

{
  const { routes, app } = createFakeApp();
  registerHealthRoutes(app, createCtx({
    getOpenCodeInstanceStats: () => ({ live: 2, pending: 1, limit: 5 }),
  }));
  const res = createFakeRes();
  routes.get('/api/diagnostics/server')({ query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body?.opencode, { live: 2, pending: 1, limit: 5 });
  assert.ok(res.body?.current);
}

{
  // A throwing getter must not take down the diagnostics endpoint.
  const { routes, app } = createFakeApp();
  registerHealthRoutes(app, createCtx({
    getOpenCodeInstanceStats: () => {
      throw new Error('manager unavailable');
    },
  }));
  const res = createFakeRes();
  routes.get('/api/diagnostics/server')({ query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.opencode, null);
}

{
  // No getter (early boot) is a valid state, not an error.
  const { routes, app } = createFakeApp();
  registerHealthRoutes(app, createCtx());
  const res = createFakeRes();
  routes.get('/api/diagnostics/server')({ query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.opencode, null);
}

console.log('health-opencode-stats.test.js OK');
