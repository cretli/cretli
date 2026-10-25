/**
 * External benchmark sources: registry, snapshot store, routes and model_pick isolation.
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
import { pickModelForPurpose } from '../lib/model-pick-service.js';
import {
  BENCHMARK_SNAPSHOT_MAX_BYTES,
  BENCHMARK_SNAPSHOT_MAX_ENTRIES,
  BENCHMARK_TERMS_MAX_BYTES,
  classifyBenchmarkEntryMapping,
  validateImportableSnapshot,
} from '../lib/benchmark-snapshot.js';
import {
  BENCHMARK_SNAPSHOTS_HISTORY_PER_SOURCE,
  importBenchmarkSnapshot,
  pickLatestTermsVerification,
  readBenchmarkSnapshots,
  resolveBenchmarkSnapshotsPath,
  resetBenchmarkSnapshotsStore,
  writeBenchmarkTermsVerification,
} from '../lib/persist/benchmark-snapshots-persist.js';
import {
  buildHarnessBenchmarkSourcesViewModel,
  renderHarnessBenchmarkSourcesHtml,
} from '../app_front/features/harness-health/harnessBenchmarkSourcesModel.js';
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
let benchmarkFile;
/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let baseUrl;
/** @type {string} */
let sessionToken;
/** @type {string} */
let csrfToken;

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function exampleIndexTerms(overrides = {}) {
  return {
    sourceId: 'example-index',
    officialTermsUrl: 'https://example.com/benchmark-api/terms',
    scopeOfConsent: 'manual import only for operator display',
    version: '2026-01',
    verifiedAt: new Date().toISOString(),
    costAcknowledged: true,
    redistributionAllowed: true,
    attributionRequired: true,
    ...overrides,
  };
}

/**
 * @param {string} method
 * @param {string} url
 * @param {{ body?: object, headers?: Record<string, string> }} [options]
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
 */
function authHeaders(options = {}) {
  const headers = { cookie: `cr_session=${encodeURIComponent(sessionToken)}` };
  if (options.csrf !== false) headers[AUTH_CSRF_HEADER] = csrfToken;
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;
  return headers;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-benchmark-'));
  roleFile = path.join(dir, 'model-role-profiles.json');
  overridesFile = path.join(dir, 'model-pick-overrides.json');
  benchmarkFile = path.join(dir, 'benchmark-snapshots.json');
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
    benchmarkSnapshotsFile: benchmarkFile,
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
  fs.rmSync(benchmarkFile, { force: true });
});

test('ambiguous mapping rows are classified as unmapped', () => {
  const mapped = classifyBenchmarkEntryMapping({ releaseTier: 2, mappingDimension: 'release' });
  assert.equal(mapped.dimension, 'release');
  const ambiguous = classifyBenchmarkEntryMapping({ releaseTier: 2, baseScore: 0.5 });
  assert.equal(ambiguous.dimension, 'unmapped');
});

test('real snapshot import is blocked without terms verification', () => {
  assert.throws(
    () => validateImportableSnapshot({
      sourceId: 'example-index',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/x', releaseTier: 1 }] },
    }, null),
    (err) => err && err.code === 'terms_unverified',
  );
});

test('body kind fixture cannot bypass terms on a real registry source', () => {
  assert.throws(
    () => validateImportableSnapshot({
      kind: 'fixture',
      sourceId: 'example-index',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/x', releaseTier: 1 }] },
    }, null),
    (err) => err && err.code === 'terms_unverified',
  );
  const terms = exampleIndexTerms();
  const validated = validateImportableSnapshot({
    kind: 'fixture',
    sourceId: 'example-index',
    capturedAt: new Date().toISOString(),
    payload: { entries: [{ modelKey: 'example/x', releaseTier: 1, mappingDimension: 'release' }] },
  }, terms);
  assert.equal(validated.kind, 'real');
});

