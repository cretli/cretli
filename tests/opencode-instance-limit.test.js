/**
 * Opt-in OpenCode instance cap (`CRETLI_OPENCODE_MAX_INSTANCES`).
 *
 * - With the cap unset (default) many instances still start: no behaviour change.
 * - At the cap, the least-recently-used idle instance is closed before a new
 *   one starts.
 * - When every live instance is busy, the new chat is refused with the readable
 *   `opencode_instance_limit` code and no active process is killed.
 * - Per-chat isolation is preserved and the diagnostics counter reports
 *   `{ live, pending, limit }`.
 * - Delegation-child instances honour the opt-in shorter idle window while
 *   normal chats keep the shared default.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveSettings } from '../lib/persist/settings.js';
import { getOpenCodePortRegistryPath } from '../lib/opencode/opencode-port-registry.js';
import {
  __resetOpenCodeShutdownForTest,
  disposeAllOpenCodeInstances,
  getOpenCodeInstanceDiag,
  getOpenCodeInstanceStats,
  getOrCreateOpenCodeInstance,
  resolveOpenCodeDelegationIdleMs,
  resolveOpenCodeMaxInstances,
} from '../lib/opencode/opencode-server-manager.js';

for (const key of ['OPENCODE_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'MIMO_API_KEY']) {
  delete process.env[key];
}
process.env.OPENCODE_PORT_BASE = '28000';
delete process.env.CRETLI_OPENCODE_MAX_INSTANCES;
delete process.env.CRETLI_OPENCODE_DELEGATION_IDLE_MS;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-opencode-limit-'));
const fakeBin = path.join(tempDir, 'opencode');
const pidFile = path.join(tempDir, 'opencode.pid');
process.env.OPENCODE_LIMIT_TEST_PID_FILE = pidFile;

fs.writeFileSync(fakeBin, [
  '#!/usr/bin/env node',
  "const net = require('net');",
  "const fs = require('fs');",
  "const portArg = process.argv.find((arg) => arg.startsWith('--port=')) || '';",
  "const port = Number(portArg.slice('--port='.length));",
  'if (process.env.OPENCODE_LIMIT_TEST_PID_FILE) {',
  '  fs.writeFileSync(process.env.OPENCODE_LIMIT_TEST_PID_FILE, String(process.pid));',
  '}',
  "const delay = Number(process.env.OPENCODE_LIMIT_TEST_LISTEN_DELAY_MS || '0');",
  'const listener = net.createServer(() => {});',
  'setTimeout(() => {',
  "  listener.listen(port, '127.0.0.1', () => {",
  "    console.log('opencode server listening on http://127.0.0.1:' + port);",
  '  });',
  '}, delay);',
  '',
].join('\n'), 'utf8');
fs.chmodSync(fakeBin, 0o755);
saveSettings({ opencodeBin: fakeBin });

/** @type {Set<number>} */
const trackedPids = new Set();

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'EPERM';
  }
}

/**
 * @param {number} pid
 */
function trackPid(pid) {
  if (Number.isInteger(pid) && pid > 0) trackedPids.add(pid);
}

/**
 * PID of the most recently spawned fake `opencode` (spawns are sequential in
 * this test, so the file always belongs to the instance just created).
 *
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function readPid(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(pidFile)) {
      const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    if (Date.now() > deadline) throw new Error(`PID file was not written in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetScenario() {
  __resetOpenCodeShutdownForTest();
  fs.rmSync(pidFile, { force: true });
  delete process.env.OPENCODE_LIMIT_TEST_LISTEN_DELAY_MS;
}

/**
 * @param {number} pid
 */
