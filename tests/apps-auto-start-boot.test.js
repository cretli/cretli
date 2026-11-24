/** autoStart apps are queued only on the success path of the delegation boot, after runtime-ready. */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { getDelegationLifecycleState, resetDelegationLifecycleForTest } from '../lib/delegation-lifecycle.js';
import { bootDelegationRuntime, shutdownDelegationRuntime } from '../lib/delegation-runtime-boot.js';
import { resolveRecoveryStorePath } from '../lib/recovery/recovery-store.ts';
import { resetDelegationRuntimeHealth, stopDelegationRuntimeWorker } from '../lib/delegation-runtime-worker.js';

async function cleanup() {
  await shutdownDelegationRuntime({ timeoutMs: 1000 });
  stopDelegationRuntimeWorker();
  resetDelegationRuntimeHealth();
  resetDelegationLifecycleForTest();
}

test('boot queues autoStart apps once, only after the lifecycle is ready', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  const seen = [];
  try {
    await bootDelegationRuntime({
      intervalMs: 60_000,
      recoverySchedulerFactory: () => ({ start: () => () => {} }),
      startAppsAutoStart: () => { seen.push(getDelegationLifecycleState()); },
    });
    assert.deepEqual(seen, ['ready']);
  } finally {
    await cleanup();
  }
});

test('degraded boot never queues autoStart apps', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  const storePath = resolveRecoveryStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.rmSync(storePath, { force: true });
  fs.mkdirSync(storePath, { recursive: true });
  let calls = 0;
  try {
    await bootDelegationRuntime({ intervalMs: 60_000, startAppsAutoStart: () => { calls += 1; } });
    assert.equal(getDelegationLifecycleState(), 'degraded');
    assert.equal(calls, 0);
  } finally {
    await cleanup();
    fs.rmSync(storePath, { recursive: true, force: true });
  }
});

test('a throwing autoStart hook does not degrade a ready boot', async () => {
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  try {
    await bootDelegationRuntime({
      intervalMs: 60_000,
      recoverySchedulerFactory: () => ({ start: () => () => {} }),
      startAppsAutoStart: () => { throw new Error('boom'); },
    });
    assert.equal(getDelegationLifecycleState(), 'ready');
  } finally {
    await cleanup();
  }
});
