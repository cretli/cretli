/**
 * PENDING performance budgets: new targets of the performance plan that the current JSON chat store cannot
 * meet. Each one is a node:test `skip` (latency numbers the JSON baseline already meets, so a `todo` would print a
 * misleading "ok") or `todo` (numbers that fail today). Neither is reported as a pass. Enable condition for all of them: stage 3 (chat metadata moves from chats.json to SQLite, see
 * docs/storage-chats-metadata-decision.md) is cut over. Then delete the `skip`/`todo` option; the test becomes enforced.
 * The stage 3 ADR may tighten these numbers, never loosen them.
 *
 * Bodies assert against the repository baseline (docs/perf-budgets-baseline.json) so they stay red until the
 * recorded numbers are re-captured on the new backend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBaseline } from './helpers/perf-budget.js';

const STAGE3 = 'pending stage 3 (chat metadata to SQLite); remove `todo` once cut over';

function jsonEntry(operation) {
  const entry = readBaseline().entries.find((e) => e.operation === operation && e.chats === 50_000);
  assert.ok(entry, `no baseline entry for ${operation}`);
  return entry;
}

test('chat list page(50) at 50k chats: p95 <= 40 ms', { skip: `${STAGE3}; NOTE: the current JSON baseline already satisfies this latency number, only the bytes/query gates fail` }, () => {
  assert.ok(jsonEntry('chat-list-page-50').p95Ms <= 40);
});

test('chat list page(50) at 50k chats: p99 <= 90 ms', { skip: `${STAGE3}; NOTE: the current JSON baseline already satisfies this latency number, only the bytes/query gates fail` }, () => {
  assert.ok(jsonEntry('chat-list-page-50').p99Ms <= 90);
});

test('chat metadata write handler at 50k chats: p95 <= 120 ms', { skip: `${STAGE3}; NOTE: the current JSON baseline already satisfies this latency number, only the bytes/query gates fail` }, () => {
  assert.ok(jsonEntry('chat-metadata-write').p95Ms <= 120);
});

test('chat metadata write handler at 50k chats: p99 <= 250 ms', { skip: `${STAGE3}; NOTE: the current JSON baseline already satisfies this latency number, only the bytes/query gates fail` }, () => {
  assert.ok(jsonEntry('chat-metadata-write').p99Ms <= 250);
});

test('chat metadata write at 50k chats: <= 64 KiB written per change', { todo: STAGE3 }, () => {
  assert.ok(jsonEntry('chat-metadata-write').bytesWritten <= 64 * 1024);
});

test('chat list / metadata write: query count independent of N (5k / 20k / 50k)', { todo: `${STAGE3}; needs a query counter on the SQLite chat store, which does not exist yet` }, () => {
  assert.fail('no SQLite chat store to count queries on');
});

test('cold presence index build at 50k chats: p95 <= 500 ms', { todo: 'pending: the one-off index build is O(active rows) and measured 300-740 ms at 50k; enable after the build is incremental or persisted' }, () => {
  assert.fail('measured 300-740 ms at 50k (tests/perf-budget-presence.test.js cold attach), above the 500 ms target on slow runs');
});
