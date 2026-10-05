/**
 * Workspace Scout tests.
 *
 * Scout is a separate periodic read-only scan, so the critical assertions are:
 *   1. pure planning (prompt build, parse, dedupe, eligibility) is deterministic;
 *   2. a scan stamps its own `lastScoutAt`/`scoutScans` and never touches
 *      `activeCycles` or the `cycles`/`maxCyclesPerDay` budget;
 *   3. proposals are deduped against todos, resolved findings and memory;
 *   4. accept/reject is explicit and only `scoutAutoCreate` creates an idea todo.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_SCOUT_CATEGORIES,
  defaultWorkspaceWatcherPolicy,
  getWorkspaceWatcher,
  normalizeWorkspaceWatcherPolicy,
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { addTodo, loadTodosData } from '../lib/persist/todos-persist.js';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { addWorkspaceMemory } from '../lib/persist/workspace-memory-persist.js';
import {
  acceptScoutFindings,
  buildScoutPrompt,
  buildScoutSignalsBlock,
  collectScoutSignals,
  decideScoutRun,
  dedupeScoutFindings,
  expireStaleActiveScoutScan,
  isExploredMemoryEntry,
  parseScoutFindings,
  recordScoutFindings,
  rejectScoutFindings,
  resolveWorkspaceScoutFilePath,
  runWorkspaceWatcherScout,
  runWorkspaceWatcherScoutAction,
  runWorkspaceWatcherScoutPass,
  scoutTitlesOverlap,
  submitScoutFindings,
} from '../lib/workspace-watcher-scout.js';
import { mutateWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';
import * as scout from '../lib/workspace-watcher-scout.js';
import { runWorkspaceWatcherScoutNow } from '../lib/workspace-watcher-control.js';
import { reconcileWorkspaceWatchersOnBoot } from '../lib/workspace-watcher.js';
import { registerWorkspaceWatcherRoutes } from '../lib/routes/workspace-watcher-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;
/** @type {Promise<void>[]} */
const pending = [];

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-'));
let counter = 0;

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

const quietGit = () => '';

/* ------------------------------------------------------------------ policy */

runCase('policy defaults + normalization expose the scout fields', () => {
  const defaults = defaultWorkspaceWatcherPolicy();
  assert.equal(defaults.scoutEnabled, false);
  assert.equal(defaults.scoutIntervalHours, 6);
  assert.equal(defaults.scoutAutoCreate, false);
  assert.deepEqual(defaults.scoutCategories, [...WORKSPACE_SCOUT_CATEGORIES]);
  assert.equal(defaults.scoutMaxPerDay, 4);
  assert.equal(defaults.scoutMaxPerScan, 10);

  const normalized = normalizeWorkspaceWatcherPolicy({
    scoutEnabled: true,
    scoutIntervalHours: 0.5,
    scoutAutoCreate: true,
    scoutCategories: ['BUG', 'bogus', 'security'],
    scoutMaxPerDay: 2,
    scoutMaxPerScan: 3,
  });
  assert.equal(normalized.scoutEnabled, true);
  assert.equal(normalized.scoutIntervalHours, 0.5);
  assert.equal(normalized.scoutAutoCreate, true);
  assert.deepEqual(normalized.scoutCategories, ['bug', 'security']);
  assert.equal(normalized.scoutMaxPerDay, 2);
  assert.equal(normalized.scoutMaxPerScan, 3);

  // Historical alias from the task brief.
  assert.equal(normalizeWorkspaceWatcherPolicy({ autoCreateScoutTodos: true }).scoutAutoCreate, true);

  // An empty category list falls back to all categories instead of disabling.
  assert.deepEqual(
    normalizeWorkspaceWatcherPolicy({ scoutCategories: [] }).scoutCategories,
    [...WORKSPACE_SCOUT_CATEGORIES],
  );
});

runCase('row normalization carries lastScoutAt/scoutScans/pendingScoutFindings', () => {
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/scout-row',
    lastScoutAt: '2026-01-01T00:00:00.000Z',
    scoutScans: { day: '2026-01-01', count: 3 },
    pendingScoutFindings: [{ title: 'A', category: 'bug', files: ['a.js'] }],
  });
  assert.equal(row.lastScoutAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(row.scoutScans, { day: '2026-01-01', count: 3 });
  assert.equal(row.pendingScoutFindings.length, 1);
  assert.equal(row.pendingScoutFindings[0].status, 'pending');
  assert.equal(row.pendingScoutFindings[0].dedupeKey, 'bug:a');
});

/* ------------------------------------------------------------------- parse */

runCase('parseScoutFindings accepts fenced JSON, bare arrays and {findings}', () => {
  const fenced = 'Here you go:\n```json\n[{"title":"Fix red test","category":"bug","rationale":"r","files":["a.js"]}]\n```';
  const fromFence = parseScoutFindings(fenced);
  assert.equal(fromFence.length, 1);
  assert.equal(fromFence[0].category, 'bug');
  assert.deepEqual(fromFence[0].files, ['a.js']);

  const bare = parseScoutFindings('[{"title":"Add docs","category":"documentation"}]');
  assert.equal(bare[0].category, 'documentation');

  const object = parseScoutFindings('{"findings":[{"title":"Harden input","category":"security"}]}');
  assert.equal(object[0].category, 'security');

  assert.deepEqual(parseScoutFindings('not json at all'), []);
  assert.deepEqual(parseScoutFindings(''), []);
});