test('fixture import succeeds without terms and persist keeps failed real import', () => {
  const fixture = importBenchmarkSnapshot({
    filePath: benchmarkFile,
    importBody: {
      sourceId: 'local-fixture',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/a', releaseTier: 1, mappingDimension: 'release' }] },
    },
    ifMatch: readBenchmarkSnapshots({ filePath: benchmarkFile }).etag,
  });
  assert.equal(fixture.ok, true);
  assert.equal(fixture.snapshot?.kind, 'fixture');
  const beforeCount = readBenchmarkSnapshots({ filePath: benchmarkFile }).snapshots.length;
  const blocked = importBenchmarkSnapshot({
    filePath: benchmarkFile,
    importBody: {
      sourceId: 'example-index',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/b', baseScore: 0.1, mappingDimension: 'base' }] },
    },
    ifMatch: readBenchmarkSnapshots({ filePath: benchmarkFile }).etag,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'terms_unverified');
  const after = readBenchmarkSnapshots({ filePath: benchmarkFile });
  assert.equal(after.snapshots.length, beforeCount);
});

test('terms verification gates import: url, version, flags, expiry', () => {
  const base = exampleIndexTerms();
  const capturedAt = new Date().toISOString();
  const payload = { entries: [{ modelKey: 'example/x', releaseTier: 1, mappingDimension: 'release' }] };
  assert.throws(
    () => validateImportableSnapshot({ sourceId: 'example-index', capturedAt, payload }, exampleIndexTerms({ officialTermsUrl: 'https://evil.example/terms' })),
    (err) => err && err.code === 'terms_url_mismatch',
  );
  assert.throws(
    () => validateImportableSnapshot({ sourceId: 'example-index', capturedAt, payload }, exampleIndexTerms({ version: '' })),
    (err) => err && err.code === 'terms_invalid',
  );
  assert.throws(
    () => validateImportableSnapshot({ sourceId: 'example-index', capturedAt, payload }, exampleIndexTerms({ redistributionAllowed: false })),
    (err) => err && err.code === 'terms_redistribution_denied',
  );
  assert.throws(
    () => validateImportableSnapshot({ sourceId: 'example-index', capturedAt, payload }, exampleIndexTerms({ costAcknowledged: false })),
    (err) => err && err.code === 'terms_cost_unacknowledged',
  );
  const expiredAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  assert.throws(
    () => validateImportableSnapshot(
      { sourceId: 'example-index', capturedAt, payload },
      exampleIndexTerms({ verifiedAt: expiredAt, freshnessPolicyDays: 30 }),
      { now: Date.now() },
    ),
    (err) => err && err.code === 'terms_expired',
  );
});

test('terms verification then real import succeeds; stale freshness is visible', () => {
  const etag0 = readBenchmarkSnapshots({ filePath: benchmarkFile }).etag;
  const terms = writeBenchmarkTermsVerification({
    filePath: benchmarkFile,
    ifMatch: etag0,
    verification: exampleIndexTerms(),
  });
  assert.equal(terms.ok, true);
  const oldCapture = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const imported = importBenchmarkSnapshot({
    filePath: benchmarkFile,
    ifMatch: terms.etag,
    importBody: {
      sourceId: 'example-index',
      capturedAt: oldCapture,
      payload: { entries: [{ modelKey: 'example/stale', effortHint: 'high', mappingDimension: 'effort' }] },
    },
  });
  assert.equal(imported.ok, true);
  const snap = readBenchmarkSnapshots({ filePath: benchmarkFile }).snapshots.slice(-1)[0];
  assert.equal(snap.freshness.stale, true);
});

test('future capturedAt is rejected', () => {
  const etag0 = readBenchmarkSnapshots({ filePath: benchmarkFile }).etag;
  const terms = writeBenchmarkTermsVerification({
    filePath: benchmarkFile,
    ifMatch: etag0,
    verification: exampleIndexTerms(),
  });
  assert.equal(terms.ok, true);
  const future = new Date(Date.now() + 60_000).toISOString();
  const blocked = importBenchmarkSnapshot({
    filePath: benchmarkFile,
    ifMatch: terms.etag,
    importBody: {
      sourceId: 'example-index',
      capturedAt: future,
      payload: { entries: [{ modelKey: 'example/future', releaseTier: 1, mappingDimension: 'release' }] },
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'captured_at_future');
});

test('GET benchmark sources requires auth; writes need CSRF and If-Match', async () => {
  const anonymous = await request('GET', '/api/harness-benchmark-sources');
  assert.equal(anonymous.status, 401);
  const res = await request('GET', '/api/harness-benchmark-sources', { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.sources));
  const noMatch = await request('PUT', '/api/harness-benchmark-sources/import', {
    headers: authHeaders(),
    body: { sourceId: 'local-fixture', capturedAt: new Date().toISOString(), payload: { entries: [] } },
  });
  assert.equal(noMatch.status, 428);
  const etag = res.body.etag;
  const noCsrf = await request('PUT', '/api/harness-benchmark-sources/import', {
    headers: authHeaders({ csrf: false, ifMatch: etag }),
    body: {
      sourceId: 'local-fixture',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/x', releaseTier: 1, mappingDimension: 'release' }] },
    },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.body.csrfRequired, true);
});

test('stale If-Match on import returns 409', async () => {
  const current = await request('GET', '/api/harness-benchmark-sources', { headers: authHeaders() });
  const stale = await request('PUT', '/api/harness-benchmark-sources/import', {
    headers: authHeaders({ ifMatch: 'deadbeef' }),
    body: {
      sourceId: 'local-fixture',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/x', releaseTier: 1, mappingDimension: 'release' }] },
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.ok(current.body.etag);
});

test('source and reset routes enforce If-Match, backup, and deny widget/MCP', async () => {
  fs.writeFileSync(benchmarkFile, JSON.stringify({
    version: 1,
    sourcePreferences: {},
    termsVerifications: [],
    snapshots: [],
    legacyMarker: true,
  }), 'utf8');
  const current = await request('GET', '/api/harness-benchmark-sources', { headers: authHeaders() });
  assert.equal(current.status, 200);
  assert.deepEqual(current.body.unknownTopLevelKeys, ['legacyMarker']);
  const noMatchSource = await request('PUT', '/api/harness-benchmark-sources/source', {
    headers: authHeaders(),
    body: { sourceId: 'example-index', enabled: true },
  });
  assert.equal(noMatchSource.status, 428);
  const staleSource = await request('PUT', '/api/harness-benchmark-sources/source', {
    headers: authHeaders({ ifMatch: 'deadbeef' }),
    body: { sourceId: 'example-index', enabled: true },
  });
  assert.equal(staleSource.status, 409);
  const enabled = await request('PUT', '/api/harness-benchmark-sources/source', {
    headers: authHeaders({ ifMatch: current.body.etag }),
    body: { sourceId: 'example-index', enabled: true },
  });
  assert.equal(enabled.status, 200);
  const afterSource = await request('GET', '/api/harness-benchmark-sources', { headers: authHeaders() });
  const noMatchReset = await request('POST', '/api/harness-benchmark-sources/reset', { headers: authHeaders() });
  assert.equal(noMatchReset.status, 428);
  const reset = await request('POST', '/api/harness-benchmark-sources/reset', {
    headers: authHeaders({ ifMatch: afterSource.body.etag }),
  });
  assert.equal(reset.status, 200);
  assert.ok(reset.body.backupPath);
  assert.ok(fs.existsSync(reset.body.backupPath));
  const routes = new Map();
  const app = {
    get(p, h) { routes.set(`GET ${p}`, h); },
    put(p, h) { routes.set(`PUT ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
  };
  registerHarnessModelRoleConfigRoutes(app, { benchmarkSnapshotsFile: benchmarkFile });
  /** @param {string} key @param {object} req */
  const invoke = async (key, req) => {
    let statusCode = null;
    const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
    await routes.get(key)(req, res);
    return statusCode;
  };
  for (const key of [
    'GET /api/harness-benchmark-sources',
    'PUT /api/harness-benchmark-sources/import',
    'PUT /api/harness-benchmark-sources/terms',
    'PUT /api/harness-benchmark-sources/source',
    'POST /api/harness-benchmark-sources/reset',
  ]) {
    assert.equal(await invoke(key, { widgetAccess: true, headers: {} }), 403, key);
    assert.equal(await invoke(key, { mcpIntegration: true, headers: {} }), 403, key);
  }
});

test('oversize terms, snapshot payload, and schema errors via HTTP', async () => {
  const etag0 = (await request('GET', '/api/harness-benchmark-sources', { headers: authHeaders() })).body.etag;
  const hugeScope = 'x'.repeat(BENCHMARK_TERMS_MAX_BYTES);
  const bigTerms = await request('PUT', '/api/harness-benchmark-sources/terms', {
    headers: authHeaders({ ifMatch: etag0 }),
    body: exampleIndexTerms({ scopeOfConsent: hugeScope }),
  });
  assert.equal(bigTerms.status, 400);
  const termsOk = await request('PUT', '/api/harness-benchmark-sources/terms', {
    headers: authHeaders({ ifMatch: etag0 }),
    body: exampleIndexTerms(),
  });
  assert.equal(termsOk.status, 200);
  const tooMany = Array.from({ length: BENCHMARK_SNAPSHOT_MAX_ENTRIES + 1 }, (_, i) => ({
    modelKey: `example/m-${i}`,
    releaseTier: 1,
    mappingDimension: 'release',
  }));
  const manyRows = await request('PUT', '/api/harness-benchmark-sources/import', {
    headers: authHeaders({ ifMatch: termsOk.body.etag }),
    body: {
      sourceId: 'example-index',
      capturedAt: new Date().toISOString(),
      payload: { entries: tooMany },
    },
  });
  assert.equal(manyRows.status, 400);
  assert.equal(manyRows.body.code, 'size_exceeded');
  const pad = 'z'.repeat(BENCHMARK_SNAPSHOT_MAX_BYTES);
  const hugeImport = importBenchmarkSnapshot({
    filePath: benchmarkFile,
    ifMatch: termsOk.body.etag,
    importBody: {
      sourceId: 'example-index',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/big', releaseTier: 1, mappingDimension: 'release', pad }] },
    },
  });
  assert.equal(hugeImport.ok, false);
  assert.equal(hugeImport.code, 'size_exceeded');
  const badSchema = await request('PUT', '/api/harness-benchmark-sources/import', {
    headers: authHeaders({ ifMatch: termsOk.body.etag }),
    body: {
      sourceId: 'example-index',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ releaseTier: 1 }] },
    },
  });
  assert.equal(badSchema.status, 400);
  assert.equal(badSchema.body.code, 'schema_invalid');
});

test('non-array snapshots field marks store invalid and refuses writes', () => {
  fs.writeFileSync(benchmarkFile, JSON.stringify({
    version: 1,
    sourcePreferences: {},
    termsVerifications: [],
    snapshots: {},
  }), 'utf8');
  const read = readBenchmarkSnapshots({ filePath: benchmarkFile });
  assert.equal(read.state, 'invalid');
  const blocked = importBenchmarkSnapshot({
    filePath: benchmarkFile,
    ifMatch: read.etag,
    importBody: {
      sourceId: 'local-fixture',
      capturedAt: new Date().toISOString(),
      payload: { entries: [{ modelKey: 'example/x', releaseTier: 1, mappingDimension: 'release' }] },
    },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.state, 'invalid');
});

test('history trim keeps newest valid snapshots and never drops the last valid one', () => {
  let etag = readBenchmarkSnapshots({ filePath: benchmarkFile }).etag;
  const terms = writeBenchmarkTermsVerification({
    filePath: benchmarkFile,
    ifMatch: etag,
    verification: exampleIndexTerms(),
  });
  assert.equal(terms.ok, true);
  etag = terms.etag;
  const total = BENCHMARK_SNAPSHOTS_HISTORY_PER_SOURCE + 3;
  for (let i = 0; i < total; i += 1) {
    const now = Date.now() + i * 1000;
    const result = importBenchmarkSnapshot({
      filePath: benchmarkFile,
      ifMatch: etag,
      now,
      generateId: () => `snap-${i}`,
      importBody: {
        sourceId: 'example-index',
        capturedAt: new Date(now - 1000).toISOString(),
        payload: { entries: [{ modelKey: `example/m-${i}`, releaseTier: 1, mappingDimension: 'release' }] },
      },
    });
    assert.equal(result.ok, true);
    etag = result.etag;
  }
  const rows = readBenchmarkSnapshots({ filePath: benchmarkFile }).snapshots.filter((row) => row.sourceId === 'example-index');
  assert.equal(rows.length, BENCHMARK_SNAPSHOTS_HISTORY_PER_SOURCE);
  const ids = rows.map((row) => row.id).sort();
  assert.ok(ids.includes(`snap-${total - 1}`));
  assert.ok(!ids.includes('snap-0'));
});

test('public payload and pickLatestTermsVerification agree on the latest terms row', async () => {
  let etag = readBenchmarkSnapshots({ filePath: benchmarkFile }).etag;
  const first = writeBenchmarkTermsVerification({
    filePath: benchmarkFile,
    ifMatch: etag,
    verification: exampleIndexTerms({ version: 'v1', scopeOfConsent: 'first consent record here' }),
  });
  assert.equal(first.ok, true);
  etag = first.etag;
  const second = writeBenchmarkTermsVerification({
    filePath: benchmarkFile,
    ifMatch: etag,
    verification: exampleIndexTerms({ version: 'v2', scopeOfConsent: 'second consent record here' }),
  });
  assert.equal(second.ok, true);
  const snapshot = readBenchmarkSnapshots({ filePath: benchmarkFile });
  const picked = pickLatestTermsVerification('example-index', snapshot.termsVerifications);
  assert.equal(picked?.version, 'v2');
  const api = await request('GET', '/api/harness-benchmark-sources', { headers: authHeaders() });
  const source = api.body.sources.find((row) => row.id === 'example-index');
  assert.equal(source?.termsVerification?.version, 'v2');
});

test('widget and MCP callers are denied on benchmark routes', async () => {
  const routes = new Map();
  const app = {
    get(p, h) { routes.set(`GET ${p}`, h); },
    put(p, h) { routes.set(`PUT ${p}`, h); },
    post(p, h) { routes.set(`POST ${p}`, h); },
  };
  registerHarnessModelRoleConfigRoutes(app, { benchmarkSnapshotsFile: benchmarkFile });
  /** @param {string} key @param {object} req */
  const invoke = async (key, req) => {
    let statusCode = null;
    const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
    await routes.get(key)(req, res);
    return statusCode;
  };
  for (const key of [
    'GET /api/harness-benchmark-sources',
    'PUT /api/harness-benchmark-sources/import',
    'PUT /api/harness-benchmark-sources/terms',
  ]) {
    assert.equal(await invoke(key, { widgetAccess: true, headers: {} }), 403, key);
    assert.equal(await invoke(key, { mcpIntegration: true, headers: {} }), 403, key);
  }
});

test('model_pick result is identical with and without benchmark snapshots on disk', async () => {
  const harnesses = [
    { id: 'codex', enabled: true, ready: true, can_delegate: true },
  ];
  const modelsByHarness = {
    codex: {
      favorites_configured: true,
      items: [
        { id: 'gpt-test', roles: ['implement'], cost_tier: 2, quality_tier: 4, speed_tier: 3 },
        { id: 'gpt-alt', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 4 },
      ],
    },
  };
  const { buildModelPickHistory } = await import('../lib/model-pick-history.js');
  const history = buildModelPickHistory({ role: 'implement', harnesses, delegations: [], now: Date.now(), lockouts: [], planLimits: [] });
  const base = { role: 'implement', harnesses, modelsByHarness, rotation: { mode: 'off' }, explore: false, history };
  const without = pickModelForPurpose(base);
  const defaultPath = resolveBenchmarkSnapshotsPath();
  importBenchmarkSnapshot({
    filePath: defaultPath,
    ifMatch: readBenchmarkSnapshots({ filePath: defaultPath }).etag,
    importBody: {
      sourceId: 'local-fixture',
      capturedAt: new Date().toISOString(),
      payload: {
        entries: [
          { modelKey: 'codex/gpt-test', releaseTier: 99, mappingDimension: 'release' },
          { modelKey: 'codex/gpt-alt', releaseTier: 1, mappingDimension: 'release' },
        ],
      },
    },
  });
  assert.ok(readBenchmarkSnapshots({ filePath: defaultPath }).snapshots.length >= 1);
  const withSnapshots = pickModelForPurpose(base);
  assert.deepEqual(withSnapshots.pick, without.pick);
  assert.deepEqual(withSnapshots.picks, without.picks);
});

test('UI render and import path perform zero outbound fetch', () => {
  const payload = {
    ok: true,
    state: 'missing',
    etag: 'abc',
    localMode: { fetchEnabled: false, outgoingMetadata: 'none' },
    sources: [{
      id: 'local-fixture',
      provider: 'Fixture',
      officialTermsUrl: 'https://example.com/terms',
      endpointPurpose: 'test',
      enabled: true,
      health: 'unknown',
      outgoingMetadata: 'none',
      keyRequired: false,
      pricingNote: 'free',
      cacheTtlMs: 0,
      termsVerification: null,
      latestSnapshot: null,
    }],
    unknownTopLevelKeys: [],
  };
  const t = (key, values = {}) => String(key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network forbidden in benchmark UI/import tests');
  };
  try {
    const model = buildHarnessBenchmarkSourcesViewModel(payload, t);
    const html = renderHarnessBenchmarkSourcesHtml(model, t);
    assert.match(html, /local-fixture/);
    assert.match(html, /cr-bar-button/);
    importBenchmarkSnapshot({
      filePath: benchmarkFile,
      ifMatch: readBenchmarkSnapshots({ filePath: benchmarkFile }).etag,
      importBody: {
        sourceId: 'local-fixture',
        capturedAt: new Date().toISOString(),
        payload: { entries: [{ modelKey: 'example/z', releaseTier: 2, mappingDimension: 'release' }] },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test('invalid store state is rendered in the benchmark UI model', () => {
  const payload = {
    ok: true,
    state: 'invalid',
    error: 'snapshots must be an array when present',
    etag: 'x',
    localMode: { fetchEnabled: false, outgoingMetadata: 'none' },
    sources: [],
    unknownTopLevelKeys: [],
  };
  const t = (key) => key;
  const html = renderHarnessBenchmarkSourcesHtml(buildHarnessBenchmarkSourcesViewModel(payload, t), t);
  assert.match(html, /harness-benchmark-store-invalid/);
  assert.match(html, /data-tone="error"/);
});

test('Artificial Analysis UI gates fetching on configuration and keeps unsupported sources informational', () => {
  const translate = (key) => key;
  const payload = {
    apiKeys: { 'artificial-analysis': { configured: false } },
    sources: [{ id: 'artificial-analysis', enabled: false }, { id: 'arena-ai' }],
  };
  const render = () => renderHarnessBenchmarkSourcesHtml(buildHarnessBenchmarkSourcesViewModel(payload, translate), translate);
  assert.match(render(), /data-benchmark-action="fetch" disabled/);
  assert.match(render(), /type="password"/);
  assert.match(render(), /harnessBenchmarkSources.unsupported/);
  assert.equal((render().match(/data-benchmark-action="toggle"/g) || []).length, 1);
  payload.sources[0].enabled = true;
  payload.apiKeys['artificial-analysis'].configured = true;
  assert.doesNotMatch(render(), /data-benchmark-action="fetch" disabled/);
  assert.doesNotMatch(render(), /benchmark-redistribution|benchmark-cost|benchmark-version|benchmark-scope/);
  assert.match(render(), /data-benchmark-action="test"/);
  payload.sources[0].termsVerification = { version: '2026-10', scopeOfConsent: 'Display API results' };
  assert.doesNotMatch(render(), /data-benchmark-action="fetch" disabled/);
  assert.doesNotMatch(render(), /value="2026-10"/);
});
