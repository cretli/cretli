/**
 * Own-spawn layer + start-up sweep against real processes.
 *
 * - `startOpenCodeServer` must report the real PID and close() must kill the
 *   whole process group (children included).
 * - `reconcileOpenCodePortRegistry` with the real /proc probes must stop an
 *   OpenCode process whose recorded Cretli owner is dead, both for the new
 *   registry format (recorded PID) and the legacy format (listener lookup).
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getOpenCodePortRegistryPath,
  readOpenCodePortRegistry,
  reconcileOpenCodePortRegistry,
} from '../lib/opencode/opencode-port-registry.js';
import { startOpenCodeServer } from '../lib/opencode/opencode-server-manager.js';

const registryPath = getOpenCodePortRegistryPath();

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
 * @returns {Promise<number>}
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Kill a process group when a scenario failed before its normal cleanup.
 *
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

function resetRegistry() {
  fs.rmSync(registryPath, { force: true });
  fs.rmSync(`${registryPath}.lock`, { recursive: true, force: true });
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-opencode-spawn-'));
const fakeBin = path.join(tempDir, 'opencode');
const childPidFile = path.join(tempDir, 'child.pid');
fs.writeFileSync(fakeBin, [
  '#!/usr/bin/env node',
  "const net = require('net');",
  "const fs = require('fs');",
  "const { spawn } = require('child_process');",
  "const portArg = process.argv.find((arg) => arg.startsWith('--port=')) || '';",
  "const port = Number(portArg.slice('--port='.length));",
  "const child = spawn('sleep', ['300'], { stdio: 'ignore' });",
  'if (process.env.OPENCODE_SPAWN_TEST_CHILD_FILE) {',
  '  fs.writeFileSync(process.env.OPENCODE_SPAWN_TEST_CHILD_FILE, String(child.pid));',
  '}',
  "const listener = net.createServer(() => {});",
  "listener.listen(port, '127.0.0.1', () => {",
  "  console.log('opencode server listening on http://127.0.0.1:' + port);",
  '});',
  '',
].join('\n'), 'utf8');
fs.chmodSync(fakeBin, 0o755);
process.env.OPENCODE_SPAWN_TEST_CHILD_FILE = childPidFile;

/** @type {number[]} */
const spawnedGroups = [];
try {
  // --- 1. own spawn: real PID, group kill on close -----------------------------
  const portA = await findFreePort();
  const serverA = await startOpenCodeServer({ bin: fakeBin, hostname: '127.0.0.1', port: portA, timeout: 5000 });
  spawnedGroups.push(serverA.pid);
  assert.equal(serverA.url, `http://127.0.0.1:${portA}`);
  assert.ok(Number.isInteger(serverA.pid) && serverA.pid > 0, 'spawn must report the OpenCode PID');
  assert.equal(isAlive(serverA.pid), true);
  const childReady = await waitFor(() => fs.existsSync(childPidFile), 3000);
  assert.equal(childReady, true, 'fake OpenCode child must start');
  const childA = Number.parseInt(fs.readFileSync(childPidFile, 'utf8').trim(), 10);
  spawnedGroups.push(childA);
  assert.equal(isAlive(childA), true);
  serverA.close();
  assert.equal(await waitFor(() => !isAlive(serverA.pid), 4000), true, 'close() must stop OpenCode');
  assert.equal(await waitFor(() => !isAlive(childA), 4000), true, 'close() must stop OpenCode children too');

  // --- 2. new format: dead owner -> recorded orphan is killed ------------------
  resetRegistry();
  fs.rmSync(childPidFile, { force: true });
  const portB = await findFreePort();
  const serverB = await startOpenCodeServer({ bin: fakeBin, hostname: '127.0.0.1', port: portB, timeout: 5000 });
  spawnedGroups.push(serverB.pid);
  fs.writeFileSync(registryPath, `${JSON.stringify({
    [String(portB)]: {
      instanceKey: 'session:orphan',
      opencodePid: serverB.pid,
      opencodeStartedAt: serverB.startedAt,
      serverPid: 999999,
      serverStartedAt: '1',
      serverInstanceToken: 'dead-server-token',
      updatedAt: '2026-10-09T00:00:00.000Z',
    },
  }, null, 2)}\n`, 'utf8');
  const childBReady = await waitFor(() => fs.existsSync(childPidFile), 3000);
  assert.equal(childBReady, true);
  const childB = Number.parseInt(fs.readFileSync(childPidFile, 'utf8').trim(), 10);
  spawnedGroups.push(childB);
  const sweepB = await reconcileOpenCodePortRegistry({ killWaitMs: 500 });
  assert.ok(sweepB.killed.includes(portB), `expected port ${portB} killed, got ${JSON.stringify(sweepB)}`);
  assert.equal(await waitFor(() => !isAlive(serverB.pid), 3000), true);
  assert.equal(await waitFor(() => !isAlive(childB), 3000), true, 'sweep must kill the process group');
  assert.deepEqual(readOpenCodePortRegistry(), {});

  // --- 3. legacy format: listener lookup kills the orphan ----------------------
  // Launch detached via a short-lived shell so the fake is reparented to init:
  // the real sweep refuses to touch an OpenCode whose ancestor is a live Cretli
  // server (that is the e2e/worktree protection), and this test process runs
  // under one.
  resetRegistry();
  fs.rmSync(childPidFile, { force: true });
  const portC = await findFreePort();
  const launch = spawnSync('/bin/sh', [
    '-c',
    `setsid "${fakeBin}" serve --hostname=127.0.0.1 --port=${portC} >/dev/null 2>&1 & echo $!`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_SPAWN_TEST_CHILD_FILE: childPidFile },
  });
  const serverC = Number.parseInt(String(launch.stdout || '').trim(), 10);
  assert.ok(Number.isInteger(serverC) && serverC > 0, 'detached fake must start');
  spawnedGroups.push(serverC);
  fs.writeFileSync(registryPath, `${JSON.stringify({ [String(portC)]: 'session:legacy' }, null, 2)}\n`, 'utf8');
  const childCReady = await waitFor(() => fs.existsSync(childPidFile), 3000);
  assert.equal(childCReady, true);
  const childC = Number.parseInt(fs.readFileSync(childPidFile, 'utf8').trim(), 10);
  spawnedGroups.push(childC);
  assert.equal(isAlive(serverC), true);
  const sweepC = await reconcileOpenCodePortRegistry({ killWaitMs: 500 });
  assert.ok(sweepC.killed.includes(portC), `expected port ${portC} killed, got ${JSON.stringify(sweepC)}`);
  assert.equal(await waitFor(() => !isAlive(serverC), 3000), true);
  assert.equal(await waitFor(() => !isAlive(childC), 3000), true, 'legacy sweep must kill the process group');
  assert.deepEqual(readOpenCodePortRegistry(), {});
} finally {
  for (const pid of spawnedGroups.reverse()) forceKillGroup(pid);
  delete process.env.OPENCODE_SPAWN_TEST_CHILD_FILE;
  resetRegistry();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

removeIsolatedDataDir();
console.log('opencode-server-spawn.test.js OK');
