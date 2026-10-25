/**
 * Harness npm update checks (read-only, snapshot + optional registry fetch).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  UPDATE_CACHE_TTL_MS,
  UPDATE_STATUS_FILE_NAME,
  classifyUpdateMode,
  compareSemver,
  getHarnessVersionInventoryWithUpdates,
  isPinnedPrereleaseSpec,
  isUpdateBackoffActive,
  isUpdateCacheFresh,
  mergeUpdatesIntoInventory,
  pickLatestMatchingVersion,
  readHarnessUpdateStatusSync,
  refreshHarnessUpdateStatus,
  resolveUpdateChannel,
  satisfiesDeclaredSpec,
  withHarnessUpdateStoreLock,
} from '../lib/harness-updates.js';
import { runHarnessUpdateCheckSweep } from '../lib/harness-updates-worker.js';
import { registerHarnessVersionsRoutes } from '../lib/routes/harness-versions-routes.js';
import { createSession, requireAuth, setPassword } from '../lib/auth.js';

setPassword('test-password-123');

const statusPath = path.join(ISOLATED_DATA_DIR, UPDATE_STATUS_FILE_NAME);

/**
 * @param {Record<string, string>} versionsByPackage
 * @returns {typeof fetch}
 */
function mockRegistryFetch(packuments) {
  return async (url) => {
    const name = decodeURIComponent(String(url).split('/').pop() || '');
    const spec = packuments[name];
    if (!spec) {
      return { ok: false, status: 404, async json() { return {}; } };
    }
    const versionList = Array.isArray(spec.versions)
      ? spec.versions
      : Object.keys(spec).filter((key) => key !== 'latest');
    const latest = spec.latest || versionList[versionList.length - 1] || '';
    return {
      ok: true,
      async json() {
        return {
          'dist-tags': { latest },
          versions: Object.fromEntries(versionList.map((v) => [v, { version: v }])),
        };
      },
    };
  };
}

test('semver helpers: in-range npm-update vs manifest-bump', () => {
  assert.ok(satisfiesDeclaredSpec('1.0.40', '^1.0.0'));
  assert.ok(!satisfiesDeclaredSpec('2.0.0', '^1.0.0'));
  assert.equal(classifyUpdateMode('1.0.37', '1.0.40', '^1.0.0', 'sdk'), 'npm-update');
  assert.equal(classifyUpdateMode('1.0.37', '2.0.0', '^1.0.0', 'sdk'), 'manifest-bump');
  assert.equal(classifyUpdateMode('0.1.2-alpha.5', '0.1.2-alpha.6', '0.1.2-alpha.5', 'deepseek'), 'manifest-bump');
  assert.ok(isPinnedPrereleaseSpec('0.1.2-alpha.5'));
  assert.equal(classifyUpdateMode('0.3.284', '0.3.300', '^0.3.0', 'claude'), 'manifest-bump');
  assert.equal(classifyUpdateMode('1.0.37', '1.0.37', '^1.0.0', 'sdk'), 'current');
  assert.ok(compareSemver('1.0.40', '1.0.37') > 0);
});

test('channel selection and latest pick respects stable vs prerelease', () => {
  const versions = ['1.0.0', '1.0.5', '1.1.0-beta.1'];
  assert.equal(resolveUpdateChannel('1.0.0', '^1.0.0', 'sdk'), 'stable');
  assert.equal(resolveUpdateChannel('0.1.2-alpha.5', '0.1.2-alpha.5', 'deepseek'), 'prerelease');
  assert.equal(pickLatestMatchingVersion(versions, '^1.0.0', 'stable'), '1.0.5');
  assert.equal(pickLatestMatchingVersion(versions, '^1.0.0', 'prerelease'), '1.1.0-beta.1');
});

