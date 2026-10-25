/**
 * Scout active-scan collection + scan history tests (stage 1b).
 *
 * Covers the additive v2 model: the `activeScoutScans` collection (migration
 * from the legacy singleton, parallel scans, reserve/rollback, clear/expire,
 * submit authorization), the MCP autofill by `chatId`, the runtime drain count,
 * and the bounded `scoutScanHistory` retention.
 *
 * Isolation: the very first import points persist at a temp data dir; every
 * workspace and dataDir below lives in `os.tmpdir()`, never the real `data/`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCOUT_GENERAL_PROFILE_ID,
  WORKSPACE_SCOUT_CATEGORIES,
  WORKSPACE_SCOUT_PROFILE_SOURCES,
  WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_PROFILE,
  WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_WORKSPACE,
  WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS,
  WORKSPACE_WATCHER_MAX_SCOUT_FINDING_DECISIONS,
  WORKSPACE_WATCHER_MAX_SCOUT_FINDING_SOURCES,
  appendWorkspaceScoutScanHistory,
  getActiveScoutScanByChatId,
  getActiveScoutScanByScanId,
  getActiveScoutScans,
  getWorkspaceWatcher,
  getWorkspaceWatchersDataPath,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceScoutFinding,
  normalizeWorkspaceScoutFindingDecisions,
  normalizeWorkspaceScoutFindingSources,
  normalizeWorkspaceScoutFindings,
  normalizeWorkspaceScoutScanHistory,
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceScoutProfile,
  upsertWorkspaceWatcher,
  validateWorkspaceScoutProfile,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  acceptScoutFindings,
  clearActiveScoutScanIfScanId,
  expireStaleActiveScoutScan,
  listScoutFindings,
  recordScoutFindings,
  rejectScoutFindings,
  rollbackScoutScan,
  runWorkspaceWatcherScout,
  submitScoutFindings,
} from '../lib/workspace-watcher-scout.js';
import {
  getWorkspaceWatcherRuntimeStatus,
  setWorkspaceWatcherStartsEnabled,
} from '../lib/workspace-watcher-runtime-control.js';
import { loadTodosData } from '../lib/persist/todos-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;
/** @type {Promise<void>[]} */
const pending = [];

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 */
function runCase(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => console.log('OK:', name), (err) => {
        failed += 1;
        console.error('FAIL:', name);
        console.error(err && err.stack ? err.stack : String(err));
      }));
      return;
    }
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-scans-'));
let counter = 0;
/**
 * The in-process MCP client reads its data dir from a module-global runtime-deps
 * singleton, so the cases that exercise it must not interleave with each other.
 * They are queued here while the rest of the suite keeps running concurrently.
 * @type {Promise<unknown>}
 */
let mcpQueue = Promise.resolve();

/**
 * @param {string} name
 * @param {() => void | Promise<void>} fn
 * @returns {void}
 */
function runMcpCase(name, fn) {
  runCase(name, () => {
    const run = mcpQueue.then(() => fn());
    mcpQueue = run.catch(() => {});
    return run;
  });
}

/**
 * @param {string} name
 * @returns {{ cwd: string, dataDir: string }}
 */
function freshWorkspace(name) {
  counter += 1;
  const cwd = path.join(tmpRoot, `${name}-${counter}`);
  fs.mkdirSync(cwd, { recursive: true });
  const dataDir = path.join(tmpRoot, `${name}-${counter}-data`);
  fs.mkdirSync(dataDir, { recursive: true });
  return { cwd, dataDir };
}

// Lifecycle tests need a non-empty scope before a model may start.
const scopedGit = (args) => {
  if (args[0] === 'rev-parse') return 'a'.repeat(40);
  if (args[0] === 'diff' && args.includes('--name-only')) return 'lib/a.js';
  if (args[0] === 'ls-files' && args.includes('--cached')) return 'lib/a.js';
  return '';
};

/**
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {object} row
 * @returns {void}
 */
function writeLegacyV1Document(dataDir, workspaceFolder, row) {
  const filePath = getWorkspaceWatchersDataPath({ dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    v: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
    items: { [workspaceFolder]: row },
  }), 'utf8');
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function validProfile(overrides = {}) {
  return {
    id: 'perf',
    name: 'Wydajność zapytań',
    description: '',
    enabled: false,
    objective: 'Znajdź N+1 i brakujące indeksy.',
    instructions: 'Każda propozycja wskazuje zapytanie i sposób pomiaru.',
    scope: { mode: 'area', base: 'main', include: ['lib/orders/**'], exclude: [] },
    sources: [...WORKSPACE_SCOUT_PROFILE_SOURCES],
    categories: [...WORKSPACE_SCOUT_CATEGORIES],
    executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
    schedule: { mode: 'manual', intervalHours: 6 },
    limits: { maxPerDay: 4, maxFindingsPerScan: 10, timeoutMs: 60_000 },
    ...overrides,
  };
}

/* ---------------------------------------------------- legacy migration */

runCase('legacy activeScoutScan migrates to exactly one collection record with a general snapshot', () => {
  const { cwd, dataDir } = freshWorkspace('scan-migrate');
  writeLegacyV1Document(dataDir, cwd, {
    workspaceFolder: cwd,
    mode: 'observe',
    policy: { scoutEnabled: true },
    activeScoutScan: {
      scanId: 'scan-legacy',
      chatId: 'chat-legacy',
      startedAt: '2026-02-02T10:00:00.000Z',
      expiresAt: '2026-02-02T11:00:00.000Z',
      submitToken: 'tok-legacy',
    },
  });

  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeScoutScans.length, 1);
  const scan = row.activeScoutScans[0];
  assert.equal(scan.scanId, 'scan-legacy');
  assert.equal(scan.chatId, 'chat-legacy');
  assert.equal(scan.submitToken, 'tok-legacy');
  assert.equal(scan.startedAt, '2026-02-02T10:00:00.000Z');
  assert.equal(scan.expiresAt, '2026-02-02T11:00:00.000Z');
  assert.equal(scan.scoutId, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(scan.scoutRevision, 1);
  assert.equal(scan.snapshot?.id, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(scan.status, 'running');
  // The derived v1 mirror reflects the first collection entry.
  assert.equal(row.activeScoutScan.scanId, 'scan-legacy');
  assert.equal(row.activeScoutScan.submitToken, 'tok-legacy');

  // Re-normalizing the same row yields one record, not two.
  const again = normalizeWorkspaceWatcherRow(row);
  assert.equal(again.activeScoutScans.length, 1);
  assert.equal(again.activeScoutScans[0].scanId, 'scan-legacy');
  assert.equal(again.activeScoutScan.scanId, 'scan-legacy');

  // A load -> save -> load round-trip does not duplicate either.
  upsertWorkspaceWatcher(cwd, { lastTickAt: '2026-03-03T00:00:00.000Z' }, { dataDir });
  const reloaded = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(reloaded.activeScoutScans.length, 1);
  assert.equal(reloaded.activeScoutScans[0].scanId, 'scan-legacy');
  assert.equal(reloaded.activeScoutScan.scanId, 'scan-legacy');

  const doc = JSON.parse(fs.readFileSync(getWorkspaceWatchersDataPath({ dataDir }), 'utf8'));
  assert.equal(doc.v, 2);
  assert.equal(doc.items[cwd].activeScoutScans.length, 1);
  assert.equal(doc.items[cwd].activeScoutScans[0].submitToken, 'tok-legacy');
});

runCase('an explicit activeScoutScans key (even []) is never migrated again', () => {
  const empty = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/scan-empty',
    activeScoutScan: { scanId: '', chatId: '' },
  });
  assert.deepEqual(empty.activeScoutScans, []);
  assert.equal(empty.activeScoutScan.scanId, '');

  const explicit = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/scan-explicit',
    activeScoutScan: { scanId: 'ignored', chatId: 'c' },
    activeScoutScans: [],
  });
  assert.deepEqual(explicit.activeScoutScans, []);
  assert.equal(explicit.activeScoutScan.scanId, '');
});

