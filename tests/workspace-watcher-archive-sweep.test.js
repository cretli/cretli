/**
 * Unit tests for the shared closed-cycle archive sweep
 * (lib/workspace-watcher-archive-sweep.js).
 *
 * The sweep must archive an orchestrator family recorded in a closed
 * `cycleChats` window once it is past the 15-minute idle grace, child before
 * parent, and leave pinned / in-grace / unknown-liveness / live-cycle chats
 * alone. It reads and writes the real (isolated) chat store through the persist
 * API; only the liveness probe and the delegation reader are injected so each
 * case controls exactly the signal it asserts on.
 *
 * Runner: plain assertion script —
 * `node tests/workspace-watcher-archive-sweep.test.js`.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getWorkspaceWatcher,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { addChat, loadChats, saveChats, updateChat } from '../lib/persist/chats-persist.js';
import { sweepClosedWorkspaceWatcherCycles } from '../lib/workspace-watcher-archive-sweep.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

/** @type {number} */
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-archive-sweep-'));
/** Real clock baseline; chats are created with `updatedAt` ≈ this value. */
const base = Date.now();
const PAST_GRACE = base + 20 * 60_000;
const WITHIN_GRACE = base + 60_000;

/**
 * @param {string} name
 * @returns {string}
 */
function workspaceDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a watcher row in the isolated store and return its normalized form.
 *
 * @param {string} name
 * @param {object} patch
 * @returns {{ cwd: string, row: object }}
 */
function rowFor(name, patch) {
  const cwd = workspaceDir(name);
  upsertWorkspaceWatcher(cwd, patch);
  const row = getWorkspaceWatcher(cwd);
  assert.ok(row, `watcher row ${name} exists`);
  return { cwd, row };
}

/**
 * @param {string} id
 * @returns {object | undefined}
 */
function storedChat(id) {
  return loadChats().find((chat) => chat.id === id);
}

