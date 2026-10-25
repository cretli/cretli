/**
 * Runtime boundary for the executor memory guard:
 * - a denied pre-flight must throw before the real `spawn` is called;
 * - an allowed launch still spawns and is tracked by the child registry;
 * - critical / reserve-starved hosts are refused, unknown state is allowed.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { test } from 'node:test';

import {
  __resetChildProcessRegistryForTest,
  installChildProcessSpawnTracking,
  isChildProcessRegistered,
  listRegisteredChildProcesses,
} from '../lib/child-process-registry.js';
import {
  ExecutorLaunchDeniedError,
  assertExecutorLaunchAllowed,
  configureExecutorLaunchGate,
  createExecutorLaunchGate,
  resetExecutorLaunchGateForTest,
  resolveExecutorLaunchGateConfig,
} from '../lib/executor-launch-gate.js';

const GB = 1024 ** 3;

/**
 * Restore the process-wide spawn hook and gate after a test. The registry
 * snapshot of the original spawn is captured at install time, so the caller
 * keeps its own reference to the true original.
 *
 * @param {import('node:test').TestContext} context
 * @param {typeof childProcess.spawn} originalSpawn
 */
function restoreSpawnAndGate(context, originalSpawn) {
  context.after(() => {
    __resetChildProcessRegistryForTest();
    childProcess.spawn = originalSpawn;
    resetExecutorLaunchGateForTest();
  });
}

test('a critical host refuses a managed executor before the real spawn', (context) => {
  const originalSpawn = childProcess.spawn;
  restoreSpawnAndGate(context, originalSpawn);
  resetExecutorLaunchGateForTest({
    enabled: true,
    readHostMemory: () => ({ totalBytes: 10 * GB, availableBytes: 0.5 * GB }),
  });
  let realSpawnCalls = 0;
  childProcess.spawn = function countingSpawn(...args) {
    realSpawnCalls += 1;
    return originalSpawn.apply(this, args);
  };
  installChildProcessSpawnTracking();

  let denied = null;
  try {
    childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)', 'agent'], { stdio: 'ignore' });
  } catch (error) {
    denied = error;
  }
  assert.ok(denied instanceof ExecutorLaunchDeniedError);
  assert.equal(denied.code, 'EXECUTOR_LAUNCH_DENIED');
  assert.equal(denied.decision.level, 'critical');
  assert.equal(denied.decision.type, 'harness-cli');
  assert.equal(realSpawnCalls, 0, 'a refused launch must never reach the real spawn');
  assert.equal(listRegisteredChildProcesses().length, 0);
});

test('an allowed launch still spawns and is tracked until exit', async (context) => {
  const originalSpawn = childProcess.spawn;
  restoreSpawnAndGate(context, originalSpawn);
  resetExecutorLaunchGateForTest({
    enabled: true,
    readHostMemory: () => ({ totalBytes: 10 * GB, availableBytes: 5 * GB }),
  });
  installChildProcessSpawnTracking();

  const child = childProcess.spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.exit(0), 150)', 'agent'],
    { stdio: 'ignore' },
  );
  assert.ok(child.pid > 0);
  assert.equal(isChildProcessRegistered(child.pid), true);
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(isChildProcessRegistered(child.pid), false);
});

