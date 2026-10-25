import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  armWakeup,
  cancelWakeup,
  cancelWakeupsWhere,
  listWakeups,
  loadWakeups,
  newestWakeupForSubject,
  saveWakeups,
  WAKEUPS_MAX_ROWS,
} from '../lib/persist/wakeups-persist.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wakeups-'));
const row = (over = {}) => ({
  id: 'r1', kind: 'usage_limit_resume', subjectType: 'chat', subjectId: 'c1',
  state: 'armed', pausedAt: new Date(NOW).toISOString(), ...over,
});

test('corrupt file loads as an empty list', () => {
  const dataDir = tmp();
  fs.writeFileSync(path.join(dataDir, 'wakeups.json'), '{not json');
  assert.deepEqual(loadWakeups({ dataDir }), []);
});

test('armWakeup is idempotent on the id', () => {
  const dataDir = tmp();
  for (let i = 0; i < 3; i += 1) armWakeup(row(), { dataDir, now: NOW });
  assert.equal(loadWakeups({ dataDir }).length, 1);
});

test('cancelWakeup is idempotent and never touches a non-armed row', () => {
  const dataDir = tmp();
  armWakeup(row(), { dataDir, now: NOW });
  assert.equal(cancelWakeup('r1', 'x', { dataDir, now: NOW }).changed, true);
  assert.equal(cancelWakeup('r1', 'x', { dataDir, now: NOW }).changed, false);
  assert.equal(cancelWakeup('nope', 'x', { dataDir }).code, 'not_found');
});

test('cancelWakeupsWhere honours kind, leaf and parent', () => {
  const dataDir = tmp();
  const d = (id, leafId, kind = 'usage_limit_resume') => row({
    id, kind, subjectType: 'delegation', subjectId: id, parentChatId: 'p', leafId,
  });
  saveWakeups([d('a', 'leaf1'), d('b', 'leaf2'), d('c', ''), d('o', 'leaf1', 'future_kind')], { dataDir, now: NOW });
  const n = cancelWakeupsWhere({ kind: 'usage_limit_resume', subjectType: 'delegation', parentChatId: 'p', leafId: 'leaf1' }, { dataDir, now: NOW });
  assert.equal(n, 2); // same leaf + leafless fallback; other leaf untouched
  const states = Object.fromEntries(loadWakeups({ dataDir }).map((r) => [r.id, r.state]));
  assert.deepEqual(states, { a: 'cancelled', b: 'armed', c: 'cancelled', o: 'armed' });
  assert.equal(cancelWakeupsWhere({ subjectId: 'o' }, { dataDir }), 0); // kind is mandatory
});

test('store stays bounded; unknown kinds survive prune', () => {
  const dataDir = tmp();
  const old = new Date(NOW - 8 * 86400000).toISOString();
  const rows = [row({ id: 'unk', kind: 'future_kind', state: 'cancelled', updatedAt: old, pausedAt: old })];
  rows.push(row({ id: 'old', state: 'cancelled', updatedAt: old, pausedAt: old }));
  for (let i = 0; i < 250; i += 1) {
    rows.push(row({ id: `p${i}`, pausedAt: new Date(NOW + i).toISOString(), updatedAt: new Date(NOW + i).toISOString() }));
  }
  saveWakeups(rows, { dataDir, now: NOW });
  const saved = loadWakeups({ dataDir });
  assert.ok(saved.length <= WAKEUPS_MAX_ROWS);
  assert.ok(saved.some((r) => r.id === 'unk'));
  assert.ok(!saved.some((r) => r.id === 'old'));
});

test('list and newest-for-subject', () => {
  const dataDir = tmp();
  armWakeup(row({ id: 'a', pausedAt: '2026-10-19T10:00:00Z' }), { dataDir, now: NOW });
  armWakeup(row({ id: 'b', pausedAt: '2026-10-19T11:00:00Z' }), { dataDir, now: NOW });
  assert.equal(listWakeups({ kind: 'usage_limit_resume' }, { dataDir }).length, 2);
  assert.equal(listWakeups({ state: 'resumed' }, { dataDir }).length, 0);
  assert.equal(newestWakeupForSubject('usage_limit_resume', 'chat', 'c1', { dataDir }).id, 'b');
});