/* -------------------------------------------------- parallel scans */

runCase('two parallel scans coexist; expiry of one never removes the other', () => {
  const { cwd, dataDir } = freshWorkspace('scan-parallel-expire');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const now = Date.parse('2026-04-04T12:00:00.000Z');
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      { scanId: 'A', chatId: 'chat-A', expiresAt: '2026-04-04T11:59:00.000Z', submitToken: 'tok-A' },
      { scanId: 'B', chatId: 'chat-B', expiresAt: '2026-04-04T13:00:00.000Z', submitToken: 'tok-B' },
    ],
  }), { dataDir });

  assert.deepEqual(
    getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).map((scan) => scan.scanId).sort(),
    ['A', 'B'],
  );

  assert.equal(expireStaleActiveScoutScan(cwd, { dataDir, now }), true);
  const afterExpire = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(afterExpire.activeScoutScans.map((scan) => scan.scanId), ['B']);
  assert.equal(afterExpire.activeScoutScan.scanId, 'B', 'mirror follows the remaining scan');

  // Clearing A when only B remains is a no-op for B.
  assert.equal(clearActiveScoutScanIfScanId(cwd, 'A', { dataDir }), false);
  assert.deepEqual(
    getWorkspaceWatcher(cwd, { dataDir }).activeScoutScans.map((scan) => scan.scanId),
    ['B'],
  );
  assert.equal(clearActiveScoutScanIfScanId(cwd, 'B', { dataDir }), true);
  assert.deepEqual(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScans, []);
});

runCase('submit A is authorized while a parallel scan B is present', () => {
  const { cwd, dataDir } = freshWorkspace('scan-parallel-submit');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      { scanId: 'A', chatId: 'chat-A', expiresAt: future, submitToken: 'tok-A' },
      { scanId: 'B', chatId: 'chat-B', expiresAt: future, submitToken: 'tok-B' },
    ],
  }), { dataDir });

  const result = submitScoutFindings(cwd, {
    dataDir,
    findings: [{ title: 'Parallel A', category: 'bug' }],
    sourceChatId: 'chat-A',
    scanId: 'A',
    scoutSubmitToken: 'tok-A',
  });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);

  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(after.activeScoutScans.map((scan) => scan.scanId), ['B'], 'A cleared, B kept');
});

/* -------------------------------------------------- reserve / rollback */

runCase('reserve appends an attempt record and rollback removes only its own scan', async () => {
  const { cwd, dataDir } = freshWorkspace('scan-reserve');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    scoutScans: { day: '2026-01-01', count: 5 },
    activeScoutScans: [
      { scanId: 'B', chatId: 'chat-B', expiresAt: '2030-01-01T00:00:00.000Z', submitToken: 'tok-B' },
    ],
  }), { dataDir });

  let seen = null;
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: Date.parse('2026-06-06T10:00:00.000Z'),
    deps: {
      execGit: scopedGit,
      runScout: async ({ scanId }) => {
        const row = getWorkspaceWatcher(cwd, { dataDir });
        seen = row.activeScoutScans.find((scan) => scan.scanId === scanId) || null;
        throw new Error('boom');
      },
    },
  });

  assert.equal(result.reason, 'scout_failed');
  assert.ok(seen, 'the reserved record exists before handoff');
  assert.equal(seen.status, 'reserved');
  assert.equal(seen.scoutId, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(seen.snapshot?.id, SCOUT_GENERAL_PROFILE_ID);
  assert.ok(seen.attemptId, 'attemptId is minted at reservation');
  assert.equal(seen.launchIssued, false);
  assert.ok(Date.parse(seen.startDeadlineAt) > Date.parse(seen.reservedAt), 'start deadline follows reservedAt');

  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(after.activeScoutScans.map((scan) => scan.scanId), ['B'], 'only the failed scan is removed');
  assert.deepEqual(after.scoutScans, { day: '2026-01-01', count: 5 }, 'previous counters restored');
  assert.equal(after.lastScoutAt, '');
});

runCase('clearActiveScoutScanIfScanId does not clear a successor scan', () => {
  const { cwd, dataDir } = freshWorkspace('scan-successor');
  const future = new Date(Date.now() + 60_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      { scanId: 'successor', chatId: 'chat-s', expiresAt: future, submitToken: 'tok-s' },
    ],
  }), { dataDir });
  assert.equal(clearActiveScoutScanIfScanId(cwd, 'older', { dataDir }), false);
  assert.equal(
    getActiveScoutScanByScanId(getWorkspaceWatcher(cwd, { dataDir }), 'successor').scanId,
    'successor',
  );
  assert.equal(clearActiveScoutScanIfScanId(cwd, 'successor', { dataDir }), true);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan.scanId, '');
});

/* -------------------------------------------------- MCP autofill */

runMcpCase('MCP autofill uses the record found by chatId and never leaks it to a foreign chat', async () => {
  const { cwd, dataDir } = freshWorkspace('scan-autofill');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      { scanId: 'scan-own', chatId: 'chat-own', expiresAt: future, submitToken: 'tok-own' },
      { scanId: 'scan-other', chatId: 'chat-other', expiresAt: future, submitToken: 'tok-other' },
    ],
  }), { dataDir });
  assert.equal(getActiveScoutScanByChatId(getWorkspaceWatcher(cwd, { dataDir }), 'chat-other').submitToken, 'tok-other');
  assert.equal(getActiveScoutScanByChatId(getWorkspaceWatcher(cwd, { dataDir }), 'chat-nobody'), null);

  setBuiltinMcpRuntimeDeps({ dataDir });
  const client = createInProcessMcpClient({});

  // Foreign chat gets no credentials, so submit is refused.
  await assert.rejects(
    () => client.workspaceWatcherScout({
      action: 'submit',
      workspaceFolder: cwd,
      sourceChatId: 'chat-foreign',
      findings: [{ title: 'Foreign', category: 'bug' }],
    }),
    /No active Scout scan/,
  );
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings.length, 0);

  // The owner omits scan_id/submit_token on purpose: autofill fills them.
  const own = await client.workspaceWatcherScout({
    action: 'submit',
    workspaceFolder: cwd,
    sourceChatId: 'chat-own',
    findings: [{ title: 'Autofilled', category: 'bug' }],
  });
  assert.equal(own.ok, true);
  assert.equal(own.added, 1);
  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(after.pendingScoutFindings[0].title, 'Autofilled');
  assert.deepEqual(after.activeScoutScans.map((scan) => scan.scanId), ['scan-other'], 'only the owner scan cleared');
});

/* -------------------------------------------------- runtime control */

runCase('runtime status counts live collection records and skips expired ones', () => {
  const { cwd, dataDir } = freshWorkspace('scan-runtime');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const now = Date.parse('2026-05-05T12:00:00.000Z');
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      { scanId: 'live-1', chatId: 'c1', expiresAt: '2026-05-05T13:00:00.000Z' },
      { scanId: 'live-2', chatId: 'c2', expiresAt: '2026-05-05T13:00:00.000Z' },
      { scanId: 'dead', chatId: 'c3', expiresAt: '2026-05-05T11:00:00.000Z' },
    ],
  }), { dataDir });

  const status = getWorkspaceWatcherRuntimeStatus({ dataDir, now });
  assert.equal(status.activeScoutScans, 2);
  assert.equal(status.activeProcesses, 2);

  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: false });
  const draining = getWorkspaceWatcherRuntimeStatus({ dataDir, now });
  assert.equal(draining.draining, true);
  assert.equal(draining.readyForRestart, false);
});

/* -------------------------------------------------- restart flow */