runCase('parseScoutFindings filters categories and caps maxFindings', () => {
  const text = JSON.stringify([
    { title: 'one', category: 'bug' },
    { title: 'two', category: 'bogus' },
    { title: 'three', category: 'security' },
  ]);
  const filtered = parseScoutFindings(text, { categories: ['bug', 'security'] });
  assert.deepEqual(filtered.map((finding) => finding.title), ['one', 'three']);

  const capped = parseScoutFindings(text, { maxFindings: 1 });
  assert.equal(capped.length, 1);

  const defaultCategory = parseScoutFindings(JSON.stringify([{ title: 'no category' }]), { defaultCategory: 'improvement' });
  assert.equal(defaultCategory[0].category, 'improvement');

  assert.deepEqual(parseScoutFindings(JSON.stringify([{ title: 'bad cat', category: 'nope' }])), []);
  const smuggled = parseScoutFindings(JSON.stringify([{ title: 'x', category: 'bug', status: 'accepted' }]));
  assert.equal(smuggled.length, 0);
});

/* ------------------------------------------------------------------ signals */

runCase('collectScoutSignals gathers git/markers/todos/memory read-only', () => {
  const { cwd, dataDir } = freshWorkspace('signals');
  addTodo(dataDir, cwd, { title: 'Existing todo', status: 'ready' });
  addWorkspaceMemory(cwd, { type: 'context', key: 'ctx', value: 'a note' }, { dataDir });
  const signals = collectScoutSignals({ workspaceFolder: cwd, dataDir }, {
    execGit: (args) => {
      if (args[0] === 'diff' && args[1] === 'main') return 'diff --git a/a.js b/a.js\n+TODO: fix';
      if (args[0] === 'diff' && args[1] === '--name-only') return 'a.js';
      if (args[0] === 'log') return 'abc123 commit';
      return '';
    },
    readFile: (file) => {
      assert.equal(path.basename(file), 'a.js');
      return 'const x = 1;\n// FIXME: this is wrong\n';
    },
  });
  assert.match(signals.diff, /TODO: fix/);
  assert.equal(signals.log, 'abc123 commit');
  assert.deepEqual(signals.changedFiles, ['a.js']);
  assert.equal(signals.markers.length, 1);
  assert.match(signals.markers[0], /a\.js:2/);
  assert.equal(signals.existingTodos.length, 1);
  assert.equal(signals.memory.length, 1);

  const block = buildScoutSignalsBlock(signals).join('\n');
  assert.match(block, /existing todos/);
  assert.match(block, /workspace memory/);
  assert.match(block, /UNTRUSTED_SIGNAL_DATA/);
  assert.match(signals.failingTests, /unavailable|FAIL/i);
});

/* ---------------------------------------------------------------- prompt */

runCase('buildScoutPrompt is read-only and carries categories + signals', () => {
  const prompt = buildScoutPrompt({
    workspaceFolder: '/tmp/ws',
    scanId: 'scan-1',
    categories: ['bug', 'security'],
    maxFindings: 3,
    signals: { diff: 'diff --git a/x b/x', existingTodos: [{ id: '1', title: 'T', status: 'ready' }] },
  });
  assert.match(prompt, /PLAN mode/);
  assert.match(prompt, /bug, security/);
  assert.match(prompt, /at most 3/);
  assert.match(prompt, /watcher_scout_findings/);
  assert.match(prompt, /existing todos/);
  assert.match(prompt, /UNTRUSTED DATA/);
});

/* ----------------------------------------------------------------- dedupe */

runCase('dedupeScoutFindings drops todos, pending, resolved and explored memory', () => {
  const findings = [
    normalizeFinding('Fix the red test', 'bug'),
    normalizeFinding('Brand new opportunity', 'opportunity'),
    normalizeFinding('Already explored area', 'improvement'),
    normalizeFinding('Resolved item', 'bug'),
    normalizeFinding('Same as pending', 'security'),
  ];
  const { kept, dropped } = dedupeScoutFindings(findings, {
    existingTodos: [{ id: 't1', title: 'Fix the red test', status: 'ready' }],
    memory: [{ type: 'context', key: 'explored:already explored area', value: 'nothing left' }],
    pendingFindings: [
      { id: 'p1', title: 'Resolved item', category: 'bug', status: 'accepted', dedupeKey: 'bug:resolved item' },
      { id: 'p2', title: 'Same as pending', category: 'security', status: 'pending', dedupeKey: 'security:same as pending' },
    ],
  });
  assert.deepEqual(kept.map((finding) => finding.title), ['Brand new opportunity']);
  const reasons = dropped.map((row) => row.reason).sort();
  assert.deepEqual(reasons, ['already_explored', 'already_pending', 'already_resolved', 'existing_todo']);
});

runCase('dedupeScoutFindings drops repeats of prior review findings without summary', () => {
  const { kept, dropped } = dedupeScoutFindings(
    [normalizeFinding('Fix flaky auth login test', 'bug')],
    {
      priorFindings: [{
        todoId: 'todo-review-1',
        hash: 'abc',
        streak: 1,
        summary: '',
        title: 'Fix flaky auth login test',
      }],
    },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].reason, 'prior_review');
});

runCase('isExploredMemoryEntry ignores generic covered/scanned value-only notes', () => {
  assert.equal(isExploredMemoryEntry({ key: 'notes', value: 'area covered in meeting' }), false);
  assert.equal(isExploredMemoryEntry({ key: 'explored:auth', value: 'done' }), true);
  assert.equal(isExploredMemoryEntry({ key: 'ctx', value: 'already scanned auth module yesterday' }), true);
});

runCase('scoutTitlesOverlap ignores short tokens like fix/test', () => {
  assert.equal(scoutTitlesOverlap('fix', 'Fix unrelated module'), false);
  assert.equal(scoutTitlesOverlap('Fix red test in auth', 'Fix red test in auth module'), true);
});

runCase('resolveWorkspaceScoutFilePath rejects paths outside the workspace', () => {
  const { cwd } = freshWorkspace('paths');
  assert.equal(resolveWorkspaceScoutFilePath(cwd, 'src/a.js'), 'src/a.js');
  assert.equal(resolveWorkspaceScoutFilePath(cwd, '../escape.js'), null);
  assert.equal(resolveWorkspaceScoutFilePath(cwd, '/etc/passwd'), null);
});

