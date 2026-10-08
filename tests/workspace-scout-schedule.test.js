/**
 * Scout per-profile scheduling + shared limits + full attempt lifecycle
 * (stage 3). Covers the pure scheduler, the durable attempt record, the
 * settlement table from docs/configurable-scouts.md and the drain predicate.
 *
 * Isolation: the very first import points persist at a temp data dir; every
 * workspace and dataDir below lives in `os.tmpdir()`, never the real `data/`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SCOUT_GENERAL_PROFILE_ID,
  WORKSPACE_SCOUT_CATEGORIES,
  WORKSPACE_SCOUT_PROFILE_SOURCES,
  getActiveScoutScans,
  getWorkspaceScoutScheduleState,
  getWorkspaceWatcher,
  getWorkspaceWatchersDataPath,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceScoutProfile,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  computeScoutProfileNextRunAt,
  decideScoutRun,
  markScoutScanLaunchIssued,
  markScoutScanUncertain,
  expireStaleActiveScoutScan,
  reconcileScoutScans,
  resolveScoutScheduleState,
  rollbackScoutScan,
  runWorkspaceWatcherScout,
  runWorkspaceWatcherScoutPass,
  selectDueScoutProfiles,
  submitScoutFindings,
} from '../lib/workspace-watcher-scout.js';
import { getServerInstanceId } from '../lib/sdk/sdk-instance-id.js';
import { isScoutScanOccupied } from '../lib/workspace-scout-occupancy.js';
import { reconcileWorkspaceWatchersOnBoot } from '../lib/workspace-watcher.js';
import { workspaceWatcherUtcDayKey } from '../lib/workspace-watcher-guardrails.js';
import {
  getWorkspaceWatcherRuntimeStatus,
  setWorkspaceWatcherStartsEnabled,
} from '../lib/workspace-watcher-runtime-control.js';
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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-scout-sched-'));
let counter = 0;
// Lifecycle tests need a non-empty scope before a model may start.
const scopedGit = (args) => {
  if (args[0] === 'rev-parse') return 'a'.repeat(40);
  if (args[0] === 'diff' && args.includes('--name-only')) return 'lib/a.js';
  if (args[0] === 'ls-files' && args.includes('--cached')) return 'lib/a.js';
  return '';
};

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

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function profile(overrides = {}) {
  return {
    id: 'p1',
    name: 'Profil',
    description: '',
    enabled: true,
    objective: 'Cel profilu.',
    instructions: '',
    scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
    sources: [...WORKSPACE_SCOUT_PROFILE_SOURCES],
    categories: [...WORKSPACE_SCOUT_CATEGORIES],
    executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
    schedule: { mode: 'interval', intervalHours: 6 },
    limits: { maxPerDay: 4, maxFindingsPerScan: 10, timeoutMs: 60_000 },
    ...overrides,
  };
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {object} [policy]
 * @param {string} [mode]
 */
function makeWatcher(dataDir, cwd, policy = {}, mode = 'observe') {
  upsertWorkspaceWatcher(cwd, {
    mode,
    policy: { scoutEnabled: true, scoutMaxPerDay: 10, ...policy },
  }, { dataDir });
}

/**
 * Seed a raw active scan and/or schedule state without going through reserve.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {object} patch
 */
function seedRow(dataDir, cwd, patch) {
  mutateWorkspaceWatcherRow(cwd, () => patch, { dataDir });
}

/* --------------------------------------------------------- pure scheduler */

runCase('per-profile schedule state drives nextRunAt and the UTC counter', () => {
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const p = profile();
  // A profile that never ran is due now, not after one interval.
  const first = computeScoutProfileNextRunAt({ profile: p, profileState: {}, now });
  assert.equal(new Date(first).toISOString(), '2026-06-06T10:00:00.000Z');

  const ranAt = '2026-06-06T10:00:00.000Z';
  const next = computeScoutProfileNextRunAt({
    profile: p,
    profileState: { lastRunAt: ranAt, day: workspaceWatcherUtcDayKey(now), count: 1 },
    now,
  });
  assert.equal(new Date(next).toISOString(), '2026-06-06T16:00:00.000Z');

  // A spent daily budget pushes the next run to the next UTC midnight.
  const spent = computeScoutProfileNextRunAt({
    profile: p,
    profileState: { lastRunAt: ranAt, day: workspaceWatcherUtcDayKey(now), count: 4 },
    now,
  });
  assert.equal(new Date(spent).toISOString(), '2026-06-07T00:00:00.000Z');

  // A manual profile never schedules automatically.
  assert.equal(computeScoutProfileNextRunAt({
    profile: profile({ schedule: { mode: 'manual', intervalHours: 6 } }),
    now,
  }), 0);
});