test('snapshot read without check=1 never calls fetch', async () => {
  let fetchCalls = 0;
  const inventory = async () => ({
    checkedAt: '2026-10-08T00:00:00.000Z',
    harnesses: [{
      harness: 'sdk',
      packages: [{
        name: '@cursor/sdk',
        installed: '1.0.37',
        declaredSpec: '^1.0.0',
        canUpdate: true,
        status: 'managed',
      }],
    }],
  });
  const result = await getHarnessVersionInventoryWithUpdates({
    inventory,
    statusPath,
    check: false,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('network forbidden');
    },
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.harnesses[0].packages[0].latest, undefined);
});

test('check=1 persists update snapshot and merges fields', async () => {
  if (fs.existsSync(statusPath)) fs.rmSync(statusPath);
  const inventory = async () => ({
    checkedAt: '2026-10-08T00:00:00.000Z',
    harnesses: [{
      harness: 'sdk',
      packages: [{
        name: '@cursor/sdk',
        installed: '1.0.37',
        declaredSpec: '^1.0.0',
        canUpdate: true,
        status: 'managed',
      }],
    }],
  });
  const now = () => 1_700_000_000_000;
  const result = await getHarnessVersionInventoryWithUpdates({
    inventory,
    statusPath,
    check: true,
    now,
    fetchImpl: mockRegistryFetch({
      '@cursor/sdk': { versions: ['1.0.37', '1.0.40'], latest: '1.0.40' },
    }),
  });
  const pkg = result.harnesses[0].packages[0];
  assert.equal(pkg.latest, '1.0.40');
  assert.equal(pkg.mode, 'npm-update');
  assert.equal(pkg.behind, true);
  assert.equal(pkg.channel, 'stable');
  assert.equal(fs.existsSync(statusPath), true);
  const stored = readHarnessUpdateStatusSync({ statusPath });
  assert.equal(stored.packages['@cursor/sdk'].latest, '1.0.40');
});

test('cache TTL serves snapshot without refetch when not forced', async () => {
  const checkedAtMs = 1_700_000_000_000;
  const doc = {
    schemaVersion: 1,
    checkedAt: new Date(checkedAtMs).toISOString(),
    cacheExpiresAt: new Date(checkedAtMs + UPDATE_CACHE_TTL_MS).toISOString(),
    packages: {
      '@cursor/sdk': {
        installed: '1.0.37',
        latest: '1.0.40',
        mode: 'npm-update',
        behind: true,
        channel: 'stable',
        error: null,
      },
    },
    lastError: null,
    nextAttemptAfter: null,
  };
  await withHarnessUpdateStoreLock(() => {
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  });
  let fetchCalls = 0;
  const inventory = { harnesses: [{ harness: 'sdk', packages: [{ name: '@cursor/sdk', installed: '1.0.37', declaredSpec: '^1.0.0', canUpdate: true, status: 'managed' }] }] };
  const refreshed = await refreshHarnessUpdateStatus(inventory, {
    statusPath,
    now: () => checkedAtMs + 1000,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('should not fetch');
    },
  });
  assert.equal(fetchCalls, 0);
  assert.equal(refreshed.fromCache, true);
});

test('rejected fetch and timeout do not throw refresh', async () => {
  const inventory = {
    harnesses: [{
      harness: 'sdk',
      packages: [{
        name: '@cursor/sdk',
        installed: '1.0.37',
        declaredSpec: '^1.0.0',
        canUpdate: true,
        status: 'managed',
      }],
    }],
  };
  const fail = await refreshHarnessUpdateStatus(inventory, {
    statusPath: path.join(ISOLATED_DATA_DIR, 'harness-update-status-fail.json'),
    force: true,
    now: () => 1_700_000_100_000,
    fetchImpl: () => Promise.reject(new Error('offline')),
  });
  assert.equal(fail.doc.packages['@cursor/sdk'].error, 'offline');
  const slow = await refreshHarnessUpdateStatus(inventory, {
    statusPath: path.join(ISOLATED_DATA_DIR, 'harness-update-status-timeout.json'),
    force: true,
    now: () => 1_700_000_200_000,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    timeoutMs: 5,
  });
  assert.ok(slow.doc.packages['@cursor/sdk'].error);
});

