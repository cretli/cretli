import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { FleetRegistry } from '../lib/fleet/registry.js';
import { FleetPoller } from '../lib/fleet/poller.js';
import { registerFleetRoutes } from '../lib/routes/fleet-routes.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-api-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = dataDir;
process.env.CRETLI_DATA_DIR = dataDir;
const auth = await import('../lib/auth.js');

test('fleet API requires auth and CSRF; CRUD/status/errors never expose tokens', async (t) => {
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  auth.setPassword('fleet-password-123');
  const session = auth.createSession();
  const headers = { cookie: `cr_session=${session}`, [auth.AUTH_CSRF_HEADER]: auth.getCsrfTokenForSessionToken(session), 'Content-Type': 'application/json' };
  const registry = new FleetRegistry({ dataDir }); const poller = new FleetPoller(registry);
  const app = express(); app.use(express.json()); app.use(auth.requireAuth);
  app.use((req, _res, next) => { if (req.headers['x-test-limited']) req.mcpIntegration = {}; next(); });
  registerFleetRoutes(app, { registry, poller });
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const secret = 'FLEET_API_SECRET_93';
  async function call(url, method = 'GET', body, customHeaders = headers) {
    const res = await fetch(base + url, { method, headers: customHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text(); assert.equal(text.includes(secret), false); assert.equal(text.includes('"token"'), false);
    return { status: res.status, body: JSON.parse(text), headers: res.headers };
  }
  for (const [url, method] of [['/api/fleet/instances', 'GET'], ['/api/fleet/status', 'GET'], ['/api/fleet/instances', 'POST'], ['/api/fleet/instances/fake', 'PATCH'], ['/api/fleet/instances/fake', 'DELETE'], ['/api/fleet/instances/fake/status', 'GET']]) {
    assert.equal((await call(url, method, undefined, {})).status, 401);
    assert.equal(auth.isPublicApiPath(url), false);
  }
  const input = { name: 'Team', ownerLabel: 'Owner', url: 'https://example.com', token: secret };
  assert.equal((await call('/api/fleet/instances', 'POST', input, { cookie: headers.cookie, 'Content-Type': 'application/json' })).status, 403);
  assert.deepEqual(registry.list(), []);
  assert.equal((await call('/api/fleet/instances', 'GET', undefined, { ...headers, 'x-test-limited': 'yes' })).status, 403);
  const created = await call('/api/fleet/instances', 'POST', input);
  assert.equal(created.status, 201); const id = created.body.instance.id;
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/fleet/instances')).body.instances.length, 1);
  assert.equal((await call('/api/fleet/status')).body.instances[0].state, 'offline');
  assert.equal((await call(`/api/fleet/instances/${id}/status`)).status, 200);
  for (const method of ['PATCH', 'DELETE']) assert.equal((await call(`/api/fleet/instances/${id}`, method, {}, { cookie: headers.cookie, 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await call(`/api/fleet/instances/${id}`, 'PATCH', { name: 'New' })).body.instance.name, 'New');
  assert.equal(registry.credentials(id).token, secret);
  assert.equal((await call(`/api/fleet/instances/${id}`, 'PATCH', { token: 'rotated-secret' })).status, 200);
  assert.equal((await call('/api/fleet/instances', 'POST', { ...input, url: `https://${secret}@example.com` })).status, 400);
  assert.equal((await call(`/api/fleet/instances/${id}`, 'DELETE')).status, 200);
  assert.equal((await call(`/api/fleet/instances/${id}`, 'DELETE')).status, 404);
  assert.equal((await call(`/api/fleet/instances/${id}`, 'PATCH', {})).status, 404);
  assert.equal((await call(`/api/fleet/instances/${id}/status`)).status, 404);
});