/**
 * @param {string} title
 * @param {string} category
 * @returns {object}
 */
function normalizeFinding(title, category) {
  return { title, category, rationale: 'r', files: [] };
}

/* -------------------------------------------------------------- eligibility */

runCase('decideScoutRun enforces opt-in, mode, quiet hours, interval and budget', () => {
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const base = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/ws',
    mode: 'observe',
    policy: { scoutEnabled: true, scoutIntervalHours: 6, scoutMaxPerDay: 2 },
  });

  assert.equal(decideScoutRun({ watcher: { ...base, policy: { ...base.policy, scoutEnabled: false } }, now }).reason, 'scout_disabled');
  assert.equal(decideScoutRun({ watcher: { ...base, mode: 'off' }, now }).reason, 'mode_not_active');
  assert.equal(decideScoutRun({ watcher: { ...base, paused: true }, now }).reason, 'paused');
  assert.equal(decideScoutRun({ watcher: { ...base, stopReason: 'x' }, now }).reason, 'stopped');

  const quiet = {
    ...base,
    policy: { ...base.policy, quietHours: { start: '11:00', end: '13:00' } },
  };
  assert.equal(decideScoutRun({ watcher: quiet, now }).reason, 'quiet_hours');

  const recent = { ...base, lastScoutAt: new Date(now - 60_000).toISOString() };
  assert.equal(decideScoutRun({ watcher: recent, now }).reason, 'scan_interval');

  const old = { ...base, lastScoutAt: new Date(now - 7 * 3600_000).toISOString() };
  assert.equal(decideScoutRun({ watcher: old, now }).allowed, true);

  const overBudget = {
    ...old,
    scoutScans: { day: '2026-02-02', count: 2 },
  };
  assert.equal(decideScoutRun({ watcher: overBudget, now }).reason, 'daily_budget');

  // A previous UTC day resets the budget.
  const yesterday = { ...overBudget, scoutScans: { day: '2026-02-01', count: 9 } };
  assert.equal(decideScoutRun({ watcher: yesterday, now }).allowed, true);

  const disabledDaily = {
    ...base,
    policy: { ...base.policy, scoutMaxPerDay: 0 },
  };
  assert.equal(decideScoutRun({ watcher: disabledDaily, now }).reason, 'scout_daily_disabled');

  const busyScout = { ...old, policy: { ...old.policy, scoutMaxParallel: 1 } };
  assert.equal(decideScoutRun({ watcher: busyScout, now, scoutAgentCount: 1 }).reason, 'scout_parallel');
  assert.equal(decideScoutRun({ watcher: busyScout, now, scoutAgentCount: 0 }).allowed, true);
});

/* ------------------------------------------------------------ store + CRUD */

runCase('record/accept/reject proposals; only scoutAutoCreate creates a todo', async () => {
  const { cwd, dataDir } = freshWorkspace('crud');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });

  const recorded = recordScoutFindings(cwd, [
    { title: 'Fix red test', category: 'bug', rationale: 'test fails', files: ['a.js'] },
    { title: 'Add docs', category: 'documentation' },
  ], { dataDir });
  assert.equal(recorded.added, 2);
  assert.equal(recorded.findings.length, 2);

  const listed = runWorkspaceWatcherScoutAction({ dataDir, workspaceFolder: cwd, action: 'list' });
  assert.equal(listed.findings.length, 2);
  assert.equal(listed.findings.every((finding) => finding.status === 'pending'), true);

  const bug = listed.findings.find((finding) => finding.category === 'bug');
  const docs = listed.findings.find((finding) => finding.category === 'documentation');
  const accepted = acceptScoutFindings(cwd, [bug.id], { dataDir });
  assert.equal(accepted.changed, 1);
  assert.equal(accepted.createdTodos.length, 0, 'autoCreate defaults to false');
  const rejected = rejectScoutFindings(cwd, [docs.id], { dataDir });
  assert.equal(rejected.changed, 1);
  const after = runWorkspaceWatcherScoutAction({ dataDir, workspaceFolder: cwd, action: 'list' });
  assert.equal(after.findings.find((finding) => finding.id === bug.id).status, 'accepted');
  assert.equal(after.findings.find((finding) => finding.id === docs.id).status, 'rejected');

  // Enable autoCreate and accept a fresh finding: one idea todo appears.
  upsertWorkspaceWatcher(cwd, { policy: { scoutAutoCreate: true } }, { dataDir });
  recordScoutFindings(cwd, [{ title: 'Auto create me', category: 'opportunity' }], { dataDir });
  const auto = runWorkspaceWatcherScoutAction({ dataDir, workspaceFolder: cwd, action: 'list' });
  const target = auto.findings.find((finding) => finding.title === 'Auto create me');
  const autoAccepted = acceptScoutFindings(cwd, [target.id], { dataDir });
  assert.equal(autoAccepted.createdTodos.length, 1);
  const todoDoc = loadTodosData(dataDir, cwd);
  const created = todoDoc.items.find((item) => item.id === autoAccepted.createdTodos[0].id);
  assert.ok(created);
  assert.equal(created.status, 'idea');
  assert.match(created.title, /Auto create me/);
  assert.match(created.plan.markdown, /\(no rationale\)/);
  assert.match(created.plan.markdown, new RegExp(target.id));
  assert.equal(created.plan.approvedAt, undefined);

  // A replayed create must not call updateTodo, so a human-edited plan survives CAS retry.
  recordScoutFindings(cwd, [{ title: 'Replay me', category: 'bug', rationale: 'keep the human plan' }], { dataDir });
  const replayList = runWorkspaceWatcherScoutAction({ dataDir, workspaceFolder: cwd, action: 'list' });
  const replayTarget = replayList.findings.find((finding) => finding.title === 'Replay me');
  let planWrites = 0;
  const replayed = acceptScoutFindings(cwd, [replayTarget.id], {
    dataDir,
    deps: {
      addTodo: () => ({ replayed: true, item: { id: 'already-there', title: '[Scout] Replay me' } }),
      updateTodo: () => { planWrites += 1; },
    },
  });
  assert.equal(replayed.changed, 1);
  assert.equal(planWrites, 0);

  const reReject = rejectScoutFindings(cwd, [bug.id], { dataDir });
  assert.equal(reReject.changed, 0, 'terminal findings cannot be re-resolved');
});

