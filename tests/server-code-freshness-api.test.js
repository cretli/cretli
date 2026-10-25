/**
 * Server-code freshness at the boundaries: what the pre-auth health endpoint may
 * expose, what the authorized diagnostics endpoint exposes, the real-repo walk,
 * and how the flag reaches the Workspace Watcher decision log ("Why?").
 *
 * The detector's own rules live in tests/server-code-freshness.test.js; this file
 * proves the wiring keeps the secrets in and the unknowns honest.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { registerHealthRoutes } from '../lib/routes/health-routes.js';
import { isPublicApiPath } from '../lib/auth.js';
import { scanServerCodeManifest } from '../lib/server-code-freshness.js';
import {
  backendCodeFreshnessDecisionStamp,
  describeWorkspaceWatcherDecision,
} from '../lib/workspace-watcher.js';
import { normalizeWorkspaceWatcherDecision } from '../lib/persist/workspace-watchers-persist.js';
import { formatWatcherDecisionReasonText } from '../app_front/features/watcher/watcherStatus.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} relativePath
 * @returns {Promise<string>}
 */
function readFileText(relativePath) {
  return readFile(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

/**
 * @returns {{ routes: Map<string, Function>, app: { get: (path: string, handler: Function) => void } }}
 */
function createFakeApp() {
  const routes = new Map();
  return {
    routes,
    app: {
      get(routePath, handler) {
        routes.set(routePath, handler);
      },
    },
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
 * @param {Record<string, unknown>} [ctxOverrides]
 * @param {Record<string, unknown>} [request]
 */
function callDiagnostics(ctxOverrides = {}, request = {}) {
  const { app, routes } = createFakeApp();
  registerHealthRoutes(app, createCtx(ctxOverrides));
  const res = createFakeRes();
  routes.get('/api/diagnostics/server')({ widgetAccess: false, mcpIntegration: false, query: {}, ...request }, res);
  return res;
}

/**
 * @param {Record<string, unknown>} [ctxOverrides]
 */
function callHealth(ctxOverrides = {}) {
  const { app, routes } = createFakeApp();
  registerHealthRoutes(app, createCtx(ctxOverrides));
  const res = createFakeRes();
  routes.get('/api/health')({}, res);
  return res;
}

// ---------------------------------------------------------------------------
// Pre-auth /api/health: the bare flag, nothing more.

{
  assert.equal(isPublicApiPath('/api/health'), true);
  assert.equal(isPublicApiPath('/api/diagnostics/server'), false);
}

{
  const res = callHealth({
    isServerCodeStale: () => true,
    readServerCodeFreshness: () => ({ state: 'stale', changedCount: 4, staleSinceAt: '2026-10-10T10:00:00.000Z' }),
  });
  assert.equal(res.body.backendCodeStale, true);
  // The count and the timestamp belong to the authorized endpoint only.
  assert.equal('codeFreshness' in res.body, false);
  assert.equal('backendCodeChangedFiles' in res.body, false);
  assert.doesNotMatch(JSON.stringify(res.body), /changedCount/);
}

{
  // No measurement is not an alarm: `unknown` must not read as stale.
  assert.equal(callHealth({ isServerCodeStale: () => false }).body.backendCodeStale, false);
  assert.equal(callHealth({}).body.backendCodeStale, false);
  assert.equal(callHealth({ isServerCodeStale: () => { throw new Error('detector not ready'); } }).body.backendCodeStale, false);
}

// ---------------------------------------------------------------------------
// Authorized /api/diagnostics/server: state + count, never paths.

{
  const res = callDiagnostics({
    readServerCodeFreshness: () => ({ state: 'stale', changedCount: 3, staleSinceAt: '2026-10-10T10:00:00.000Z' }),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.codeFreshness, {
    state: 'stale',
    changedCount: 3,
    staleSinceAt: '2026-10-10T10:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(res.body), /lib\/|server\.js|app_front/);
}

{
  // Missing data stays missing: an unmeasured backend is `unknown` with a null
  // count, never a `0` that would read as "nothing changed".
  const res = callDiagnostics({
    readServerCodeFreshness: () => ({ state: 'unknown', changedCount: null, staleSinceAt: null }),
  });
  assert.equal(res.body.codeFreshness.state, 'unknown');
  assert.equal(res.body.codeFreshness.changedCount, null);
  // A stray zero on an unknown state cannot be laundered into the payload.
  const lie = callDiagnostics({
    readServerCodeFreshness: () => ({ state: 'unknown', changedCount: 0, staleSinceAt: null }),
  });
  assert.equal(lie.body.codeFreshness.changedCount, null);
}

{
  // An unwired getter or a throwing one must not take the endpoint down.
  const unwired = callDiagnostics({});
  assert.equal(unwired.statusCode, 200);
  assert.deepEqual(unwired.body.codeFreshness, { state: 'unknown', changedCount: null, staleSinceAt: null });
  const throwing = callDiagnostics({
    readServerCodeFreshness: () => { throw new Error('detector unavailable'); },
  });
  assert.equal(throwing.statusCode, 200);
  assert.equal(throwing.body.codeFreshness.state, 'unknown');
  const nonsense = callDiagnostics({ readServerCodeFreshness: () => ({ state: 'exploded', changedCount: -5 }) });
  assert.equal(nonsense.body.codeFreshness.state, 'unknown');
  assert.equal(nonsense.body.codeFreshness.changedCount, null);
}

{
  // Widget and MCP integrations are not a Cretli login session: no details, no flag.
  const asWidget = callDiagnostics({ readServerCodeFreshness: () => ({ state: 'stale', changedCount: 3 }) }, { widgetAccess: true });
  assert.equal(asWidget.statusCode, 403);
  const asMcp = callDiagnostics({ readServerCodeFreshness: () => ({ state: 'stale', changedCount: 3 }) }, { mcpIntegration: true });
  assert.equal(asMcp.statusCode, 403);
}

// ---------------------------------------------------------------------------
// The walk runs against the real repository: backend sources only, no exclusions.

{
  const scan = await scanServerCodeManifest({ rootDir: PROJECT_ROOT });
  assert.equal(scan.status, 'ok');
  const keys = Object.keys(scan.manifest);
  assert.ok(keys.length > 100, `expected a real manifest, got ${keys.length} entries`);
  assert.equal(keys.includes('server.js'), true);
  assert.ok(keys.some((rel) => rel.startsWith('lib/') && rel.endsWith('.js')));
  assert.equal(keys.some((rel) => rel.startsWith('app_front/')), false);
  assert.equal(keys.some((rel) => rel.startsWith('data/')), false);
  assert.equal(keys.some((rel) => rel.startsWith('public/')), false);
  assert.equal(keys.some((rel) => rel.includes('node_modules/')), false);
  assert.equal(keys.filter((rel) => rel.startsWith('lib/')).every((rel) => rel.endsWith('.js') || rel.endsWith('.ts')), true);
  // A manifest entry is a hash, not a path list leak into the payload.
  const firstHash = scan.manifest['server.js'];
  assert.equal(typeof firstHash, 'string');
  assert.equal(firstHash.length, 64);
}

// ---------------------------------------------------------------------------
// Workspace Watcher: the stamp exists only for a measured stale backend.

{
  assert.deepEqual(backendCodeFreshnessDecisionStamp(() => ({ state: 'stale', changedCount: 2 })), {
    backendCodeStale: true,
    backendCodeChangedFiles: 2,
  });
  // fresh / unknown / missing count / a throwing reader all produce no stamp.
  assert.deepEqual(backendCodeFreshnessDecisionStamp(() => ({ state: 'fresh', changedCount: 0 })), {});
  assert.deepEqual(backendCodeFreshnessDecisionStamp(() => ({ state: 'unknown', changedCount: null })), {});
  assert.deepEqual(backendCodeFreshnessDecisionStamp(() => ({ state: 'stale', changedCount: null })), {});
  assert.deepEqual(backendCodeFreshnessDecisionStamp(() => { throw new Error('no detector in this process'); }), {});
  assert.deepEqual(backendCodeFreshnessDecisionStamp(undefined) instanceof Object, true);
}

{
  const decision = {
    kind: 'observe_ready',
    reason: 'idle_has_work',
    ...backendCodeFreshnessDecisionStamp(() => ({ state: 'stale', changedCount: 5 })),
  };
  const summary = describeWorkspaceWatcherDecision(decision);
  assert.match(summary, /backend changed since start \(5 file\(s\)\), restart may be required/);
  assert.doesNotMatch(summary, /restart is required/);
  // An unstamped decision says nothing about the backend.
  assert.doesNotMatch(describeWorkspaceWatcherDecision({ kind: 'idle_no_work', reason: 'no_ready_work' }), /backend/);

  // The durable decision log keeps the stamp (count only) through normalization.
  const stored = normalizeWorkspaceWatcherDecision({
    at: '2026-10-10T10:00:00.000Z',
    kind: 'observe_ready',
    reason: 'idle_has_work',
    ...decision,
  });
  assert.equal(stored.backendCodeStale, true);
  assert.equal(stored.backendCodeChangedFiles, 5);
  const unstamped = normalizeWorkspaceWatcherDecision({
    at: '2026-10-10T10:00:00.000Z',
    kind: 'idle_no_work',
    reason: 'no_ready_work',
    backendCodeStale: false,
    backendCodeChangedFiles: 0,
  });
  assert.equal('backendCodeStale' in unstamped, false);
  assert.equal('backendCodeChangedFiles' in unstamped, false);

  // The "Why?" table renders the same honest wording.
  const reasonText = formatWatcherDecisionReasonText(stored);
  assert.match(reasonText, /backend changed since start \(5 file\(s\)\), restart may be required/);
  assert.match(formatWatcherDecisionReasonText(unstamped), /^no_ready_work$/);
}

// ---------------------------------------------------------------------------
// The UI marker is hidden by default in the shipped markup and uses no literal
// Polish in the component.

{
  const html = await readFileText('public/index.html');
  assert.match(html, /id="connection-status-backend-row" hidden/);
  assert.match(html, /<dt data-i18n="connectionStatus\.backend">/);
  const panelSource = await readFileText('app_front/features/connection/views/connectionStatusPanel.js');
  assert.doesNotMatch(panelSource, /Zmieniony od startu|możliwy wymagany restart/);
}

console.log('server-code-freshness-api.test.js: ok');