test('preflight refuses critical and reserve-starved hosts, allows unknown state', () => {
  const critical = createExecutorLaunchGate({
    enabled: true,
    readHostMemory: () => ({ totalBytes: 10 * GB, availableBytes: 0.5 * GB }),
  });
  const criticalDecision = critical.check({ type: 'agent-run' });
  assert.deepEqual([criticalDecision.allowed, criticalDecision.level], [false, 'critical']);
  assert.throws(
    () => critical.assert({ type: 'agent-run', label: 'agent' }),
    (error) => error instanceof ExecutorLaunchDeniedError
      && error.code === 'EXECUTOR_LAUNCH_DENIED'
      && /critical/.test(error.message)
      && error.decision.type === 'agent-run',
  );

  // 10 GB total, 7% critical line (0.7 GB), 512 MiB reserve: 1 GB is above the
  // line but leaves only 0.3 GB of headroom, so it is refused.
  const reserveStarved = createExecutorLaunchGate({
    enabled: true,
    readHostMemory: () => ({ totalBytes: 10 * GB, availableBytes: 1 * GB }),
  });
  assert.equal(reserveStarved.check({ type: 'task-run' }).level, 'warn');
  assert.equal(reserveStarved.check({ type: 'task-run' }).allowed, false);
  assert.match(reserveStarved.check({ type: 'task-run' }).reason, /headroom/);

  const warning = createExecutorLaunchGate({
    enabled: true,
    readHostMemory: () => ({ totalBytes: 10 * GB, availableBytes: 1.4 * GB }),
  });
  assert.deepEqual([warning.check().allowed, warning.check().level], [true, 'warn']);

  const unknown = createExecutorLaunchGate({
    enabled: true,
    readHostMemory: () => ({ totalBytes: null, availableBytes: null }),
  });
  assert.deepEqual([unknown.check().allowed, unknown.check().level], [true, 'unknown']);

  const unreadable = createExecutorLaunchGate({
    enabled: true,
    readHostMemory: () => {
      throw new Error('no /proc');
    },
  });
  assert.equal(unreadable.check().allowed, true, 'a probe failure is unknown, not critical');
});

test('config comes from the environment and a disabled gate is a pass-through', () => {
  assert.equal(resolveExecutorLaunchGateConfig({}).enabled, true);
  assert.equal(resolveExecutorLaunchGateConfig({ CRETLI_EXECUTOR_MEMORY_GUARD: '0' }).enabled, false);
  assert.equal(resolveExecutorLaunchGateConfig({ CRETLI_EXECUTOR_MEMORY_GUARD: 'off' }).enabled, false);
  const custom = resolveExecutorLaunchGateConfig({
    CRETLI_MEMORY_GUARD_WARN_RATIO: '0.3',
    CRETLI_MEMORY_GUARD_CRITICAL_RATIO: '0.2',
    CRETLI_MEMORY_GUARD_RESERVE_MB: '256',
  });
  assert.deepEqual(
    [custom.warnAvailableRatio, custom.criticalAvailableRatio, custom.executorReserveBytes],
    [0.3, 0.2, 256 * 1024 ** 2],
  );
  const invalid = resolveExecutorLaunchGateConfig({ CRETLI_MEMORY_GUARD_CRITICAL_RATIO: '9' });
  assert.equal(invalid.criticalAvailableRatio, 0.07, 'an out-of-range override falls back to the default');

  const disabled = createExecutorLaunchGate({ env: { CRETLI_EXECUTOR_MEMORY_GUARD: 'off' } });
  assert.equal(disabled.check().allowed, true);
  assert.equal(disabled.check().level, 'disabled');
});

test('a denied decision reaches the observability hook', () => {
  const decisions = [];
  const gate = createExecutorLaunchGate({
    enabled: true,
    readHostMemory: () => ({ totalBytes: 10 * GB, availableBytes: 0.5 * GB }),
    onDecision: (decision) => decisions.push(decision),
  });
  gate.check({ type: 'terminal-pty', label: 'bash' });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].allowed, false);
  assert.equal(decisions[0].type, 'terminal-pty');
  assert.equal(decisions[0].level, 'critical');
});

test('the process-wide gate is configurable and denies by default when critical', () => {
  configureExecutorLaunchGate({
    enabled: true,
    readHostMemory: () => ({ totalBytes: 10 * GB, availableBytes: 0.5 * GB }),
  });
  try {
    assert.throws(
      () => assertExecutorLaunchAllowed({ type: 'dev-build', label: 'build' }),
      (error) => error instanceof ExecutorLaunchDeniedError && error.decision.type === 'dev-build',
    );
  } finally {
    configureExecutorLaunchGate({ enabled: false });
  }
  assert.equal(assertExecutorLaunchAllowed({ type: 'dev-build' }).allowed, true);
});