/* -------------------------------------------------------------------- scan */

runCase('runWorkspaceWatcherScout stamps its own schedule and never touches cycles', async () => {
  const { cwd, dataDir } = freshWorkspace('scan');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true, scoutIntervalHours: 6 } }, { dataDir });

  // The daily scan budget is keyed by UTC day, so anchor every scan inside one
  // and the same day. A wall-clock `Date.now()` would make this case fail
  // whenever the suite runs within `scoutIntervalHours` of UTC midnight.
  const base = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 3600_000;

  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: base,
    deps: {
      execGit: quietGit,
      runScout: async () => ({ started: true, findings: [{ title: 'New bug', category: 'bug' }] }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, true);
  assert.equal(result.added, 1);

  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.ok(row.lastScoutAt);
  assert.equal(row.scoutScans.count, 1);
  // Scout must not consume the cycle budget or the cycle slots.
  assert.equal(row.cycles.count, 0);
  assert.deepEqual(row.activeCycles, []);
  assert.equal(row.pendingScoutFindings.length, 1);

  // The interval blocks an immediate second scan.
  const second = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: base + 60_000,
    deps: { execGit: quietGit, runScout: async () => ({ started: true, findings: [] }) },
  });
  assert.equal(second.scanned, false);
  assert.equal(second.reason, 'scan_interval');

  const forced = await runWorkspaceWatcherScoutNow({
    workspaceFolder: cwd,
    dataDir,
    now: base + 120_000,
    deps: { execGit: quietGit, runScout: async () => ({ started: true, findings: [] }) },
  });
  assert.equal(forced.scanned, true, 'manual run bypasses scan_interval');

  // Re-running after the interval dedupes an already-pending proposal.
  const later = base + 7 * 3600_000;
  const third = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: later,
    deps: {
      execGit: quietGit,
      runScout: async () => ({ started: true, findings: [{ title: 'New bug', category: 'bug' }] }),
    },
  });
  assert.equal(third.scanned, true);
  assert.equal(third.added, 0);
  const rowAfter = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(rowAfter.pendingScoutFindings.length, 1);
  assert.equal(rowAfter.scoutScans.count, 3);
});

runCase('runWorkspaceWatcherScout rolls back its stamp when the scan throws', async () => {
  const { cwd, dataDir } = freshWorkspace('rollback');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const before = getWorkspaceWatcher(cwd, { dataDir }).scoutScans;
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: {
      execGit: quietGit,
      runScout: async () => {
        throw new Error('model exploded');
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scout_failed');
  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(after.lastScoutAt, '');
  assert.deepEqual(after.scoutScans, before);
});

runCase('runWorkspaceWatcherScoutPass scans only opted-in observe/autopilot rows', async () => {
  const { cwd: cwdA, dataDir } = freshWorkspace('pass-a');
  const { cwd: cwdB } = freshWorkspace('pass-b');
  const { cwd: cwdC } = freshWorkspace('pass-c');
  upsertWorkspaceWatcher(cwdA, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  upsertWorkspaceWatcher(cwdB, { mode: 'observe', policy: { scoutEnabled: false } }, { dataDir });
  upsertWorkspaceWatcher(cwdC, { mode: 'off', policy: { scoutEnabled: true } }, { dataDir });

  const result = await runWorkspaceWatcherScoutPass({
    dataDir,
    deps: {
      execGit: quietGit,
      runScout: async () => ({ started: true, findings: [{ title: 'Pass finding', category: 'bug' }] }),
    },
  });
  assert.equal(result.scanned, 1, 'only the opted-in observe row is scanned');
  assert.equal(result.started, 1);
  assert.equal(result.skipped, 0);
  assert.equal(getWorkspaceWatcher(cwdA, { dataDir }).pendingScoutFindings.length, 1);
  assert.equal(getWorkspaceWatcher(cwdB, { dataDir }).pendingScoutFindings.length, 0);
  assert.equal(getWorkspaceWatcher(cwdC, { dataDir }).pendingScoutFindings.length, 0);
});

runCase('runWorkspaceWatcherScout starts a running scan when mode is autopilot too', async () => {
  const { cwd, dataDir } = freshWorkspace('autopilot');
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot', policy: { scoutEnabled: true } }, { dataDir });
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: { execGit: quietGit, runScout: async () => ({ started: true, findings: [] }) },
  });
  assert.equal(result.scanned, true);
});

runCase('runWorkspaceWatcherScout parses findings from a returned text block', async () => {
  const { cwd, dataDir } = freshWorkspace('text');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: {
      execGit: quietGit,
      runScout: async () => ({
        started: true,
        text: 'Done.\n```json\n[{"title":"From text","category":"security","files":["s.js"]}]\n```',
      }),
    },
  });
  assert.equal(result.scanned, true);
  assert.equal(result.added, 1);
  const findings = getWorkspaceWatcher(cwd, { dataDir }).pendingScoutFindings;
  assert.equal(findings[0].title, 'From text');
  assert.equal(findings[0].category, 'security');
});

/* ------------------------------------------------------------------- route */

