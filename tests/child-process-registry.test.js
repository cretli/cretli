/**
 * Child-process ownership registry and shutdown lifecycle.
 *
 * Runs against real processes:
 * - registration follows a native child and is dropped on exit;
 * - the first shutdown phase SIGTERMs each owned group once and the bounded
 *   phase escalates a SIGTERM-ignoring child to SIGKILL;
 * - the startup sweep reclaims an orphan of a dead server, never a recycled PID
 *   and never the detached restart helper;
 * - a second `beginChildProcessShutdown` never signals again.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  __resetChildProcessRegistryForTest,
  beginChildProcessShutdown,
  classifyHeavyChildCmdline,
  createChildProcessProbes,
  finishChildProcessShutdown,
  getChildProcessRegistryPath,
  isChildProcessRegistered,
  isRestartHelperCmdline,
  readChildProcessRegistryRaw,
  reconcileChildProcessRegistry,
  registerChildProcess,
  installChildProcessSpawnTracking,
  registerServerDescendants,
  trackChildProcess,
  unregisterChildProcess,
} from '../lib/child-process-registry.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-child-registry-'));

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
 * Long-lived child that ignores SIGTERM, so escalation is observable.
 *
 * @param {{ ignoreSigterm?: boolean, name?: string, script?: string }} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnSleeper(options = {}) {
  const script = options.script
    || `${options.ignoreSigterm !== false ? "process.on('SIGTERM',()=>{});" : ''}setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  trackPid(child.pid);
  return child;
}

/**
 * Write an executable node script and return its path.
 *
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function writeExecutable(name, body) {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

/**
 * @param {number} pid
 * @returns {string}
 */
function startedAtOf(pid) {
  return createChildProcessProbes().getProcessStartTime(pid);
}

/**
 * Registry entry owned by a server that is no longer alive.
 *
 * @param {number} pid
 * @param {Partial<import('../lib/child-process-registry.js').ChildProcessEntry>} [overrides]
 */
