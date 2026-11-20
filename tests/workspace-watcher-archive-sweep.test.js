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
import { loadChatsAsync, updateChatAsync } from '../lib/persist/chats-persist.js';
import { sweepClosedWorkspaceWatcherCycles } from '../lib/workspace-watcher-archive-sweep.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { registerChatsBackendTeardown, seedChatRows, useChatsBackendFromEnv } from './helpers/chats-backends.js';

const backend = await useChatsBackendFromEnv();

/** @type {number} */
let failed = 0;

/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function runCase(name, fn) {
  try {
    await fn();
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
 * @returns {Promise<object | undefined>}
 */
async function storedChat(id) {
  return (await loadChatsAsync()).find((chat) => chat.id === id);
}

/**
 * Seeds one chat on the active backend (legacy keeps the row verbatim, so it carries explicit timestamps).
 *
 * @param {string} id
 * @param {string} title
 * @param {string} cwd
 * @param {Record<string, any>} [extra]
 * @returns {Promise<void>}
 */
async function seedChat(id, title, cwd, extra = {}) {
  const at = new Date(base).toISOString();
  await seedChatRows([{
    id, title, cursorSessionId: `sess-${id}`, workspaceFolder: cwd, agentTransport: 'test', createdAt: at, updatedAt: at, ...extra,
  }], { append: true });
}

await runCase('archives a closed-cycle family past the grace, delegation child before the parent', async () => {
  const { cwd, row } = rowFor('sweep-past-grace', {
    mode: 'observe',
    cycleChats: [{ id: 'sweep-orch', cycleId: 'c1', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  await seedChat('sweep-orch', 'Orchestrator', cwd);
  await seedChat('sweep-child', 'Child', cwd, { pickPurpose: 'implement', delegationParentChatId: 'sweep-orch' });
  const out = await sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: {
      isChatRunConfirmedIdle: () => true,
      listDelegationsForController: (parentId) => (parentId === 'sweep-orch'
        ? [{ parentChatId: 'sweep-orch', childChatId: 'sweep-child', status: 'completed' }]
        : []),
    },
  });
  assert.deepEqual(out.archived, ['sweep-child', 'sweep-orch'], 'child first, then the orchestrator');
  assert.equal(out.considered, 1);
  assert.ok((await storedChat('sweep-child'))?.archivedAt, 'child is archived in the store');
  assert.ok((await storedChat('sweep-orch'))?.archivedAt, 'orchestrator is archived in the store');
  // The sweep is read-only on the watcher row: no slot, no daily budget.
  const after = getWorkspaceWatcher(cwd);
  assert.equal((after.activeCycles || []).length, 0, 'the sweep never opens a cycle slot');
  assert.equal(after.cycles?.count || 0, 0, 'the sweep never consumes the daily cycle budget');
});

await runCase('sweeps children created after the closed-cycle parent was archived', async () => {
  const { cwd, row } = rowFor('sweep-late-children', {
    mode: 'observe',
    cycleChats: [{ id: 'late-orch', cycleId: 'c-late', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  await seedChat('late-orch', 'Orchestrator', cwd);
  await updateChatAsync('late-orch', { archived: true });
  const originalArchivedAt = (await storedChat('late-orch')).archivedAt;
  // Reproduce data written by the old delegation path; new child creation now
  // rejects archived parents, while the sweep must still repair existing trees.
  // Only the legacy store can hold such a row (the SQLite store refuses an archived parent), so the late-child
  // scenario is legacy-only.
  if (backend !== 'legacy') return;
  await seedChatRows([{
    id: 'late-child', title: 'Child', cursorSessionId: 'sess-late-child',
    workspaceFolder: cwd, agentTransport: 'test', forkParentChatId: 'late-orch',
    createdAt: new Date(base).toISOString(), updatedAt: new Date(base).toISOString(),
  }], { append: true });
  const deps = {
    isChatRunConfirmedIdle: () => true,
    listDelegationsForController: (parentId) => (parentId === 'late-orch'
      ? [{ parentChatId: 'late-orch', childChatId: 'late-child', status: 'completed' }]
      : []),
    isDelegationSlotOccupied: () => false,
  };
  assert.deepEqual((await sweepClosedWorkspaceWatcherCycles({ now: WITHIN_GRACE, rows: [row], deps })).archived, []);
  const out = await sweepClosedWorkspaceWatcherCycles({ now: PAST_GRACE, rows: [row], deps });
  assert.deepEqual(out.archived, ['late-child']);
  assert.ok((await storedChat('late-child')).archivedAt, 'the later child joins its parent in the archive');
  assert.equal((await storedChat('late-orch')).archivedAt, originalArchivedAt, 'the parent archive stamp is preserved');
  assert.deepEqual((await sweepClosedWorkspaceWatcherCycles({ now: PAST_GRACE, rows: [row], deps })).archived, []);
});

await runCase('keeps a pinned closed-cycle orchestrator', async () => {
  const { cwd, row } = rowFor('sweep-pinned', {
    mode: 'observe',
    cycleChats: [{ id: 'pin-orch', cycleId: 'c-pin', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  await seedChat('pin-orch', 'Pinned', cwd, { watcherPinned: true });
  const out = await sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => true, listDelegationsForController: () => [] },
  });
  assert.deepEqual(out.archived, [], 'a pinned orchestrator stays visible');
  assert.ok(!(await storedChat('pin-orch'))?.archivedAt);
});

await runCase('keeps a closed-cycle orchestrator inside the grace window', async () => {
  const { cwd, row } = rowFor('sweep-within-grace', {
    mode: 'observe',
    cycleChats: [{ id: 'grace-orch', cycleId: 'c-grace', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  await seedChat('grace-orch', 'Fresh', cwd);
  const out = await sweepClosedWorkspaceWatcherCycles({
    now: WITHIN_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => true, listDelegationsForController: () => [] },
  });
  assert.deepEqual(out.archived, [], 'a freshly closed cycle is not hidden before the grace');
  assert.ok(!(await storedChat('grace-orch'))?.archivedAt);
});

await runCase('keeps a closed-cycle orchestrator whose run liveness is unknown (fail-closed)', async () => {
  const { cwd, row } = rowFor('sweep-unknown', {
    mode: 'observe',
    cycleChats: [{ id: 'unknown-orch', cycleId: 'c-unknown', at: new Date(base).toISOString(), outcome: 'success' }],
  });
  await seedChat('unknown-orch', 'Unknown', cwd);
  const out = await sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => false, listDelegationsForController: () => [] },
  });
  assert.deepEqual(out.archived, [], 'unknown liveness keeps the chat (fail-closed)');
  assert.ok(!(await storedChat('unknown-orch'))?.archivedAt);
});

await runCase('never sweeps a chat that still orchestrates a live cycle', async () => {
  const startedAt = new Date(base).toISOString();
  const { cwd, row } = rowFor('sweep-live', {
    mode: 'observe',
    activeCycle: { cycleId: 'c-live', chatId: 'live-orch', todoIds: ['t-live'], startedAt, phase: 'running' },
    cycleChats: [{ id: 'live-orch', cycleId: 'c-live', at: startedAt, outcome: 'success' }],
  });
  await seedChat('live-orch', 'Live', cwd);
  const out = await sweepClosedWorkspaceWatcherCycles({
    now: PAST_GRACE,
    rows: [row],
    deps: { isChatRunConfirmedIdle: () => true, listDelegationsForController: () => [] },
  });
  assert.deepEqual(out.archived, [], 'a chat with a live cycle slot on the row is never swept');
  assert.ok(!(await storedChat('live-orch'))?.archivedAt);
});

removeIsolatedDataDir();
if (failed > 0) {
  console.error(`\n${failed} workspace-watcher-archive-sweep test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace-watcher-archive-sweep tests passed');

registerChatsBackendTeardown();