runCase('REST /api/workspace-watcher/scout lists, submits and resolves', async () => {
  const { cwd, dataDir } = freshWorkspace('route');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerWorkspaceWatcherRoutes(app, { dataDir, getCurrentCwd: () => cwd });
  const invoke = (method, urlPath, req = {}) => new Promise((resolve) => {
    const fn = handlers.get(`${method} ${urlPath}`);
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    fn({ params: {}, query: {}, body: {}, ...req }, res);
  });

  const submitted = await invoke('POST', '/api/workspace-watcher/scout', {
    body: { action: 'submit', findings: [{ title: 'Route finding', category: 'security', files: ['s.js'] }] },
  });
  assert.equal(submitted.status, 403);

  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-test',
      chatId: 'chat-test',
      startedAt: new Date().toISOString(),
      expiresAt,
      submitToken: 'token-test',
    },
  }), { dataDir });
  const authorized = runWorkspaceWatcherScoutAction({
    dataDir,
    workspaceFolder: cwd,
    action: 'submit',
    sourceChatId: 'chat-test',
    scanId: 'scan-test',
    scoutSubmitToken: 'token-test',
    findings: [{ title: 'Route finding', category: 'security', files: ['s.js'] }],
  });
  assert.equal(authorized.added, 1);

  const listed = await invoke('GET', '/api/workspace-watcher/scout', { query: {} });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.findings.length, 1);
  const id = listed.body.findings[0].id;

  const accepted = await invoke('POST', '/api/workspace-watcher/scout', {
    body: { action: 'accept', ids: [id] },
  });
  assert.equal(accepted.body.changed, 1);
  assert.equal(accepted.body.findings.find((finding) => finding.id === id).status, 'accepted');

  const badAction = await invoke('POST', '/api/workspace-watcher/scout', {
    body: { action: 'explode' },
  });
  assert.equal(badAction.status, 400);
});

runCase('submit strips caller-owned ids and rejects duplicate smuggled ids', () => {
  const { cwd, dataDir } = freshWorkspace('sanitize');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-s',
      chatId: 'chat-s',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      submitToken: 'tok-s',
    },
  }), { dataDir });
  const smuggledId = '00000000-0000-4000-8000-000000000001';
  submitScoutFindings(cwd, {
    dataDir,
    findings: [{
      id: smuggledId,
      todoId: 'evil',
      createdAt: '1970-01-01T00:00:00.000Z',
      title: 'Sanitized finding',
      category: 'bug',
      source: { scanner: 'evil' },
    }],
    sourceChatId: 'chat-s',
    scanId: 'scan-s',
    scoutSubmitToken: 'tok-s',
  });
  const row = getWorkspaceWatcher(cwd, { dataDir });
  const finding = row.pendingScoutFindings.find((item) => item.title === 'Sanitized finding');
  assert.ok(finding);
  assert.notEqual(finding.id, smuggledId);
  assert.equal(finding.status, 'pending');
  assert.equal(finding.todoId, undefined);
  assert.equal(finding.source, undefined);

  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-s2',
      chatId: 'chat-s',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      submitToken: 'tok-s2',
    },
  }), { dataDir });
  const second = submitScoutFindings(cwd, {
    dataDir,
    findings: [{
      id: finding.id,
      title: 'Sanitized finding',
      category: 'bug',
    }],
    sourceChatId: 'chat-s',
    scanId: 'scan-s2',
    scoutSubmitToken: 'tok-s2',
  });
  assert.equal(second.added, 0);
  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(after.pendingScoutFindings.filter((item) => item.title === 'Sanitized finding').length, 1);
});

runCase('active Scout scan expires and cannot submit afterward', () => {
  const { cwd, dataDir } = freshWorkspace('expire');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-exp',
      chatId: 'chat-exp',
      startedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
      submitToken: 'tok-exp',
    },
  }), { dataDir });
  assert.equal(expireStaleActiveScoutScan(cwd, { dataDir, now }), true);
  assert.throws(
    () => submitScoutFindings(cwd, {
      dataDir,
      now,
      findings: [{ title: 'Late', category: 'bug' }],
      sourceChatId: 'chat-exp',
      scanId: 'scan-exp',
      scoutSubmitToken: 'tok-exp',
    }),
    /No active Scout scan/,
  );
});

runCase('runWorkspaceWatcherScout clears active scan when startChatRun throws', async () => {
  const { cwd, dataDir } = freshWorkspace('run-fail');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: {
      execGit: quietGit,
      resolveWorkspaceWatcherOrchestrator: async () => ({
        ok: true,
        harness: 'test',
        model: 'test-model',
      }),
      addChat: () => ({ id: 'chat-run-fail' }),
      startChatRun: async () => {
        throw new Error('run boom');
      },
    },
  });
  const active = getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan;
  assert.equal(active.scanId, '');
});

runCase('runWorkspaceWatcherScoutAction validates action and ids', () => {
  const { cwd, dataDir } = freshWorkspace('validate');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  assert.throws(
    () => runWorkspaceWatcherScoutAction({ dataDir, workspaceFolder: cwd, action: 'nope' }),
    /action must be one of/,
  );
  assert.throws(
    () => runWorkspaceWatcherScoutAction({ dataDir, workspaceFolder: cwd, action: 'accept', ids: [] }),
    /ids is required/,
  );
});

/* ------------------------------------------- Finding 1: prior review text  */

function makeWatcherApp(dataDir, cwd) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerWorkspaceWatcherRoutes(app, { dataDir, getCurrentCwd: () => cwd });
  const invoke = (method, urlPath, req = {}) => new Promise((resolve) => {
    const fn = handlers.get(`${method} ${urlPath}`);
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    fn({ params: {}, query: {}, body: {}, ...req }, res);
  });
  return { invoke };
}

