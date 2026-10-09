/**
 * Exclusive lock for CLI webpack watch processes.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { isProcessAlive, getProcessStartTime } from '../lib/delegation-owner-lock.js';
import { killExternalBuildProcesses } from '../lib/dev-build.js';
import {
  getWebpackCliWatchLockPath,
  isMatchingWebpackCliWatchProcess,
  isWebpackCliWatchLockHeld,
  isWebpackCliWatchLockStale,
  killWebpackCliWatchProcessTree,
  parseWebpackCliWatchLockRecord,
  readWebpackCliWatchLock,
  releaseWebpackCliWatchLock,
  sweepOrphanWebpackCliWatchers,
  tryAcquireWebpackCliWatchLock,
} from '../lib/webpack-cli-watch-lock.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configRealpath = path.join(projectRoot, 'app_front', 'webpack.dev.js');
const lockId = 'webpack-watch.dev';
const wrapperPath = path.join(projectRoot, 'app_front', 'scripts', 'webpack-cli-watch.mjs');
const isLinux = process.platform === 'linux';

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @returns {string}
 */
function makeIsolatedDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-webpack-watch-lock-'));
}

/**
 * @param {string} dataDir
 * @param {string[]} extraArgs
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnWatchWrapper(dataDir, extraArgs = []) {
  return spawn(
    process.execPath,
    [wrapperPath, '--config', 'webpack.dev.js', ...extraArgs],
    {
      cwd: path.join(projectRoot, 'app_front'),
      env: { ...process.env, CRETLI_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

/**
 * @param {string} dataDir
 * @param {number} timeoutMs
 * @returns {Promise<import('../lib/webpack-cli-watch-lock.js').WebpackCliWatchLockRecord>}
 */
async function waitForLockWithChild(dataDir, timeoutMs = 120_000) {
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readWebpackCliWatchLock(lockPath);
    if (record?.childPid && isProcessAlive(record.childPid)) {
      return record;
    }
    await sleep(200);
  }
  throw new Error('Timed out waiting for webpack watch lock with live childPid');
}

test('parseWebpackCliWatchLockRecord accepts owner metadata', () => {
  const parsed = parseWebpackCliWatchLockRecord({
    lockId: 'webpack-watch.dev',
    pid: 42,
    pidStart: '999',
    startedAtMs: 1,
    projectRootRealpath: '/tmp/cretli',
    configRealpath: '/tmp/cretli/app_front/webpack.dev.js',
    childPid: 43,
    childPgid: 43,
  });
  assert.ok(parsed);
  assert.equal(parsed.pid, 42);
  assert.equal(parsed.childPid, 43);
});

test('isWebpackCliWatchLockStale treats dead pid as stale', () => {
  const stale = isWebpackCliWatchLockStale(
    {
      lockId,
      pid: 999999,
      pidStart: '1',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
    },
    { isAlive: () => false, getStartTime: () => '1' },
  );
  assert.equal(stale, true);
});

test('isWebpackCliWatchLockStale detects pid reuse via start time', () => {
  const stale = isWebpackCliWatchLockStale(
    {
      lockId,
      pid: process.pid,
      pidStart: 'stored-start',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
    },
    { isAlive: () => true, getStartTime: () => 'live-start' },
  );
  assert.equal(stale, true);
});

test('isWebpackCliWatchLockStale without live start time does not treat alive pid as stale', () => {
  const stale = isWebpackCliWatchLockStale(
    {
      lockId,
      pid: process.pid,
      pidStart: 'stored-start',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
    },
    { isAlive: () => true, getStartTime: () => '' },
  );
  assert.equal(stale, false);
});

test('tryAcquireWebpackCliWatchLock uses atomic create and blocks a second holder', () => {
  const dataDir = makeIsolatedDataDir();
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  const first = tryAcquireWebpackCliWatchLock({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
    pid: process.pid,
    pidStart: getProcessStartTime(process.pid),
    startedAtMs: 10,
  });
  assert.equal(first.acquired, true);
  assert.equal(fs.existsSync(lockPath), true);
  const second = tryAcquireWebpackCliWatchLock({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
    pid: process.pid,
    pidStart: getProcessStartTime(process.pid),
    startedAtMs: 20,
  });
  assert.equal(second.acquired, false);
  assert.match(second.message, /already running/i);
  releaseWebpackCliWatchLock(lockPath, first.record);
  assert.equal(fs.existsSync(lockPath), false);
});

