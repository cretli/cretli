/**
 * Durable server-wide start gate for Workspace Watcher cycles and Scout scans.
 *
 * The module fails closed: a missing control file is the enabled default, a
 * damaged one blocks starts, and `readyForRestart` must only be true when the
 * gate is off, nothing occupies a slot and the watcher store is readable.
 *
 * Isolation: the very first import points persist at a temp data dir; every
 * dataDir below lives under `os.tmpdir()`, never the real `data/`.
 */
import './helpers/isolated-data-dir.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  upsertWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  areWorkspaceWatcherStartsEnabled,
  getWorkspaceWatcherRuntimeControl,
  getWorkspaceWatcherRuntimeStatus,
  setWorkspaceWatcherStartsEnabled,
} from '../lib/workspace-watcher-runtime-control.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

// A fixed clock keeps the expiresAt / drain cases deterministic.
const NOW = Date.parse('2026-05-05T12:00:00.000Z');
const CONTROL_FILE = 'workspace-watcher-runtime.json';
// The default delegation store is irrelevant here and must not be touched.
const NO_REVIEW_DEPS = {
  listDelegationsForController: () => [],
  isDelegationSlotOccupied: () => false,
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-runtime-control-'));
let counter = 0;

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  removeIsolatedDataDir();
});

/**
 * A workspace folder plus its own data dir, both under the temp root.
 *
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
 * @param {string} dataDir
 * @returns {string}
 */
function controlPath(dataDir) {
  return path.join(dataDir, CONTROL_FILE);
}

test('missing control file defaults to enabled with no activity', () => {
  const { cwd, dataDir } = freshWorkspace('missing');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });

  assert.deepEqual(
    getWorkspaceWatcherRuntimeControl({ dataDir }),
    { startsEnabled: true, updatedAt: '', controlError: false },
  );
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), true);

  const status = getWorkspaceWatcherRuntimeStatus({ dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.startsEnabled, true);
  assert.equal(status.controlError, false);
  assert.equal(status.activeProcesses, 0);
  assert.equal(status.draining, false);
  assert.equal(status.readyForRestart, false);
  assert.equal(status.statusUnavailable, false);
});

test('damaged control JSON fails closed and never looks ready for restart', () => {
  const { cwd, dataDir } = freshWorkspace('damaged');
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir });
  fs.writeFileSync(controlPath(dataDir), '{', 'utf8');

  const control = getWorkspaceWatcherRuntimeControl({ dataDir });
  assert.equal(control.startsEnabled, false);
  assert.equal(control.controlError, true);
  assert.equal(control.updatedAt, '');
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), false);

  const status = getWorkspaceWatcherRuntimeStatus({ dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.statusUnavailable, true);
  assert.equal(status.readyForRestart, false);
  // The gate is off but nothing is draining because no process is active.
  assert.equal(status.draining, false);
});

test('setter round-trips both states and rejects a non-boolean without writing', () => {
  const { dataDir } = freshWorkspace('setter');

  const off = setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: false });
  assert.equal(off.startsEnabled, false);
  assert.ok(off.updatedAt, 'updatedAt is stamped');
  const readOff = getWorkspaceWatcherRuntimeControl({ dataDir });
  assert.equal(readOff.startsEnabled, false);
  assert.equal(readOff.controlError, false);
  assert.equal(readOff.updatedAt, off.updatedAt);
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), false);

  const on = setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: true });
  assert.equal(on.startsEnabled, true);
  assert.ok(on.updatedAt, 'updatedAt is stamped when flipping back');
  assert.equal(getWorkspaceWatcherRuntimeControl({ dataDir }).startsEnabled, true);
  assert.equal(areWorkspaceWatcherStartsEnabled({ dataDir }), true);

  for (const bad of ['yes', 1, undefined, null]) {
    assert.throws(
      () => setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: bad }),
      (error) => error.code === 'VALIDATION',
      `startsEnabled=${String(bad)} must be rejected`,
    );
  }
  const onDisk = JSON.parse(fs.readFileSync(controlPath(dataDir), 'utf8'));
  assert.equal(onDisk.startsEnabled, true, 'a rejected write leaves the stored value unchanged');
});