runCase('review finding text recorded via REST is persisted and dedupes a Scout proposal', async () => {
  const { cwd, dataDir } = freshWorkspace('prior-review');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const todo = addTodo(dataDir, cwd, { title: 'Flaky auth login', status: 'doing' }).item;
  const { invoke } = makeWatcherApp(dataDir, cwd);

  // The orchestrator records the real review finding (hash + summary text).
  const rec = await invoke('POST', '/api/workspace-watcher/findings', {
    body: {
      hash: 'find-xyz',
      todoId: todo.id,
      findings_text: 'Flaky auth login: test intermittently fails on token refresh',
    },
  });
  assert.equal(rec.status, 200);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.findings.byTodo[todo.id].hash, 'find-xyz');
  // The summary must be persisted (Finding 1: text was dropped before).
  assert.match(row.findings.byTodo[todo.id].summary || '', /intermittently fails on token refresh/);

  // Signals fed to Scout carry the summary — no manually preconstructed array.
  const signals = collectScoutSignals({ workspaceFolder: cwd, dataDir, watcher: row }, { execGit: quietGit });
  const prior = signals.priorFindings.find((r) => r.todoId === todo.id);
  assert.ok(prior, 'prior finding references the reviewed todo');
  assert.match(prior.summary, /intermittently fails/);

  // A Scout re-proposal that overlaps only the recorded review SUMMARY (not the
  // todo title, not an existing todo) is dropped as a prior review — proving the
  // persisted text, not just the hash, now feeds Scout dedupe.
  const recorded = recordScoutFindings(cwd, [
    { title: 'Test intermittently fails on token refresh', category: 'bug', files: ['auth.js'] },
  ], { dataDir });
  assert.equal(recorded.added, 0, 'same finding as a prior review is deduped');
  assert.equal(recorded.dropped[0].reason, 'prior_review');
});

/* ------------------------------- Finding 2/6: chat + active-scan cleanup    */

runCase('defaultStartScoutJob deletes the orphan chat when startChatRun throws', async () => {
  const { cwd, dataDir } = freshWorkspace('orphan-chat');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  /** @type {string[]} */
  const deleted = [];
  await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: {
      execGit: quietGit,
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'test', model: 'test-model' }),
      addChat: () => ({ id: 'orphan-chat-1' }),
      startChatRun: async () => { throw new Error('boom'); },
      deleteScoutChat: (id) => { deleted.push(id); },
    },
  });
  assert.deepEqual(deleted, ['orphan-chat-1'], 'the orphan chat is removed after run failure');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan.scanId, '');
});

runCase('runWorkspaceWatcherScout clears the active scan when the runner throws after setting it', async () => {
  const { cwd, dataDir } = freshWorkspace('outer-clear');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const before = getWorkspaceWatcher(cwd, { dataDir }).scoutScans;
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: {
      execGit: quietGit,
      runScout: async ({ scanId }) => {
        mutateWorkspaceWatcherRow(cwd, () => ({
          activeScoutScan: {
            scanId,
            chatId: 'live-chat',
            startedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            submitToken: 'tok',
          },
        }), { dataDir });
        throw new Error('runner exploded after setting the scan');
      },
    },
  });
  assert.equal(result.reason, 'scout_failed');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan.scanId, '', 'stale token cleared');
  assert.deepEqual(getWorkspaceWatcher(cwd, { dataDir }).scoutScans, before, 'stamp rolled back');
});

runCase('an accepted async scan keeps its active credentials and consumes the stamp', async () => {
  const { cwd, dataDir } = freshWorkspace('accepted-keep');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: {
      execGit: quietGit,
      runScout: async ({ scanId }) => {
        mutateWorkspaceWatcherRow(cwd, () => ({
          activeScoutScan: {
            scanId,
            chatId: 'live-chat',
            startedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            submitToken: 'tok',
          },
        }), { dataDir });
        // The runner accepted the run and returns with no inline findings: the
        // live Scout chat will submit later, so its credentials must persist.
        return { started: true, chatId: 'live-chat', runId: 'run-1' };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.scanned, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeScoutScan.scanId, result.scanId, 'a running scout keeps its credentials');
  assert.equal(row.scoutScans.count, 1, 'the schedule slot is consumed');
});

runCase('clearActiveScoutScanIfScanId never clears a successor scan', () => {
  const { cwd, dataDir } = freshWorkspace('scan-match');
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-A',
      chatId: 'chat-A',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      submitToken: 'tok-A',
    },
  }), { dataDir });
  scout.clearActiveScoutScanIfScanId(cwd, 'scan-B', { dataDir });
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan.scanId, 'scan-A');
  scout.clearActiveScoutScanIfScanId(cwd, 'scan-A', { dataDir });
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan.scanId, '');
});

/* ----------------------------------------- Finding 3: bounded test probe    */

runCase('test probe is OFF by default: no exec, unavailable marker surfaced', () => {
  const { cwd, dataDir } = freshWorkspace('probe-off');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  let execCalls = 0;
  const signals = collectScoutSignals(
    { workspaceFolder: cwd, dataDir, watcher: getWorkspaceWatcher(cwd, { dataDir }) },
    { execGit: quietGit, execTestProbe: () => { execCalls += 1; return 'should not run'; } },
  );
  assert.equal(execCalls, 0, 'no probe runs unless policy enables it');
  assert.match(signals.failingTests, /unavailable/i);
});

runCase('enabled bounded probe runs argv (no shell) with the probe timeout', () => {
  const { cwd, dataDir } = freshWorkspace('probe-on');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true, scoutTestProbe: true, scoutTestCommand: ['node', 'scripts/run-unit-tests.mjs'] } }, { dataDir });
  const seen = {};
  const signals = collectScoutSignals(
    { workspaceFolder: cwd, dataDir, watcher: getWorkspaceWatcher(cwd, { dataDir }) },
    {
      execGit: quietGit,
      execTestProbe: (argv, opts) => {
        seen.argv = argv;
        seen.timeout = opts && opts.timeout;
        return 'FAIL: expected 1 to be 2\n1 test failed';
      },
    },
  );
  assert.deepEqual(seen.argv, ['node', 'scripts/run-unit-tests.mjs']);
  assert.equal(seen.timeout, scout.WORKSPACE_SCOUT_TEST_PROBE_TIMEOUT_MS);
  assert.match(signals.failingTests, /FAIL: expected 1 to be 2/);
});

