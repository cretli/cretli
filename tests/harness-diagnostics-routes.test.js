/**
 * Route guard for the read-only diagnostics endpoint.
 *
 * The endpoint is admin-only: widget and MCP-integration callers must get 403
 * before any loader runs (no catalog read, no inference, no write). The role is
 * validated before the first read as well, so a typo is a 400, not a fallback.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHarnessDiagnosticsRoutes } from '../lib/routes/harness-diagnostics-routes.js';

test.after(() => {
  removeIsolatedDataDir();
});

/**
 * Minimal Express stand-in: records GET routes and lets a test invoke one.
 *
 * @returns {{ routes: Map<string, Function> }}
 */
function createApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) {
      routes.set(path, handler);
    },
  };
}

/**
 * @returns {{ status: number|null, body: object|null, statusCode: Function, json: Function }}
 */
function createResponse() {
  return {
    statusCode: null,
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

test('the diagnostics endpoint is registered as a GET', () => {
  const app = createApp();
  registerHarnessDiagnosticsRoutes(app, {});
  assert.deepEqual([...app.routes.keys()], ['/api/harness-diagnostics']);
});

test('widget callers are refused with 403 before any loader runs', async () => {
  const app = createApp();
  registerHarnessDiagnosticsRoutes(app, {});
  const handler = app.routes.get('/api/harness-diagnostics');
  const res = createResponse();
  await handler({ query: {}, widgetAccess: true }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
});

test('MCP-integration callers are refused with 403', async () => {
  const app = createApp();
  registerHarnessDiagnosticsRoutes(app, {});
  const handler = app.routes.get('/api/harness-diagnostics');
  const res = createResponse();
  await handler({ query: {}, mcpIntegration: true }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
});

test('an unknown role is a 400 before any loader runs', async () => {
  const app = createApp();
  registerHarnessDiagnosticsRoutes(app, {});
  const handler = app.routes.get('/api/harness-diagnostics');
  const res = createResponse();
  await handler({ query: { role: 'nope' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /role must be/);
});
