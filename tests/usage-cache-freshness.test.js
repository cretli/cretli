/**
 * Cache freshness, session generation and the read-only MCP tool.
 * Deterministic: an injected clock, no sleeping, no provider calls.
 */
process.env.CRETLI_TEST_DATA_DIR ||= 'usage-cache-freshness-test';

import assert from 'node:assert/strict';
import {
  getCacheFreshness,
  invalidateCacheState,
  noteHarnessCacheState,
  resetCacheStateForTests,
} from '../lib/usage/cache-state.js';
import { resetContextRestartsForTests } from '../lib/usage/context-restarts.js';
import { CACHE_MCP_TOOLS } from '../lib/mcp/builtin/cache-tools.js';
import { deltaTokens } from '../lib/usage/usage-normalize.js';

const T0 = 1_000_000_000_000;
const MIN = 60 * 1000;
resetCacheStateForTests();
resetContextRestartsForTests();

// Known TTL: warm with an expiry, cache and context stay separate dimensions.
noteHarnessCacheState({
  chatId: 'c1', harness: 'claude', now: T0,
  tokens: { textInput: 100, cachedInput: 900, cacheWrite: 50 },
});
let view = getCacheFreshness('c1', { now: T0 + MIN });
assert.equal(view.readOnly, true);
assert.equal(view.requestIssued, false);
assert.equal(view.cache.state, 'warm');
assert.equal(view.cache.expiresAt, T0 + 5 * MIN);
assert.equal(view.cache.expiresInMs, 4 * MIN);
assert.equal(view.context.inputTokens, 100 + 900 + 50);
assert.equal(view.session.cachedInputTokens, 900);
assert.equal(view.session.generation, 0);

// Expired TTL: cold, no countdown.
view = getCacheFreshness('c1', { now: T0 + 6 * MIN });
assert.equal(view.cache.state, 'cold');
assert.equal(view.cache.expiresAt, null);

// Unknown TTL harness: never a countdown, even right after a hit.
noteHarnessCacheState({ chatId: 'c2', harness: 'deepseek', now: T0, tokens: { textInput: 10, cachedInput: 90 } });
view = getCacheFreshness('c2', { now: T0 + 1000 });
assert.equal(view.cache.state, 'unknown');
assert.equal(view.cache.ttlKnown, false);
assert.equal(view.cache.expiresAt, null);

// Reset: new generation, estimate and context dropped, usage history kept.
invalidateCacheState({ chatId: 'c1', at: T0 + 2 * MIN, reason: 'compaction' });
view = getCacheFreshness('c1', { now: T0 + 3 * MIN });
assert.equal(view.cache.state, 'cold');
assert.equal(view.cache.reason, 'session_restarted');
assert.equal(view.session.generation, 1);
assert.equal(view.session.lastResetReason, 'compaction');
assert.equal(view.session.cachedInputTokens, 900);
assert.equal(view.session.generationCachedInputTokens, 0);
assert.equal(view.context.inputTokens, null);

// Unknown chat: honest empty view, not zeros posing as a measurement.
view = getCacheFreshness('nope', { now: T0 });
assert.equal(view.cache.confidence, 'none');
assert.equal(view.context.inputTokens, null);

// Snapshot/cumulative diffing never double counts a replayed snapshot.
const prev = { textInput: 100, textOutput: 10, cachedInput: 50, cacheWrite: 0, reasoning: 0, audioInput: 0, audioOutput: 0 };
const cur = { ...prev, textInput: 160, cachedInput: 80 };
assert.equal(deltaTokens(cur, prev).textInput, 60);
assert.equal(deltaTokens(cur, prev).cachedInput, 30);
assert.equal(deltaTokens(cur, cur).textInput, 0);

// MCP tool: read-only, resolves chat from args or session.
const tool = CACHE_MCP_TOOLS[0];
assert.equal(tool.readOnly, true);
const result = tool.handler({ chat_id: 'c2' }, { session: {} });
assert.equal(result.structuredContent.chatId, 'c2');
assert.throws(() => tool.handler({}, { session: {} }));

console.log('usage-cache-freshness ok');

const { renderCacheFreshnessHtml } = await import('../app_front/features/usage/usageInsightsView.js');
const html = renderCacheFreshnessHtml(
  { cache: { state: 'unknown', expiresInMs: null }, session: { generation: 2, cachedInputTokens: 1234, cacheWriteTokens: 5 }, context: { inputTokens: null } },
  { t: (k) => k, lang: 'en' },
);
assert.match(html, /usage\.cacheNoData/);
assert.match(html, /tabindex="0"/);
assert.doesNotMatch(html, /usage\.cacheEstimated/);