test('tryAcquireWebpackCliWatchLock reclaims a stale lock file', () => {
  const dataDir = makeIsolatedDataDir();
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      lockId,
      pid: 999999,
      pidStart: 'dead',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
    })}\n`,
    'utf8',
  );
  const acquired = tryAcquireWebpackCliWatchLock({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
    pid: 2002,
    pidStart: 'alive',
    startedAtMs: 2,
  });
  assert.equal(acquired.acquired, true);
  const onDisk = readWebpackCliWatchLock(lockPath);
  assert.ok(onDisk);
  assert.equal(onDisk.pid, 2002);
  releaseWebpackCliWatchLock(lockPath, acquired.record);
});

test('releaseWebpackCliWatchLock removes only the owning record', () => {
  const dataDir = makeIsolatedDataDir();
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  const owner = tryAcquireWebpackCliWatchLock({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
    pid: process.pid,
    pidStart: getProcessStartTime(process.pid),
    startedAtMs: 3,
  });
  assert.equal(owner.acquired, true);
  const removed = releaseWebpackCliWatchLock(lockPath, {
    ...owner.record,
    pid: 3004,
  });
  assert.equal(removed, false);
  assert.equal(isWebpackCliWatchLockHeld(readWebpackCliWatchLock(lockPath)), true);
  releaseWebpackCliWatchLock(lockPath, owner.record);
});

test('concurrent acquire from separate processes leaves one holder', async () => {
  const dataDir = makeIsolatedDataDir();
  const runnerPath = path.join(dataDir, 'acquire-runner.mjs');
  fs.writeFileSync(
    runnerPath,
    `import { tryAcquireWebpackCliWatchLock, releaseWebpackCliWatchLock } from ${JSON.stringify(
      pathToFileURL(path.join(projectRoot, 'lib', 'webpack-cli-watch-lock.js')).href,
    )};
