import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResumeAdvice } from '../lib/usage/resume-advice.ts';
import { registerUsageRoutes } from '../lib/routes/usage-routes.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { noteHarnessCacheState, resetCacheStateForTests } from '../lib/usage/cache-state.ts';
import { normalizeUsageSettings } from '../lib/usage/usage-settings.ts';

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

function coldView(overrides = {}) {
  return {
    freshness: { cache: { state: 'cold', lastCachedTurnAt: NOW - 20 * MIN }, context: { inputTokens: 250_000 } },
    countdown: { state: 'cold', lastCachedTurnAt: NOW - 20 * MIN },
    ...overrides,
  };
}

function advise(overrides = {}) {
  return buildResumeAdvice({
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    billingMode: 'api-key',
    samples: [],
    settings: { enabled: true, minContextTokens: 100_000 },
    runActive: false,
    ...coldView(),
    ...overrides,
  });
}

test('cold large context on claude shows a priced lower-bound estimate', () => {
  const advice = advise();
  assert.equal(advice.show, true);
  assert.equal(advice.contextTokens, 250_000);
  assert.ok(advice.estimatedRewriteUsd > 0);
  assert.equal(advice.estimateBasis, 'lower_bound_text_input');
});

test('warm cache, unknown state and 1h cache within retention do not show', () => {
  const warm = advise({ freshness: { cache: { state: 'warm', lastCachedTurnAt: NOW }, context: { inputTokens: 250_000 } } });
  assert.equal(warm.show, false);
  assert.equal(warm.reason, 'cache_warm');
  // 1h cache written 6 minutes ago: freshness says warm, so no banner.
  const hour = advise({ freshness: { cache: { state: 'warm', lastCachedTurnAt: NOW - 6 * MIN }, context: { inputTokens: 250_000 } }, countdown: { state: 'warm' } });
  assert.equal(hour.show, false);
  const unknown = advise({ freshness: { cache: { state: 'unknown', lastCachedTurnAt: null }, context: {} }, countdown: { state: 'unknown', lastCachedTurnAt: null } });
  assert.equal(unknown.show, false);
});

test('cold after restart uses persisted samples for size and countdown for state', () => {
  const advice = advise({
    freshness: { cache: { state: 'unknown', lastCachedTurnAt: null }, context: { inputTokens: null } },
    samples: [{ observedAt: new Date(NOW - 30 * MIN).toISOString(), inputTokens: 180_000, contextWindowTokens: 1_000_000 }],
  });
  assert.equal(advice.show, true);
  assert.equal(advice.contextTokens, 180_000);
  assert.equal(advice.fillRatio, 0.18);
});

test('suppression reasons: threshold, no size, sdk, run active, disabled', () => {
  assert.equal(advise({ settings: { enabled: true, minContextTokens: 300_000 } }).reason, 'below_threshold');
  const noSize = advise({ freshness: { cache: { state: 'cold', lastCachedTurnAt: NOW }, context: { inputTokens: null } } });
  assert.equal(noSize.reason, 'no_context_size');
  assert.equal(advise({ harness: 'sdk' }).show, false);
  assert.equal(advise({ runActive: true }).reason, 'run_active');
  assert.equal(advise({ settings: { enabled: false, minContextTokens: 1 } }).reason, 'disabled');
});

test('cost is null for subscription, unpriced harnesses and auto models', () => {
  assert.equal(advise({ billingMode: 'subscription' }).estimatedRewriteUsd, null);
  assert.equal(advise({ harness: 'codebuddy' }).estimatedRewriteUsd, null);
  assert.equal(advise({ harness: 'codebuddy' }).show, true);
  assert.equal(advise({ harness: 'qwen' }).estimatedRewriteUsd, null);
  assert.equal(advise({ model: 'auto' }).estimatedRewriteUsd, null);
  assert.equal(advise({ model: 'default' }).estimatedRewriteUsd, null);
});

test('usage settings default and clamp resumeAdvice', () => {
  assert.deepEqual(normalizeUsageSettings({}).resumeAdvice, { enabled: true, minContextTokens: 100_000 });
  assert.equal(normalizeUsageSettings({ resumeAdvice: { minContextTokens: 5 } }).resumeAdvice.minContextTokens, 1000);
});

function fakeApp() {
  const routes = new Map();
  return { get: (r, h) => routes.set(`GET ${r}`, h), post: (r, h) => routes.set(`POST ${r}`, h), routes };
}

async function call(app, query, extra = {}) {
  const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(p) { res.body = p; return res; } };
  await app.routes.get('GET /api/usage/resume-advice')({ query, ...extra }, res);
  return res;
}

test('GET /api/usage/resume-advice: 400, 403 and a cold claude chat', async () => {
  resetCacheStateForTests();
  const app = fakeApp();
  registerUsageRoutes(app, {
    loadSettings: () => ({}),
    getChatRunState: () => ({ busy: false }),
  });
  assert.equal((await call(app, {})).statusCode, 400);
  assert.equal((await call(app, { chat_id: 'x' }, { widgetAccess: true })).statusCode, 403);
  const chat = addChat('sess-advice', 'Big', null, '/tmp/ws', 'claude-sonnet-4-5', { agentTransport: 'claude' });
  noteHarnessCacheState({ chatId: chat.id, harness: 'claude', now: Date.now() - 60 * MIN, tokens: { textInput: 1000, cachedInput: 199_000, cacheWrite: 0 } });
  const res = await call(app, { chat_id: chat.id });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.advice.show, true);
  assert.equal(res.body.advice.contextTokens, 200_000);
});

test('shared retention: a 1h cache written 6 minutes ago is warm for both endpoints', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { recordHarnessContextSample } = await import('../lib/usage/harness-context-telemetry.ts');
  resetCacheStateForTests();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-resume-advice-'));
  const app = fakeApp();
  registerUsageRoutes(app, { dataDir, loadSettings: () => ({}), getChatRunState: () => ({ busy: false }) });
  const at = Date.now() - 6 * MIN;
  const tokens = { textInput: 1000, cachedInput: 199_000, cacheWrite: 0 };
  const hourChat = addChat('sess-1h', 'Hour', null, '/tmp/ws', 'claude-sonnet-4-5', { agentTransport: 'claude' });
  const fiveChat = addChat('sess-5m', 'Five', null, '/tmp/ws', 'claude-sonnet-4-5', { agentTransport: 'claude' });
  noteHarnessCacheState({ chatId: hourChat.id, harness: 'claude', now: at, tokens });
  noteHarnessCacheState({ chatId: fiveChat.id, harness: 'claude', now: at, tokens });
  recordHarnessContextSample({
    room: { chatId: hourChat.id, _contextEpoch: 0 }, harness: 'claude', dataDir,
    event: { observedAt: new Date(at).toISOString(), usage: { inputTokens: 200_000, totalTokens: 200_500, cacheWriteTokens: 5000, cacheWrite1hTokens: 5000 } },
  });
  assert.equal((await call(app, { chat_id: hourChat.id })).body.advice.show, false);
  assert.equal((await call(app, { chat_id: fiveChat.id })).body.advice.show, true);
  const freshness = { body: null, statusCode: 200, status(c) { this.statusCode = c; return this; }, json(v) { this.body = v; return this; } };
  await app.routes.get('GET /api/usage/cache-freshness')({ query: { chat_id: hourChat.id } }, freshness);
  assert.equal(freshness.body.countdown.state, 'warm');
  assert.equal(freshness.body.countdown.ttlMs, 60 * MIN);
});