// ---- F4: replay/retry, restart, reset vs history, workflow breakdown, UI keys.
const { buildWorkflowBreakdown } = await import('../lib/usage/workflow-breakdown.js');
const { renderWorkflowBreakdownHtml } = await import('../app_front/features/usage/usageInsightsView.js');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const pathMod = await import('node:path');
const { commitUsageEvent, readUsageEvents, resetUsageLedgerCache } = await import('../lib/persist/usage-persist.js');
const { createUsageEvent } = await import('../lib/usage/usage-event.js');
const { sumUsageTokenBuckets } = await import('../lib/usage/usage-insights.js');

const dataDir = mkdtempSync(pathMod.join(tmpdir(), 'cretli-cache-fresh-'));
const ev = createUsageEvent({
  provider: 'other', harness: 'claude', feature: 'chat', chatId: 'c9', model: 'claude-x',
  runId: 'r1', sourceSessionId: 'sess-1', requestId: 'req-1', role: 'implement',
  tokens: { textInput: 10, textOutput: 5, cachedInput: 40 },
  at: '2026-10-01T10:00:00.000Z',
});
assert.equal(commitUsageEvent(ev, { dataDir }).status, 'committed');
resetUsageLedgerCache(dataDir); // restart: in-memory read model gone
assert.equal(commitUsageEvent(ev, { dataDir }).status, 'duplicate'); // replay/retry
const sumAll = () => sumUsageTokenBuckets(readUsageEvents({ from: '2026-10-01', to: '2026-10-01', dataDir }));
const first = sumAll();
assert.equal(first.cacheRead, 40, 'replay must not double the cache read');
// Restart: drop every in-memory cache; the ledger re-read gives the same sums.
resetUsageLedgerCache(dataDir);
resetCacheStateForTests();
assert.deepEqual(sumAll().cacheRead, first.cacheRead);
view = getCacheFreshness('c9', { now: T0 });
assert.equal(view.cache.confidence, 'none');
assert.equal(view.cache.state, 'unknown');
assert.equal(view.cache.expiresAt, null);
assert.equal(view.stateScope, 'process');

// Reset invalidates the estimate, not the cumulative usage history.
noteHarnessCacheState({ chatId: 'c9', harness: 'claude', now: T0, tokens: { textInput: 1, cachedInput: 9 } });
invalidateCacheState({ chatId: 'c9', at: T0 + MIN, reason: 'epoch' });
view = getCacheFreshness('c9', { now: T0 + 2 * MIN });
assert.equal(view.cache.expiresAt, null);
assert.equal(view.session.cachedInputTokens, 9);
assert.equal(sumAll().cacheRead, first.cacheRead);

// Workflow breakdown: attempts → rounds, replay deduped, unmatched reported.
const delegations = [{
  id: 'd1', leafId: 'leaf-aaaaaaaa',
  attempts: [{ attemptId: 'a0', runId: 'r0', startedAt: '2026-01-01T00:00:00Z' }],
  attemptId: 'a1', runId: 'r1', startedAt: '2026-01-02T00:00:00Z',
}];
const mk = (attemptId, runId, key, usd, estimated) => ({
  delegationId: 'd1', attemptId, runId, logicalEventKey: key, role: 'implement',
  tokens: { textInput: 10, cachedInput: 5 }, usd, estimated,
});
const breakdown = buildWorkflowBreakdown({
  delegations,
  events: [mk('a0', 'r0', 'k0', 0.1, false), mk('a1', 'r1', 'k1', 0.2, true), mk('a1', 'r1', 'k1', 0.2, true),
    { delegationId: 'zzz', attemptId: 'x', runId: 'y', tokens: { textInput: 1 } }],
});
assert.equal(breakdown.duplicates, 1);
assert.equal(breakdown.unmatched.events, 1);
assert.deepEqual(breakdown.rows.map((r) => r.round), [1, 2]);
assert.equal(breakdown.rows[0].cost.actualUsd, 0.1);
assert.equal(breakdown.rows[1].cost.estimatedUsd, 0.2);
const wfHtml = renderWorkflowBreakdownHtml(breakdown, { t: (k) => k, lang: 'en' });
assert.match(wfHtml, /usage\.workflowCostOrigin/);

// Keyboard: scrollable regions are focusable and the chat select is native.
assert.match(wfHtml, /tabindex="0"/);
const { readFileSync } = await import('node:fs');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
assert.match(indexHtml, /<select id="usage-cache-chat-select"/);
console.log('usage-cache-freshness F4 ok');