runCase('decideScoutRun: profile budget + interval, manual bypass, archived/disabled', () => {
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const watcher = { mode: 'observe', policy: { scoutEnabled: true, scoutMaxPerDay: 10, scoutMaxParallel: 2 } };
  const enabled = profile();
  // Fresh profile: allowed automatically.
  assert.equal(decideScoutRun({ watcher, now, profile: enabled, profileState: {} }).allowed, true);
  // Recent lastRunAt denies on the interval.
  const recent = { lastRunAt: new Date(now - 60_000).toISOString(), day: workspaceWatcherUtcDayKey(now), count: 1 };
  assert.equal(decideScoutRun({ watcher, now, profile: enabled, profileState: recent }).reason, 'scan_interval');
  // Manual bypass skips only the interval.
  assert.equal(decideScoutRun({ watcher, now, bypassInterval: true, profile: enabled, profileState: recent }).allowed, true);
  // Profile daily budget.
  const spent = { lastRunAt: new Date(now - 90 * 3600_000).toISOString(), day: workspaceWatcherUtcDayKey(now), count: 4 };
  assert.equal(decideScoutRun({ watcher, now, profile: enabled, profileState: spent }).reason, 'profile_daily_budget');
  // A spent counter from a previous UTC day resets to zero.
  const yesterdaySpent = { lastRunAt: new Date(now - 30 * 3600_000).toISOString(), day: '2026-06-05', count: 4 };
  assert.equal(decideScoutRun({ watcher, now, profile: enabled, profileState: yesterdaySpent }).allowed, true);
  // Workspace budget also applies to a profile.
  const wsSpent = { mode: 'observe', policy: { scoutEnabled: true, scoutMaxPerDay: 1, scoutMaxParallel: 2 }, scoutScans: { day: workspaceWatcherUtcDayKey(now), count: 1 } };
  assert.equal(decideScoutRun({ watcher: wsSpent, now, profile: enabled, profileState: {} }).reason, 'daily_budget');
  // Disabled blocks the automatic schedule but a manual non-archived run may work.
  const disabled = profile({ enabled: false, schedule: { mode: 'manual', intervalHours: 6 } });
  assert.equal(decideScoutRun({ watcher, now, profile: disabled, profileState: {} }).reason, 'profile_disabled');
  assert.equal(decideScoutRun({ watcher, now, bypassInterval: true, profile: disabled, profileState: {} }).allowed, true);
  // Archived blocks even a manual run.
  const archived = profile({ archivedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(decideScoutRun({ watcher, now, bypassInterval: true, profile: archived }).reason, 'profile_archived');
  // Global gates still apply to a manual run.
  const paused = { mode: 'observe', paused: true, policy: { scoutEnabled: true, scoutMaxPerDay: 10 } };
  assert.equal(decideScoutRun({ watcher: paused, now, bypassInterval: true, profile: enabled }).reason, 'paused');
  const off = { mode: 'off', policy: { scoutEnabled: true, scoutMaxPerDay: 10 } };
  assert.equal(decideScoutRun({ watcher: off, now, bypassInterval: true, profile: enabled }).reason, 'mode_not_active');
});

runCase('selectDueScoutProfiles: two due profiles run in parallel at cap 2, one at cap 1', () => {
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const row = {
    mode: 'observe',
    policy: { scoutEnabled: true, scoutMaxPerDay: 10, scoutMaxParallel: 2 },
    scoutProfiles: [profile({ id: 'a' }), profile({ id: 'b' })],
    scoutSchedules: {},
    activeScoutScans: [],
  };
  const both = selectDueScoutProfiles({ row, now });
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((entry) => entry.profile.id).sort(), ['a', 'b']);

  const serial = selectDueScoutProfiles({ row: { ...row, policy: { ...row.policy, scoutMaxParallel: 1 } }, now });
  assert.equal(serial.length, 1);
});

runCase('selectDueScoutProfiles: a frequently run profile never starves the others', () => {
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const row = {
    mode: 'observe',
    policy: { scoutEnabled: true, scoutMaxPerDay: 10, scoutMaxParallel: 1 },
    scoutProfiles: [profile({ id: 'frequent' }), profile({ id: 'starved' })],
    scoutSchedules: {
      frequent: { lastRunAt: new Date(now - 3600_000).toISOString(), day: workspaceWatcherUtcDayKey(now), count: 1 },
      starved: { lastRunAt: new Date(now - 48 * 3600_000).toISOString(), day: '2026-06-04', count: 1 },
    },
    activeScoutScans: [],
  };
  const due = selectDueScoutProfiles({ row, now });
  assert.equal(due.length, 1);
  assert.equal(due[0].profile.id, 'starved', 'the oldest profile wins the single slot');
});

runCase('selectDueScoutProfiles: one unsettled scan per profile blocks a second start', () => {
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const row = {
    mode: 'observe',
    policy: { scoutEnabled: true, scoutMaxPerDay: 10, scoutMaxParallel: 2 },
    scoutProfiles: [profile({ id: 'a' }), profile({ id: 'b' })],
    scoutSchedules: {},
    activeScoutScans: [{
      scanId: 'scan-a',
      scoutId: 'a',
      status: 'reserved',
      launchIssued: false,
      reservedAt: new Date(now).toISOString(),
      startDeadlineAt: new Date(now + 120_000).toISOString(),
    }],
  };
  const due = selectDueScoutProfiles({ row, now });
  assert.deepEqual(due.map((entry) => entry.profile.id), ['b']);
});

/* -------------------------------------------------- reserve/lifecycle */

runCase('an explicit profile reservation writes scoutId, requestId, ownerInstance and schedule state', async () => {
  const { cwd, dataDir } = freshWorkspace('reserve-profile');
  makeWatcher(dataDir, cwd, { scoutMaxParallel: 2 });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'perf' }), { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  let seen = null;
  await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now,
    scoutId: 'perf',
    deps: {
      execGit: scopedGit,
      runScout: async ({ scanId }) => {
        seen = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }))
          .find((scan) => scan.scanId === scanId) || null;
        return { started: true, chatId: seen.chatId, runId: 'r1' };
      },
    },
  });
  assert.ok(seen);
  assert.equal(seen.scoutId, 'perf');
  assert.ok(seen.requestId, 'requestId is durable before handoff');
  assert.ok(seen.chatId, 'chatId is durable before handoff');
  assert.ok(seen.ownerInstance);
  const state = getWorkspaceScoutScheduleState(getWorkspaceWatcher(cwd, { dataDir }), 'perf');
  assert.equal(state.count, 1);
  assert.equal(new Date(state.nextRunAt).toISOString(), '2026-06-06T16:00:00.000Z');
  assert.equal(state.lastRunAt, new Date(now).toISOString());
});

runCase('parallel heartbeat: the second start of the same tick respects scoutMaxParallel', async () => {
  const { cwd, dataDir } = freshWorkspace('parallel-tick');
  makeWatcher(dataDir, cwd, { scoutMaxParallel: 1 });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'perf' }), { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const deps = { execGit: scopedGit, runScout: async () => ({ started: true }) };
  const first = await runWorkspaceWatcherScout({ workspaceFolder: cwd, dataDir, now, scoutId: 'perf', deps });
  assert.equal(first.scanned, true);
  const second = await runWorkspaceWatcherScout({ workspaceFolder: cwd, dataDir, now, scoutId: 'perf', deps });
  assert.equal(second.scanned, false);
  assert.equal(second.reason, 'scout_parallel');
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 1);
});

runCase('failed start A refunds its own profile counter and never touches a successful B', async () => {
  const { cwd, dataDir } = freshWorkspace('failed-a-success-b');
  makeWatcher(dataDir, cwd, { scoutMaxParallel: 2 });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'a' }), { dataDir });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'b' }), { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const failed = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now,
    scoutId: 'a',
    deps: { execGit: scopedGit, runScout: async () => { throw new Error('boom'); } },
  });
  assert.equal(failed.reason, 'scout_failed');
  const ok = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: now + 1000,
    scoutId: 'b',
    deps: { execGit: scopedGit, runScout: async () => ({ started: true }) },
  });
  assert.equal(ok.scanned, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  const a = getWorkspaceScoutScheduleState(row, 'a');
  const b = getWorkspaceScoutScheduleState(row, 'b');
  assert.equal(a.count, 0, 'A refunded');
  assert.equal(b.count, 1, 'B keeps its slot');
  assert.equal(row.scoutScans.count, 1, 'workspace counter keeps only B');
});