runCase('probe rejects a shell string command and reports misconfiguration without executing', () => {
  const { cwd, dataDir } = freshWorkspace('probe-shell');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true, scoutTestProbe: true, scoutTestCommand: 'npm test && rm -rf /' } }, { dataDir });
  let execCalls = 0;
  const signals = collectScoutSignals(
    { workspaceFolder: cwd, dataDir, watcher: getWorkspaceWatcher(cwd, { dataDir }) },
    { execGit: quietGit, execTestProbe: () => { execCalls += 1; return 'ran'; } },
  );
  assert.equal(execCalls, 0, 'an unsafe non-argv command never executes');
  assert.match(signals.failingTests, /misconfigured|unavailable/i);
});

/* ------------------------------- Finding 4: submit credentials in prompt    */

runCase('Scout prompt recommended submit example carries scan_id + submit_token', () => {
  const prompt = buildScoutPrompt({
    workspaceFolder: '/tmp/ws',
    scanId: 'scan-abc',
    submitToken: 'tok-abc',
    signals: {},
  });
  assert.match(prompt, /scan_id:\s*"scan-abc"/);
  assert.match(prompt, /submit_token:\s*"tok-abc"/);
});

runCase('submit succeeds with the recommended credentials from the active scout chat', () => {
  const { cwd, dataDir } = freshWorkspace('recommended-submit');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-r',
      chatId: 'chat-r',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      submitToken: 'tok-r',
    },
  }), { dataDir });
  const res = runWorkspaceWatcherScoutAction({
    dataDir,
    workspaceFolder: cwd,
    action: 'submit',
    sourceChatId: 'chat-r',
    scanId: 'scan-r',
    scoutSubmitToken: 'tok-r',
    findings: [{ title: 'Recommended shape', category: 'bug', files: ['a.js'] }],
  });
  assert.equal(res.added, 1);
});

/* ----------------------- Idle Scout chat archive sweep (Finding: liveness) -- */

/**
 * Build a chat row for the injected store without touching the real chat file.
 * @param {object} over
 */
function scoutChat(over) {
  return {
    id: 'c',
    title: '[Scout] ws',
    workspaceFolder: '/tmp/ws',
    pickPurpose: 'scout',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

runCase('archive sweep leaves a live-run scout submit alone (submit never archives)', () => {
  const { cwd, dataDir } = freshWorkspace('archive-submit-live');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const chatId = 'scout-submit-live';
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  // A real chat in the isolated store, just like defaultStartScoutJob creates it.
  const created = addChat('scan-live', '[Scout] live', null, cwd, undefined, {
    id: chatId, agentTransport: 'test', sdkMode: 'agent', pickPurpose: 'scout',
  });
  const liveId = created?.id || chatId;
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-live',
      chatId: liveId,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      submitToken: 'tok-live',
    },
  }), { dataDir });
  submitScoutFindings(cwd, {
    dataDir,
    now,
    findings: [{ title: 'Fresh finding', category: 'bug' }],
    sourceChatId: liveId,
    scanId: 'scan-live',
    scoutSubmitToken: 'tok-live',
  });
  const stored = loadChats().find((c) => c.id === liveId);
  assert.ok(stored, 'the scout chat still exists after submit');
  assert.notEqual(stored.archived, true);
  assert.ok(!stored.archivedAt, 'submit clears credentials but never archives the live chat');
});

runCase('heartbeat pass clears an expired scan AND archives only past-grace idle scout chats', async () => {
  const { cwd, dataDir } = freshWorkspace('archive-pass');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  // scoutIntervalHours with a fresh lastScoutAt denies the run, so the ONLY
  // thing that can clear the expired scan inside the pass is the expire wiring.
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true, scoutIntervalHours: 6 } }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    lastScoutAt: new Date(now).toISOString(),
    activeScoutScan: {
      scanId: 'scan-pass',
      chatId: 'scout-old',
      startedAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
      submitToken: 'tok-pass',
    },
  }), { dataDir });
  const archivedIds = [];
  const result = await runWorkspaceWatcherScoutPass({
    dataDir,
    now,
    deps: {
      execGit: quietGit,
      runScout: async () => ({ started: true, findings: [] }),
      scoutArchive: {
        loadChats: () => [
          scoutChat({ id: 'scout-old', workspaceFolder: cwd, updatedAt: new Date(now - 16 * 60_000).toISOString() }),
          scoutChat({ id: 'scout-fresh', workspaceFolder: cwd, updatedAt: new Date(now - 60_000).toISOString() }),
        ],
        updateChat: (id) => { archivedIds.push(id); },
        listDelegationsForParent: () => [],
        isChatRunConfirmedIdle: () => true,
        isDelegationSlotOccupied: () => false,
      },
    },
  });
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan.scanId, '', 'expired active scan cleared by the pass');
  assert.equal(result.scanned, 1);
  assert.equal(result.started, 0, 'interval blocks a fresh scan; expire cleared the row');
  assert.deepEqual(result.archived, ['scout-old'], 'only the past-grace idle chat is archived');
  assert.deepEqual(archivedIds, ['scout-old']);
});