runMcpCase('after a restart the migrated legacy flow still autofills, submits and clears', async () => {
  const { cwd, dataDir } = freshWorkspace('scan-restart');
  const future = new Date(Date.now() + 3_600_000).toISOString();
  writeLegacyV1Document(dataDir, cwd, {
    workspaceFolder: cwd,
    mode: 'observe',
    policy: { scoutEnabled: true },
    activeScoutScan: {
      scanId: 'scan-r',
      chatId: 'chat-r',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: future,
      submitToken: 'tok-r',
    },
  });

  // The "migration write" then a fresh read is the restart boundary.
  upsertWorkspaceWatcher(cwd, { lastTickAt: '2026-07-07T00:00:00.000Z' }, { dataDir });
  const reloaded = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(reloaded.activeScoutScans.length, 1);
  assert.equal(reloaded.activeScoutScans[0].submitToken, 'tok-r');
  assert.equal(reloaded.activeScoutScan.scanId, 'scan-r');

  setBuiltinMcpRuntimeDeps({ dataDir });
  const client = createInProcessMcpClient({});
  const submitted = await client.workspaceWatcherScout({
    action: 'submit',
    workspaceFolder: cwd,
    sourceChatId: 'chat-r',
    findings: [{ title: 'Restart finding', category: 'bug' }],
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.added, 1);

  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(after.activeScoutScans, []);
  assert.equal(after.activeScoutScan.scanId, '');
  assert.equal(after.pendingScoutFindings.length, 1);
});

/* -------------------------------------------------- history */

runCase('scan history records reserved -> running -> completed and keeps usage null', async () => {
  const { cwd, dataDir } = freshWorkspace('scan-history-flow');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });

  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: Date.parse('2026-06-06T10:00:00.000Z'),
    deps: {
      execGit: scopedGit,
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'test', model: 'test-model' }),
      addChat: () => ({ id: 'chat-history' }),
      startChatRun: async () => ({ runId: 'run-history' }),
    },
  });
  assert.equal(result.scanned, true);

  const running = getWorkspaceWatcher(cwd, { dataDir });
  const runningEntry = running.scoutScanHistory.find((entry) => entry.scanId === result.scanId);
  assert.ok(runningEntry, 'the reserved scan has a history entry');
  assert.equal(runningEntry.status, 'running');
  assert.equal(runningEntry.chatId, 'chat-history');
  assert.equal(runningEntry.scoutId, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(runningEntry.usage, null, 'no measurement is null, not zero');
  assert.equal(runningEntry.added, 0);
  assert.deepEqual(runningEntry.executor, { harness: '', model: '' });

  assert.equal(clearActiveScoutScanIfScanId(cwd, result.scanId, { dataDir }), true);
  const done = getWorkspaceWatcher(cwd, { dataDir });
  const doneEntry = done.scoutScanHistory.find((entry) => entry.scanId === result.scanId);
  assert.equal(doneEntry.status, 'completed');
  assert.ok(doneEntry.finishedAt);
  assert.equal(done.scoutScanHistory.filter((entry) => entry.scanId === result.scanId).length, 1);
});

runCase('expiry settles the matching history entry as interrupted', () => {
  const { cwd, dataDir } = freshWorkspace('scan-history-expire');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      { scanId: 'scan-x', chatId: 'chat-x', expiresAt: '2026-06-06T09:59:00.000Z' },
    ],
    scoutScanHistory: [
      { scanId: 'scan-x', scoutId: SCOUT_GENERAL_PROFILE_ID, status: 'reserved', startedAt: '2026-06-06T09:00:00.000Z', usage: null },
    ],
  }), { dataDir });

  assert.equal(expireStaleActiveScoutScan(cwd, { dataDir, now }), true);
  const entry = getWorkspaceWatcher(cwd, { dataDir }).scoutScanHistory.find((item) => item.scanId === 'scan-x');
  assert.equal(entry.status, 'interrupted');
  assert.ok(entry.finishedAt);
});

runCase('scan history caps terminal entries per profile and per workspace, never non-terminal', () => {
  /** @param {string} profile @param {number} count @param {string} status */
  const make = (profile, count, status) => Array.from({ length: count }, (_, i) => ({
    scanId: `${profile}-${status}-${i}`,
    scoutId: profile,
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
  }));

  const oneProfile = normalizeWorkspaceScoutScanHistory([
    ...make('p1', 30, 'reserved'),
    ...make('p1', 150, 'completed'),
  ]);
  assert.equal(
    oneProfile.filter((entry) => entry.status === 'completed').length,
    WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_PROFILE,
  );
  assert.equal(oneProfile.filter((entry) => entry.status === 'reserved').length, 30, 'non-terminal kept');

  /** @type {object[]} */
  const many = [];
  for (let p = 0; p < 11; p += 1) many.push(...make(`p${p}`, 150, 'completed'));
  const capped = normalizeWorkspaceScoutScanHistory(many);
  assert.equal(capped.length, WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_WORKSPACE);

  const mixed = normalizeWorkspaceScoutScanHistory([
    ...many,
    ...make('p0', 5, 'uncertain'),
  ]);
  assert.equal(
    mixed.filter((entry) => entry.status === 'uncertain').length,
    5,
    'non-terminal survives the workspace cap',
  );
  assert.ok(mixed.length >= WORKSPACE_SCOUT_SCAN_HISTORY_MAX_PER_WORKSPACE);
});

runCase('appendWorkspaceScoutScanHistory updates by scanId instead of duplicating', () => {
  const row = { scoutScanHistory: [] };
  const first = appendWorkspaceScoutScanHistory(row, {
    scanId: 's1',
    scoutId: SCOUT_GENERAL_PROFILE_ID,
    status: 'reserved',
    startedAt: '2026-01-01T00:00:00.000Z',
    usage: null,
  });
  assert.equal(first.scoutScanHistory.length, 1);
  const second = appendWorkspaceScoutScanHistory(first, {
    scanId: 's1',
    status: 'completed',
    finishedAt: '2026-01-01T00:10:00.000Z',
    added: 3,
  });
  assert.equal(second.scoutScanHistory.length, 1, 'no duplicate for the same scanId');
  assert.equal(second.scoutScanHistory[0].status, 'completed');
  assert.equal(second.scoutScanHistory[0].added, 3);
  assert.equal(second.scoutScanHistory[0].scoutId, SCOUT_GENERAL_PROFILE_ID, 'earlier fields survive the update');
  assert.equal(second.scoutScanHistory[0].usage, null);

  const measured = normalizeWorkspaceScoutScanHistory([
    { scanId: 's2', status: 'completed', usage: { tokens: 42, costUsd: 0.01 } },
  ]);
  assert.deepEqual(measured[0].usage, { tokens: 42, costUsd: 0.01 });
});

/* -------------------------------------------------- findings sources[] */

runCase('legacy source migrates into sources[0] without inventing fields', () => {
  const finding = normalizeWorkspaceScoutFinding({
    title: 'Legacy attribution',
    category: 'bug',
    source: { scanner: 'scanner-1', chatId: 'chat-1', runId: 'run-1' },
  });
  assert.ok(finding);
  assert.deepEqual(finding.source, { scanner: 'scanner-1', chatId: 'chat-1', runId: 'run-1' });
  assert.equal(finding.sources.length, 1);
  assert.deepEqual(finding.sources[0], {
    scoutId: '',
    scoutRevision: 0,
    scanId: '',
    chatId: 'chat-1',
    runId: 'run-1',
    scanner: 'scanner-1',
    harness: '',
    model: '',
    at: '',
  });

  // No attribution at all: an empty list, nothing invented.
  const bare = normalizeWorkspaceScoutFinding({ title: 'Bare', category: 'bug' });
  assert.deepEqual(bare.sources, []);
  assert.equal(bare.source, undefined);

  // An explicit `sources` list wins; the legacy `source` is not merged in.
  const explicit = normalizeWorkspaceScoutFinding({
    title: 'Explicit',
    category: 'bug',
    source: { scanner: 'legacy' },
    sources: [{ scanId: 'scan-1', chatId: 'chat-1' }],
  });
  assert.equal(explicit.sources.length, 1);
  assert.equal(explicit.sources[0].scanId, 'scan-1');
  assert.equal(explicit.sources[0].scanner, '');
  assert.deepEqual(explicit.source, { scanner: 'legacy', chatId: '', runId: '' });
});