runCase('a failed start across a UTC boundary never decrements the new day counter', () => {
  const { cwd, dataDir } = freshWorkspace('utc-boundary-profile');
  makeWatcher(dataDir, cwd);
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'p1' }), { dataDir });
  // A reserved on D-1; B reserved on D (the profile counter reset).
  seedRow(dataDir, cwd, {
    scoutSchedules: {
      p1: { lastRunAt: '2026-06-06T00:00:05.000Z', nextRunAt: '', day: '2026-06-06', count: 1 },
    },
    activeScoutScans: [
      { scanId: 'A', scoutId: 'p1', chatId: 'chat-A', reservedAt: '2026-06-05T23:59:00.000Z' },
      { scanId: 'B', scoutId: 'p1', chatId: 'chat-B', reservedAt: '2026-06-06T00:00:05.000Z' },
    ],
  });
  rollbackScoutScan(cwd, {
    dataDir,
    scanId: 'A',
    now: Date.parse('2026-06-06T00:00:05.000Z'),
    reservedAt: '2026-06-05T23:59:00.000Z',
    reservedScans: { day: '2026-06-05', count: 4 },
    previousLastScoutAt: '',
    previousScans: { day: '2026-06-05', count: 3 },
  });
  const state = getWorkspaceScoutScheduleState(getWorkspaceWatcher(cwd, { dataDir }), 'p1');
  assert.equal(state.day, '2026-06-06');
  assert.equal(state.count, 1, "today's B counter is untouched");
});

runCase('an explicit profile executor overrides the legacy orchestrator and narrows harnesses', async () => {
  const { cwd, dataDir } = freshWorkspace('executor');
  // Real transport ids: the read-only gate rejects an unknown harness before the
  // executor precedence under test would ever run.
  makeWatcher(dataDir, cwd, { scoutAllowedHarnesses: ['claude', 'sdk'], scoutMaxParallel: 2 });
  upsertWorkspaceScoutProfile(cwd, profile({
    id: 'explicit',
    executor: { auto: false, harness: 'sdk', model: 'm2', allowedHarnesses: ['sdk'] },
  }), { dataDir });
  upsertWorkspaceScoutProfile(cwd, profile({
    id: 'auto',
    executor: { auto: true, harness: '', model: '', allowedHarnesses: ['sdk'] },
  }), { dataDir });
  /** @type {object[]} */
  const seen = [];
  const deps = {
    execGit: scopedGit,
    resolveWorkspaceWatcherOrchestrator: async ({ watcher }) => {
      seen.push(watcher.policy);
      return { ok: true, harness: 'sdk', model: 'm2' };
    },
    addChat: () => ({ id: 'chat-x' }),
    startChatRun: async () => ({ runId: 'r' }),
  };
  await runWorkspaceWatcherScout({ workspaceFolder: cwd, dataDir, now: Date.now(), scoutId: 'explicit', deps });
  assert.deepEqual(seen[0].orchestrator, { harness: 'sdk', model: 'm2' });
  assert.deepEqual(seen[0].allowedHarnesses, ['sdk']);
  await runWorkspaceWatcherScout({ workspaceFolder: cwd, dataDir, now: Date.now() + 60_000, scoutId: 'auto', deps });
  assert.deepEqual(seen[1].orchestrator, {}, 'auto never inherits a cycle orchestrator');
});

runCase('an empty profile/global harness intersection blocks the start with a clear reason', async () => {
  const { cwd, dataDir } = freshWorkspace('executor-empty');
  makeWatcher(dataDir, cwd, { scoutAllowedHarnesses: ['one'] });
  upsertWorkspaceScoutProfile(cwd, profile({
    id: 'blocked',
    executor: { auto: false, harness: 'two', model: 'm2', allowedHarnesses: ['two'] },
  }), { dataDir });
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: Date.now(),
    scoutId: 'blocked',
    deps: {
      execGit: scopedGit,
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'two', model: 'm2' }),
    },
  });
  assert.equal(result.scanned, false);
  assert.equal(result.reason, 'executor_not_allowed');
});

runCase('a normal started=false consumes the profile and workspace daily budget (refund table)', async () => {
  const { cwd, dataDir } = freshWorkspace('started-false-consumes');
  makeWatcher(dataDir, cwd, { scoutMaxParallel: 2 });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'perf' }), { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  // A normal "no orchestrator / chat create refused" answer is NOT
  // `global_starts_disabled`, so the reservation stamp is kept on purpose: it
  // consumes the profile and workspace day counters and advances lastRunAt so a
  // missing model cannot make every heartbeat retry the same scan. Only the
  // parallel slot is released (the active record is cleared, not rolled back).
  const result = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now,
    scoutId: 'perf',
    deps: {
      execGit: scopedGit,
      runScout: async () => ({ started: false, reason: 'orchestrator_unavailable' }),
    },
  });
  assert.equal(result.scanned, false);
  assert.equal(result.reason, 'orchestrator_unavailable');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  const state = getWorkspaceScoutScheduleState(row, 'perf');
  assert.equal(state.count, 1, 'profile daily counter is consumed, not refunded');
  assert.equal(state.lastRunAt, new Date(now).toISOString(), 'schedule advanced so the heartbeat will not retry');
  assert.equal(row.scoutScans.count, 1, 'workspace daily counter is consumed too');
  assert.deepEqual(getActiveScoutScans(row), [], 'the parallel slot is released');
  const entry = row.scoutScanHistory.find((item) => item.scanId === result.scanId);
  assert.equal(entry.status, 'failed', 'the never-started scan is not completed');
});

/* ------------------------------------------------------ reconciliation */

runCase('crash before handoff past the start deadline refunds exactly once', () => {
  const { cwd, dataDir } = freshWorkspace('crash-refund');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    scoutScans: { day: '2026-06-06', count: 3 },
    scoutSchedules: { p1: { lastRunAt: '2026-06-06T09:00:00.000Z', day: '2026-06-06', count: 2 } },
    activeScoutScans: [{
      scanId: 'crash',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      reservedAt: '2026-06-06T09:00:00.000Z',
      startDeadlineAt: '2026-06-06T09:02:00.000Z',
      ownerInstance: 'dead-instance',
    }],
  });
  const first = reconcileScoutScans(cwd, { dataDir, now, instanceId: 'current' });
  assert.equal(first.refunded, 1);
  assert.deepEqual(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })), []);
  let row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.scoutScans, { day: '2026-06-06', count: 2 }, 'workspace refunded once');
  assert.equal(getWorkspaceScoutScheduleState(row, 'p1').count, 1, 'profile refunded once');

  const replay = reconcileScoutScans(cwd, { dataDir, now: now + 1000, instanceId: 'current' });
  assert.equal(replay.refunded, 0, 'a replay is a no-op');
  row = getWorkspaceWatcher(cwd, { dataDir });
  assert.deepEqual(row.scoutScans, { day: '2026-06-06', count: 2 }, 'no double refund');
});

