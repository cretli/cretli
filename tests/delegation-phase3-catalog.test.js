import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createDelegationRecord, loadDelegations, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createMailboxMessage } from '../lib/persist/delegation-mailbox-persist.js';
import { pageDelegationRows } from '../lib/delegation-query.js';
import { applyDelegationRetention } from '../lib/delegation-retention.js';
import { getDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';

const inputCount = 1000;
const createdAt = '2026-01-01T00:00:00.000Z';
const ids = [];
for (let i = 0; i < inputCount; i += 1) {
  const row = createDelegationRecord({
    parentChatId: `parent-${i % 10}`,
    childChatId: `child-${i}`,
    sourceKind: 'text',
    sourceText: 'catalog',
  });
  updateDelegationRecord(row.id, {
    status: 'completed',
    createdAt,
    finishedAt: createdAt,
    planMarkdown: '',
    report: '',
  });
  ids.push(row.id);
}
const active = createDelegationRecord({
  parentChatId: 'active-parent',
  childChatId: 'active-child',
  sourceKind: 'text',
  sourceText: 'live',
});
updateDelegationRecord(active.id, { status: 'running' });
createMailboxMessage({
  fromChatId: 'c',
  toChatId: 'p',
  delegationId: ids[0],
  kind: 'reply',
  body: 'pending',
  status: 'uncertain',
});

const all = loadDelegations().filter((row) => ids.includes(row.id));
assert.equal(all.length, inputCount);
const summaries = all.map((row) => ({
  id: row.id,
  createdAt: createdAt,
  status: row.status,
  report: row.report,
  planMarkdown: row.planMarkdown,
}));
assert.equal(summaries.every((row) => !row.report && !row.planMarkdown), true);

const first = pageDelegationRows(summaries, { limit: 40 });
const seen = new Set(first.items.map((row) => row.id));
let cursor = first.nextCursor;
while (cursor) {
  const page = pageDelegationRows(summaries, { limit: 40, cursor });
  for (const row of page.items) {
    assert.equal(seen.has(row.id), false);
    seen.add(row.id);
  }
  cursor = page.nextCursor;
}
assert.equal(seen.size, inputCount);

const withInsert = [
  { id: 'newer', createdAt: '2026-02-01T00:00:00.000Z', status: 'completed' },
  ...summaries,
];
const pageAfterInsert = pageDelegationRows(withInsert, { limit: 40, cursor: first.nextCursor });
assert.equal(pageAfterInsert.items.some((row) => seen.has(row.id) === false && row.id !== 'newer'), false);

const retention = applyDelegationRetention({ now: Date.now(), retentionMs: 1 });
assert.equal(loadDelegations().some((row) => row.id === active.id && row.status === 'running'), true);

const warmups = 5;
const samples = 30;
for (let i = 0; i < warmups; i += 1) {
  pageDelegationRows(summaries, { limit: 40 });
}
const times = [];
let payloadBytes = 0;
for (let i = 0; i < samples; i += 1) {
  const t0 = performance.now();
  const page = pageDelegationRows(summaries, { limit: 40 });
  times.push(performance.now() - t0);
  payloadBytes = Buffer.byteLength(JSON.stringify(page.items));
}
times.sort((a, b) => a - b);
const p50 = times[Math.floor(times.length / 2)];
console.log(JSON.stringify({
  gate: 'D7',
  backend: getDelegationStoreBackend(),
  hardware: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model || 'cpu'}`,
  node: process.version,
  items: inputCount,
  warmups,
  samples,
  p50Ms: Math.round(p50 * 1000) / 1000,
  rssBytes: process.memoryUsage().rss,
  payloadBytes,
  retention,
}));
console.log('delegation-phase3-catalog.test.js OK');