runCase('archives a closed-cycle family past the grace, delegation child before the parent', () => {
  const { cwd, row } = rowFor('sweep-past-grace', {
    mode: 'observe',
    cycleChats: [{ id: 'sweep-orch', cycleId: 'c1', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  const sessions = ['sess-sweep-orch', 'sess-sweep-child'];
  addChat(sessions[0], 'Orchestrator', null, cwd, undefined, { id: 'sweep-orch', agentTransport: 'test' });
  addChat(sessions[1], 'Child', null, cwd, undefined, {
    id: 'sweep-child',
    agentTransport: 'test',
    pickPurpose: 'implement',
    delegationParentChatId: 'sweep-orch',
  });
  const out = sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: {
      isChatRunConfirmedIdle: () => true,
      listDelegationsForParent: (parentId) => (parentId === 'sweep-orch'
        ? [{ parentChatId: 'sweep-orch', childChatId: 'sweep-child', status: 'completed' }]
        : []),
    },
  });
  assert.deepEqual(out.archived, ['sweep-child', 'sweep-orch'], 'child first, then the orchestrator');
  assert.equal(out.considered, 1);
  assert.ok(storedChat('sweep-child')?.archivedAt, 'child is archived in the store');
  assert.ok(storedChat('sweep-orch')?.archivedAt, 'orchestrator is archived in the store');
  // The sweep is read-only on the watcher row: no slot, no daily budget.
  const after = getWorkspaceWatcher(cwd);
  assert.equal((after.activeCycles || []).length, 0, 'the sweep never opens a cycle slot');
  assert.equal(after.cycles?.count || 0, 0, 'the sweep never consumes the daily cycle budget');
});

runCase('sweeps children created after the closed-cycle parent was archived', () => {
  const { cwd, row } = rowFor('sweep-late-children', {
    mode: 'observe',
    cycleChats: [{ id: 'late-orch', cycleId: 'c-late', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  addChat('sess-late-orch', 'Orchestrator', null, cwd, undefined, { id: 'late-orch', agentTransport: 'test' });
  updateChat('late-orch', { archived: true });
  const originalArchivedAt = storedChat('late-orch').archivedAt;
  // Reproduce data written by the old delegation path; new child creation now
  // rejects archived parents, while the sweep must still repair existing trees.
  saveChats([...loadChats(), {
    id: 'late-child', title: 'Child', cursorSessionId: 'sess-late-child',
    workspaceFolder: cwd, agentTransport: 'test', forkParentChatId: 'late-orch',
    createdAt: new Date(base).toISOString(), updatedAt: new Date(base).toISOString(),
  }]);
  const deps = {
    isChatRunConfirmedIdle: () => true,
    listDelegationsForParent: (parentId) => (parentId === 'late-orch'
      ? [{ parentChatId: 'late-orch', childChatId: 'late-child', status: 'completed' }]
      : []),
    isDelegationSlotOccupied: () => false,
  };
  assert.deepEqual(sweepClosedWorkspaceWatcherCycles({ now: WITHIN_GRACE, rows: [row], deps }).archived, []);
  const out = sweepClosedWorkspaceWatcherCycles({ now: PAST_GRACE, rows: [row], deps });
  assert.deepEqual(out.archived, ['late-child']);
  assert.ok(storedChat('late-child').archivedAt, 'the later child joins its parent in the archive');
  assert.equal(storedChat('late-orch').archivedAt, originalArchivedAt, 'the parent archive stamp is preserved');
  assert.deepEqual(sweepClosedWorkspaceWatcherCycles({ now: PAST_GRACE, rows: [row], deps }).archived, []);
});

runCase('keeps a pinned closed-cycle orchestrator', () => {
  const { cwd, row } = rowFor('sweep-pinned', {
    mode: 'observe',
    cycleChats: [{ id: 'pin-orch', cycleId: 'c-pin', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  addChat('sess-pin-orch', 'Pinned', null, cwd, undefined, {
    id: 'pin-orch',
    agentTransport: 'test',
    watcherPinned: true,
  });
  const out = sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => true, listDelegationsForParent: () => [] },
  });
  assert.deepEqual(out.archived, [], 'a pinned orchestrator stays visible');
  assert.ok(!storedChat('pin-orch')?.archivedAt);
});

runCase('keeps a closed-cycle orchestrator inside the grace window', () => {
  const { cwd, row } = rowFor('sweep-within-grace', {
    mode: 'observe',
    cycleChats: [{ id: 'grace-orch', cycleId: 'c-grace', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  addChat('sess-grace-orch', 'Fresh', null, cwd, undefined, { id: 'grace-orch', agentTransport: 'test' });
  const out = sweepClosedWorkspaceWatcherCycles({
    now: WITHIN_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => true, listDelegationsForParent: () => [] },
  });
  assert.deepEqual(out.archived, [], 'a freshly closed cycle is not hidden before the grace');
  assert.ok(!storedChat('grace-orch')?.archivedAt);
});

runCase('keeps a closed-cycle orchestrator whose run liveness is unknown (fail-closed)', () => {
  const { cwd, row } = rowFor('sweep-unknown', {
    mode: 'observe',
    cycleChats: [{ id: 'unknown-orch', cycleId: 'c-unknown', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  addChat('sess-unknown-orch', 'Unknown', null, cwd, undefined, { id: 'unknown-orch', agentTransport: 'test' });
  const out = sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => false, listDelegationsForParent: () => [] },
  });
  assert.deepEqual(out.archived, [], 'unknown liveness keeps the chat (fail-closed)');
  assert.ok(!storedChat('unknown-orch')?.archivedAt);
});

runCase('never sweeps a chat that still orchestrates a live cycle', () => {
  const startedAt = new Date(base).toISOString();
  const { cwd, row } = rowFor('sweep-live', {
    mode: 'observe',
    activeCycle: { cycleId: 'c-live', chatId: 'live-orch', todoIds: ['t-live'], startedAt, phase: 'running' },
    cycleChats: [{ id: 'live-orch', cycleId: 'c-live', at: startedAt, outcome: 'success' }],
  });
  addChat('sess-live-orch', 'Live', null, cwd, undefined, { id: 'live-orch', agentTransport: 'test' });
  const out = sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => true, listDelegationsForParent: () => [] },
  });
  assert.deepEqual(out.archived, [], 'a chat with a live cycle slot on the row is never swept');
  assert.ok(!storedChat('live-orch')?.archivedAt);
});

removeIsolatedDataDir();
if (failed > 0) {
  console.error(`\n${failed} workspace-watcher-archive-sweep test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace-watcher-archive-sweep tests passed');