runCase('a live in-deadline reservation is never released while its owner may be alive', () => {
  const { cwd, dataDir } = freshWorkspace('reserve-alive');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'fresh',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      reservedAt: new Date(now).toISOString(),
      startDeadlineAt: new Date(now + 120_000).toISOString(),
      ownerInstance: 'current',
    }],
  });
  const summary = reconcileScoutScans(cwd, { dataDir, now, instanceId: 'current' });
  assert.equal(summary.reconciled, 0);
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 1);
});

runCase('delayed/uncertain handoff: launched, no chat, deadline passed -> uncertain, no refund', () => {
  const { cwd, dataDir } = freshWorkspace('uncertain-handoff');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    scoutScans: { day: '2026-06-06', count: 1 },
    activeScoutScans: [{
      scanId: 'unc',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: true,
      chatId: '',
      reservedAt: '2026-06-06T09:00:00.000Z',
      startDeadlineAt: '2026-06-06T09:02:00.000Z',
      ownerInstance: 'current',
    }],
  });
  const summary = reconcileScoutScans(cwd, { dataDir, now, instanceId: 'current' });
  assert.equal(summary.uncertain, 1);
  assert.equal(summary.refunded, 0);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(getActiveScoutScans(row)[0].status, 'uncertain');
  assert.equal(row.scoutScans.count, 1, 'no refund for a possible handoff');
  // unknown occupies the slot and blocks the profile from starting again.
  const due = selectDueScoutProfiles({
    row: { ...row, scoutProfiles: [profile({ id: 'p1' })] },
    now,
  });
  assert.deepEqual(due, []);
});

runCase('no response after acceptance stays occupied; confirmed idle with no review releases', () => {
  const { cwd, dataDir } = freshWorkspace('accepted-probe');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'acc',
      scoutId: 'p1',
      status: 'running',
      launchIssued: true,
      acceptedAt: '2026-06-06T09:00:00.000Z',
      chatId: 'chat-acc',
      requestId: 'scan-acc',
      expiresAt: '2026-06-06T13:00:00.000Z',
    }],
  });
  const unknown = reconcileScoutScans(cwd, {
    dataDir,
    now,
    deps: { probeChatRunLiveness: () => ({ known: false, busy: false }) },
  });
  assert.equal(unknown.reconciled, 0);
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 1);

  const idle = reconcileScoutScans(cwd, {
    dataDir,
    now,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false }),
      listDelegationsForParent: () => [],
    },
  });
  assert.equal(idle.released, 1);
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 0);
});

runCase('expired-but-busy stays occupied; review delegation keeps the slot', () => {
  const { cwd, dataDir } = freshWorkspace('expired-busy');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'busy',
      scoutId: 'p1',
      status: 'running',
      launchIssued: true,
      acceptedAt: '2026-06-06T08:00:00.000Z',
      chatId: 'chat-busy',
      expiresAt: '2026-06-06T09:00:00.000Z',
    }],
  });
  const busy = reconcileScoutScans(cwd, {
    dataDir,
    now,
    deps: { probeChatRunLiveness: () => ({ known: true, busy: true }) },
  });
  assert.equal(busy.reconciled, 0);
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 1, 'expired but busy is kept');

  const review = reconcileScoutScans(cwd, {
    dataDir,
    now,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false }),
      listDelegationsForParent: () => [{ parentChatId: 'chat-busy', childChatId: 'c1', status: 'running' }],
      isDelegationSlotOccupied: () => true,
    },
  });
  assert.equal(review.reconciled, 0);
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 1, 'review keeps the slot');
  assert.equal(isScoutScanOccupied(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }))[0], now), true);
});

runCase('expiry of A never removes a parallel B and a launched scan skips legacy expiry', () => {
  const { cwd, dataDir } = freshWorkspace('expire-parallel');
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  makeWatcher(dataDir, cwd);
  seedRow(dataDir, cwd, {
    activeScoutScans: [
      { scanId: 'A', scoutId: 'a', chatId: 'chat-A', expiresAt: '2026-06-06T09:59:00.000Z' },
      { scanId: 'B', scoutId: 'b', chatId: 'chat-B', expiresAt: '2026-06-06T13:00:00.000Z' },
      {
        scanId: 'launched',
        scoutId: 'c',
        chatId: 'chat-C',
        launchIssued: true,
        expiresAt: '2026-06-06T09:00:00.000Z',
      },
    ],
  });
  const pass = reconcileScoutScans(cwd, {
    dataDir,
    now,
    deps: { probeChatRunLiveness: () => ({ known: true, busy: true }) },
  });
  assert.ok(pass.reconciled >= 1, 'never-launched expired A is settled');
  const ids = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).map((scan) => scan.scanId).sort();
  assert.deepEqual(ids, ['B', 'launched'], 'B and the launched scan survive');
});

runCase('drain: reconciliation runs while off and unknown never yields readyForRestart', async () => {
  const { cwd, dataDir } = freshWorkspace('drain-off');
  makeWatcher(dataDir, cwd, {}, 'off');
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    activeScoutScans: [
      {
        scanId: 'idle',
        scoutId: 'p1',
        status: 'running',
        launchIssued: true,
        acceptedAt: '2026-06-06T08:00:00.000Z',
        chatId: 'chat-idle',
        expiresAt: '2026-06-06T09:00:00.000Z',
      },
      {
        scanId: 'unknown',
        scoutId: 'p2',
        status: 'running',
        launchIssued: true,
        acceptedAt: '2026-06-06T08:00:00.000Z',
        chatId: 'chat-unknown',
        expiresAt: '2026-06-06T09:00:00.000Z',
      },
    ],
  });
  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: false });
  // Even off, the pass reconciles: idle chat is released, unknown is kept.
  const pass = await runWorkspaceWatcherScoutPass({
    dataDir,
    now,
    workspaceFolders: [cwd],
    deps: {
      probeChatRunLiveness: ({ chatId }) => (chatId === 'chat-idle'
        ? { known: true, busy: false }
        : { known: false, busy: false }),
      listDelegationsForParent: () => [],
    },
  });
  assert.ok(pass.reconciled >= 1);
  const remaining = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).map((scan) => scan.scanId);
  assert.deepEqual(remaining, ['unknown']);
  const status = getWorkspaceWatcherRuntimeStatus({ dataDir, now });
  assert.equal(status.readyForRestart, false, 'unknown still occupies a slot');
  assert.equal(status.statusUnavailable, false);

  // Once the unknown scan is settled, the drain can finish.
  reconcileScoutScans(cwd, {
    dataDir,
    now,
    deps: { probeChatRunLiveness: () => ({ known: true, busy: false }), listDelegationsForParent: () => [] },
  });
  const ready = getWorkspaceWatcherRuntimeStatus({ dataDir, now });
  assert.equal(ready.readyForRestart, true);
});