function deadOwnerEntry(pid, overrides = {}) {
  return {
    pid,
    type: 'review-verify',
    label: 'test',
    startedAt: startedAtOf(pid),
    serverPid: 2147483646,
    serverStartedAt: '',
    serverInstanceToken: 'dead-server-token',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const liveSelf = {
  pid: process.pid,
  startedAt: startedAtOf(process.pid),
  instanceToken: 'live-server-token',
};

try {
  // --- 1. registration follows the child and is dropped on exit ---------------
  __resetChildProcessRegistryForTest();
  const shortLived = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0), 150);'], { stdio: 'ignore' });
  trackPid(shortLived.pid);
  const release = trackChildProcess(shortLived, { type: 'test-child', label: 'short' });
  assert.equal(isChildProcessRegistered(shortLived.pid), true, 'the child must be registered immediately');
  assert.ok(
    readChildProcessRegistryRaw()[String(shortLived.pid)],
    'the persisted registry must carry the child',
  );
  assert.equal(await waitFor(() => !isAlive(shortLived.pid), 3000), true, 'the test child must exit');
  assert.equal(await waitFor(() => !isChildProcessRegistered(shortLived.pid), 2000), true, 'exit must unregister');
  assert.equal(readChildProcessRegistryRaw()[String(shortLived.pid)], undefined, 'the file must drop the child');
  release();

  // --- 2. phase 1 SIGTERM, phase 2 SIGKILL escalation -------------------------
  __resetChildProcessRegistryForTest();
  const stubborn = spawnSleeper({ ignoreSigterm: true });
  registerChildProcess({ pid: stubborn.pid, type: 'test-child', label: 'stubborn' });
  // Let the child install its SIGTERM handler before phase 1 signals it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const phaseOne = beginChildProcessShutdown();
  assert.equal(phaseOne.total, 1);
  assert.ok(phaseOne.signaled >= 1, `expected a SIGTERM, got ${JSON.stringify(phaseOne)}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isAlive(stubborn.pid), true, 'the child ignores SIGTERM until escalation');
  const phaseTwo = await finishChildProcessShutdown({ graceMs: 200, killWaitMs: 2000 });
  assert.equal(phaseTwo.ok, true, JSON.stringify(phaseTwo));
  assert.ok(phaseTwo.escalated >= 1, `expected a SIGKILL escalation, got ${JSON.stringify(phaseTwo)}`);
  assert.equal(await waitFor(() => !isAlive(stubborn.pid), 2500), true, 'the group must die on escalation');
  assert.equal(isChildProcessRegistered(stubborn.pid), false, 'a dead child must leave the registry');

  // --- 2b. graceful shutdown sends exactly one SIGTERM per PID ----------------
  __resetChildProcessRegistryForTest();
  const gracefulA = spawnSleeper({ ignoreSigterm: true });
  const gracefulB = spawnSleeper({ ignoreSigterm: true });
  registerChildProcess({ pid: gracefulA.pid, type: 'test-child', label: 'grace-a' });
  registerChildProcess({ pid: gracefulB.pid, type: 'test-child', label: 'grace-b' });
  /** @type {Array<{ pid: number, signal: string }>} */
  const gracefulSignals = [];
  beginChildProcessShutdown({
    kill: (pid, signal) => {
      gracefulSignals.push({ pid, signal });
      return true;
    },
  });
  await finishChildProcessShutdown({
    graceMs: 50,
    killWaitMs: 50,
    probes: {
      isProcessAlive: (pid) => pid === gracefulA.pid || pid === gracefulB.pid,
      getProcessStartTime: (pid) => startedAtOf(pid),
      readProcessCmdline: () => '',
      killProcessTree: (pid, signal) => {
        gracefulSignals.push({ pid, signal });
        return true;
      },
    },
  });
  for (const pid of [gracefulA.pid, gracefulB.pid]) {
    const sigterms = gracefulSignals.filter((entry) => entry.pid === pid && entry.signal === 'SIGTERM');
    assert.equal(sigterms.length, 1, `pid ${pid} must get one SIGTERM, got ${JSON.stringify(gracefulSignals)}`);
  }
  forceKillGroup(gracefulA.pid);
  forceKillGroup(gracefulB.pid);

  // --- 3. a second begin never signals twice ----------------------------------
  __resetChildProcessRegistryForTest();
  const first = spawnSleeper({ ignoreSigterm: false });
  const second = spawnSleeper({ ignoreSigterm: false });
  registerChildProcess({ pid: first.pid, type: 'test-child', label: 'first' });
  registerChildProcess({ pid: second.pid, type: 'test-child', label: 'second' });
  /** @type {Array<{ pid: number, signal: string }>} */
  const kills = [];
  const killSpy = (pid, signal) => {
    kills.push({ pid, signal });
    return true;
  };
  const once = beginChildProcessShutdown({ kill: killSpy });
  const twice = beginChildProcessShutdown({ kill: killSpy });
  assert.equal(once.signaled, 2);
  assert.equal(twice.signaled, 0, 'the second phase-1 call must not signal again');
  assert.equal(twice.alreadyStarted, true);
  const sigterms = kills.filter((entry) => entry.signal === 'SIGTERM');
  assert.equal(sigterms.length, 2, `each child must be SIGTERMed exactly once, got ${JSON.stringify(kills)}`);
  assert.deepEqual(
    [...new Set(sigterms.map((entry) => entry.pid))].sort((a, b) => a - b),
    [first.pid, second.pid].sort((a, b) => a - b),
  );
  await finishChildProcessShutdown({ graceMs: 50, killWaitMs: 1500 });
  forceKillGroup(first.pid);
  forceKillGroup(second.pid);

  // --- 3b. phase 1 never signals a recycled PID -------------------------------
  __resetChildProcessRegistryForTest();
  const recycled = spawnSleeper({ ignoreSigterm: true });
  registerChildProcess({ pid: recycled.pid, type: 'test-child', startedAt: '999999' });
  /** @type {number[]} */
  const recycledKills = [];
  const recycledPhase = beginChildProcessShutdown({
    kill: (pid) => {
      recycledKills.push(pid);
      return true;
    },
  });
  assert.equal(recycledPhase.total, 0);
  assert.deepEqual(recycledKills, [], 'a start-time mismatch must block the signal');
  assert.equal(isChildProcessRegistered(recycled.pid), false, 'the stale entry must be dropped');
  forceKillGroup(recycled.pid);

  // --- 4. SIGKILL sweep: reclaim an orphan of a dead server -------------------
  __resetChildProcessRegistryForTest();
  const orphan = spawnSleeper({ ignoreSigterm: false });
  const orphanSweep = await reconcileChildProcessRegistry({
    registry: { [orphan.pid]: deadOwnerEntry(orphan.pid) },
    self: liveSelf,
    killWaitMs: 200,
  });
  assert.deepEqual(orphanSweep.killed, [orphan.pid], JSON.stringify(orphanSweep));
  assert.equal(await waitFor(() => !isAlive(orphan.pid), 2500), true, 'the orphan must be gone after the sweep');

  // --- 4b. the persisted file is read, not only an injected registry ----------
  __resetChildProcessRegistryForTest();
  const fileOrphan = spawnSleeper({ ignoreSigterm: false });
  fs.mkdirSync(path.dirname(getChildProcessRegistryPath()), { recursive: true });
  fs.writeFileSync(
    getChildProcessRegistryPath(),
    `${JSON.stringify({ [fileOrphan.pid]: deadOwnerEntry(fileOrphan.pid) }, null, 2)}\n`,
    'utf8',
  );
  const fileSweep = await reconcileChildProcessRegistry({ killWaitMs: 200 });
  assert.deepEqual(fileSweep.killed, [fileOrphan.pid], JSON.stringify(fileSweep));
  assert.equal(await waitFor(() => !isAlive(fileOrphan.pid), 2500), true, 'the persisted orphan must be swept');
  assert.equal(readChildProcessRegistryRaw()[String(fileOrphan.pid)], undefined, 'the swept entry must be dropped');

  // --- 5. PID reuse: a mismatched start time is never signalled ---------------
  __resetChildProcessRegistryForTest();
  const reused = spawnSleeper({ ignoreSigterm: false });
  const reuseSweep = await reconcileChildProcessRegistry({
    registry: { [reused.pid]: deadOwnerEntry(reused.pid, { startedAt: '999999' }) },
    self: liveSelf,
    killWaitMs: 100,
  });
  assert.deepEqual(reuseSweep.removed, [reused.pid], JSON.stringify(reuseSweep));
  assert.equal(isAlive(reused.pid), true, 'a recycled PID must never be signalled');
  forceKillGroup(reused.pid);

  // --- 6. the detached restart helper is never swept --------------------------
  __resetChildProcessRegistryForTest();
  const helper = writeExecutable('restart-server-helper.js', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
  const helperChild = spawn(process.execPath, [helper], { detached: true, stdio: 'ignore' });
  trackPid(helperChild.pid);
  assert.equal(isRestartHelperCmdline(createChildProcessProbes().readProcessCmdline(helperChild.pid)), true);
  const helperSweep = await reconcileChildProcessRegistry({
    registry: { [helperChild.pid]: deadOwnerEntry(helperChild.pid, { type: 'restart-helper' }) },
    self: liveSelf,
    killWaitMs: 100,
  });
  assert.deepEqual(helperSweep.skipped, [helperChild.pid], JSON.stringify(helperSweep));
  assert.equal(isAlive(helperChild.pid), true, 'the restart helper must survive the sweep');
  forceKillGroup(helperChild.pid);

  // --- 7. discovery adopts SDK-managed harness CLI descendants ----------------
  __resetChildProcessRegistryForTest();
  assert.equal(classifyHeavyChildCmdline('/usr/bin/claude --print'), 'harness-cli');
  assert.equal(classifyHeavyChildCmdline('/path/@anthropic-ai/claude-agent-sdk/cli.js'), 'harness-cli');
  assert.equal(classifyHeavyChildCmdline('node /path/@openai/codex-sdk/dist/index.js exec'), 'harness-cli');
  assert.equal(classifyHeavyChildCmdline('/usr/bin/node scripts/cretli-mcp.js --bridge'), 'mcp-bridge');
  assert.equal(classifyHeavyChildCmdline('node /repo/tests/browser-egress-proxy.test.js'), 'review-verify');
  assert.equal(classifyHeavyChildCmdline('bash -lc npm test'), 'tool-shell');
  assert.equal(classifyHeavyChildCmdline('/usr/bin/node scripts/restart-server-helper.js'), '');
  assert.equal(classifyHeavyChildCmdline('/usr/bin/opencode serve --port=4096'), '');
  const fakeClaude = writeExecutable('claude', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
  const claudeChild = spawn(fakeClaude, [], { detached: true, stdio: 'ignore' });
  trackPid(claudeChild.pid);
  const plainSleeper = spawnSleeper({ ignoreSigterm: true });
  const discovered = registerServerDescendants({ rootPid: process.pid });
  const discoveredPids = discovered.map((entry) => entry.pid);
  assert.ok(discoveredPids.includes(claudeChild.pid), `expected ${claudeChild.pid} in ${JSON.stringify(discoveredPids)}`);
  assert.equal(discoveredPids.includes(plainSleeper.pid), false, 'an unrelated node child must not be adopted');
  assert.equal(
    discovered.find((entry) => entry.pid === claudeChild.pid)?.type,
    'harness-cli',
    'the harness CLI type must be recorded',
  );
  forceKillGroup(claudeChild.pid);
  forceKillGroup(plainSleeper.pid);

  // --- 7b. spawn hook registers harness CLI immediately -----------------------
  __resetChildProcessRegistryForTest();
  installChildProcessSpawnTracking();
  const hookedClaude = writeExecutable('claude', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);");
  const hookedChild = childProcess.spawn(hookedClaude, [], { detached: true, stdio: 'ignore' });
  trackPid(hookedChild.pid);
  assert.equal(isChildProcessRegistered(hookedChild.pid), true, 'spawn tracking must register before discovery');
  assert.equal(
    readChildProcessRegistryRaw()[String(hookedChild.pid)]?.type,
    'harness-cli',
    'the harness CLI type must be recorded at spawn',
  );
  const sigkillOrphanScript = writeExecutable('hook-server.mjs', [
    `import childProcess from 'node:child_process';`,
    `import { installChildProcessSpawnTracking } from ${JSON.stringify(pathToFileURL(path.resolve('lib/child-process-registry.js')).href)};`,
    `installChildProcessSpawnTracking();`,
    `const cli = childProcess.spawn(${JSON.stringify(hookedClaude)}, [], { detached: true, stdio: 'ignore' });`,
    `setTimeout(() => {`,
    `  process.stdout.write(String(cli.pid));`,
    `  process.kill(process.pid, 'SIGKILL');`,
    `}, 50);`,
  ].join('\n'));
  const hookServer = spawn(process.execPath, [sigkillOrphanScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  trackPid(hookServer.pid);
  const hookedOrphanPid = Number.parseInt(await new Promise((resolve) => {
    let out = '';
    hookServer.stdout.on('data', (chunk) => { out += chunk.toString(); });
    hookServer.on('close', () => resolve(out.trim()));
  }), 10);
  trackPid(hookedOrphanPid);
  assert.ok(Number.isInteger(hookedOrphanPid) && hookedOrphanPid > 0, 'hooked server must report CLI pid');
  assert.equal(await waitFor(() => isAlive(hookedOrphanPid), 2000), true, 'CLI orphan must survive SIGKILL parent');
  const hookedSweep = await reconcileChildProcessRegistry({ killWaitMs: 300 });
  assert.deepEqual(hookedSweep.killed, [hookedOrphanPid], JSON.stringify(hookedSweep));
  assert.equal(await waitFor(() => !isAlive(hookedOrphanPid), 2500), true, 'sweep must reclaim spawn-tracked orphan');
  forceKillGroup(hookedChild.pid);

  // --- 7c. registry lock failure must not break trackChildProcess -------------
  __resetChildProcessRegistryForTest();
  const registryLockPath = `${getChildProcessRegistryPath()}.lock`;
  fs.mkdirSync(path.dirname(getChildProcessRegistryPath()), { recursive: true });
  fs.rmSync(registryLockPath, { recursive: true, force: true });
  fs.mkdirSync(registryLockPath, { recursive: true });
  fs.utimesSync(registryLockPath, new Date(), new Date());
  const lockHeld = spawnSleeper({ ignoreSigterm: true });
  trackPid(lockHeld.pid);
  assert.doesNotThrow(() => trackChildProcess(lockHeld, { type: 'test-child', label: 'lock-held' }));
  assert.equal(isChildProcessRegistered(lockHeld.pid), false, 'failed persist must not block spawn bookkeeping');
  fs.rmdirSync(`${getChildProcessRegistryPath()}.lock`);
  forceKillGroup(lockHeld.pid);

  // --- 7d. orphan sweep respects a total time budget --------------------------
  __resetChildProcessRegistryForTest();
  const budgetOrphanA = spawnSleeper({ ignoreSigterm: false });
  const budgetOrphanB = spawnSleeper({ ignoreSigterm: false });
  const budgetSweep = await reconcileChildProcessRegistry({
    registry: {
      [budgetOrphanA.pid]: deadOwnerEntry(budgetOrphanA.pid),
      [budgetOrphanB.pid]: deadOwnerEntry(budgetOrphanB.pid),
    },
    self: liveSelf,
    killWaitMs: 500,
    sweepTotalBudgetMs: 400,
  });
  assert.equal(budgetSweep.killed.length, 1, JSON.stringify(budgetSweep));
  const budgetSurvivors = [budgetOrphanA.pid, budgetOrphanB.pid].filter((pid) => isAlive(pid));
  assert.equal(budgetSurvivors.length, 1, 'the sweep must stop once the total budget is exhausted');
  forceKillGroup(budgetOrphanA.pid);
  forceKillGroup(budgetOrphanB.pid);

  // --- 8. unregister is idempotent and scoped --------------------------------
  __resetChildProcessRegistryForTest();
  const scoped = spawnSleeper({ ignoreSigterm: true });
  registerChildProcess({ pid: scoped.pid, type: 'test-child', label: 'scoped' });
  assert.equal(unregisterChildProcess(scoped.pid), true);
  assert.equal(unregisterChildProcess(scoped.pid), false, 'a second unregister is a no-op');
  assert.equal(isChildProcessRegistered(scoped.pid), false);
  forceKillGroup(scoped.pid);

  // --- 9. end-to-end SIGKILL: a killed server leaves a sweepable registry -----
  __resetChildProcessRegistryForTest();
  const registryUrl = pathToFileURL(path.resolve('lib/child-process-registry.js')).href;
  const fakeServer = writeExecutable('fake-server.mjs', [
    `import { spawn } from 'node:child_process';`,
    `import { registerChildProcess } from ${JSON.stringify(registryUrl)};`,
    `const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], { detached: true, stdio: 'ignore' });`,
    `registerChildProcess({ pid: child.pid, type: 'review-verify', label: 'sigkill-orphan' });`,
    `process.stdout.write(String(child.pid));`,
    `process.kill(process.pid, 'SIGKILL');`,
  ].join('\n'));
  const fakeServerChild = spawn(process.execPath, [fakeServer], { stdio: ['ignore', 'pipe', 'ignore'] });
  trackPid(fakeServerChild.pid);
  const orphanPid = Number.parseInt(await new Promise((resolve) => {
    let out = '';
    fakeServerChild.stdout.on('data', (chunk) => { out += chunk.toString(); });
    fakeServerChild.on('close', () => resolve(out.trim()));
  }), 10);
  trackPid(orphanPid);
  assert.ok(Number.isInteger(orphanPid) && orphanPid > 0, 'the fake server must report its orphan PID');
  assert.equal(await waitFor(() => isAlive(orphanPid), 2000), true, 'the orphan must outlive its killed server');
  const sigkillSweep = await reconcileChildProcessRegistry({ killWaitMs: 300 });
  assert.deepEqual(sigkillSweep.killed, [orphanPid], JSON.stringify(sigkillSweep));
  assert.equal(await waitFor(() => !isAlive(orphanPid), 2500), true, 'the startup sweep must reclaim the orphan');

  // --- 10. a corrupt registry value never becomes a killable entry ------------
  __resetChildProcessRegistryForTest();
  const innocent = spawnSleeper({ ignoreSigterm: true });
  const corruptSweep = await reconcileChildProcessRegistry({
    registry: { [innocent.pid]: 'garbage' },
    self: liveSelf,
    killWaitMs: 100,
  });
  assert.deepEqual(corruptSweep.removed, [innocent.pid], JSON.stringify(corruptSweep));
  assert.deepEqual(corruptSweep.killed, []);
  assert.equal(isAlive(innocent.pid), true, 'a corrupt value must not turn a PID into a target');
  forceKillGroup(innocent.pid);
} finally {
  for (const pid of trackedPids) forceKillGroup(pid);
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(getChildProcessRegistryPath(), { force: true });
  fs.rmSync(`${getChildProcessRegistryPath()}.lock`, { recursive: true, force: true });
}

removeIsolatedDataDir();
console.log('child-process-registry.test.js OK');