runCase('stored sources[] round-trips and normalization dedupes/caps it', () => {
  const stored = {
    title: 'Round trip',
    category: 'security',
    sources: [{
      scoutId: SCOUT_GENERAL_PROFILE_ID,
      scoutRevision: 2,
      scanId: 's-1',
      chatId: 'c-1',
      runId: 'r-1',
      scanner: 'scanner',
      harness: 'h',
      model: 'm',
      at: '2026-01-02T00:00:00.000Z',
    }],
  };
  const once = normalizeWorkspaceScoutFinding(stored);
  const twice = normalizeWorkspaceScoutFinding(once);
  assert.deepEqual(twice.sources, once.sources);
  assert.equal(twice.sources[0].scoutRevision, 2);
  assert.equal(twice.sources[0].runId, 'r-1');
  assert.equal(twice.sources[0].harness, 'h');
  assert.equal(twice.sources[0].model, 'm');
  assert.equal(twice.sources[0].at, '2026-01-02T00:00:00.000Z');

  // The stored row keeps them too.
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/finding-roundtrip',
    pendingScoutFindings: [stored],
  });
  assert.deepEqual(row.pendingScoutFindings[0].sources, once.sources);

  // Stable key dedupe + merge: a collision never loses a field.
  const merged = normalizeWorkspaceScoutFindingSources([
    { scanId: 's', chatId: 'c', at: 'T', scanner: 'x', harness: 'h' },
    { scanId: 's', chatId: 'c', at: 'T', scanner: 'x', model: 'm' },
  ]);
  assert.equal(merged.length, 1, 'same scanId|chatId|at|scanner dedupes');
  assert.equal(merged[0].harness, 'h');
  assert.equal(merged[0].model, 'm');
  assert.equal(merged[0].at, 'T');

  // Hard cap keeps the newest entries.
  const many = Array.from({ length: 30 }, (_, i) => ({
    scanId: `s-${i}`,
    chatId: 'c',
    at: '2026-01-01T00:00:00.000Z',
  }));
  const capped = normalizeWorkspaceScoutFindingSources(many);
  assert.equal(capped.length, WORKSPACE_WATCHER_MAX_SCOUT_FINDING_SOURCES);
  assert.equal(capped[capped.length - 1].scanId, 's-29');
});

runCase('forcePending normalizes away caller sources/source/scanId/sourceChatId', () => {
  const [finding] = normalizeWorkspaceScoutFindings([{
    title: 'Untrusted',
    category: 'bug',
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    scanId: 'evil-scan',
    sourceChatId: 'evil-chat',
    source: { scanner: 'evil', chatId: 'evil-chat', runId: 'evil-run' },
    sources: [{ scoutId: 'evil', scanId: 'evil-scan' }],
  }], { forcePending: true });
  assert.ok(finding);
  assert.notEqual(finding.id, '00000000-0000-4000-8000-000000000001');
  assert.equal(finding.status, 'pending');
  assert.equal(finding.source, undefined);
  assert.deepEqual(finding.sources, []);
  assert.equal(finding.scanId, undefined);
  assert.equal(finding.sourceChatId, undefined);
  assert.notEqual(finding.createdAt, '1970-01-01T00:00:00.000Z');
});

runCase('recordScoutFindings stamps sources[] from the active scan and never duplicates', () => {
  const { cwd, dataDir } = freshWorkspace('finding-stamp');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [{
      scanId: 'scan-stamp',
      scoutId: SCOUT_GENERAL_PROFILE_ID,
      scoutRevision: 3,
      chatId: 'chat-stamp',
      expiresAt: future,
      submitToken: 'tok-stamp',
    }],
  }), { dataDir });

  const opts = {
    dataDir,
    scanId: 'scan-stamp',
    sourceChatId: 'chat-stamp',
    runId: 'run-stamp',
    harness: 'test-harness',
    model: 'test-model',
    now: Date.parse('2026-06-06T10:00:00.000Z'),
  };
  const first = recordScoutFindings(cwd, [{ title: 'Stamped', category: 'bug' }], opts);
  assert.equal(first.added, 1);
  const stored = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings
    .find((item) => item.title === 'Stamped');
  assert.equal(stored.sources.length, 1);
  assert.deepEqual(stored.sources[0], {
    scoutId: SCOUT_GENERAL_PROFILE_ID,
    scoutRevision: 3,
    scanId: 'scan-stamp',
    chatId: 'chat-stamp',
    runId: 'run-stamp',
    scanner: '',
    harness: 'test-harness',
    model: 'test-model',
    at: '2026-06-06T10:00:00.000Z',
  });

  // Re-proposing the same finding is deduped and keeps a single entry.
  const second = recordScoutFindings(cwd, [{ title: 'Stamped', category: 'bug' }], opts);
  assert.equal(second.added, 0);
  const again = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings
    .filter((item) => item.title === 'Stamped');
  assert.equal(again.length, 1);
  assert.equal(again[0].sources.length, 1);
  assert.deepEqual(again[0].sources, stored.sources);
});

runCase('submit cannot smuggle attribution; sources[] survive resolution and list', () => {
  const { cwd, dataDir } = freshWorkspace('finding-submit');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [{
      scanId: 'scan-src',
      scoutId: SCOUT_GENERAL_PROFILE_ID,
      scoutRevision: 4,
      chatId: 'chat-src',
      expiresAt: future,
      submitToken: 'tok-src',
    }],
  }), { dataDir });

  const submitted = submitScoutFindings(cwd, {
    dataDir,
    findings: [{
      title: 'Attributed',
      category: 'security',
      sources: [{ scoutId: 'evil', scanId: 'evil-scan', chatId: 'evil-chat', at: '1970-01-01T00:00:00.000Z' }],
      source: { scanner: 'evil', chatId: 'evil-chat', runId: 'evil-run' },
      scanId: 'evil-scan',
      sourceChatId: 'evil-chat',
    }],
    sourceChatId: 'chat-src',
    scanId: 'scan-src',
    scoutSubmitToken: 'tok-src',
  });
  assert.equal(submitted.added, 1);

  const finding = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings
    .find((item) => item.title === 'Attributed');
  assert.equal(finding.source, undefined);
  assert.equal(finding.sources.length, 1);
  assert.deepEqual(finding.sources[0], {
    scoutId: SCOUT_GENERAL_PROFILE_ID,
    scoutRevision: 4,
    scanId: 'scan-src',
    chatId: 'chat-src',
    runId: '',
    scanner: '',
    harness: '',
    model: '',
    at: finding.sources[0].at,
  });
  assert.ok(finding.sources[0].at, 'server stamps the time');
  assert.equal(finding.scanId, 'scan-src');
  assert.equal(finding.sourceChatId, 'chat-src');

  const accepted = acceptScoutFindings(cwd, [finding.id], { dataDir });
  assert.equal(accepted.changed, 1);
  const listed = listScoutFindings(cwd, { dataDir });
  assert.equal(listed[0].status, 'accepted');
  assert.deepEqual(listed[0].sources, finding.sources, 'attribution survives accept and list');
});

/* -------------------------------------------------- rollback minor fixes */

