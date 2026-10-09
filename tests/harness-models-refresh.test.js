/**
 * Harness model refresh dispatcher + shared snapshot (no network, no real CLIs).
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import {
  SNAPSHOT_FILE_NAME,
  applyHarnessModelsSnapshotUpdate,
  readHarnessModelsSnapshot,
} from '../lib/harness-models-snapshot.js';
import { refreshHarnessModelsCatalog } from '../lib/harness-models-refresh.js';
import { registerHarnessModelsRefreshRoutes } from '../lib/routes/harness-models-refresh-routes.js';
import { listHarnessModels } from '../lib/harness-catalog.js';

const snapshotPath = path.join(ISOLATED_DATA_DIR, SNAPSHOT_FILE_NAME);

/**
 * @param {import('../model-catalog.js').ModelCatalogEntry[]} entries
 * @param {string} [modelsSource]
 * @returns {object}
 */
function fakeListed(entries, modelsSource = 'live') {
  return {
    catalog: entries,
    modelsSource,
    defaultModel: entries[0]?.value || 'model-a',
    models: entries.map((row) => ({ id: row.value, name: row.label })),
  };
}

test('refresh routes deepseek through injected list and persists snapshot', async () => {
  const liveEntry = {
    value: 'deepseek-live-only',
    label: 'DeepSeek Live Only',
    modelId: 'deepseek-live-only',
  };
  let listCalls = 0;
  const result = await refreshHarnessModelsCatalog('deepseek', {
    snapshotPath,
    async listDeepSeekModels() {
      listCalls += 1;
      return fakeListed([liveEntry]);
    },
  });
  assert.equal(listCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'live');
  assert.equal(result.stale, false);
  assert.equal(result.itemCount, 1);
  assert.equal(fs.existsSync(snapshotPath), true);
  const catalog = listHarnessModels({ harness: 'deepseek' });
  assert.ok(catalog.items.some((row) => row.id === 'deepseek-live-only'));
  assert.equal(catalog.source, 'live');
});

test('claude session source maps through dispatcher response', async () => {
  const entry = { value: 'claude-session-id', label: 'Session', modelId: 'claude-session-id' };
  const result = await refreshHarnessModelsCatalog('claude', {
    snapshotPath,
    async listClaudeModels() {
      return fakeListed([entry], 'session');
    },
  });
  assert.equal(result.source, 'session');
  assert.equal(result.stale, false);
  const listed = listHarnessModels({ harness: 'claude' });
  assert.equal(listed.source, 'session');
  assert.ok(listed.items.some((row) => row.id === 'claude-session-id'));
});

test('unknown harness returns validation error from refresh', async () => {
  await assert.rejects(
    () => refreshHarnessModelsCatalog('cursor-typo', { snapshotPath }),
    (err) => err.code === 'VALIDATION',
  );
});

test('opencode is explicitly not refreshable', async () => {
  await assert.rejects(
    () => refreshHarnessModelsCatalog('opencode', { snapshotPath }),
    (err) => err.code === 'NOT_REFRESHABLE',
  );
});

test('failed refresh keeps prior snapshot entries and marks stale', async () => {
  await applyHarnessModelsSnapshotUpdate('deepseek', {
    entries: [{ value: 'keep-me', label: 'Keep', modelId: 'keep-me' }],
    source: 'live',
    stale: false,
    lastAttemptAt: '2026-01-01T00:00:00.000Z',
    lastSuccessAt: '2026-01-01T00:00:00.000Z',
    warning: '',
    persistEntries: true,
  }, { snapshotPath });
  const result = await refreshHarnessModelsCatalog('deepseek', {
    snapshotPath,
    async listDeepSeekModels() {
      return fakeListed([], 'fallback');
    },
  });
  assert.equal(result.stale, true);
  assert.ok(result.warning.length > 0);
  const snap = readHarnessModelsSnapshot({ snapshotPath });
  assert.ok(snap.harnesses.deepseek.entries.some((row) => row.value === 'keep-me'));
  assert.equal(snap.harnesses.deepseek.stale, true);
});

test('concurrent refresh coalesces to one in-flight operation', async () => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entry = { value: 'claude-one', label: 'One', modelId: 'claude-one' };
  const p1 = refreshHarnessModelsCatalog('claude', {
    snapshotPath,
    async listClaudeModels() {
      started += 1;
      await gate;
      return fakeListed([entry], 'session');
    },
  });
  const p2 = refreshHarnessModelsCatalog('claude', { snapshotPath });
  assert.equal(started, 1);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.source, 'session');
  assert.deepEqual(a, b);
});