function forceKillGroup(pid) {
  if (!isAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

try {
  // --- 0. resolution: setting when no env, default unlimited -----------------
  saveSettings({ opencodeBin: fakeBin, opencodeMaxInstances: 3 });
  assert.equal(resolveOpenCodeMaxInstances(), 3, 'settings cap must resolve');
  saveSettings({ opencodeBin: fakeBin, opencodeMaxInstances: 0 });
  assert.equal(resolveOpenCodeMaxInstances(), 0, 'zero must mean unlimited');
  saveSettings({ opencodeBin: fakeBin });
  assert.equal(resolveOpenCodeMaxInstances(), 0, 'absent cap must be unlimited');
  assert.equal(resolveOpenCodeDelegationIdleMs(), 0, 'absent delegation idle must be 0');

  // --- 1. cap disabled: several instances coexist ----------------------------
  resetScenario();
  const unlimitedFolder = path.join(tempDir, 'unlimited');
  const first = await getOrCreateOpenCodeInstance({ workspaceFolder: unlimitedFolder, sessionKey: 'one' });
  trackPid(await readPid());
  const second = await getOrCreateOpenCodeInstance({ workspaceFolder: unlimitedFolder, sessionKey: 'two' });
  trackPid(await readPid());
  const third = await getOrCreateOpenCodeInstance({ workspaceFolder: unlimitedFolder, sessionKey: 'three' });
  trackPid(await readPid());
  const unlimitedStats = getOpenCodeInstanceStats();
  assert.equal(unlimitedStats.limit, 0, 'no cap configured');
  assert.equal(unlimitedStats.live, 3, `expected 3 live instances, got ${JSON.stringify(unlimitedStats)}`);
  assert.ok(getOpenCodeInstanceDiag(unlimitedFolder, 'one'));
  assert.ok(getOpenCodeInstanceDiag(unlimitedFolder, 'two'));
  assert.ok(getOpenCodeInstanceDiag(unlimitedFolder, 'three'));
  first.release();
  second.release();
  third.release();

  // --- 2. cap reached: LRU idle instance is closed ---------------------------
  resetScenario();
  process.env.CRETLI_OPENCODE_MAX_INSTANCES = '2';
  const lruFolder = path.join(tempDir, 'lru');
  const older = await getOrCreateOpenCodeInstance({ workspaceFolder: lruFolder, sessionKey: 'older' });
  const olderPid = await readPid();
  trackPid(olderPid);
  older.release();
  await delay(30);
  const newer = await getOrCreateOpenCodeInstance({ workspaceFolder: lruFolder, sessionKey: 'newer' });
  trackPid(await readPid());
  newer.release();
  await delay(30);

  const replacement = await getOrCreateOpenCodeInstance({ workspaceFolder: lruFolder, sessionKey: 'replacement' });
  trackPid(await readPid());
  replacement.release();
  assert.equal(getOpenCodeInstanceDiag(lruFolder, 'older'), null, 'oldest idle instance must be evicted');
  assert.ok(getOpenCodeInstanceDiag(lruFolder, 'newer'), 'more recently used idle instance must survive');
  assert.ok(getOpenCodeInstanceDiag(lruFolder, 'replacement'), 'new instance must be published');
  assert.equal(getOpenCodeInstanceStats().live, 2);
  assert.equal(await waitFor(() => !isAlive(olderPid), 2500), true, 'evicted instance process must exit');
  delete process.env.CRETLI_OPENCODE_MAX_INSTANCES;

  // --- 3. cap reached, all busy: readable refusal, no active kill ------------
  resetScenario();
  process.env.CRETLI_OPENCODE_MAX_INSTANCES = '2';
  const busyFolder = path.join(tempDir, 'busy');
  const busyA = await getOrCreateOpenCodeInstance({ workspaceFolder: busyFolder, sessionKey: 'busy-a' });
  const busyAPid = await readPid();
  trackPid(busyAPid);
  const busyB = await getOrCreateOpenCodeInstance({ workspaceFolder: busyFolder, sessionKey: 'busy-b' });
  const busyBPid = await readPid();
  trackPid(busyBPid);
  await assert.rejects(
    getOrCreateOpenCodeInstance({ workspaceFolder: busyFolder, sessionKey: 'busy-c' }),
    (err) => {
      assert.equal(err?.code, 'opencode_instance_limit');
      assert.match(err.message, /opencode_instance_limit|instance limit/i);
      return true;
    },
  );
  assert.equal(getOpenCodeInstanceStats().live, 2, 'refused create must not leak a slot');
  assert.equal(getOpenCodeInstanceStats().pending, 0, 'refused create must clear its pending slot');
  assert.ok(getOpenCodeInstanceDiag(busyFolder, 'busy-a'), 'active instance A must survive');
  assert.ok(getOpenCodeInstanceDiag(busyFolder, 'busy-b'), 'active instance B must survive');
  assert.equal(isAlive(busyAPid), true, 'active process A must not be killed');
  assert.equal(isAlive(busyBPid), true, 'active process B must not be killed');
  busyA.release();
  busyB.release();
  delete process.env.CRETLI_OPENCODE_MAX_INSTANCES;

  // --- 4. isolation per chat is preserved ------------------------------------
  resetScenario();
  const isoFolder = path.join(tempDir, 'iso');
  const isoA = await getOrCreateOpenCodeInstance({ workspaceFolder: isoFolder, sessionKey: 'iso-a' });
  trackPid(await readPid());
  const isoB = await getOrCreateOpenCodeInstance({ workspaceFolder: isoFolder, sessionKey: 'iso-b' });
  trackPid(await readPid());
  const isoDiagA = getOpenCodeInstanceDiag(isoFolder, 'iso-a');
  const isoDiagB = getOpenCodeInstanceDiag(isoFolder, 'iso-b');
  assert.ok(isoDiagA && isoDiagB, 'each chat must own an instance');
  assert.notEqual(isoDiagA.port, isoDiagB.port, 'instances must not share a port');
  assert.equal(isoDiagA.refCount, 1);
  assert.equal(isoDiagB.refCount, 1);
  isoA.release();
  isoB.release();

  // --- 5. pending counter reflects an in-flight create -----------------------
  resetScenario();
  process.env.OPENCODE_LIMIT_TEST_LISTEN_DELAY_MS = '400';
  const pendingFolder = path.join(tempDir, 'pending');
  const pendingCreate = getOrCreateOpenCodeInstance({ workspaceFolder: pendingFolder, sessionKey: 'pending' });
  const pendingStats = getOpenCodeInstanceStats();
  assert.equal(pendingStats.pending, 1, `expected one pending create, got ${JSON.stringify(pendingStats)}`);
  const pendingInstance = await pendingCreate;
  trackPid(await readPid());
  assert.equal(getOpenCodeInstanceStats().pending, 0);
  pendingInstance.release();
  delete process.env.OPENCODE_LIMIT_TEST_LISTEN_DELAY_MS;

  // --- 6. delegation-child idle override is opt-in ---------------------------
  resetScenario();
  process.env.CRETLI_OPENCODE_DELEGATION_IDLE_MS = '60';
  assert.equal(resolveOpenCodeDelegationIdleMs(), 60);
  const delegationFolder = path.join(tempDir, 'delegation');
  const child = await getOrCreateOpenCodeInstance({
    workspaceFolder: delegationFolder,
    sessionKey: 'delegation-child',
    delegation: true,
  });
  trackPid(await readPid());
  child.release();
  assert.equal(
    await waitFor(() => getOpenCodeInstanceDiag(delegationFolder, 'delegation-child') === null, 2500),
    true,
    'delegation child must use the configured shorter idle window',
  );
  delete process.env.CRETLI_OPENCODE_DELEGATION_IDLE_MS;

  const normalFolder = path.join(tempDir, 'normal');
  const normal = await getOrCreateOpenCodeInstance({ workspaceFolder: normalFolder, sessionKey: 'normal' });
  trackPid(await readPid());
  normal.release();
  await delay(250);
  assert.ok(
    getOpenCodeInstanceDiag(normalFolder, 'normal'),
    'a normal chat must keep the shared long idle window',
  );
} finally {
  disposeAllOpenCodeInstances();
  for (const pid of trackedPids) forceKillGroup(pid);
  delete process.env.OPENCODE_LIMIT_TEST_PID_FILE;
  delete process.env.CRETLI_OPENCODE_MAX_INSTANCES;
  delete process.env.CRETLI_OPENCODE_DELEGATION_IDLE_MS;
  delete process.env.OPENCODE_LIMIT_TEST_LISTEN_DELAY_MS;
  fs.rmSync(getOpenCodePortRegistryPath(), { force: true });
  fs.rmSync(`${getOpenCodePortRegistryPath()}.lock`, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
  __resetOpenCodeShutdownForTest();
}

removeIsolatedDataDir();
console.log('opencode-instance-limit.test.js OK');
