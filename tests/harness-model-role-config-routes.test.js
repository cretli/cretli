/**
 * HTTP contract for the audited model-role config route.
 *
 * The route is registered behind the real `requireAuth` middleware, so the
 * tests cover the full-session + CSRF gate, the `If-Match` precondition
 * (missing -> 428, stale -> 409), the invalid-config write refusal and the reset
 * backup. Widget / MCP-integration denial is covered with a minimal app stand-in
 * because those callers never present a session cookie.
 */

import './helpers/isolated-data-dir.js';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  AUTH_CSRF_HEADER,
  createSession,
  getCsrfTokenForSessionToken,
  requireAuth,
  setPassword,
} from '../lib/auth.js';
import { registerHarnessModelRoleConfigRoutes } from '../lib/routes/harness-model-role-config-routes.js';
import { computeModelRoleConfigEtag } from '../lib/model-role-config-store.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

after(() => {
  removeIsolatedDataDir();
});

/** @type {string} */
let dir;
/** @type {string} */
let filePath;
/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {string} */
let sessionToken;
/** @type {string} */
let csrfToken;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-role-route-'));
  filePath = path.join(dir, 'model-role-profiles.json');
  setPassword('test-password-123');
  sessionToken = createSession();
  csrfToken = getCsrfTokenForSessionToken(sessionToken);
  assert.ok(csrfToken);
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  registerHarnessModelRoleConfigRoutes(app, { roleProfilesFile: filePath });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(filePath, { force: true });
});

/**
 * @param {string} method
 * @param {string} url
 * @param {{ body?: object, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function request(method, url, options = {}) {
  const init = { method, headers: { ...(options.headers || {}) } };
  if (typeof options.body !== 'undefined') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${url}`, init);
  return { status: response.status, body: await response.json() };
}

/**
 * @param {{ csrf?: boolean, ifMatch?: string }} [options]
 * @returns {Record<string, string>}
 */
function authHeaders(options = {}) {
  const headers = { cookie: `cr_session=${encodeURIComponent(sessionToken)}` };
  if (options.csrf !== false) headers[AUTH_CSRF_HEADER] = csrfToken;
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;
  return headers;
}

test('GET requires a session and reports the missing config state', async () => {
  const anonymous = await request('GET', '/api/harness-model-role-config');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.authRequired, true);

  const res = await request('GET', '/api/harness-model-role-config', { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.state, 'missing');
  assert.equal(res.body.etag, computeModelRoleConfigEtag(null));
  assert.ok(res.body.roles?.plan?.policy.includes('grok'));
});

test('PUT reuses the session and CSRF guard', async () => {
  const anonymous = await request('PUT', '/api/harness-model-role-config', {
    body: { roles: { plan: { remove: ['grok'] } } },
  });
  assert.equal(anonymous.status, 401);

  const noCsrf = await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders({ csrf: false }),
    body: { roles: { plan: { remove: ['grok'] } } },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.csrfRequired, true);
});

test('PUT without If-Match is 428 and does not write', async () => {
  const res = await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders(),
    body: { roles: { plan: { remove: ['grok'] } } },
  });
  assert.equal(res.status, 428);
  assert.equal(res.body.ok, false);
  assert.equal(fs.existsSync(filePath), false);
});

test('PUT applies a delta with a matching If-Match and bumps the ETag', async () => {
  const before = await request('GET', '/api/harness-model-role-config', { headers: authHeaders() });
  const res = await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: { roles: { plan: { set: { flash: { priority: 2 } }, remove: ['grok'] } } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.notEqual(res.body.etag, before.body.etag);
  assert.deepEqual(res.body.diff.roles.plan.removed.map((row) => row.pattern), ['grok']);
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(doc.rolesDelta.plan.set.flash);
});

test('a stale If-Match is 409 and leaves the file untouched', async () => {
  const first = await request('GET', '/api/harness-model-role-config', { headers: authHeaders() });
  await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders({ ifMatch: first.body.etag }),
    body: { roles: { plan: { remove: ['grok'] } } },
  });
  const bytes = fs.readFileSync(filePath, 'utf8');
  const stale = await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders({ ifMatch: first.body.etag }),
    body: { roles: { plan: { remove: ['luna'] } } },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
});

test('an invalid config is a 409 and is not overwritten', async () => {
  fs.writeFileSync(filePath, '{ broken');
  const res = await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders({ ifMatch: computeModelRoleConfigEtag('{ broken') }),
    body: { roles: { plan: { remove: ['grok'] } } },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.state, 'invalid');
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{ broken');
});

test('an invalid delta is a 400 and does not write', async () => {
  const before = await request('GET', '/api/harness-model-role-config', { headers: authHeaders() });
  const res = await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: { roles: { plan: { set: { madeup: { priority: 1 } } } } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(fs.existsSync(filePath), false);
});

test('unknown top-level keys survive a route write', async () => {
  fs.writeFileSync(filePath, JSON.stringify({ custom: { keep: 1 } }));
  const before = await request('GET', '/api/harness-model-role-config', { headers: authHeaders() });
  assert.deepEqual(before.body.unknownTopLevelKeys, ['custom']);
  const res = await request('PUT', '/api/harness-model-role-config', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: { adaptive: { enabled: false } },
  });
  assert.equal(res.status, 200);
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(doc.custom, { keep: 1 });
});

test('a dry run returns the diff without writing or requiring If-Match', async () => {
  const res = await request('PUT', '/api/harness-model-role-config?dryRun=1', {
    headers: authHeaders(),
    body: { roles: { plan: { remove: ['grok'] } } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.diff.changed, true);
  assert.equal(fs.existsSync(filePath), false);
});

test('reset backs up the current file and restores defaults', async () => {
  const original = JSON.stringify({ rolesDelta: { plan: { remove: ['grok'] } } });
  fs.writeFileSync(filePath, original);
  const current = await request('GET', '/api/harness-model-role-config', { headers: authHeaders() });
  const res = await request('POST', '/api/harness-model-role-config/reset', {
    headers: authHeaders({ ifMatch: current.body.etag }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.backupPath);
  assert.equal(fs.readFileSync(res.body.backupPath, 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {});
});

test('widget and MCP callers are refused with 403 before any read', async () => {
  const routes = new Map();
  const app = {
    get(p, h) { routes.set(`GET ${p}`, h); },
    put(p, h) { routes.set(`PUT ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
  };
  registerHarnessModelRoleConfigRoutes(app, { roleProfilesFile: filePath });
  /** @param {object} req */
  const invoke = async (key, req) => {
    let statusCode = null;
    let payload = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { payload = body; return this; },
    };
    await routes.get(key)(req, res);
    return { statusCode, payload };
  };
  for (const key of ['GET /api/harness-model-role-config', 'PUT /api/harness-model-role-config', 'POST /api/harness-model-role-config/reset']) {
    const widget = await invoke(key, { widgetAccess: true, query: {}, headers: {}, body: {} });
    assert.equal(widget.statusCode, 403, key);
    const mcp = await invoke(key, { mcpIntegration: true, query: {}, headers: {}, body: {} });
    assert.equal(mcp.statusCode, 403, key);
  }
});