runCase('rollback refunds only its own slot and is idempotent (N3/M2a)', () => {
  const { cwd, dataDir } = freshWorkspace('rollback-idempotent');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  const reservedAt = '2026-06-06T10:00:00.000Z';
  mutateWorkspaceWatcherRow(cwd, () => ({
    lastScoutAt: reservedAt,
    scoutScans: { day: '2026-06-06', count: 7 },
    activeScoutScans: [
      { scanId: 'A', chatId: 'chat-A' },
      { scanId: 'B', chatId: 'chat-B' },
    ],
  }), { dataDir });

  const options = {
    dataDir,
    scanId: 'A',
    now: Date.parse('2026-06-06T10:05:00.000Z'),
    reservedAt,
    reservedScans: { day: '2026-06-06', count: 6 },
    previousLastScoutAt: '',
    previousScans: { day: '2026-06-06', count: 5 },
  };
  assert.equal(rollbackScoutScan(cwd, options), true);
  let row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.activeScoutScans.map((scan) => scan.scanId), ['B'], 'B survives');
  assert.deepEqual(row.scoutScans, { day: '2026-06-06', count: 6 }, 'A refunded, B keeps its slot');

  // A replay of the same rollback must not decrement again.
  assert.equal(rollbackScoutScan(cwd, { ...options, now: Date.parse('2026-06-06T10:06:00.000Z') }), false);
  row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.scoutScans, { day: '2026-06-06', count: 6 }, 'idempotent');
  const history = row.scoutScanHistory.filter((entry) => entry.scanId === 'A');
  assert.equal(history.length, 1, 'history settled exactly once');
  assert.equal(history[0].status, 'failed');
});

runCase('rollback across a UTC day boundary never decrements the new day counter (M2b)', () => {
  const { cwd, dataDir } = freshWorkspace('rollback-utc');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  // A reserved on D-1; B reserved on D (the counter reset); A's rollback arrives on D.
  mutateWorkspaceWatcherRow(cwd, () => ({
    lastScoutAt: '2026-06-06T00:00:05.000Z',
    scoutScans: { day: '2026-06-06', count: 1 },
    activeScoutScans: [
      { scanId: 'A', chatId: 'chat-A' },
      { scanId: 'B', chatId: 'chat-B' },
    ],
  }), { dataDir });

  rollbackScoutScan(cwd, {
    dataDir,
    scanId: 'A',
    now: Date.parse('2026-06-06T00:00:05.000Z'),
    reservedAt: '2026-06-05T23:59:00.000Z',
    reservedScans: { day: '2026-06-05', count: 4 },
    previousLastScoutAt: '',
    previousScans: { day: '2026-06-05', count: 3 },
  });

  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.activeScoutScans.map((scan) => scan.scanId), ['B']);
  assert.deepEqual(row.scoutScans, { day: '2026-06-06', count: 1 }, 'today counter untouched');
});

runCase('a scan that never started settles its history as failed (M4)', async () => {
  const { cwd, dataDir } = freshWorkspace('scan-never-started');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });

  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: Date.parse('2026-06-06T10:00:00.000Z'),
    deps: {
      execGit: scopedGit,
      runScout: async () => ({ started: false, reason: 'orchestrator_unavailable' }),
    },
  });
  assert.equal(result.scanned, false);
  assert.equal(result.reason, 'orchestrator_unavailable');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.activeScoutScans, []);
  const entry = row.scoutScanHistory.find((item) => item.scanId === result.scanId);
  assert.equal(entry.status, 'failed', 'a never-started scan is not completed');
  assert.ok(entry.finishedAt);
});

runCase('getActiveScoutScans ignores the legacy singleton once the collection key exists (N1)', () => {
  assert.deepEqual(
    getActiveScoutScans({ activeScoutScan: { scanId: 'legacy', chatId: 'c' } }).map((scan) => scan.scanId),
    ['legacy'],
    'key absent: legacy is adapted',
  );
  assert.deepEqual(
    getActiveScoutScans({ activeScoutScans: [], activeScoutScan: { scanId: 'legacy', chatId: 'c' } }),
    [],
    'key present but empty: no stale fallback',
  );
  assert.deepEqual(
    getActiveScoutScans({
      activeScoutScans: [{ scanId: 'new', chatId: 'c' }],
      activeScoutScan: { scanId: 'legacy', chatId: 'c' },
    }).map((scan) => scan.scanId),
    ['new'],
    'collection wins over the singleton',
  );
});

/* -------------------------------------------------- minor D1/D2 */

runCase('validateWorkspaceScoutProfile rejects a glob list over the cap', () => {
  const tooMany = Array.from({ length: 201 }, (_, i) => `lib/f${i}/**`);
  const include = validateWorkspaceScoutProfile(validProfile({
    scope: { mode: 'area', base: 'main', include: tooMany, exclude: [] },
  }));
  assert.equal(include.ok, false);
  assert.ok(include.errors.some((error) => /scope\.include.*glob/i.test(error)), include.errors.join('; '));

  const exclude = validateWorkspaceScoutProfile(validProfile({
    scope: { mode: 'area', base: 'main', include: [], exclude: tooMany },
  }));
  assert.equal(exclude.ok, false);
  assert.ok(exclude.errors.some((error) => /scope\.exclude.*glob/i.test(error)), exclude.errors.join('; '));

  const atCap = validateWorkspaceScoutProfile(validProfile({
    scope: { mode: 'area', base: 'main', include: Array.from({ length: 200 }, (_, i) => `lib/f${i}/**`), exclude: [] },
  }));
  assert.equal(atCap.ok, true);
});

runCase('a profile payload cannot overwrite server-owned id/revision/createdAt/updatedAt', () => {
  const { cwd, dataDir } = freshWorkspace('scan-profile-server-fields');
  const created = upsertWorkspaceScoutProfile(cwd, validProfile(), { dataDir });
  assert.equal(created.ok, true);
  const createdProfile = created.profile;

  const updated = upsertWorkspaceScoutProfile(cwd, {
    ...validProfile({ name: 'Zmieniona nazwa' }),
    id: 'perf',
    revision: 99,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  }, { dataDir, expectedRevision: 1 });
  assert.equal(updated.ok, true);
  assert.equal(updated.profile.id, 'perf', 'id stays server-owned');
  assert.equal(updated.profile.revision, 2, 'revision is bumped by the server, not the payload');
  assert.equal(updated.profile.createdAt, createdProfile.createdAt, 'createdAt is immutable');
  assert.notEqual(updated.profile.updatedAt, '1970-01-01T00:00:00.000Z', 'updatedAt is stamped by the server');
  assert.equal(updated.profile.name, 'Zmieniona nazwa');
});

/* --------------------------------------- findings dedupe / capacity / decisions */