runCase('readyForRestart is blocked by an unreadable store, never only by expiresAt', () => {
  const { cwd, dataDir } = freshWorkspace('drain-unavailable');
  makeWatcher(dataDir, cwd);
  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: false });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'launched',
      scoutId: 'p1',
      status: 'running',
      launchIssued: true,
      acceptedAt: '2026-06-06T08:00:00.000Z',
      chatId: 'chat-l',
      expiresAt: '2026-06-06T09:00:00.000Z',
    }],
  });
  const status = getWorkspaceWatcherRuntimeStatus({
    dataDir,
    now,
    probeScoutOccupancy: () => ({ ok: false }),
  });
  assert.equal(status.statusUnavailable, true);
  assert.equal(status.readyForRestart, false);
});

/* -------------------------------------------------------------- snapshot */

runCase('a running scan keeps its reserved profile snapshot after an edit', async () => {
  const { cwd, dataDir } = freshWorkspace('snapshot');
  makeWatcher(dataDir, cwd);
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'snap', name: 'Before' }), { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  /** @type {object | null} */
  let snapshot = null;
  await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now,
    scoutId: 'snap',
    deps: {
      execGit: scopedGit,
      runScout: async () => {
        const row = getWorkspaceWatcher(cwd, { dataDir });
        snapshot = getActiveScoutScans(row)[0].snapshot;
        return { started: true };
      },
    },
  });
  assert.equal(snapshot.name, 'Before');
  // Edit the profile: the in-flight scan snapshot is unchanged.
  const current = getWorkspaceWatcher(cwd, { dataDir }).scoutProfiles.find((p) => p.id === 'snap');
  upsertWorkspaceScoutProfile(cwd, { ...current, name: 'After' }, { dataDir, expectedRevision: current.revision });
  const after = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }))[0];
  assert.equal(after.snapshot.name, 'Before', 'the running scan keeps its snapshot');
  assert.equal(after.snapshot.revision, 1);
});

/* --------------------------------------------------- TODO slot isolation */

runCase('a Scout scan never touches the todo cycle budget or active cycles', async () => {
  const { cwd, dataDir } = freshWorkspace('no-todo-slot');
  makeWatcher(dataDir, cwd);
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'perf' }), { dataDir });
  await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: Date.now(),
    scoutId: 'perf',
    deps: { execGit: scopedGit, runScout: async () => ({ started: true }) },
  });
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycles.count, 0);
  assert.deepEqual(row.activeCycles, []);
  assert.equal(getWorkspaceScoutScheduleState(row, 'perf').count, 1);
});

runCase('resolveScoutScheduleState falls back to the legacy workspace schedule for the general profile', () => {
  const row = {
    lastScoutAt: '2026-06-06T10:00:00.000Z',
    scoutScans: { day: '2026-06-06', count: 2 },
    scoutSchedules: {},
  };
  const state = resolveScoutScheduleState(row, SCOUT_GENERAL_PROFILE_ID);
  assert.equal(state.lastRunAt, '2026-06-06T10:00:00.000Z');
  assert.equal(state.count, 2);
  const other = resolveScoutScheduleState({ ...row, scoutSchedules: { p2: { lastRunAt: 'x', day: 'y', count: 1 } } }, 'p2');
  assert.equal(other.lastRunAt, 'x');
});

runCase('markScoutScanLaunchIssued and markScoutScanUncertain keep the record and slot', () => {
  const { cwd, dataDir } = freshWorkspace('markers');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'mark',
      scoutId: 'p1',
      status: 'reserved',
      reservedAt: new Date(now).toISOString(),
      startDeadlineAt: new Date(now + 120_000).toISOString(),
      ownerInstance: 'current',
    }],
  });
  assert.equal(markScoutScanLaunchIssued(cwd, { scanId: 'mark', chatId: 'c1', dataDir }), true);
  let scan = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }))[0];
  assert.equal(scan.launchIssued, true);
  assert.equal(scan.chatId, 'c1');
  assert.equal(markScoutScanUncertain(cwd, { scanId: 'mark', dataDir, error: 'x' }), true);
  scan = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }))[0];
  assert.equal(scan.status, 'uncertain');
  assert.equal(isScoutScanOccupied(scan, now), true);
});

runCase('the heartbeat pass schedules stored profiles up to the parallel cap', async () => {
  const { cwd, dataDir } = freshWorkspace('pass-schedule');
  makeWatcher(dataDir, cwd, { scoutMaxParallel: 2 });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'a', name: 'A' }), { dataDir });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'b', name: 'B' }), { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  const deps = {
    execGit: scopedGit,
    runScout: async () => ({ started: true, findings: [] }),
  };
  const pass = await runWorkspaceWatcherScoutPass({
    dataDir,
    now,
    workspaceFolders: [cwd],
    deps,
  });
  assert.equal(pass.scanned, 1);
  assert.equal(pass.started, 2, 'both due profiles start at the cap');
  assert.deepEqual(pass.scans.map((scan) => scan.scoutId).sort(), ['a', 'b']);

  const serial = await runWorkspaceWatcherScoutPass({
    dataDir,
    now: now + 60_000,
    workspaceFolders: [cwd],
    deps: { ...deps, runScout: async () => ({ started: true, findings: [] }) },
  });
  // Both profiles already have an unsettled scan, so neither restarts.
  assert.equal(serial.started, 0);
  assert.equal(serial.skipped, 1);
});

runCase('the heartbeat pass picks the oldest profile when only one slot is free', async () => {
  const { cwd, dataDir } = freshWorkspace('pass-starvation');
  makeWatcher(dataDir, cwd, { scoutMaxParallel: 1 });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'frequent', name: 'F' }), { dataDir });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'starved', name: 'S' }), { dataDir });
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    scoutSchedules: {
      frequent: { lastRunAt: new Date(now - 3600_000).toISOString(), day: workspaceWatcherUtcDayKey(now), count: 1 },
      starved: { lastRunAt: new Date(now - 48 * 3600_000).toISOString(), day: '2026-06-04', count: 1 },
    },
  });
  const pass = await runWorkspaceWatcherScoutPass({
    dataDir,
    now,
    workspaceFolders: [cwd],
    deps: { execGit: scopedGit, runScout: async () => ({ started: true, findings: [] }) },
  });
  assert.equal(pass.started, 1);
  assert.equal(pass.scans[0].scoutId, 'starved');
});

