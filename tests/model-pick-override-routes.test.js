/**
 * HTTP contract for the audited model-selection override routes.
 *
 * Registered behind the real `requireAuth` middleware, so the tests cover the
 * session + CSRF gate, the mandatory `If-Match` (missing -> 428, stale -> 409),
 * the invalid-override 400 and the scope separation between the global Settings
 * mount and the workspace Watcher mount. Widget / MCP denial is covered with a
 * minimal app stand-in because those callers never present a session cookie.
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
import { registerModelPickOverrideRoutes } from '../lib/routes/model-pick-override-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

after(() => {
  removeIsolatedDataDir();
});

/** @type {string} */
let dir;
/** @type {string} */
let roleFile;
/** @type {string} */
let overridesFile;
/** @type {string} */
let workspaceOverridesFile;
/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {string} */
let sessionToken;
/** @type {string} */
let csrfToken;

const TTL_MS = 60 * 60 * 1000;

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function overrideBody(overrides = {}) {
  return {
    action: 'exclude',
    targetHarness: 'codex',
    reason: 'planned maintenance window',
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    ...overrides,
  };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-override-route-'));
  roleFile = path.join(dir, 'model-role-profiles.json');
  overridesFile = path.join(dir, 'model-pick-overrides.json');
  workspaceOverridesFile = path.join(dir, 'workspace-overrides.json');
  setPassword('test-password-123');
  sessionToken = createSession();
  csrfToken = getCsrfTokenForSessionToken(sessionToken);
  assert.ok(csrfToken);
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  registerHarnessModelRoleConfigRoutes(app, {
    roleProfilesFile: roleFile,
    modelOverridesFile: overridesFile,
  });
  registerModelPickOverrideRoutes(app, {
    basePath: '/api/workspace-watcher/overrides',
    scope: 'workspace',
    filePath: workspaceOverridesFile,
    resolveWorkspaceFolder: (req) => req.query?.workspaceFolder || req.body?.workspaceFolder || '',
  });
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
  fs.rmSync(overridesFile, { force: true });
  fs.rmSync(workspaceOverridesFile, { force: true });
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

test('GET requires a session and reports the missing store', async () => {
  const anonymous = await request('GET', '/api/harness-model-role-config/overrides');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.authRequired, true);

  const res = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.state, 'missing');
  assert.deepEqual(res.body.overrides, []);

  // The same route module exposes the read-only explore ledger next to the
  // role config, separately from the rotation cold-start signal.
  const roleConfig = await request('GET', '/api/harness-model-role-config', { headers: authHeaders() });
  assert.equal(roleConfig.status, 200);
  assert.equal(roleConfig.body.ok, true);
  assert.ok(roleConfig.body.exploreStatus);
  assert.equal(typeof roleConfig.body.exploreStatus.attemptCount, 'number');
});

test('PUT reuses the session and CSRF guard', async () => {
  const anonymous = await request('PUT', '/api/harness-model-role-config/overrides', { body: overrideBody() });
  assert.equal(anonymous.status, 401);

  const noCsrf = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ csrf: false }),
    body: overrideBody(),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.csrfRequired, true);
});

test('PUT without If-Match is 428 and does not write', async () => {
  const res = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders(),
    body: overrideBody(),
  });
  assert.equal(res.status, 428);
  assert.equal(fs.existsSync(overridesFile), false);
});

test('PUT creates with a matching If-Match and bumps the ETag', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const res = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.notEqual(res.body.etag, before.body.etag);
  assert.equal(res.body.override.action, 'exclude');
  assert.equal(res.body.override.createdBy, 'operator');
  assert.equal(res.body.override.source, 'settings-ui');

  const after = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  assert.equal(after.body.overrides.length, 1);
});

test('a stale If-Match is 409 and leaves the store untouched', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  const bytes = fs.readFileSync(overridesFile, 'utf8');
  const stale = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody({ targetHarness: 'qwen' }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.equal(fs.readFileSync(overridesFile, 'utf8'), bytes);
});

test('an invalid override is a 400 and does not write', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const res = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody({ action: 'approve' }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'override_invalid_action');
  assert.equal(fs.existsSync(overridesFile), false);
});

test('PUT ignores client-supplied now for createdAt and TTL bounds', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const forgedNow = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const res = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody({ now: forgedNow }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.override.now, undefined);
  const createdAtMs = Date.parse(res.body.override.createdAt);
  assert.ok(Math.abs(createdAtMs - Date.now()) < 60_000, 'createdAt must come from the server clock');
  assert.ok(createdAtMs > forgedNow + 86400000, 'createdAt must not follow a forged client clock');

  const tooFar = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: res.body.etag }),
    body: overrideBody({
      now: forgedNow,
      expiresAt: new Date(forgedNow + TTL_MS).toISOString(),
      targetHarness: 'qwen',
    }),
  });
  assert.equal(tooFar.status, 400);
  assert.equal(tooFar.body.code, 'override_invalid_ttl');
});

test('revoke without If-Match is 428', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const created = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  const revoked = await request('POST', '/api/harness-model-role-config/overrides/revoke', {
    headers: authHeaders(),
    body: { id: created.body.override.id },
  });
  assert.equal(revoked.status, 428);
  assert.match(revoked.body.error, /If-Match/i);
});

