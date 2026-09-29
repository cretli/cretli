import assert from 'node:assert/strict';
import {
  catalogHasModels,
  createNewChatCatalogCache,
  createNewChatHarnessStatusTracker,
  isSuccessfulCatalog,
  normalizeNewChatHarnessId,
  resolveCatalogConfirmedReadiness,
  resolveNewChatHarnessUiState,
} from '../app_front/features/chat/newChatHarnessStatus.js';

assert.equal(normalizeNewChatHarnessId('OpenCode'), 'opencode');
assert.equal(normalizeNewChatHarnessId(' qwen '), 'qwen');
assert.equal(normalizeNewChatHarnessId('codex'), 'codex');
assert.equal(normalizeNewChatHarnessId('nonsense'), 'sdk');
assert.equal(normalizeNewChatHarnessId(undefined), 'sdk');

// Unknown readiness must keep Create disabled without showing a warning (the reported bug).
assert.deepEqual(resolveNewChatHarnessUiState(null), {
  ready: false,
  showWarning: false,
  disableCreate: true,
});
assert.deepEqual(resolveNewChatHarnessUiState(false), {
  ready: false,
  showWarning: true,
  disableCreate: true,
});
assert.deepEqual(resolveNewChatHarnessUiState(true), {
  ready: true,
  showWarning: false,
  disableCreate: false,
});
// A create in flight must keep Create disabled even when the harness is ready.
assert.equal(resolveNewChatHarnessUiState(true, true).disableCreate, true);

const tracker = createNewChatHarnessStatusTracker();
const sdkToken = tracker.begin('sdk');
assert.equal(tracker.isLatest(sdkToken), true);
assert.equal(tracker.isCurrent(sdkToken, 'sdk'), true);
// A fast switch away from SDK makes the pending SDK response stale for the UI, but it stays
// latest for its own harness so it may still warm the SDK readiness cache.
assert.equal(tracker.isLatest(sdkToken), true);
assert.equal(tracker.isCurrent(sdkToken, 'opencode'), false);

const opencodeToken = tracker.begin('opencode');
assert.equal(tracker.isLatest(opencodeToken), true);
assert.equal(tracker.isCurrent(opencodeToken, 'opencode'), true);
// Responses are tracked independently per harness: a newer SDK request does not invalidate OpenCode.
const newerSdkToken = tracker.begin('sdk');
assert.equal(tracker.isLatest(opencodeToken), true);
assert.equal(tracker.isCurrent(opencodeToken, 'opencode'), true);
assert.equal(tracker.isLatest(sdkToken), false);
assert.equal(tracker.isCurrent(sdkToken, 'sdk'), false);
assert.equal(tracker.isLatest(newerSdkToken), true);
// A latest token for a non-selected harness must never count as current UI.
assert.equal(tracker.isCurrent(newerSdkToken, 'opencode'), false);
assert.equal(tracker.isCurrent(newerSdkToken, 'sdk'), true);
assert.equal(tracker.isLatest(null), false);
assert.equal(tracker.isCurrent(null, 'sdk'), false);
assert.equal(tracker.isLatest({ harness: 'sdk', seq: Number.NaN }), false);

// Selection settlement and in-flight tracking per harness.
tracker.selectHarness('openrouter');
assert.equal(tracker.isSelectionSettled('openrouter'), false);
tracker.markSelectionSettled('openrouter');
assert.equal(tracker.isSelectionSettled('openrouter'), true);
// Another harness is not settled.
assert.equal(tracker.isSelectionSettled('sdk'), false);

// Switching selection to another harness creates a new unsettled selection.
tracker.selectHarness('opencode');
assert.equal(tracker.isSelectionSettled('opencode'), false);

// Returning to openrouter creates a new selection cycle for openrouter.
tracker.selectHarness('openrouter');
assert.equal(tracker.isSelectionSettled('openrouter'), false);

// Invalidation resets settlement.
tracker.markSelectionSettled('openrouter');
assert.equal(tracker.isSelectionSettled('openrouter'), true);
tracker.invalidate('openrouter');
assert.equal(tracker.isSelectionSettled('openrouter'), false);