runCase('archive sweep keeps pinned, non-idle, unknown and human [Scout]-titled chats', () => {
  const { cwd } = freshWorkspace('archive-keep');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const oldAt = new Date(now - scout.WORKSPACE_SCOUT_ARCHIVE_GRACE_MS - 1000).toISOString();
  const freshAt = new Date(now - 60_000).toISOString();
  const chats = [
    scoutChat({ id: 'pinned', workspaceFolder: cwd, updatedAt: oldAt, watcherPinned: true }),
    scoutChat({ id: 'within-grace', workspaceFolder: cwd, updatedAt: freshAt }),
    scoutChat({ id: 'not-idle', workspaceFolder: cwd, updatedAt: oldAt }),
    scoutChat({ id: 'human', workspaceFolder: cwd, updatedAt: oldAt, title: '[Scout] looks like one', pickPurpose: undefined }),
    scoutChat({ id: 'archivable', workspaceFolder: cwd, updatedAt: oldAt }),
    scoutChat({ id: 'other-workspace', workspaceFolder: '/tmp/not-this', updatedAt: oldAt }),
  ];
  const archived = [];
  const out = scout.archiveIdleScoutChats(cwd, {
    now,
    deps: {
      loadChats: () => chats,
      updateChat: (id) => { archived.push(id); },
      listDelegationsForParent: () => [],
      // Idle-true for every candidate except not-idle so pin/grace/folder gates are tested directly.
      isChatRunConfirmedIdle: ({ chatId }) => chatId !== 'not-idle',
      isDelegationSlotOccupied: () => false,
    },
  });
  assert.deepEqual(out.archived, ['archivable'], 'only the fully eligible scout chat is archived');
  assert.deepEqual(archived, ['archivable']);
  assert.ok(out.skipped >= 3, 'pinned, within-grace and not-idle scout candidates increment skipped');
});

runCase('archive sweep skips scout parent when delegation list read fails', () => {
  const { cwd } = freshWorkspace('archive-deleg-fail');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const oldAt = new Date(now - scout.WORKSPACE_SCOUT_ARCHIVE_GRACE_MS - 1000).toISOString();
  const parent = scoutChat({ id: 'parent-deleg', workspaceFolder: cwd, updatedAt: oldAt });
  const archived = [];
  const out = scout.archiveIdleScoutChats(cwd, {
    now,
    deps: {
      loadChats: () => [parent],
      updateChat: (id) => { archived.push(id); },
      listDelegationsForParent: () => { throw new Error('delegation store unavailable'); },
      isChatRunConfirmedIdle: () => true,
      isDelegationSlotOccupied: () => false,
    },
  });
  assert.deepEqual(out.archived, [], 'fail-closed delegation read blocks archive');
  assert.equal(archived.length, 0);
  assert.equal(out.skipped, 1);
});

runCase('boot reconcile clears expired activeScoutScan before archive sweep', () => {
  const { cwd, dataDir } = freshWorkspace('boot-expire-scout');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeScoutScan: {
      scanId: 'scan-boot-expire',
      chatId: 'scout-boot',
      startedAt: new Date(now - 120_000).toISOString(),
      expiresAt: new Date(now - 1).toISOString(),
      submitToken: 'tok-boot',
    },
  }), { dataDir });
  reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    scoutArchiveDeps: {
      loadChats: () => [],
      updateChat: () => {},
      listDelegationsForParent: () => [],
      isChatRunConfirmedIdle: () => true,
      isDelegationSlotOccupied: () => false,
    },
  });
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan.scanId, '', 'boot expires stale scan before sweep');
});

runCase('archive sweep keeps a scout child that holds a slot and refuses its parent', () => {
  const { cwd } = freshWorkspace('archive-child');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const oldAt = new Date(now - scout.WORKSPACE_SCOUT_ARCHIVE_GRACE_MS - 1000).toISOString();
  const parent = scoutChat({ id: 'parent', workspaceFolder: cwd, updatedAt: oldAt });
  const child = scoutChat({ id: 'child', workspaceFolder: cwd, updatedAt: oldAt, pickPurpose: 'review' });
  const archived = [];
  const deps = {
    loadChats: () => [parent, child],
    updateChat: (id) => { archived.push(id); },
    listDelegationsForParent: (id) => (id === 'parent' ? [{ parentChatId: 'parent', childChatId: 'child', status: 'completed' }] : []),
    isChatRunConfirmedIdle: () => true,
  };
  // Child still occupies its delegation slot → both the child stays and the parent is refused.
  const held = scout.archiveIdleScoutChats(cwd, { now, deps: { ...deps, isDelegationSlotOccupied: () => true } });
  assert.deepEqual(held.archived, [], 'a slot-holding child blocks the whole family');
  assert.equal(archived.length, 0);
  // Once the slot is freed, the child is archived before the parent.
  const freed = scout.archiveIdleScoutChats(cwd, { now, deps: { ...deps, isDelegationSlotOccupied: () => false } });
  assert.deepEqual(freed.archived, ['child', 'parent'], 'children first, then the parent');
});

runCase('archive sweep refuses a parent whose fork descendant is still busy', () => {
  const { cwd } = freshWorkspace('archive-fork');
  const now = Date.parse('2026-02-02T12:00:00.000Z');
  const oldAt = new Date(now - scout.WORKSPACE_SCOUT_ARCHIVE_GRACE_MS - 1000).toISOString();
  const parent = scoutChat({ id: 'fparent', workspaceFolder: cwd, updatedAt: oldAt });
  const fork = scoutChat({ id: 'ffork', workspaceFolder: cwd, updatedAt: oldAt, pickPurpose: 'implement', forkParentChatId: 'fparent' });
  const archived = [];
  const deps = {
    loadChats: () => [parent, fork],
    updateChat: (id) => { archived.push(id); },
    listDelegationsForParent: () => [],
    isDelegationSlotOccupied: () => false,
  };
  const busy = scout.archiveIdleScoutChats(cwd, { now, deps: { ...deps, isChatRunConfirmedIdle: ({ chatId }) => chatId === 'fparent' } });
  assert.deepEqual(busy.archived, [], 'a busy fork keeps the parent visible (store cascade would hide it)');
  const idle = scout.archiveIdleScoutChats(cwd, { now, deps: { ...deps, isChatRunConfirmedIdle: () => true } });
  assert.deepEqual(idle.archived, ['ffork', 'fparent']);
});

await Promise.all(pending);
removeIsolatedDataDir();
if (failed > 0) {
  console.error(`\n${failed} workspace scout test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace scout tests passed');