runCase('boot reconcile refunds a crashed reservation and keeps a launched one', () => {
  const { cwd, dataDir } = freshWorkspace('boot-reconcile');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-06T10:00:00.000Z');
  seedRow(dataDir, cwd, {
    scoutScans: { day: '2026-06-06', count: 1 },
    activeScoutScans: [
      {
        scanId: 'crashed',
        scoutId: 'p1',
        status: 'reserved',
        launchIssued: false,
        reservedAt: '2026-06-06T09:00:00.000Z',
        startDeadlineAt: '2026-06-06T09:02:00.000Z',
        ownerInstance: 'dead-instance',
      },
      {
        scanId: 'live',
        scoutId: 'p2',
        status: 'running',
        launchIssued: true,
        acceptedAt: '2026-06-06T09:00:00.000Z',
        chatId: 'chat-live',
        requestId: 'scan-live',
        expiresAt: '2026-06-06T13:00:00.000Z',
      },
    ],
  });
  const result = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now,
    probeChatRunLiveness: () => ({ known: true, busy: true }),
  });
  assert.equal(Array.isArray(result.errors), true);
  const ids = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).map((scan) => scan.scanId);
  assert.deepEqual(ids, ['live'], 'crash refunded, launched scan kept');
  assert.deepEqual(getWorkspaceWatcher(cwd, { dataDir }).scoutScans, { day: '2026-06-06', count: 0 });
});

/* ------------------------------------------------------------ findings 1–5 */

runCase('finding 1: deadline does NOT free a reservation owned by the current instance', () => {
  // A never-launched scan past startDeadlineAt must stay occupied when the
  // owner instance is still alive (same instanceId). Only reconciliation may
  // free it after confirming the owner is dead.
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  const ownerInstance = 'alive-instance';
  const scan = {
    scanId: 's1',
    status: 'reserved',
    launchIssued: false,
    reservedAt: '2026-06-10T11:00:00.000Z',
    startDeadlineAt: '2026-06-10T11:02:00.000Z', // 2 minutes ago
    ownerInstance,
  };
  assert.equal(isScoutScanOccupied(scan, now, ownerInstance), true,
    'live owner: slot must stay occupied past deadline');
  assert.equal(isScoutScanOccupied(scan, now, 'other-instance'), false,
    'dead owner: slot is drainable');
  assert.equal(isScoutScanOccupied(scan, now), false,
    'no instanceId provided: treated as unknown/drainable (backward compat)');
});

runCase('finding 1: reconcileScoutScans TTL branch respects ownerDead', () => {
  // A never-launched scan past expiresAt must NOT be cleared if the owner
  // is alive (ownerInstance matches the running instanceId).
  const { cwd, dataDir } = freshWorkspace('reconcile-ttl-live');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  const aliveInstance = 'alive-instance-123';
  seedRow(dataDir, cwd, {
    scoutScans: { day: '2026-06-10', count: 1 },
    activeScoutScans: [
      {
        scanId: 'ttl-alive',
        scoutId: SCOUT_GENERAL_PROFILE_ID,
        status: 'reserved',
        launchIssued: false,
        reservedAt: '2026-06-10T10:00:00.000Z',
        startDeadlineAt: '2026-06-10T10:05:00.000Z',
        expiresAt: '2026-06-10T11:00:00.000Z', // expired
        ownerInstance: aliveInstance,
      },
    ],
  });
  reconcileScoutScans(cwd, {
    dataDir,
    now,
    instanceId: aliveInstance, // owner is alive
  });
  const scans = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }));
  assert.equal(scans.length, 1, 'alive owner scan must NOT be cleared by TTL branch');
});

runCase('finding 2: throw after launchIssued → uncertain, slot occupied', async () => {
  // startChatRun threw after markScoutScanLaunchIssued: the slot must become
  // `uncertain`, not cleared. Reconciliation (liveness probe) frees it later.
  const { cwd, dataDir } = freshWorkspace('uncertain-f2');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    deps: {
      execGit: scopedGit,
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'test', model: 'test-model' }),
      addChat: () => ({ id: 'chat-uncertain' }),
      startChatRun: async () => { throw new Error('handoff unknown'); },
    },
  });
  const active = getWorkspaceWatcher(cwd, { dataDir }).activeScoutScan;
  assert.notEqual(active.scanId, '', 'slot must remain occupied (uncertain)');
  assert.equal(active.status, 'uncertain', 'status must be uncertain, not cleared');
});

runCase('finding 3: submit after expiresAt keeps slot of a launched scan', async () => {
  // The submit token expiry must not clear a scan that was already launched.
  // `expireStaleActiveScoutScan` (liveness-checked) is the correct path.
  const { cwd, dataDir } = freshWorkspace('submit-ttl-launched');
  makeWatcher(dataDir, cwd);
  const launchTime = '2026-06-10T10:00:00.000Z';
  const expiredAt = '2026-06-10T11:00:00.000Z';
  const now = Date.parse('2026-06-10T12:00:00.000Z'); // past TTL
  seedRow(dataDir, cwd, {
    scoutScans: { day: '2026-06-10', count: 1 },
    activeScoutScans: [
      {
        scanId: 'launched-scan',
        scoutId: SCOUT_GENERAL_PROFILE_ID,
        status: 'running',
        launchIssued: true,
        chatId: 'chat-running',
        acceptedAt: launchTime,
        expiresAt: expiredAt,
        submitToken: 'tok-valid',
        startedAt: launchTime,
        reservedAt: launchTime,
      },
    ],
  });
  let caught = null;
  try {
    submitScoutFindings(cwd, {
      dataDir,
      now,
      sourceChatId: 'chat-running',
      scanId: 'launched-scan',
      submitToken: 'tok-valid',
      findings: [],
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'submit must throw (token expired)');
  assert.equal(caught.code, 'OUT_OF_SCOPE');
  // The slot must still be occupied; only liveness probe may free it.
  const scans = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }));
  assert.equal(scans.length, 1, 'launched scan must NOT be cleared by submit-token expiry');
  assert.equal(scans[0].scanId, 'launched-scan', 'slot still occupied');
});