runCase('duplicate submissions merge into one proposal with two sources, replay is idempotent', () => {
  const { cwd, dataDir } = freshWorkspace('finding-merge');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      {
        scanId: 'scan-A', scoutId: SCOUT_GENERAL_PROFILE_ID, scoutRevision: 1,
        chatId: 'chat-A', expiresAt: future, submitToken: 'tok-A',
      },
      {
        scanId: 'scan-B', scoutId: SCOUT_GENERAL_PROFILE_ID, scoutRevision: 2,
        chatId: 'chat-B', expiresAt: future, submitToken: 'tok-B',
      },
    ],
  }), { dataDir });

  // Two scans race to report the same problem. Dedupe + merge run under the
  // store lock, so the second call folds its attribution into the first.
  const first = recordScoutFindings(cwd, [{ title: 'Race finding', category: 'bug' }], {
    dataDir, scanId: 'scan-A', sourceChatId: 'chat-A', now: Date.parse('2026-06-06T10:00:00.000Z'),
  });
  const second = recordScoutFindings(cwd, [{ title: 'Race finding', category: 'bug' }], {
    dataDir, scanId: 'scan-B', sourceChatId: 'chat-B', now: Date.parse('2026-06-06T10:00:05.000Z'),
  });
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.merged, 1, 'the second scan merged into the existing proposal');

  let row = getWorkspaceWatcher(cwd, { dataDir });
  let matches = row.pendingScoutFindings.filter((finding) => finding.title === 'Race finding');
  assert.equal(matches.length, 1, 'exactly one proposal');
  assert.equal(matches[0].status, 'pending');
  assert.equal(matches[0].sources.length, 2, 'two attribution sources');
  assert.deepEqual(
    matches[0].sources.map((source) => source.scanId).sort(),
    ['scan-A', 'scan-B'],
  );
  assert.ok(second.dropped.some((entry) => entry.reason === 'already_pending'));

  // A replay of the same scan (even with a fresh server timestamp) is
  // idempotent: the source identity is the scan, not the moment it arrived.
  const retry = recordScoutFindings(cwd, [{ title: 'Race finding', category: 'bug' }], {
    dataDir, scanId: 'scan-A', sourceChatId: 'chat-A', now: Date.parse('2026-06-06T10:00:09.000Z'),
  });
  assert.equal(retry.added, 0);
  assert.equal(retry.merged, 0, 'a replayed source does not merge a third entry');
  row = getWorkspaceWatcher(cwd, { dataDir });
  matches = row.pendingScoutFindings.filter((finding) => finding.title === 'Race finding');
  assert.equal(matches[0].sources.length, 2, 'still exactly two sources');
});

runCase('cross-process race: two children submit the same problem into one merged proposal', async () => {
  const { cwd, dataDir } = freshWorkspace('finding-merge-proc');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      {
        scanId: 'proc-A', scoutId: SCOUT_GENERAL_PROFILE_ID,
        chatId: 'proc-chat-A', expiresAt: future, submitToken: 'proc-tok-A',
      },
      {
        scanId: 'proc-B', scoutId: SCOUT_GENERAL_PROFILE_ID,
        chatId: 'proc-chat-B', expiresAt: future, submitToken: 'proc-tok-B',
      },
    ],
  }), { dataDir });

  const helperPath = fileURLToPath(new URL('./helpers/workspace-scout-merge-child.js', import.meta.url));
  const startAt = Date.now() + 600;
  const children = [
    { scanId: 'proc-A', chatId: 'proc-chat-A' },
    { scanId: 'proc-B', chatId: 'proc-chat-B' },
  ].map((entry) => new Promise((resolve) => {
    const child = spawn(process.execPath, [
      helperPath, dataDir, cwd, entry.scanId, entry.chatId, String(startAt),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CRETLI_TEST_DATA_DIR: dataDir,
        CURSOR_REMOTE_TEST_DATA_DIR: dataDir,
        CRETLI_DATA_DIR: dataDir,
        CURSOR_REMOTE_DATA_DIR: dataDir,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => resolve({ code, out, err }));
  }));
  const results = await Promise.all(children);
  for (const result of results) {
    assert.equal(result.code, 0, `child exited with ${result.code}: ${result.err || result.out}`);
  }
  const stats = results.map((result) => JSON.parse(result.out.trim().split('\n').at(-1)));
  assert.equal(stats.reduce((sum, stat) => sum + stat.added, 0), 1, 'exactly one new proposal');
  assert.equal(stats.reduce((sum, stat) => sum + stat.merged, 0), 1, 'the other child merged its source');

  const row = getWorkspaceWatcher(cwd, { dataDir });
  const matches = row.pendingScoutFindings.filter((finding) => finding.title === 'Cross process race');
  assert.equal(matches.length, 1, 'one proposal across processes');
  assert.deepEqual(
    matches[0].sources.map((source) => source.scanId).sort(),
    ['proc-A', 'proc-B'],
    'both processes attributed the proposal',
  );
});

runCase('capacity_exceeded rejects a 201st unique finding without dropping the oldest', () => {
  const { cwd, dataDir } = freshWorkspace('finding-capacity');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const seeded = normalizeWorkspaceScoutFindings(Array.from(
    { length: WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS },
    (_, i) => ({ title: `Capacity ${i}`, category: 'improvement' }),
  ));
  assert.equal(seeded.length, WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS);
  mutateWorkspaceWatcherRow(cwd, () => ({ pendingScoutFindings: seeded }), { dataDir });
  const oldestId = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings[0].id;

  const overflow = recordScoutFindings(cwd, [{ title: 'Capacity 201', category: 'improvement' }], { dataDir });
  assert.equal(overflow.added, 0);
  assert.equal(overflow.capacityExceeded, 1);
  assert.ok(overflow.dropped.some((entry) => entry.reason === 'capacity_exceeded'));
  let row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.pendingScoutFindings.length, WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS, 'no silent truncation');
  assert.equal(row.pendingScoutFindings[0].id, oldestId, 'the oldest pending proposal survives');
  assert.equal(row.pendingScoutFindings.some((finding) => finding.title === 'Capacity 201'), false);

  // Merging into an existing proposal is still allowed when the mailbox is full.
  const mergeWhenFull = recordScoutFindings(cwd, [{ title: 'Capacity 0', category: 'improvement' }], {
    dataDir, scanId: 'scan-cap', sourceChatId: 'chat-cap',
  });
  assert.equal(mergeWhenFull.added, 0);
  assert.equal(mergeWhenFull.capacityExceeded, 0);
  assert.equal(mergeWhenFull.merged, 1);
  row = getWorkspaceWatcher(cwd, { dataDir });
  const merged = row.pendingScoutFindings.find((finding) => finding.title === 'Capacity 0');
  assert.equal(merged.sources.length, 1, 'attribution landed on the existing proposal');
  assert.equal(row.pendingScoutFindings.length, WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS);
});

runCase('normalization keeps overflow pending and migrates terminal findings to the decision history', () => {
  const overflow = normalizeWorkspaceScoutFindings(Array.from(
    { length: WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS + 5 },
    (_, i) => ({ title: `Pending ${i}`, category: 'bug' }),
  ));
  assert.equal(overflow.length, WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS + 5, 'normalization never slices pending');
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/pending-overflow',
    pendingScoutFindings: overflow,
  });
  assert.equal(row.pendingScoutFindings.length, WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS + 5);
  assert.equal(row.pendingScoutFindings[0].title, 'Pending 0', 'oldest pending kept');

  const migrated = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/pending-migrate',
    pendingScoutFindings: [
      { title: 'Still pending', category: 'bug', status: 'pending' },
      { title: 'Old accepted', category: 'bug', status: 'accepted' },
      { title: 'Old rejected', category: 'bug', status: 'rejected' },
    ],
  });
  assert.equal(migrated.pendingScoutFindings.length, 1);
  assert.equal(migrated.pendingScoutFindings[0].status, 'pending');
  assert.deepEqual(
    migrated.scoutFindingDecisions.map((finding) => finding.status).sort(),
    ['accepted', 'rejected'],
  );
  // A pending decision record never enters the history.
  assert.equal(normalizeWorkspaceScoutFindingDecisions([{ title: 'Nope', category: 'bug', status: 'pending' }]).length, 0);
});