// clearInFlight must not delete a newer promise when an older check settles late.
const oldPromise = Promise.resolve();
const newPromise = Promise.resolve();
tracker.setInFlight('codex', oldPromise);
tracker.clearInFlight('codex', oldPromise);
assert.equal(tracker.getInFlight('codex'), undefined);
tracker.setInFlight('codex', oldPromise);
tracker.setInFlight('codex', newPromise);
tracker.clearInFlight('codex', oldPromise);
assert.equal(tracker.getInFlight('codex'), newPromise, 'stale clearInFlight removed the newer promise');
tracker.clearInFlight('codex', newPromise);
assert.equal(tracker.getInFlight('codex'), undefined);
// A clear without a promise keeps the legacy unconditional behaviour.
tracker.setInFlight('codex', oldPromise);
tracker.clearInFlight('codex');
assert.equal(tracker.getInFlight('codex'), undefined);

// Catalog payload gating helpers.
assert.equal(isSuccessfulCatalog({ ok: false, models: [] }), false);
assert.equal(isSuccessfulCatalog({ ok: false, error: 'boom' }), false);
assert.equal(isSuccessfulCatalog({ ok: true, models: [] }), true);
assert.equal(isSuccessfulCatalog({ models: [{ id: 'x' }] }), true);
assert.equal(isSuccessfulCatalog(null), false);
assert.equal(catalogHasModels({ ok: true, models: [] }), false);
assert.equal(catalogHasModels({ ok: true, models: [{ id: 'x' }] }), true);
assert.equal(catalogHasModels({ models: [{ id: 'x' }] }), false);
// A raw `true` stays unknown until the catalog confirms models for the same generation.
assert.equal(resolveCatalogConfirmedReadiness(true, null), null);
assert.equal(resolveCatalogConfirmedReadiness(true, { ok: true, models: [] }), null);
assert.equal(resolveCatalogConfirmedReadiness(true, { ok: true, models: [{ id: 'x' }] }), true);
assert.equal(resolveCatalogConfirmedReadiness(false, { ok: true, models: [{ id: 'x' }] }), false);
assert.equal(resolveCatalogConfirmedReadiness(null, null), null);

// Catalog cache: deduplication, retry after a failed payload and in-flight sharing.
async function testCatalogCache() {
  const cache = createNewChatCatalogCache();
  let fetchCount = 0;
  const mockFetcher = async () => {
    fetchCount += 1;
    return { ok: true, models: [{ id: 'm1' }] };
  };

  // First successful fetch calls the fetcher and caches.
  const res1 = await cache.fetchDeduped('openrouter', mockFetcher);
  assert.equal(fetchCount, 1);
  assert.equal(res1.ok, true);

  // A cached harness does not call the fetcher again.
  const res2 = await cache.fetchDeduped('openrouter', mockFetcher);
  assert.equal(fetchCount, 1);
  assert.deepEqual(res2, res1);

  // Clearing the cache allows a new fetch.
  cache.clear('openrouter');
  assert.equal(cache.has('openrouter'), false);
  await cache.fetchDeduped('openrouter', mockFetcher);
  assert.equal(fetchCount, 2);

  // A failed catalog (with an empty models array) is not stored as success and is retried.
  let failedFetchCount = 0;
  const failedThenOk = async () => {
    failedFetchCount += 1;
    if (failedFetchCount === 1) return { ok: false, error: 'boom', models: [] };
    return { ok: true, models: [{ id: 'retry1' }] };
  };
  const first = await cache.fetchDeduped('deepseek', failedThenOk);
  assert.equal(first.ok, false);
  assert.equal(cache.has('deepseek'), false, 'failed catalog must not be cached as success');
  const second = await cache.fetchDeduped('deepseek', failedThenOk);
  assert.equal(second.ok, true);
  assert.equal(failedFetchCount, 2, 'failed catalog must be retried on the next open');

  // In-flight dedup: concurrent calls for the same harness share the same promise.
  let slowFetchCount = 0;
  const slowFetcher = () => new Promise((resolve) => {
    slowFetchCount += 1;
    setTimeout(() => resolve({ ok: true, models: [{ id: 'slow1' }] }), 10);
  });
  const [p1, p2] = await Promise.all([
    cache.fetchDeduped('qwen', slowFetcher),
    cache.fetchDeduped('qwen', slowFetcher),
  ]);
  assert.equal(slowFetchCount, 1);
  assert.deepEqual(p1, p2);
}

await testCatalogCache();

console.log('new-chat-harness-status.test.js OK');