test('single-flight: concurrent refresh shares one in-flight promise', async () => {
  let resolves = 0;
  const inventory = {
    harnesses: [{
      harness: 'sdk',
      packages: [{
        name: '@cursor/sdk',
        installed: '1.0.0',
        declaredSpec: '^1.0.0',
        canUpdate: true,
        status: 'managed',
      }],
    }],
  };
  const fetchImpl = async () => {
    resolves += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return mockRegistryFetch({ '@cursor/sdk': { versions: ['1.0.2'], latest: '1.0.2' } })('https://registry.npmjs.org/@cursor%2Fsdk');
  };
  const pathSingle = path.join(ISOLATED_DATA_DIR, 'harness-update-status-single.json');
  const a = refreshHarnessUpdateStatus(inventory, { statusPath: pathSingle, force: true, fetchImpl, now: () => 1_700_001_000_000 });
  const b = refreshHarnessUpdateStatus(inventory, { statusPath: pathSingle, force: true, fetchImpl, now: () => 1_700_001_000_000 });
  await Promise.all([a, b]);
  assert.equal(resolves, 1);
});

test('worker sweep skips when setting disabled', async () => {
  let fetchCalls = 0;
  const result = await runHarnessUpdateCheckSweep({
    settings: { harnessUpdateCheck: { enabled: false } },
    statusPath,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('forbidden');
    },
  });
  assert.equal(result?.skipped, true);
  assert.equal(fetchCalls, 0);
});

test('mergeUpdatesIntoInventory attaches update fields only when snapshot exists', () => {
  const inventory = {
    harnesses: [{
      harness: 'sdk',
      packages: [{ name: '@cursor/sdk', installed: '1.0.37' }],
    }],
  };
  const merged = mergeUpdatesIntoInventory(inventory, {
    packages: {
      '@cursor/sdk': {
        installed: '1.0.37',
        latest: '1.0.40',
        mode: 'npm-update',
        behind: true,
        channel: 'stable',
        error: null,
      },
    },
  });
  assert.equal(merged.harnesses[0].packages[0].latest, '1.0.40');
  assert.equal(isUpdateCacheFresh({ cacheExpiresAt: new Date(Date.now() + 1000).toISOString() }, () => Date.now()), true);
});

test('GET /api/harness/versions?check=1 uses session auth and rejects widget callers', async () => {
  setPassword('test-password-123');
  const inventory = async (options) => {
    assert.equal(options.check, true);
    return {
      checkedAt: '2026-10-08T00:00:00.000Z',
      harnesses: [],
      updateCheckedAt: '2026-10-08T00:00:00.000Z',
    };
  };
  const app = express();
  app.use(requireAuth);
  registerHarnessVersionsRoutes(app, { inventory });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const sessionToken = createSession();
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/harness/versions?check=1`;
    const anonymous = await fetch(base);
    assert.equal(anonymous.status, 401);
    const ok = await fetch(base, { headers: { cookie: `cr_session=${encodeURIComponent(sessionToken)}` } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.updateCheckedAt, '2026-10-08T00:00:00.000Z');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const flag of ['widgetAccess', 'mcpIntegration']) {
    const blocked = express();
    blocked.use((req, _res, next) => {
      req[flag] = { installationId: 'x' };
      next();
    });
    registerHarnessVersionsRoutes(blocked, {
      inventory: async () => assert.fail('restricted'),
    });
    const restrictedServer = await new Promise((resolve) => {
      const listener = blocked.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${restrictedServer.address().port}/api/harness/versions?check=1`);
      assert.equal(res.status, 403, flag);
    } finally {
      await new Promise((resolve) => restrictedServer.close(resolve));
    }
  }
});

/** Fixed clock for the update detection/cache cases below. */
const UPDATE_CASE_NOW = 1_700_000_000_000;

/**
 * @param {string} slug
 * @returns {string}
 */
function updateCaseStatusPath(slug) {
  return path.join(ISOLATED_DATA_DIR, `harness-update-${slug}.json`);
}