const dataDir = process.env.CRETLI_DATA_DIR;
const configRealpath = process.env.TEST_CONFIG;
const projectRootRealpath = process.env.TEST_PROJECT_ROOT;
const holdMs = Number(process.env.HOLD_MS || 0);
const result = tryAcquireWebpackCliWatchLock({
  lockId: 'webpack-watch.dev',
  configRealpath,
  projectRootRealpath,
  dataDir,
});
if (result.acquired) {
  if (holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  releaseWebpackCliWatchLock(result.lockPath, result.record);
}
console.log(JSON.stringify({ acquired: result.acquired, message: result.message || '' }));
`,
    'utf8',
  );
  const env = {
    ...process.env,
    CRETLI_DATA_DIR: dataDir,
    TEST_CONFIG: configRealpath,
    TEST_PROJECT_ROOT: projectRoot,
  };
  const spawnAcquire = (holdMs) =>
    spawn(process.execPath, [runnerPath], {
      env: { ...env, HOLD_MS: String(holdMs) },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const holder = spawnAcquire(800);
  await sleep(50);
  const challenger = spawnAcquire(0);
  const challengerOut = await new Promise((resolve) => {
    let stdout = '';
    challenger.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    challenger.on('exit', () => resolve(stdout.trim()));
  });
  const parsed = JSON.parse(challengerOut);
  assert.equal(parsed.acquired, false);
  assert.match(parsed.message, /already running/i);
  await new Promise((resolve) => {
    holder.on('exit', resolve);
  });
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  assert.equal(fs.existsSync(lockPath), false);
});

test('webpack-cli-watch --no-watch exits without creating a lock file', async () => {
  const dataDir = makeIsolatedDataDir();
  const child = spawn(
    process.execPath,
    [wrapperPath, '--config', 'webpack.dev.js', '--no-watch'],
    {
      cwd: path.join(projectRoot, 'app_front'),
      env: { ...process.env, CRETLI_DATA_DIR: dataDir },
      stdio: 'ignore',
    },
  );
  const code = await new Promise((resolve) => {
    child.on('exit', resolve);
  });
  assert.equal(code, 0);
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  assert.equal(fs.existsSync(lockPath), false);
});

test('webpack.dev.js does not import the CLI watch lock module', () => {
  const src = fs.readFileSync(path.join(projectRoot, 'app_front', 'webpack.dev.js'), 'utf8');
  assert.doesNotMatch(src, /webpack-cli-watch-lock/);
  const hmrSrc = fs.readFileSync(path.join(projectRoot, 'lib', 'front-hmr.js'), 'utf8');
  assert.doesNotMatch(hmrSrc, /webpack-cli-watch-lock/);
});

test('isMatchingWebpackCliWatchProcess never matches the current process id', () => {
  const match = isMatchingWebpackCliWatchProcess(
    process.pid,
    configRealpath,
    projectRoot,
  );
  assert.equal(match, false);
});

test('sweepOrphanWebpackCliWatchers does not kill unrelated node holding config path in argv', async () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const decoyScript = path.join(dataDir, 'decoy.mjs');
  fs.writeFileSync(
    decoyScript,
    'setInterval(() => {}, 1_000_000);\n',
    'utf8',
  );
  const decoy = spawn(process.execPath, [decoyScript, configRealpath], {
    stdio: 'ignore',
    detached: true,
  });
  decoy.unref();
  await sleep(100);
  assert.ok(decoy.pid && isProcessAlive(decoy.pid));
  sweepOrphanWebpackCliWatchers({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
  });
  assert.ok(isProcessAlive(decoy.pid));
  try {
    process.kill(decoy.pid, 'SIGTERM');
  } catch {
    // already gone
  }
});

test('killExternalBuildProcesses is safe to call at server boot', () => {
  assert.doesNotThrow(() => killExternalBuildProcesses());
});

test('server.js sweeps orphaned CLI webpack watchers before listen', () => {
  const serverSource = readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
  assert.match(serverSource, /killExternalBuildProcesses\(\)/);
  const sweepIdx = serverSource.indexOf('killExternalBuildProcesses()');
  const listenIdx = serverSource.indexOf('server.listen(');
  assert.ok(sweepIdx > 0 && listenIdx > 0 && sweepIdx < listenIdx);
});

test('sweepOrphanWebpackCliWatchers does not signal on pid reuse and drops stale lock', () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      lockId,
      pid: process.pid,
      pidStart: 'stored-start-does-not-match-live',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: process.pid,
      childPidStart: 'child-stored-start-does-not-match',
      childPgid: process.pid,
    })}\n`,
    'utf8',
  );
  let killInvocations = 0;
  const result = sweepOrphanWebpackCliWatchers({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
    killProcess: () => {
      killInvocations += 1;
    },
  });
  assert.equal(killInvocations, 0);
  assert.deepEqual(result.killed, []);
  assert.equal(fs.existsSync(lockPath), false);
});

test('killWebpackCliWatchProcessTree sends no signal when only the wrapper pid is reused', () => {
  const signals = [];
  const result = killWebpackCliWatchProcessTree(
    {
      lockId,
      pid: 911001,
      pidStart: 'wrapper-stored-start',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: 911002,
      childPidStart: 'child-stored-start',
      childPgid: 911002,
    },
    (pid, signal) => {
      signals.push([pid, signal]);
    },
    {
      // The wrapper PID was recycled by an unrelated process; the child is genuine.
      isAlive: () => true,
      getStartTime: (pid) => (pid === 911001 ? 'wrapper-live-start' : 'child-stored-start'),
    },
  );
  assert.deepEqual(signals, []);
  assert.deepEqual(result.killed, []);
  assert.equal(result.pidReuseDetected, true);
});

test('killWebpackCliWatchProcessTree sends no signal and no -pgid when only the child pid is reused', () => {
  const signals = [];
  const result = killWebpackCliWatchProcessTree(
    {
      lockId,
      pid: 912001,
      pidStart: 'wrapper-stored-start',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: 912002,
      childPidStart: 'child-stored-start',
      childPgid: 912002,
    },
    (pid, signal) => {
      signals.push([pid, signal]);
    },
    {
      // The wrapper is genuine but the stored child PID now points at another process.
      isAlive: () => true,
      getStartTime: (pid) => (pid === 912001 ? 'wrapper-stored-start' : 'child-live-start'),
    },
  );
  assert.deepEqual(signals, []);
  assert.deepEqual(result.killed, []);
  assert.equal(result.pidReuseDetected, true);
});

