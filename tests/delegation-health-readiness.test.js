import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { buildDelegationRuntimeHealthSnapshot } from '../lib/delegation-health.js';
import { resetDelegationLifecycleForTest, setDelegationLifecycleState } from '../lib/delegation-lifecycle.js';
import { DELEGATION_RUNTIME_TICK_MS, DELEGATION_TICK_HUNG_MS } from '../lib/delegation-status.js';

resetDelegationLifecycleForTest();
setDelegationLifecycleState('ready');

function workerBase(patch = {}) {
  return {
    running: true,
    tickInFlight: false,
    dispatchInFlight: 0,
    startedAt: new Date().toISOString(),
    lastTickStartedAt: Date.now() - 100,
    lastTickFinishedAt: Date.now() - 100,
    degraded: false,
    ok: true,
    code: '',
    message: '',
    at: '',
    consecutiveErrors: 0,
    nextRetryAt: 0,
    ...patch,
  };
}

{
  const now = Date.now();
  const actual = buildDelegationRuntimeHealthSnapshot({
    worker: workerBase({ lastTickFinishedAt: now - DELEGATION_RUNTIME_TICK_MS * 4 }),
    now,
  });
  assert.equal(actual.worker.staleTick, true);
  assert.equal(actual.readiness, false);
  assert.equal(actual.ok, false);
  assert.equal(actual.liveness, true);
}

{
  const now = Date.now();
  const actual = buildDelegationRuntimeHealthSnapshot({
    worker: workerBase({
      tickInFlight: true,
      lastTickStartedAt: now - DELEGATION_TICK_HUNG_MS - 10,
      lastTickFinishedAt: now - 1000,
    }),
    now,
  });
  assert.equal(actual.worker.hungTick, true);
  assert.equal(actual.readiness, false);
}

{
  const now = Date.now();
  const actual = buildDelegationRuntimeHealthSnapshot({
    worker: workerBase({ lastTickFinishedAt: now - 200, lastTickStartedAt: now - 200 }),
    now,
  });
  assert.equal(actual.worker.staleTick, false);
  assert.equal(actual.worker.hungTick, false);
  assert.equal(actual.readiness, true);
  assert.equal(actual.ok, true);
}

console.log('delegation-health-readiness.test.js OK');