test('route rejects widget and MCP callers', async () => {
  for (const flag of ['widgetAccess', 'mcpIntegration']) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req[flag] = { installationId: 'fixture-id' };
      next();
    });
    registerHarnessModelsRefreshRoutes(app, {
      refresh: async () => assert.fail(`must not reach refresh for ${flag}`),
    });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/harness/models/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: 'deepseek' }),
      });
      assert.equal(res.status, 403, flag);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(typeof body.error, 'string');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('harness-catalog read performs no fetch and reflects snapshot', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network forbidden on catalog read');
  };
  try {
    await applyHarnessModelsSnapshotUpdate('deepseek', {
      entries: [{
        value: 'deepseek-from-snap',
        label: 'From Snap',
        modelId: 'deepseek-from-snap',
      }],
      source: 'live',
      stale: false,
      lastAttemptAt: '2026-03-01T00:00:00.000Z',
      lastSuccessAt: '2026-03-01T00:00:00.000Z',
      warning: '',
      persistEntries: true,
    }, { snapshotPath });
    const listed = listHarnessModels({ harness: 'deepseek' });
    assert.equal(fetchCalls, 0);
    assert.ok(listed.items.some((row) => row.id === 'deepseek-from-snap'));
    assert.equal(listed.source, 'live');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('codex refresh marks networkInference via dispatcher', async () => {
  const entry = { value: 'gpt-test', label: 'GPT Test', modelId: 'gpt-test' };
  const result = await refreshHarnessModelsCatalog('codex', {
    snapshotPath,
    async listCodexModels() {
      return { catalog: [entry], modelsSource: 'live' };
    },
  });
  assert.equal(result.networkInference, true);
  assert.equal(result.source, 'cache');
});

test('register-app-routes imports refresh routes', () => {
  const source = fs.readFileSync(new URL('../lib/register-app-routes.js', import.meta.url), 'utf8');
  assert.match(source, /registerHarnessModelsRefreshRoutes/);
});

test('successful refresh sets lastSuccessAt on result and snapshot', async () => {
  const entry = { value: 'ds-success-ts', label: 'TS', modelId: 'ds-success-ts' };
  const fixedMs = Date.parse('2026-07-01T12:00:00.000Z');
  const result = await refreshHarnessModelsCatalog('deepseek', {
    snapshotPath,
    now: () => fixedMs,
    async listDeepSeekModels() {
      return fakeListed([entry]);
    },
  });
  assert.equal(result.lastSuccessAt, '2026-07-01T12:00:00.000Z');
  const snap = readHarnessModelsSnapshot({ snapshotPath });
  assert.equal(snap.harnesses.deepseek.lastSuccessAt, '2026-07-01T12:00:00.000Z');
});

test('lister throw keeps prior entries and updates attempt metadata only', async () => {
  const priorSuccess = '2026-01-01T00:00:00.000Z';
  await applyHarnessModelsSnapshotUpdate('deepseek', {
    entries: [{ value: 'keep-on-throw', label: 'Keep', modelId: 'keep-on-throw' }],
    source: 'live',
    stale: false,
    lastAttemptAt: '2026-01-01T00:00:00.000Z',
    lastSuccessAt: priorSuccess,
    warning: '',
    persistEntries: true,
  }, { snapshotPath });
  const attemptMs = Date.parse('2026-06-01T00:00:00.000Z');
  await assert.rejects(
    () => refreshHarnessModelsCatalog('deepseek', {
      snapshotPath,
      now: () => attemptMs,
      async listDeepSeekModels() {
        throw new Error('network down');
      },
    }),
    (err) => err.message === 'network down',
  );
  const snap = readHarnessModelsSnapshot({ snapshotPath });
  assert.ok(snap.harnesses.deepseek.entries.some((row) => row.value === 'keep-on-throw'));
  assert.equal(snap.harnesses.deepseek.stale, true);
  assert.match(snap.harnesses.deepseek.warning, /network down/);
  assert.equal(snap.harnesses.deepseek.lastAttemptAt, '2026-06-01T00:00:00.000Z');
  assert.equal(snap.harnesses.deepseek.lastSuccessAt, priorSuccess);
});

test('in-flight entry cleared after lister failure so retry invokes lister again', async () => {
  const entry = { value: 'retry-ok', label: 'Retry', modelId: 'retry-ok' };
  let calls = 0;
  await assert.rejects(
    () => refreshHarnessModelsCatalog('deepseek', {
      snapshotPath,
      async listDeepSeekModels() {
        calls += 1;
        throw new Error('transient');
      },
    }),
  );
  assert.equal(calls, 1);
  const result = await refreshHarnessModelsCatalog('deepseek', {
    snapshotPath,
    async listDeepSeekModels() {
      calls += 1;
      return fakeListed([entry]);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test('qwen dispatcher calls injected list with refresh true', async () => {
  /** @type {object|undefined} */
  let listOptions;
  const entry = { value: 'qwen-m', label: 'Qwen', modelId: 'qwen-m' };
  const result = await refreshHarnessModelsCatalog('qwen', {
    snapshotPath,
    async listQwenModels(options) {
      listOptions = options;
      return fakeListed([entry]);
    },
  });
  assert.equal(listOptions?.refresh, true);
  assert.equal(result.source, 'live');
  assert.ok(result.stale === false);
});

test('codebuddy dispatcher calls injected list with refresh true', async () => {
  /** @type {object|undefined} */
  let listOptions;
  const entry = { value: 'cb-m', label: 'Buddy', modelId: 'cb-m' };
  const result = await refreshHarnessModelsCatalog('codebuddy', {
    snapshotPath,
    async listCodeBuddyModels(options) {
      listOptions = options;
      return fakeListed([entry]);
    },
  });
  assert.equal(listOptions?.refresh, true);
  assert.equal(result.source, 'live');
});

test('openrouter dispatcher calls injected list with refresh true', async () => {
  /** @type {object|undefined} */
  let listOptions;
  const entry = { value: 'or/m', label: 'OR', modelId: 'or/m' };
  const result = await refreshHarnessModelsCatalog('openrouter', {
    snapshotPath,
    async listOpenRouterModels(options) {
      listOptions = options;
      return fakeListed([entry]);
    },
  });
  assert.equal(listOptions?.refresh, true);
  assert.equal(result.source, 'live');
});

test('sdk dispatcher uses injected loadCursorSdk and maps sdk source', async () => {
  const prevKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = 'cr-test-key-for-sdk-refresh';
  try {
    let sdkLoaded = false;
    const result = await refreshHarnessModelsCatalog('sdk', {
      snapshotPath,
      async loadCursorSdk() {
        sdkLoaded = true;
        return {
          Cursor: {
            models: {
              list: async () => [{ id: 'sdk-model-1', name: 'SDK One' }],
            },
          },
        };
      },
    });
    assert.equal(sdkLoaded, true);
    assert.equal(result.source, 'sdk');
    assert.equal(result.stale, false);
    const listed = listHarnessModels({ harness: 'sdk' });
    assert.ok(listed.items.some((row) => row.id === 'sdk-model-1'));
  } finally {
    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
  }
});

test('concurrent refresh of different harnesses retains both snapshot keys', async () => {
  const deepseekEntry = { value: 'ds-concurrent', label: 'DS', modelId: 'ds-concurrent' };
  const claudeEntry = { value: 'cl-concurrent', label: 'CL', modelId: 'cl-concurrent' };
  /** @type {(() => void)|undefined} */
  let resolveDeepseek;
  /** @type {(() => void)|undefined} */
  let resolveClaude;
  const gateDeepseek = new Promise((resolve) => {
    resolveDeepseek = resolve;
  });
  const gateClaude = new Promise((resolve) => {
    resolveClaude = resolve;
  });
  const pDeepseek = refreshHarnessModelsCatalog('deepseek', {
    snapshotPath,
    async listDeepSeekModels() {
      await gateDeepseek;
      return fakeListed([deepseekEntry]);
    },
  });
  const pClaude = refreshHarnessModelsCatalog('claude', {
    snapshotPath,
    async listClaudeModels() {
      await gateClaude;
      return fakeListed([claudeEntry], 'session');
    },
  });
  resolveClaude();
  resolveDeepseek();
  const [rDeepseek, rClaude] = await Promise.all([pDeepseek, pClaude]);
  assert.equal(rDeepseek.ok, true);
  assert.equal(rClaude.ok, true);
  const snap = readHarnessModelsSnapshot({ snapshotPath });
  assert.ok(snap.harnesses.deepseek.entries.some((row) => row.value === 'ds-concurrent'));
  assert.ok(snap.harnesses.claude.entries.some((row) => row.value === 'cl-concurrent'));
});

removeIsolatedDataDir();
console.log('harness-models-refresh.test.js OK');