/**
 * @param {{ harness: string, name: string, installed: string, declaredSpec: string }} spec
 * @returns {object}
 */
function singlePackageInventory(spec) {
  return {
    checkedAt: '2026-10-08T00:00:00.000Z',
    harnesses: [{
      harness: spec.harness,
      packages: [{
        name: spec.name,
        installed: spec.installed,
        declaredSpec: spec.declaredSpec,
        canUpdate: true,
        status: 'managed',
      }],
    }],
  };
}

/**
 * Runs one forced detection pass over a single mocked package.
 *
 * @param {{
 *   slug: string, harness: string, name: string, installed: string,
 *   declaredSpec: string, versions: string[], latest: string,
 * }} spec
 * @returns {Promise<object>}
 */
async function runDetectionCase(spec) {
  const result = await getHarnessVersionInventoryWithUpdates({
    inventory: async () => singlePackageInventory(spec),
    statusPath: updateCaseStatusPath(spec.slug),
    check: true,
    force: true,
    now: () => UPDATE_CASE_NOW,
    fetchImpl: mockRegistryFetch({ [spec.name]: { versions: spec.versions, latest: spec.latest } }),
  });
  return result.harnesses[0].packages[0];
}

test('detection sees a newer major outside the declared ^ range (manifest-bump)', async () => {
  const pkg = await runDetectionCase({
    slug: 'major-out-of-range',
    harness: 'sdk',
    name: '@cursor/sdk',
    installed: '1.0.37',
    declaredSpec: '^1.0.0',
    versions: ['1.0.37', '1.0.40', '2.0.0'],
    latest: '2.0.0',
  });
  assert.equal(pkg.latest, '2.0.0');
  assert.equal(pkg.mode, 'manifest-bump');
  assert.equal(pkg.behind, true);
  assert.equal(pkg.channel, 'stable');
});

test('detection sees the next prerelease of a pinned prerelease spec (manifest-bump)', async () => {
  const pkg = await runDetectionCase({
    slug: 'prerelease-pin',
    harness: 'deepseek',
    name: '@deepseek-ai/dsh',
    installed: '0.1.2-alpha.5',
    declaredSpec: '0.1.2-alpha.5',
    versions: ['0.1.2-alpha.5', '0.1.2-alpha.6'],
    latest: '0.1.2-alpha.6',
  });
  assert.equal(pkg.latest, '0.1.2-alpha.6');
  assert.equal(pkg.mode, 'manifest-bump');
  assert.equal(pkg.behind, true);
  assert.equal(pkg.channel, 'prerelease');
});

test('detection reports a newer Claude release as manifest-bump', async () => {
  const pkg = await runDetectionCase({
    slug: 'claude-exact',
    harness: 'claude',
    name: '@anthropic-ai/claude-agent-sdk',
    installed: '0.3.284',
    declaredSpec: '0.3.284',
    versions: ['0.3.284', '0.3.300'],
    latest: '0.3.300',
  });
  assert.equal(pkg.latest, '0.3.300');
  assert.equal(pkg.mode, 'manifest-bump');
  assert.equal(pkg.behind, true);
});

test('detection keeps an in-range release as npm-update', async () => {
  const pkg = await runDetectionCase({
    slug: 'in-range',
    harness: 'sdk',
    name: '@cursor/sdk',
    installed: '1.0.37',
    declaredSpec: '^1.0.0',
    versions: ['1.0.37', '1.0.40'],
    latest: '1.0.40',
  });
  assert.equal(pkg.latest, '1.0.40');
  assert.equal(pkg.mode, 'npm-update');
  assert.equal(pkg.behind, true);
});