runCase('finding 4: v1 legacy migration with chatId sets launchIssued, not refunded on boot', () => {
  // A v1 singleton that already has a chatId represents a running scan.
  // buildLegacyActiveScoutScan must set launchIssued=true so reconciliation
  // treats it as a live process and does NOT refund it as a stale reservation.
  //
  // To exercise the real migration path, write a raw v1-style JSON file
  // (without activeScoutScans) instead of using seedRow/mutate which
  // normalizes eagerly via expandLegacyActiveScoutScanPatch.
  const { cwd, dataDir } = freshWorkspace('legacy-v1-chatid');
  makeWatcher(dataDir, cwd);
  const dataPath = getWorkspaceWatchersDataPath({ dataDir });
  // Patch the stored file to hold a v1-style activeScoutScan with a chatId
  // and no activeScoutScans key.
  const stored = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const key = cwd;
  if (stored.items && stored.items[key]) {
    stored.items[key].activeScoutScan = {
      scanId: 'v1-scan',
      chatId: 'v1-chat',
      status: 'running',
      startedAt: '2026-06-10T09:00:00.000Z',
      reservedAt: '2026-06-10T09:00:00.000Z',
      startDeadlineAt: '2026-06-10T09:02:00.000Z', // past deadline
      expiresAt: '2026-06-10T13:00:00.000Z',
    };
    delete stored.items[key].activeScoutScans;
  }
  fs.writeFileSync(dataPath, JSON.stringify(stored), 'utf8');
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  // Verify that buildLegacyActiveScoutScan sets launchIssued on read.
  const rawScans = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }));
  assert.equal(rawScans.length, 1, 'migration should produce one scan');
  assert.equal(rawScans[0].launchIssued, true, 'migration must set launchIssued when chatId present');
  // Boot reconcile with a "dead owner" instance; must NOT refund because
  // launchIssued=true.
  reconcileScoutScans(cwd, {
    dataDir,
    now,
    instanceId: 'other-instance',
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: true }),
    },
  });
  const scans = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }));
  assert.equal(scans.length, 1, 'running v1 scan with chatId must not be refunded on boot');
});

runCase('finding 5: refund orphan restores lastRunAt instead of zeroing it', () => {
  // refundOrphanedScoutReservation must restore the previous lastScoutAt and
  // profile lastRunAt instead of writing '', otherwise the interval is bypassed.
  const { cwd, dataDir } = freshWorkspace('refund-restore-ts');
  upsertWorkspaceWatcher(cwd, { mode: 'observe', policy: { scoutEnabled: true } }, { dataDir });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'p1' }), { dataDir });
  const previousLastScoutAt = '2026-06-10T09:00:00.000Z';
  const previousLastRunAt = '2026-06-10T09:00:00.000Z';
  const reservedAt = '2026-06-10T10:00:00.000Z';
  // Seed a scan that carries the previous timestamps (as if reserved by the
  // new code that stores previousLastScoutAt on the record).
  seedRow(dataDir, cwd, {
    lastScoutAt: reservedAt,
    scoutScans: { day: '2026-06-10', count: 1 },
    scoutSchedules: { p1: { lastRunAt: reservedAt, nextRunAt: '', day: '2026-06-10', count: 1 } },
    activeScoutScans: [
      {
        scanId: 'orphan-refund',
        scoutId: 'p1',
        status: 'reserved',
        launchIssued: false,
        reservedAt,
        startDeadlineAt: '2026-06-10T10:02:00.000Z',
        ownerInstance: 'dead-instance',
        previousLastScoutAt,
        previousScheduleLastRunAt: previousLastRunAt,
        previousScheduleNextRunAt: '',
      },
    ],
  });
  const now = Date.parse('2026-06-10T11:00:00.000Z');
  reconcileScoutScans(cwd, {
    dataDir,
    now,
    instanceId: 'other-instance', // ownerDead = true
  });
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.lastScoutAt, previousLastScoutAt,
    'refund must restore previousLastScoutAt, not zero it');
  const sched = getWorkspaceScoutScheduleState(row, 'p1');
  assert.equal(sched.lastRunAt, previousLastRunAt,
    'refund must restore profile previousScheduleLastRunAt, not zero it');
});

runCase('finding 1: readyForRestart stays false while a live-owner attempt occupies a slot', () => {
  const { cwd, dataDir } = freshWorkspace('ready-live-owner');
  makeWatcher(dataDir, cwd);
  const reservedAt = '2026-06-10T10:00:00.000Z';
  const now = Date.parse('2026-06-10T10:05:00.000Z');
  const instanceId = getServerInstanceId();
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'live-res',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      reservedAt,
      startDeadlineAt: '2026-06-10T10:02:00.000Z',
      expiresAt: '2026-06-10T14:00:00.000Z',
      ownerInstance: instanceId,
    }],
  });
  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: false });
  const blocked = getWorkspaceWatcherRuntimeStatus({ dataDir, now });
  assert.equal(blocked.readyForRestart, false);
  assert.ok(blocked.activeScoutScans >= 1);
  reconcileScoutScans(cwd, {
    dataDir,
    now,
    instanceId: 'other-dead-instance',
  });
  const ready = getWorkspaceWatcherRuntimeStatus({ dataDir, now });
  assert.equal(ready.readyForRestart, true);
});

runCase('finding 1: production scheduler blocks a second profile scan after start deadline', async () => {
  const { cwd, dataDir } = freshWorkspace('sched-live-deadline');
  makeWatcher(dataDir, cwd, { scoutMaxParallel: 2 });
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'p1' }), { dataDir });
  const reservedAt = '2026-06-10T10:00:00.000Z';
  const now = Date.parse('2026-06-10T10:05:00.000Z');
  const instanceId = getServerInstanceId();
  seedRow(dataDir, cwd, {
    scoutSchedules: { p1: { lastRunAt: reservedAt, day: '2026-06-10', count: 1 } },
    activeScoutScans: [{
      scanId: 'hold',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      reservedAt,
      startDeadlineAt: '2026-06-10T10:02:00.000Z',
      ownerInstance: instanceId,
      expiresAt: '2026-06-10T14:00:00.000Z',
    }],
  });
  const blocked = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now,
    scoutId: 'p1',
    bypassInterval: true,
    deps: { execGit: scopedGit, runScout: async () => ({ started: true }) },
  });
  assert.equal(blocked.scanned, false);
  assert.ok(['profile_scan_active', 'scout_parallel'].includes(String(blocked.reason)));
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'hold',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      reservedAt,
      startDeadlineAt: '2026-06-10T10:02:00.000Z',
      ownerInstance: 'crashed-instance',
      expiresAt: '2026-06-10T14:00:00.000Z',
    }],
  });
  reconcileScoutScans(cwd, { dataDir, now, instanceId });
  const allowed = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: now + 1000,
    scoutId: 'p1',
    bypassInterval: true,
    deps: { execGit: scopedGit, runScout: async () => ({ started: true }) },
  });
  assert.equal(allowed.scanned, true);
});

runCase('finding 1: expireStaleActiveScoutScan keeps a live owner past submit TTL', () => {
  const { cwd, dataDir } = freshWorkspace('expire-live-owner');
  makeWatcher(dataDir, cwd);
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  const instanceId = getServerInstanceId();
  seedRow(dataDir, cwd, {
    activeScoutScans: [{
      scanId: 'ttl',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      expiresAt: '2026-06-10T11:00:00.000Z',
      ownerInstance: instanceId,
    }],
  });
  assert.equal(expireStaleActiveScoutScan(cwd, { dataDir, now, instanceId }), false);
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 1);
  assert.equal(
    expireStaleActiveScoutScan(cwd, { dataDir, now, instanceId: 'dead-box' }),
    true,
  );
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 0);
});

