/**
 * OpenCode shutdown phases against real processes.
 *
 * - `beginOpenCodeShutdown` SIGTERMs every owned process group and blocks new
 *   instances.
 * - A create still in flight closes the instance it spawned instead of
 *   publishing it after the map was drained (both the shutdown gate and a
 *   plain `disposeAllOpenCodeInstances`).
 * - `finishOpenCodeShutdown` escalates a SIGTERM-ignoring child to SIGKILL and
 *   kills the whole group, so the OpenCode `sleep` child disappears too.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveSettings } from '../lib/persist/settings.js';
import { getOpenCodePortRegistryPath, readOpenCodePortRegistry } from '../lib/opencode/opencode-port-registry.js';
import {
  __resetOpenCodeShutdownForTest,
  beginOpenCodeShutdown,
  disposeAllOpenCodeInstances,
  finishOpenCodeShutdown,
  getOpenCodeInstanceDiag,
  getOrCreateOpenCodeInstance,
} from '../lib/opencode/opencode-server-manager.js';

for (const key of ['OPENCODE_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'MIMO_API_KEY']) {
  delete process.env[key];
}
process.env.OPENCODE_PORT_BASE = '26000';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-opencode-shutdown-'));
const fakeBin = path.join(tempDir, 'opencode');
const pidFile = path.join(tempDir, 'opencode.pid');
const childPidFile = path.join(tempDir, 'opencode-child.pid');
process.env.OPENCODE_SHUTDOWN_TEST_PID_FILE = pidFile;
process.env.OPENCODE_SHUTDOWN_TEST_CHILD_FILE = childPidFile;

fs.writeFileSync(fakeBin, [
  '#!/usr/bin/env node',
  "const net = require('net');",
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  "const portArg = process.argv.find((arg) => arg.startsWith('--port=')) || '';",
  "const port = Number(portArg.slice('--port='.length));",
  'if (process.env.OPENCODE_SHUTDOWN_TEST_PID_FILE) {',
  '  fs.writeFileSync(process.env.OPENCODE_SHUTDOWN_TEST_PID_FILE, String(process.pid));',
  '}',
  "if (process.env.OPENCODE_SHUTDOWN_TEST_IGNORE_SIGTERM === '1') {",
  "  process.on('SIGTERM', () => {});",
  '}',
  "const child = spawn('sleep', ['300'], { stdio: 'ignore' });",
  'if (process.env.OPENCODE_SHUTDOWN_TEST_CHILD_FILE) {',
  '  fs.writeFileSync(process.env.OPENCODE_SHUTDOWN_TEST_CHILD_FILE, String(child.pid));',
  '}',
  "const delay = Number(process.env.OPENCODE_SHUTDOWN_TEST_LISTEN_DELAY_MS || '0');",
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
 * @param {string} file
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function waitForPid(file, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) {
      const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    if (Date.now() > deadline) throw new Error(`PID file ${file} was not written in ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function resetScenario() {
  __resetOpenCodeShutdownForTest();
  fs.rmSync(pidFile, { force: true });
  fs.rmSync(childPidFile, { force: true });
  delete process.env.OPENCODE_SHUTDOWN_TEST_IGNORE_SIGTERM;
  delete process.env.OPENCODE_SHUTDOWN_TEST_LISTEN_DELAY_MS;
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
  // --- 1. group kill: SIGTERM on phase 1, child of OpenCode dies too ----------
  resetScenario();
  const groupFolder = path.join(tempDir, 'group');
  const instance = await getOrCreateOpenCodeInstance({ workspaceFolder: groupFolder });
  assert.ok(instance.client, 'instance must expose a client');
  const groupPid = await waitForPid(pidFile);
  const groupChildPid = await waitForPid(childPidFile);
  trackPid(groupPid);
  trackPid(groupChildPid);
  assert.equal(isAlive(groupPid), true);

  const phaseOne = beginOpenCodeShutdown();
  assert.equal(phaseOne.instances, 1);
  assert.ok(phaseOne.signaled >= 1, `expected a SIGTERM, got ${JSON.stringify(phaseOne)}`);
  await assert.rejects(
    getOrCreateOpenCodeInstance({ workspaceFolder: path.join(tempDir, 'blocked') }),
    (err) => err?.code === 'opencode_shutting_down',
  );
  const phaseTwo = await finishOpenCodeShutdown({ graceMs: 1500, killWaitMs: 1500 });
  assert.equal(phaseTwo.ok, true, JSON.stringify(phaseTwo));
  assert.equal(await waitFor(() => !isAlive(groupPid), 2500), true, 'OpenCode must exit after the shutdown');
  assert.equal(await waitFor(() => !isAlive(groupChildPid), 2500), true, 'OpenCode child must exit with its group');
  assert.equal(getOpenCodeInstanceDiag(groupFolder), null);
  assert.deepEqual(readOpenCodePortRegistry(), {});
  instance.release();

  // --- 2. shutdown during a booting create: never published ------------------
  resetScenario();
  process.env.OPENCODE_SHUTDOWN_TEST_IGNORE_SIGTERM = '1';
  process.env.OPENCODE_SHUTDOWN_TEST_LISTEN_DELAY_MS = '900';
  const pendingFolder = path.join(tempDir, 'pending');
  const pending = getOrCreateOpenCodeInstance({ workspaceFolder: pendingFolder });
  const pendingPid = await waitForPid(pidFile);
  trackPid(pendingPid);
  const pendingPhaseOne = beginOpenCodeShutdown();
  assert.ok(pendingPhaseOne.pending >= 1, `expected a pending create, got ${JSON.stringify(pendingPhaseOne)}`);
  await assert.rejects(pending, (err) => err?.code === 'opencode_shutting_down');
  const pendingPhaseTwo = await finishOpenCodeShutdown({ graceMs: 1500, killWaitMs: 1500 });
  assert.equal(pendingPhaseTwo.ok, true, JSON.stringify(pendingPhaseTwo));
  assert.equal(await waitFor(() => !isAlive(pendingPid), 2500), true, 'a booting create must not survive shutdown');
  assert.equal(getOpenCodeInstanceDiag(pendingFolder), null);

  // --- 3. escalation: a SIGTERM-ignoring OpenCode is SIGKILLed ----------------
  resetScenario();
  process.env.OPENCODE_SHUTDOWN_TEST_IGNORE_SIGTERM = '1';
  const escalatesFolder = path.join(tempDir, 'escalate');
  const escalates = await getOrCreateOpenCodeInstance({ workspaceFolder: escalatesFolder });
  assert.ok(escalates.client);
  const escalatesPid = await waitForPid(pidFile);
  const escalatesChildPid = await waitForPid(childPidFile);
  trackPid(escalatesPid);
  trackPid(escalatesChildPid);
  beginOpenCodeShutdown();
  const escalated = await finishOpenCodeShutdown({ graceMs: 300, killWaitMs: 2000 });
  assert.equal(escalated.ok, true, JSON.stringify(escalated));
  assert.ok(escalated.escalated >= 1, `expected a SIGKILL escalation, got ${JSON.stringify(escalated)}`);
  assert.equal(await waitFor(() => !isAlive(escalatesPid), 2500), true, 'SIGKILL must stop a SIGTERM-ignoring OpenCode');
  assert.equal(await waitFor(() => !isAlive(escalatesChildPid), 2500), true, 'the group must die on escalation');
  escalates.release();

  // --- 4. dispose while a create is in flight: not published, no permanent gate
  resetScenario();
  process.env.OPENCODE_SHUTDOWN_TEST_LISTEN_DELAY_MS = '900';
  const disposeFolder = path.join(tempDir, 'dispose-pending');
  const disposePending = getOrCreateOpenCodeInstance({ workspaceFolder: disposeFolder });
  const disposePid = await waitForPid(pidFile);
  trackPid(disposePid);
  disposeAllOpenCodeInstances();
  await assert.rejects(disposePending);
  assert.equal(await waitFor(() => !isAlive(disposePid), 3000), true, 'dispose must stop an in-flight create');
  assert.equal(getOpenCodeInstanceDiag(disposeFolder), null);

  // A plain dispose is not a permanent shutdown gate: a later create still works.
  resetScenario();
  const usableFolder = path.join(tempDir, 'usable');
  const usable = await getOrCreateOpenCodeInstance({ workspaceFolder: usableFolder });
  assert.ok(usable.client, 'dispose must not block future instances');
  const usablePid = await waitForPid(pidFile);
  trackPid(usablePid);
  disposeAllOpenCodeInstances();
  assert.equal(await waitFor(() => !isAlive(usablePid), 3000), true);
} finally {
  for (const pid of trackedPids) forceKillGroup(pid);
  delete process.env.OPENCODE_SHUTDOWN_TEST_PID_FILE;
  delete process.env.OPENCODE_SHUTDOWN_TEST_CHILD_FILE;
  delete process.env.OPENCODE_SHUTDOWN_TEST_IGNORE_SIGTERM;
  delete process.env.OPENCODE_SHUTDOWN_TEST_LISTEN_DELAY_MS;
  fs.rmSync(getOpenCodePortRegistryPath(), { force: true });
  fs.rmSync(`${getOpenCodePortRegistryPath()}.lock`, { recursive: true, force: true });
  fs.rmSync(tempDir, { recursive: true, force: true });
}

removeIsolatedDataDir();
console.log('opencode-shutdown.test.js OK');