test('revoke with a stale If-Match is 409 and leaves the store untouched', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const created = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  const bytes = fs.readFileSync(overridesFile, 'utf8');
  const stale = await request('POST', '/api/harness-model-role-config/overrides/revoke', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: { id: created.body.override.id, reason: 'stale attempt' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.equal(fs.readFileSync(overridesFile, 'utf8'), bytes);
});

test('reset without If-Match is 428', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  const reset = await request('POST', '/api/harness-model-role-config/overrides/reset', {
    headers: authHeaders(),
  });
  assert.equal(reset.status, 428);
});

test('reset with a stale If-Match is 409 and leaves the store untouched', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const created = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  const bytes = fs.readFileSync(overridesFile, 'utf8');
  const stale = await request('POST', '/api/harness-model-role-config/overrides/reset', {
    headers: authHeaders({ ifMatch: before.body.etag }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.equal(fs.readFileSync(overridesFile, 'utf8'), bytes);
  assert.equal(created.body.override.id, JSON.parse(bytes).overrides[0].id);
});

test('revoke ignores client now for revokedAt', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const created = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  const forgedNow = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const revoked = await request('POST', '/api/harness-model-role-config/overrides/revoke', {
    headers: authHeaders({ ifMatch: created.body.etag }),
    body: { id: created.body.override.id, now: forgedNow },
  });
  assert.equal(revoked.status, 200);
  const revokedAtMs = Date.parse(revoked.body.override.revokedAt);
  assert.ok(Math.abs(revokedAtMs - Date.now()) < 60_000);
});

test('revoke and reset keep the audit trail', async () => {
  const before = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  const created = await request('PUT', '/api/harness-model-role-config/overrides', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody(),
  });
  const revoked = await request('POST', '/api/harness-model-role-config/overrides/revoke', {
    headers: authHeaders({ ifMatch: created.body.etag }),
    body: { id: created.body.override.id, reason: 'done' },
  });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.override.revokedAt);

  const reset = await request('POST', '/api/harness-model-role-config/overrides/reset', {
    headers: authHeaders({ ifMatch: revoked.body.etag }),
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.removed, 1);
  assert.ok(reset.body.backupPath);
  const after = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  assert.deepEqual(after.body.overrides, []);
  assert.ok(after.body.audit.some((row) => row.type === 'reset'));
});

test('the workspace mount scopes a row to its folder', async () => {
  const before = await request('GET', '/api/workspace-watcher/overrides?workspaceFolder=/w/app', { headers: authHeaders() });
  assert.equal(before.status, 200);
  const created = await request('PUT', '/api/workspace-watcher/overrides?workspaceFolder=/w/app', {
    headers: authHeaders({ ifMatch: before.body.etag }),
    body: overrideBody({ targetHarness: 'qwen' }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.override.scope, 'workspace');
  assert.equal(created.body.override.workspaceFolder, '/w/app');

  const here = await request('GET', '/api/workspace-watcher/overrides?workspaceFolder=/w/app', { headers: authHeaders() });
  assert.equal(here.body.overrides.length, 1);
  const elsewhere = await request('GET', '/api/workspace-watcher/overrides?workspaceFolder=/w/other', { headers: authHeaders() });
  assert.deepEqual(elsewhere.body.overrides, []);

  // The global mount never exposes a workspace row.
  const globalView = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  assert.deepEqual(globalView.body.overrides, []);
});

test('an expired row is surfaced in the audit view', async () => {
  fs.writeFileSync(overridesFile, JSON.stringify({
    version: 1,
    overrides: [{
      id: 'old-1',
      scope: 'global',
      action: 'exclude',
      targetHarness: 'codex',
      targetModel: '',
      targetRole: '',
      reason: 'old maintenance',
      createdBy: 'operator',
      source: 'test',
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
      revokedAt: null,
    }],
    audit: [],
  }));
  const res = await request('GET', '/api/harness-model-role-config/overrides', { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(res.body.overrides.length, 1);
  assert.ok(res.body.audit.some((row) => row.type === 'expire' && row.id === 'old-1'));
});

test('a workspace PUT without a folder is a 400', async () => {
  const res = await request('PUT', '/api/workspace-watcher/overrides', {
    headers: authHeaders({ ifMatch: '*' }),
    body: overrideBody(),
  });
  assert.equal(res.status, 400);
});

test('widget and MCP callers are refused with 403 before any read', async () => {
  const routes = new Map();
  const app = {
    get(p, h) { routes.set(`GET ${p}`, h); },
    put(p, h) { routes.set(`PUT ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
  };
  registerHarnessModelRoleConfigRoutes(app, { roleProfilesFile: roleFile, modelOverridesFile: overridesFile });
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
  for (const key of [
    'GET /api/harness-model-role-config/overrides',
    'PUT /api/harness-model-role-config/overrides',
    'POST /api/harness-model-role-config/overrides/revoke',
    'POST /api/harness-model-role-config/overrides/reset',
  ]) {
    const widget = await invoke(key, { widgetAccess: true, query: {}, headers: {}, body: {} });
    assert.equal(widget.statusCode, 403, key);
    const mcp = await invoke(key, { mcpIntegration: true, query: {}, headers: {}, body: {} });
    assert.equal(mcp.statusCode, 403, key);
  }
});