test('killWebpackCliWatchProcessTree never uses -pgid when the wrapper is dead', () => {
  const signals = [];
  const result = killWebpackCliWatchProcessTree(
    {
      lockId,
      pid: 913001,
      pidStart: 'wrapper-stored-start',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: 913002,
      childPidStart: 'child-stored-start',
      childPgid: 913003,
    },
    (pid, signal) => {
      signals.push([pid, signal]);
    },
    {
      // Wrapper is gone; only the child PID is verified alive.
      isAlive: (pid) => pid === 913002,
      getStartTime: () => 'child-stored-start',
    },
  );
  assert.deepEqual(signals, [[913002, 'SIGTERM']]);
  assert.deepEqual(result.killed, [913002]);
  assert.equal(result.pidReuseDetected, false);
});

test('killWebpackCliWatchProcessTree uses the process group only while the wrapper is verified alive', () => {
  const signals = [];
  const result = killWebpackCliWatchProcessTree(
    {
      lockId,
      pid: 914001,
      pidStart: 'wrapper-stored-start',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: 914002,
      childPidStart: 'child-stored-start',
      childPgid: 914003,
    },
    (pid, signal) => {
      signals.push([pid, signal]);
    },
    {
      isAlive: () => true,
      getStartTime: (pid) => (pid === 914001 ? 'wrapper-stored-start' : 'child-stored-start'),
    },
  );
  assert.ok(signals.some(([pid]) => pid === -914003));
  assert.ok(result.killed.includes(-914003));
});

test('sweepOrphanWebpackCliWatchers drops the lock without signalling when only the wrapper pid is reused', () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      lockId,
      pid: process.pid,
      pidStart: 'wrapper-start-does-not-match-live',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: process.pid,
      childPidStart: getProcessStartTime(process.pid),
      childPgid: process.pid,
    })}\n`,
    'utf8',
  );
  const signals = [];
  const result = sweepOrphanWebpackCliWatchers({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  assert.deepEqual(signals, []);
  assert.deepEqual(result.killed, []);
  assert.equal(fs.existsSync(lockPath), false);
});

test('sweepOrphanWebpackCliWatchers handles only-child reuse without signalling the child', () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      lockId,
      pid: process.pid,
      pidStart: getProcessStartTime(process.pid),
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: process.pid,
      childPidStart: 'child-start-does-not-match-live',
      childPgid: process.pid,
    })}\n`,
    'utf8',
  );
  const signals = [];
  // A different config forces the sweep past the "held and matching" skip so the
  // reused child classification is exercised.
  const otherConfigRealpath = path.join(projectRoot, 'app_front', 'webpack.widget.dev.js');
  const result = sweepOrphanWebpackCliWatchers({
    lockId,
    configRealpath: otherConfigRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  assert.deepEqual(signals, []);
  assert.deepEqual(result.killed, []);
  assert.equal(fs.existsSync(lockPath), false);
});