runCase('re-proposing a resolved finding merges attribution without reopening it', () => {
  const { cwd, dataDir } = freshWorkspace('finding-decisions');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });

  const rejectedFirst = recordScoutFindings(cwd, [{ title: 'Rejected idea', category: 'refactor' }], {
    dataDir, scanId: 'scan-r1', sourceChatId: 'chat-r1',
  });
  const rejectedId = rejectedFirst.findings.find((finding) => finding.title === 'Rejected idea').id;
  assert.equal(rejectScoutFindings(cwd, [rejectedId], { dataDir }).changed, 1);

  let row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.pendingScoutFindings.some((finding) => finding.id === rejectedId), false, 'left the pending mailbox');
  assert.equal(row.scoutFindingDecisions.find((finding) => finding.id === rejectedId).status, 'rejected');

  const rejectedAgain = recordScoutFindings(cwd, [{ title: 'Rejected idea', category: 'refactor' }], {
    dataDir, scanId: 'scan-r2', sourceChatId: 'chat-r2',
  });
  assert.equal(rejectedAgain.added, 0);
  assert.equal(rejectedAgain.merged, 1);
  assert.ok(rejectedAgain.dropped.some((entry) => entry.reason === 'already_resolved'));
  row = getWorkspaceWatcher(cwd, { dataDir });
  const rejectedDecision = row.scoutFindingDecisions.find((finding) => finding.id === rejectedId);
  assert.equal(rejectedDecision.status, 'rejected', 'the user decision is preserved');
  assert.equal(rejectedDecision.sources.length, 2, 'the new attribution merged into the decision');
  assert.equal(row.pendingScoutFindings.some((finding) => finding.title === 'Rejected idea'), false, 'never reopened');

  // Scan-history cleanup must not reactivate the rejected idea: the decision
  // lives in its own structure and feeds dedupe on its own.
  mutateWorkspaceWatcherRow(cwd, () => ({ scoutScanHistory: [] }), { dataDir });
  const afterClear = recordScoutFindings(cwd, [{ title: 'Rejected idea', category: 'refactor' }], {
    dataDir, scanId: 'scan-r3', sourceChatId: 'chat-r3',
  });
  assert.equal(afterClear.added, 0);
  assert.ok(afterClear.dropped.some((entry) => entry.reason === 'already_resolved'));

  // Accepted proposals keep their decision through a later re-proposal too.
  const acceptedFirst = recordScoutFindings(cwd, [{ title: 'Accepted idea', category: 'security' }], {
    dataDir, scanId: 'scan-a1', sourceChatId: 'chat-a1',
  });
  const acceptedId = acceptedFirst.findings.find((finding) => finding.title === 'Accepted idea').id;
  assert.equal(acceptScoutFindings(cwd, [acceptedId], { dataDir }).changed, 1);
  const acceptedAgain = recordScoutFindings(cwd, [{ title: 'Accepted idea', category: 'security' }], {
    dataDir, scanId: 'scan-a2', sourceChatId: 'chat-a2',
  });
  assert.equal(acceptedAgain.added, 0);
  assert.equal(acceptedAgain.merged, 1);
  row = getWorkspaceWatcher(cwd, { dataDir });
  const acceptedDecision = row.scoutFindingDecisions.find((finding) => finding.id === acceptedId);
  assert.equal(acceptedDecision.status, 'accepted');
  assert.equal(acceptedDecision.sources.length, 2);
});

runCase('submit rejects a foreign chat/token and scan B attribution never leaks to A', () => {
  const { cwd, dataDir } = freshWorkspace('finding-submit-auth');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [
      { scanId: 'scan-A', scoutId: SCOUT_GENERAL_PROFILE_ID, chatId: 'chat-A', expiresAt: future, submitToken: 'tok-A' },
      { scanId: 'scan-B', scoutId: SCOUT_GENERAL_PROFILE_ID, chatId: 'chat-B', expiresAt: future, submitToken: 'tok-B' },
    ],
  }), { dataDir });

  // A cannot submit against B's scan credentials.
  assert.throws(() => submitScoutFindings(cwd, {
    dataDir,
    findings: [{ title: 'Foreign', category: 'bug' }],
    sourceChatId: 'chat-A',
    scanId: 'scan-B',
    scoutSubmitToken: 'tok-B',
  }), (error) => error.code === 'OUT_OF_SCOPE' || error.code === 'VALIDATION');

  // A's own scan with a wrong token is rejected too.
  assert.throws(() => submitScoutFindings(cwd, {
    dataDir,
    findings: [{ title: 'Wrong token', category: 'bug' }],
    sourceChatId: 'chat-A',
    scanId: 'scan-A',
    scoutSubmitToken: 'nope',
  }), (error) => error.code === 'OUT_OF_SCOPE');

  const ok = submitScoutFindings(cwd, {
    dataDir,
    findings: [{ title: 'Owned by A', category: 'bug' }],
    sourceChatId: 'chat-A',
    scanId: 'scan-A',
    scoutSubmitToken: 'tok-A',
  });
  assert.equal(ok.added, 1);
  const finding = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings
    .find((item) => item.title === 'Owned by A');
  assert.equal(finding.sources.length, 1);
  assert.equal(finding.sources[0].scanId, 'scan-A');
  assert.equal(finding.sources[0].chatId, 'chat-A');
  assert.equal(finding.sources.some((source) => source.scanId === 'scan-B'), false, 'B attribution never leaks');
});

runCase('completed scan history records added/merged/dropped counters and reasons', () => {
  const { cwd, dataDir } = freshWorkspace('finding-history-counters');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [{
      scanId: 'scan-h', scoutId: SCOUT_GENERAL_PROFILE_ID, chatId: 'chat-h',
      expiresAt: future, submitToken: 'tok-h',
    }],
  }), { dataDir });

  const first = submitScoutFindings(cwd, {
    dataDir,
    findings: [{ title: 'History finding', category: 'bug' }],
    sourceChatId: 'chat-h',
    scanId: 'scan-h',
    scoutSubmitToken: 'tok-h',
  });
  assert.equal(first.added, 1);
  let entry = getWorkspaceWatcher(cwd, { dataDir }).scoutScanHistory.find((item) => item.scanId === 'scan-h');
  assert.equal(entry.status, 'completed');
  assert.equal(entry.added, 1);
  assert.equal(entry.merged, 0);
  assert.equal(entry.dropped, 0);

  // A second scan that re-proposes the same problem reports the merge.
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [{
      scanId: 'scan-h2', scoutId: SCOUT_GENERAL_PROFILE_ID, chatId: 'chat-h2',
      expiresAt: future, submitToken: 'tok-h2',
    }],
  }), { dataDir });
  const merged = submitScoutFindings(cwd, {
    dataDir,
    findings: [{ title: 'History finding', category: 'bug' }],
    sourceChatId: 'chat-h2',
    scanId: 'scan-h2',
    scoutSubmitToken: 'tok-h2',
  });
  assert.equal(merged.added, 0);
  assert.equal(merged.merged, 1);
  entry = getWorkspaceWatcher(cwd, { dataDir }).scoutScanHistory.find((item) => item.scanId === 'scan-h2');
  assert.equal(entry.added, 0);
  assert.equal(entry.merged, 1);
  assert.equal(entry.dropped, 1);
  assert.ok(entry.reasons.includes('already_pending'));
});

/* ------------------------------ source cap, list history, tombstones, todo */

runCase('a full sources[] cap still merges the newest attribution', () => {
  const { cwd, dataDir } = freshWorkspace('finding-source-cap');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();

  // A pending proposal already carrying the full attribution cap.
  const seededSources = Array.from(
    { length: WORKSPACE_WATCHER_MAX_SCOUT_FINDING_SOURCES },
    (_, i) => ({
      scoutId: SCOUT_GENERAL_PROFILE_ID,
      scoutRevision: 1,
      scanId: `cap-scan-${i}`,
      chatId: `cap-chat-${i}`,
      at: '2026-01-01T00:00:00.000Z',
    }),
  );
  const seeded = normalizeWorkspaceScoutFindings([
    { title: 'Source capped', category: 'bug', sources: seededSources },
  ]);
  assert.equal(seeded[0].sources.length, WORKSPACE_WATCHER_MAX_SCOUT_FINDING_SOURCES);
  mutateWorkspaceWatcherRow(cwd, () => ({ pendingScoutFindings: seeded }), { dataDir });

  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [{
      scanId: 'cap-scan-new', scoutId: SCOUT_GENERAL_PROFILE_ID, scoutRevision: 9,
      chatId: 'cap-chat-new', expiresAt: future, submitToken: 'cap-tok-new',
    }],
  }), { dataDir });

  // The list cannot grow past the cap, but the newest attribution must replace
  // the oldest entry and the merge must be counted (not silently discarded).
  const added = recordScoutFindings(cwd, [{ title: 'Source capped', category: 'bug' }], {
    dataDir, scanId: 'cap-scan-new', sourceChatId: 'cap-chat-new',
  });
  assert.equal(added.added, 0);
  assert.equal(added.merged, 1, 'a cap-full source list is still a real merge');
  const stored = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings
    .find((finding) => finding.title === 'Source capped');
  assert.equal(stored.sources.length, WORKSPACE_WATCHER_MAX_SCOUT_FINDING_SOURCES);
  assert.deepEqual(
    stored.sources.map((source) => source.scanId),
    [...seededSources.slice(1).map((source) => source.scanId), 'cap-scan-new'],
    'oldest attribution evicted, newest kept',
  );
  assert.equal(stored.sources.at(-1).scoutRevision, 9);
});