test('check=1 respects a fresh cache; force=1 bypasses it', async () => {
  const cachePath = updateCaseStatusPath('check-vs-force');
  if (fs.existsSync(cachePath)) fs.rmSync(cachePath);
  const inventory = async () => singlePackageInventory({
    harness: 'sdk',
    name: '@cursor/sdk',
    installed: '1.0.37',
    declaredSpec: '^1.0.0',
  });
  let fetchCalls = 0;
  const countingFetch = async (url) => {
    fetchCalls += 1;
    return mockRegistryFetch({ '@cursor/sdk': { versions: ['1.0.37', '1.0.40'], latest: '1.0.40' } })(url);
  };
  await getHarnessVersionInventoryWithUpdates({
    inventory,
    statusPath: cachePath,
    check: true,
    now: () => UPDATE_CASE_NOW,
    fetchImpl: countingFetch,
  });
  assert.equal(fetchCalls, 1, 'first check fills the cache');
  const cached = await getHarnessVersionInventoryWithUpdates({
    inventory,
    statusPath: cachePath,
    check: true,
    now: () => UPDATE_CASE_NOW + 1000,
    fetchImpl: countingFetch,
  });
  assert.equal(fetchCalls, 1, 'fresh cache must not hit the network');
  assert.equal(cached.updateFromCache, true);
  assert.equal(cached.harnesses[0].packages[0].latest, '1.0.40');
  await getHarnessVersionInventoryWithUpdates({
    inventory,
    statusPath: cachePath,
    check: true,
    force: true,
    now: () => UPDATE_CASE_NOW + 2000,
    fetchImpl: countingFetch,
  });
  assert.equal(fetchCalls, 2, 'force=1 bypasses the cache');
});

test('registry failure trips the short backoff and expires the cache', async () => {
  const failurePath = updateCaseStatusPath('failure-backoff');
  if (fs.existsSync(failurePath)) fs.rmSync(failurePath);
  const inventory = singlePackageInventory({
    harness: 'sdk',
    name: '@cursor/sdk',
    installed: '1.0.37',
    declaredSpec: '^1.0.0',
  });
  const failed = await refreshHarnessUpdateStatus(inventory, {
    statusPath: failurePath,
    force: true,
    now: () => UPDATE_CASE_NOW,
    fetchImpl: () => Promise.reject(new Error('offline')),
  });
  assert.equal(failed.doc.packages['@cursor/sdk'].error, 'offline');
  assert.equal(failed.doc.lastError, 'offline');
  assert.ok(failed.doc.nextAttemptAfter);
  assert.equal(isUpdateCacheFresh(failed.doc, () => UPDATE_CASE_NOW), false);
  assert.equal(isUpdateBackoffActive(failed.doc, () => UPDATE_CASE_NOW), true);
  let retryCalls = 0;
  const blocked = await refreshHarnessUpdateStatus(inventory, {
    statusPath: failurePath,
    now: () => UPDATE_CASE_NOW + 1000,
    fetchImpl: async () => {
      retryCalls += 1;
      throw new Error('should not fetch');
    },
  });
  assert.equal(retryCalls, 0, 'backoff blocks a non-forced retry');
  assert.equal(blocked.fromCache, true);
  const httpFail = await refreshHarnessUpdateStatus(inventory, {
    statusPath: failurePath,
    force: true,
    now: () => UPDATE_CASE_NOW + 2000,
    fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }),
  });
  assert.equal(httpFail.doc.packages['@cursor/sdk'].error, 'registry_http_500');
  assert.ok(httpFail.doc.nextAttemptAfter);
  assert.equal(isUpdateCacheFresh(httpFail.doc, () => UPDATE_CASE_NOW + 2000), false);
});

test('GET /api/harness/versions parses check and force flags', async () => {
  const seen = [];
  const app = express();
  registerHarnessVersionsRoutes(app, {
    inventory: async (options) => {
      seen.push(options);
      return { checkedAt: '2026-10-08T00:00:00.000Z', harnesses: [] };
    },
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/harness/versions`;
    await fetch(`${base}?check=1`);
    await fetch(`${base}?check=1&force=1`);
    await fetch(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(seen, [
    { persist: true, check: true, force: false },
    { persist: true, check: true, force: true },
    { persist: true, check: false, force: false },
  ]);
});