test('draining and readyForRestart follow the gate and active processes', () => {
  // Gate ON, no activity: nothing to drain, not ready because starts are enabled.
  let ws = freshWorkspace('on-idle');
  upsertWorkspaceWatcher(ws.cwd, { mode: 'observe' }, { dataDir: ws.dataDir });
  let status = getWorkspaceWatcherRuntimeStatus({ dataDir: ws.dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.draining, false);
  assert.equal(status.readyForRestart, false);
  assert.equal(status.statusUnavailable, false);

  // Gate OFF, no activity: ready for restart.
  ws = freshWorkspace('off-idle');
  upsertWorkspaceWatcher(ws.cwd, { mode: 'observe' }, { dataDir: ws.dataDir });
  setWorkspaceWatcherStartsEnabled({ dataDir: ws.dataDir, startsEnabled: false });
  status = getWorkspaceWatcherRuntimeStatus({ dataDir: ws.dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.draining, false);
  assert.equal(status.readyForRestart, true);
  assert.equal(status.statusUnavailable, false);

  // Gate OFF + one active cycle: draining, not ready.
  ws = freshWorkspace('off-cycle');
  upsertWorkspaceWatcher(ws.cwd, { mode: 'autopilot' }, { dataDir: ws.dataDir });
  mutateWorkspaceWatcherRow(ws.cwd, () => ({
    activeCycles: [{
      cycleId: 'cycle-1',
      chatId: 'chat-1',
      startedAt: '2026-05-05T11:00:00.000Z',
      todoIds: ['todo-1'],
    }],
  }), { dataDir: ws.dataDir });
  setWorkspaceWatcherStartsEnabled({ dataDir: ws.dataDir, startsEnabled: false });
  status = getWorkspaceWatcherRuntimeStatus({ dataDir: ws.dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.activeWatcherCycles, 1);
  assert.ok(status.activeProcesses >= 1);
  assert.equal(status.draining, true);
  assert.equal(status.readyForRestart, false);

  // Gate OFF + one live scan (future expiresAt): draining, not ready.
  ws = freshWorkspace('off-live-scan');
  upsertWorkspaceWatcher(ws.cwd, { mode: 'observe' }, { dataDir: ws.dataDir });
  mutateWorkspaceWatcherRow(ws.cwd, () => ({
    activeScoutScans: [
      { scanId: 'live', chatId: 'chat-live', expiresAt: '2026-05-05T13:00:00.000Z' },
    ],
  }), { dataDir: ws.dataDir });
  setWorkspaceWatcherStartsEnabled({ dataDir: ws.dataDir, startsEnabled: false });
  status = getWorkspaceWatcherRuntimeStatus({ dataDir: ws.dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.activeScoutScans, 1);
  assert.equal(status.draining, true);
  assert.equal(status.readyForRestart, false);

  // Gate OFF + only an expired scan (past expiresAt): drainable, ready.
  ws = freshWorkspace('off-dead-scan');
  upsertWorkspaceWatcher(ws.cwd, { mode: 'observe' }, { dataDir: ws.dataDir });
  mutateWorkspaceWatcherRow(ws.cwd, () => ({
    activeScoutScans: [
      { scanId: 'dead', chatId: 'chat-dead', expiresAt: '2026-05-05T11:00:00.000Z' },
    ],
  }), { dataDir: ws.dataDir });
  setWorkspaceWatcherStartsEnabled({ dataDir: ws.dataDir, startsEnabled: false });
  status = getWorkspaceWatcherRuntimeStatus({ dataDir: ws.dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.activeScoutScans, 0);
  assert.equal(status.draining, false);
  assert.equal(status.readyForRestart, true);
});

test('a cycle plus an expired scan leaves exactly the cycle draining', () => {
  const { cwd, dataDir } = freshWorkspace('mixed');
  upsertWorkspaceWatcher(cwd, { mode: 'autopilot' }, { dataDir });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeCycles: [{
      cycleId: 'cycle-mixed',
      chatId: 'chat-mixed',
      startedAt: '2026-05-05T11:00:00.000Z',
      todoIds: ['todo-mixed'],
    }],
    activeScoutScans: [
      { scanId: 'expired', chatId: 'chat-expired', expiresAt: '2026-05-05T11:30:00.000Z' },
    ],
  }), { dataDir });
  setWorkspaceWatcherStartsEnabled({ dataDir, startsEnabled: false });

  const status = getWorkspaceWatcherRuntimeStatus({ dataDir, now: NOW, deps: NO_REVIEW_DEPS });
  assert.equal(status.activeWatcherCycles, 1);
  assert.equal(status.activeScoutScans, 0);
  assert.equal(status.activeProcesses, 1);
  assert.equal(status.draining, true);
  assert.equal(status.readyForRestart, false);
});

test('probeScoutOccupancy can mark the store unavailable or add occupied slots', () => {
  // A failed probe must never look ready.
  let ws = freshWorkspace('probe-fail');
  upsertWorkspaceWatcher(ws.cwd, { mode: 'observe' }, { dataDir: ws.dataDir });
  setWorkspaceWatcherStartsEnabled({ dataDir: ws.dataDir, startsEnabled: false });
  let status = getWorkspaceWatcherRuntimeStatus({
    dataDir: ws.dataDir,
    now: NOW,
    deps: NO_REVIEW_DEPS,
    probeScoutOccupancy: () => ({ ok: false }),
  });
  assert.equal(status.statusUnavailable, true);
  assert.equal(status.readyForRestart, false);

  // A successful probe contributes its occupied count to the drain total.
  ws = freshWorkspace('probe-occupied');
  upsertWorkspaceWatcher(ws.cwd, { mode: 'observe' }, { dataDir: ws.dataDir });
  setWorkspaceWatcherStartsEnabled({ dataDir: ws.dataDir, startsEnabled: false });
  status = getWorkspaceWatcherRuntimeStatus({
    dataDir: ws.dataDir,
    now: NOW,
    deps: NO_REVIEW_DEPS,
    probeScoutOccupancy: () => ({ ok: true, occupied: 2 }),
  });
  assert.equal(status.statusUnavailable, false);
  assert.equal(status.activeScoutScans, 2);
  assert.equal(status.draining, true);
  assert.equal(status.readyForRestart, false);
});