runCase('a same-scan merge that fills an empty source field is persisted', () => {
  const { cwd, dataDir } = freshWorkspace('finding-source-fill');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();

  const seeded = normalizeWorkspaceScoutFindings([
    { title: 'Field fill', category: 'bug', sources: [{ scanId: 'fill-scan', chatId: 'fill-chat' }] },
  ]);
  assert.equal(seeded[0].sources[0].scoutId, '', 'starts without a scout id');
  mutateWorkspaceWatcherRow(cwd, () => ({ pendingScoutFindings: seeded }), { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [{
      scanId: 'fill-scan', scoutId: SCOUT_GENERAL_PROFILE_ID, scoutRevision: 7,
      chatId: 'fill-chat', expiresAt: future, submitToken: 'fill-tok',
    }],
  }), { dataDir });

  const filled = recordScoutFindings(cwd, [{ title: 'Field fill', category: 'bug' }], {
    dataDir, scanId: 'fill-scan', sourceChatId: 'fill-chat',
  });
  assert.equal(filled.merged, 1, 'filling an empty field is a change');
  const stored = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings
    .find((finding) => finding.title === 'Field fill');
  assert.equal(stored.sources.length, 1, 'the same scan id does not add an entry');
  assert.equal(stored.sources[0].scoutId, SCOUT_GENERAL_PROFILE_ID, 'empty scoutId filled');
  assert.equal(stored.sources[0].scoutRevision, 7);
});

runCase('the default list keeps decisions visible when the pending mailbox is full', () => {
  const { cwd, dataDir } = freshWorkspace('finding-list-history');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const pending = normalizeWorkspaceScoutFindings(Array.from(
    { length: WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS },
    (_, i) => ({ title: `Listed pending ${i}`, category: 'bug', createdAt: '2026-05-01T00:00:00.000Z' }),
  ));
  const decisions = normalizeWorkspaceScoutFindingDecisions([
    { title: 'Listed accepted', category: 'bug', status: 'accepted', createdAt: '2026-01-01T00:00:00.000Z', decidedAt: '2026-01-02T00:00:00.000Z' },
    { title: 'Listed rejected', category: 'bug', status: 'rejected', createdAt: '2026-01-01T00:00:00.000Z', decidedAt: '2026-01-02T00:00:00.000Z' },
  ]);
  mutateWorkspaceWatcherRow(cwd, () => ({
    pendingScoutFindings: pending,
    scoutFindingDecisions: decisions,
  }), { dataDir });

  const listed = listScoutFindings(cwd, { dataDir });
  assert.equal(listed.length, WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS + 2, 'default spans pending + history');
  assert.ok(listed.some((finding) => finding.title === 'Listed accepted'), 'accepted decision visible');
  assert.ok(listed.some((finding) => finding.title === 'Listed rejected'), 'rejected decision visible');

  // An explicit `max` still wins.
  const capped = listScoutFindings(cwd, { dataDir, max: WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS });
  assert.equal(capped.length, WORKSPACE_WATCHER_MAX_PENDING_SCOUT_FINDINGS);
});

runCase('a decision tombstone keeps a rejected idea rejected past the 500-entry cap', () => {
  const { cwd, dataDir } = freshWorkspace('finding-decision-tombstone');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });

  // Seed more decisions than the detailed history retains. The oldest key falls
  // off `scoutFindingDecisions` but must stay in the tombstone index.
  const decisions = Array.from(
    { length: WORKSPACE_WATCHER_MAX_SCOUT_FINDING_DECISIONS + 1 },
    (_, i) => ({
      id: `retired-${i}`,
      title: `Retired idea ${i}`,
      category: 'bug',
      status: 'rejected',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      decidedAt: '2026-01-02T00:00:00.000Z',
    }),
  );
  mutateWorkspaceWatcherRow(cwd, () => ({ scoutFindingDecisions: decisions }), { dataDir });

  let row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.scoutFindingDecisions.length, WORKSPACE_WATCHER_MAX_SCOUT_FINDING_DECISIONS, 'detail stays bounded');
  assert.equal(
    row.scoutFindingDecisions.some((finding) => finding.title === 'Retired idea 0'),
    false,
    'the oldest detailed decision rolled off',
  );
  assert.equal(
    row.scoutFindingDecisionIndex.some((entry) => entry.dedupeKey === 'bug:retired idea 0'),
    true,
    'its tombstone survives the detail cap',
  );

  const revived = recordScoutFindings(cwd, [{ title: 'Retired idea 0', category: 'bug' }], {
    dataDir, scanId: 'scan-revive', sourceChatId: 'chat-revive',
  });
  assert.equal(revived.added, 0, 'the rolled-off rejected idea is not re-proposed');
  assert.ok(revived.dropped.some((entry) => entry.reason === 'already_resolved'));
  row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(
    row.pendingScoutFindings.some((finding) => finding.title === 'Retired idea 0'),
    false,
    'never reopened as pending',
  );
});

runCase('auto-created Scout todo keeps its minimal source after scan history is cleared', () => {
  const { cwd, dataDir } = freshWorkspace('finding-todo-source');
  upsertWorkspaceWatcher(cwd, {
    mode: 'observe',
    policy: { scoutEnabled: true, scoutAutoCreate: true },
  }, { dataDir });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScans: [{
      scanId: 'scan-min', scoutId: SCOUT_GENERAL_PROFILE_ID, scoutRevision: 5,
      chatId: 'chat-min', expiresAt: future, submitToken: 'tok-min',
    }],
  }), { dataDir });

  recordScoutFindings(cwd, [{
    title: 'Minimal source', category: 'bug', rationale: 'prove the source survives',
  }], { dataDir, scanId: 'scan-min', sourceChatId: 'chat-min' });

  // Wipe the scan details, as bounded retention eventually will.
  mutateWorkspaceWatcherRow(cwd, () => ({ scoutScanHistory: [], activeScoutScans: [] }), { dataDir });

  const todos = loadTodosData(dataDir, cwd).items;
  const child = todos.find((item) => item.title === '[Scout] Minimal source');
  assert.ok(child, 'auto-created child todo exists');
  assert.match(child.body, /scan-min/);
  assert.match(child.body, new RegExp(SCOUT_GENERAL_PROFILE_ID));
  assert.match(child.body, /Revision: 5/);
  assert.match(child.plan.markdown, /scan-min/);
  assert.match(child.plan.markdown, new RegExp(SCOUT_GENERAL_PROFILE_ID));
  assert.equal(
    JSON.stringify(todos).includes('tok-min'),
    false,
    'the submit token never appears on a todo',
  );
});

/* ----------------------------------------------------------------- finish */

Promise.all(pending).then(() => {
  removeIsolatedDataDir();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\nworkspace scout scan tests: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log('\nworkspace scout scan tests passed');
});