test('sweepOrphanWebpackCliWatchers releases the lock when every signal fails', () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({
      lockId,
      pid: 915001,
      pidStart: 'dead-wrapper-start',
      startedAtMs: 1,
      projectRootRealpath: projectRoot,
      configRealpath,
      childPid: process.pid,
      childPidStart: getProcessStartTime(process.pid),
      childPgid: process.pid,
    })}\n`,
    'utf8',
  );
  const attempted = [];
  let result;
  assert.doesNotThrow(() => {
    result = sweepOrphanWebpackCliWatchers({
      lockId,
      configRealpath,
      projectRootRealpath: projectRoot,
      dataDir,
      killProcess: (pid) => {
        attempted.push(pid);
        throw new Error('EPERM: signal failed');
      },
    });
  });
  assert.ok(attempted.length > 0, 'the verified child must still be signalled');
  assert.deepEqual(attempted.filter((pid) => pid < 0), [], 'a dead wrapper must never trigger -pgid');
  assert.deepEqual(result.killed, []);
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released even when every signal fails');
});

test('SIGTERM keeps lock while webpack child is still alive', { timeout: 180_000 }, async () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const wrapper = spawnWatchWrapper(dataDir);
  const record = await waitForLockWithChild(dataDir);
  const wrapperPid = wrapper.pid;
  const childPid = record.childPid;
  assert.ok(wrapperPid && childPid);
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  process.kill(wrapperPid, 'SIGTERM');
  let sawHeldLockWhileChildAlive = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (isProcessAlive(childPid)) {
      const onDisk = readWebpackCliWatchLock(lockPath);
      if (onDisk && isWebpackCliWatchLockHeld(onDisk)) {
        sawHeldLockWhileChildAlive = true;
        const blocked = tryAcquireWebpackCliWatchLock({
          lockId,
          configRealpath,
          projectRootRealpath: projectRoot,
          dataDir,
          pid: process.pid + 999,
          pidStart: 'challenger',
          startedAtMs: Date.now(),
        });
        assert.equal(blocked.acquired, false);
      }
    } else {
      break;
    }
    await sleep(25);
  }
  assert.equal(sawHeldLockWhileChildAlive, true);
  while (Date.now() < deadline) {
    if (!isProcessAlive(wrapperPid) && !isProcessAlive(childPid)) break;
    await sleep(50);
  }
  assert.equal(fs.existsSync(lockPath), false);
});

test('SIGTERM on watch wrapper stops wrapper and webpack child and releases lock', { timeout: 180_000 }, async () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const wrapper = spawnWatchWrapper(dataDir);
  const record = await waitForLockWithChild(dataDir);
  const wrapperPid = wrapper.pid;
  const childPid = record.childPid;
  assert.ok(wrapperPid && childPid);
  assert.ok(isProcessAlive(wrapperPid));
  assert.ok(isProcessAlive(childPid));
  process.kill(wrapperPid, 'SIGTERM');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(wrapperPid) && !isProcessAlive(childPid)) break;
    await sleep(100);
  }
  assert.equal(isProcessAlive(wrapperPid), false);
  assert.equal(isProcessAlive(childPid), false);
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  assert.equal(fs.existsSync(lockPath), false);
});

test('second watch start exits with code 1 while first watcher holds lock', { timeout: 180_000 }, async () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const first = spawnWatchWrapper(dataDir);
  await waitForLockWithChild(dataDir);
  const second = spawnWatchWrapper(dataDir);
  let stderr = '';
  second.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const secondCode = await new Promise((resolve) => {
    second.on('exit', resolve);
  });
  assert.equal(secondCode, 1);
  assert.match(stderr, /already running/i);
  process.kill(first.pid, 'SIGTERM');
  await new Promise((resolve) => {
    first.on('exit', resolve);
  });
});

test('SIGKILL on wrapper leaves lock; sweep kills real webpack child', { timeout: 180_000 }, async () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const wrapper = spawnWatchWrapper(dataDir);
  const record = await waitForLockWithChild(dataDir);
  const wrapperPid = wrapper.pid;
  const childPid = record.childPid;
  assert.ok(wrapperPid && childPid);
  assert.ok(isProcessAlive(childPid));
  process.kill(wrapperPid, 'SIGKILL');
  await sleep(300);
  assert.equal(isProcessAlive(wrapperPid), false);
  assert.equal(isProcessAlive(childPid), true);
  const lockPath = getWebpackCliWatchLockPath(lockId, { dataDir });
  const onDisk = readWebpackCliWatchLock(lockPath);
  assert.ok(onDisk);
  assert.equal(onDisk.childPid, childPid);
  sweepOrphanWebpackCliWatchers({
    lockId,
    configRealpath,
    projectRootRealpath: projectRoot,
    dataDir,
  });
  await sleep(500);
  assert.equal(isProcessAlive(childPid), false);
  assert.equal(fs.existsSync(lockPath), false);
});

test('killWebpackCliWatchProcessTree terminates webpack compiler child of wrapper', { timeout: 180_000 }, async () => {
  if (!isLinux) return;
  const dataDir = makeIsolatedDataDir();
  const wrapper = spawnWatchWrapper(dataDir);
  const record = await waitForLockWithChild(dataDir);
  assert.ok(record.childPid);
  assert.ok(isProcessAlive(record.childPid));
  const treeResult = killWebpackCliWatchProcessTree(record, (pid, signal) => {
    process.kill(pid, signal);
  });
  assert.equal(treeResult.pidReuseDetected, false);
  assert.ok(treeResult.killed.length > 0);
  await sleep(500);
  assert.equal(isProcessAlive(record.childPid), false);
  try {
    process.kill(wrapper.pid, 'SIGKILL');
  } catch {
    // gone
  }
});