runCase('finding 5 e2e: real reserve then orphan refund restores counters and lastRunAt', async () => {
  const { cwd, dataDir } = freshWorkspace('f5-refund-e2e');
  makeWatcher(dataDir, cwd);
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'p1' }), { dataDir });
  const baselineAt = '2026-06-09T08:00:00.000Z';
  seedRow(dataDir, cwd, {
    scoutSchedules: {
      p1: { lastRunAt: baselineAt, nextRunAt: '', day: '2026-06-09', count: 1 },
    },
  });
  const reserveNow = Date.parse('2026-06-10T10:00:00.000Z');
  const reserved = await runWorkspaceWatcherScout({
    workspaceFolder: cwd,
    dataDir,
    now: reserveNow,
    scoutId: 'p1',
    deps: { execGit: scopedGit, runScout: async () => ({ started: true }) },
  });
  assert.equal(reserved.scanned, true);
  const midRow = getWorkspaceWatcher(cwd, { dataDir });
  const midSched = getWorkspaceScoutScheduleState(midRow, 'p1');
  assert.equal(midSched.count, 1);
  assert.notEqual(midSched.lastRunAt, baselineAt);
  const refundNow = reserveNow + 130_000;
  const owner = getActiveScoutScans(midRow)[0].ownerInstance;
  assert.ok(owner);
  const first = reconcileScoutScans(cwd, {
    dataDir,
    now: refundNow,
    instanceId: `not-${owner}`,
  });
  assert.equal(first.refunded, 1);
  const after = getWorkspaceWatcher(cwd, { dataDir });
  const afterSched = getWorkspaceScoutScheduleState(after, 'p1');
  assert.equal(afterSched.lastRunAt, baselineAt);
  assert.equal(afterSched.count, 0);
  assert.equal(after.scoutScans.count, 0);
  const second = reconcileScoutScans(cwd, {
    dataDir,
    now: refundNow,
    instanceId: `not-${owner}`,
  });
  assert.equal(second.refunded, 0);
});

runCase('finding 5 e2e: orphan refund does not touch another UTC day counter', () => {
  const { cwd, dataDir } = freshWorkspace('f5-utc-e2e');
  makeWatcher(dataDir, cwd);
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'p1' }), { dataDir });
  const now = Date.parse('2026-06-10T01:00:00.000Z');
  seedRow(dataDir, cwd, {
    scoutScans: { day: '2026-06-10', count: 1 },
    scoutSchedules: {
      p1: { lastRunAt: '2026-06-10T00:00:05.000Z', nextRunAt: '', day: '2026-06-10', count: 1 },
    },
    activeScoutScans: [{
      scanId: 'day-a-orphan',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      reservedAt: '2026-06-09T23:58:00.000Z',
      startDeadlineAt: '2026-06-10T00:00:00.000Z',
      ownerInstance: 'dead-instance',
      previousScheduleLastRunAt: '2026-06-08T08:00:00.000Z',
    }],
  });
  reconcileScoutScans(cwd, { dataDir, now, instanceId: 'live-instance' });
  const state = getWorkspaceScoutScheduleState(getWorkspaceWatcher(cwd, { dataDir }), 'p1');
  assert.equal(state.day, '2026-06-10');
  assert.equal(state.count, 1, 'counter for day B stays when orphan reserved on day A');
});

runCase('finding 5 e2e: orphan refund skips lastRunAt when a later scan already advanced it', () => {
  const { cwd, dataDir } = freshWorkspace('f5-foreign-stamp');
  makeWatcher(dataDir, cwd);
  upsertWorkspaceScoutProfile(cwd, profile({ id: 'p1' }), { dataDir });
  const advancedLastRunAt = '2026-06-10T12:00:00.000Z';
  const orphanReservedAt = '2026-06-10T10:00:00.000Z';
  const now = Date.parse('2026-06-10T13:00:00.000Z');
  seedRow(dataDir, cwd, {
    scoutSchedules: {
      p1: { lastRunAt: advancedLastRunAt, nextRunAt: '', day: '2026-06-10', count: 2 },
    },
    activeScoutScans: [{
      scanId: 'orphan',
      scoutId: 'p1',
      status: 'reserved',
      launchIssued: false,
      reservedAt: orphanReservedAt,
      startDeadlineAt: '2026-06-10T10:02:00.000Z',
      ownerInstance: 'dead-instance',
      previousScheduleLastRunAt: '2026-06-09T08:00:00.000Z',
    }],
  });
  reconcileScoutScans(cwd, { dataDir, now, instanceId: 'live-instance' });
  const after = getWorkspaceScoutScheduleState(getWorkspaceWatcher(cwd, { dataDir }), 'p1');
  assert.equal(after.lastRunAt, advancedLastRunAt);
});

runCase('finding 4 negative: v1 legacy scan without chatId is refunded after deadline', () => {
  const { cwd, dataDir } = freshWorkspace('legacy-v1-no-chat');
  makeWatcher(dataDir, cwd);
  const dataPath = getWorkspaceWatchersDataPath({ dataDir });
  const stored = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const key = cwd;
  if (stored.items && stored.items[key]) {
    stored.items[key].scoutScans = { day: '2026-06-10', count: 1 };
    stored.items[key].activeScoutScan = {
      scanId: 'v1-no-chat',
      status: 'reserved',
      reservedAt: '2026-06-10T09:00:00.000Z',
      startDeadlineAt: '2026-06-10T09:02:00.000Z',
      expiresAt: '2026-06-10T13:00:00.000Z',
      ownerInstance: 'dead-v1-instance',
    };
    delete stored.items[key].activeScoutScans;
  }
  fs.writeFileSync(dataPath, JSON.stringify(stored), 'utf8');
  const migrated = getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir }))[0];
  assert.equal(migrated.launchIssued, false);
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  reconcileScoutScans(cwd, {
    dataDir,
    now,
    instanceId: 'current-instance',
    deps: { probeChatRunLiveness: () => ({ known: true, busy: false }) },
  });
  assert.equal(getActiveScoutScans(getWorkspaceWatcher(cwd, { dataDir })).length, 0);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).scoutScans.count, 0);
});

/* ----------------------------------------------------------------- finish */

Promise.all(pending).then(() => {
  removeIsolatedDataDir();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\nworkspace scout schedule tests: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log('\nworkspace scout schedule tests passed');
});
