import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { findWorkspaceWatcherStaleDoing } from '../lib/workspace-watcher-guardrails.js';

const now = Date.parse('2026-11-05T12:00:00Z');
const row = (id, hours = 25, extra = {}) => ({ id, status: 'doing', updatedAt: new Date(now - hours * 3_600_000).toISOString(), ...extra });

test('old ownerless doing leaf is diagnostic only, with suggested action', () => {
  const items = [row('old'), row('young', 23), row('boundary', 24), row('ready', 30, { status: 'ready' })];
  const before = structuredClone(items);
  const result = findWorkspaceWatcherStaleDoing({ items, now });
  assert.deepEqual(result.map((r) => r.todoId), ['old']);
  assert.equal(result[0].reason, 'stale_doing');
  assert.ok(result[0].suggestedAction);
  assert.deepEqual(items, before);
});

test('live claim, active execution, cycle on leaf or ancestor, and containers stay out', () => {
  const items = [row('claim', 40, { claimedByChatId: 'chat', claimLeaseUntil: new Date(now + 1000).toISOString() }),
    row('active'), row('cycle'), row('parent'), row('child', 30, { parentId: 'parent' }),
    row('expired', 30, { claimedByChatId: 'chat', claimLeaseUntil: new Date(now - 1000).toISOString() })];
  const result = findWorkspaceWatcherStaleDoing({ items, now,
    doingStates: [{ todoId: 'active', state: 'active' }], cycles: [{ todoIds: ['cycle', 'parent'] }] });
  assert.deepEqual(result.map((r) => r.todoId), ['expired']);
});

test('threshold is configurable; invalid configuration defaults to 24h and invalid dates stay out', () => {
  const items = [row('old', 4), row('missing', 30, { updatedAt: 'bad' })];
  assert.equal(findWorkspaceWatcherStaleDoing({ items, now, staleDoingHours: 3 }).length, 1);
  for (const value of ['bad', 0, -1, Infinity, undefined]) {
    assert.deepEqual(findWorkspaceWatcherStaleDoing({ items, now, staleDoingHours: value }), []);
  }
});
