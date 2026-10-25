/**
 * The dev/prod decision for fatal process events and the run admission gate.
 *
 * Dev must never run the shutdown cleanup on `unhandledRejection` — one
 * rejected promise would otherwise kill live chats. Production runs the hook
 * (whose first phase is synchronous) instead of a bare `process.exit`.
 */

import assert from 'node:assert/strict';
import { createFatalProcessEventHandler } from '../lib/process-fatal.js';
import {
  assertCanAcceptNewRun,
  beginServerShutdown,
  canAcceptNewRun,
  isServerShuttingDown,
  resetUpdateGateForTest,
} from '../lib/update-gate.js';

// --- dev: recorded, but no cleanup and no terminate -------------------------
{
  const recorded = [];
  let shutdownCalls = 0;
  const handle = createFatalProcessEventHandler({
    isProd: false,
    record: (kind, error) => recorded.push({ kind, message: error?.message }),
    shutdown: () => { shutdownCalls += 1; },
  });
  const outcome = handle({ kind: 'unhandled-rejection', error: new Error('dev rejection') });
  assert.deepEqual(outcome, { terminate: false, shutdownCalled: false });
  assert.equal(shutdownCalls, 0, 'dev must not run the shutdown cleanup');
  assert.deepEqual(recorded, [{ kind: 'unhandled-rejection', message: 'dev rejection' }]);
}

// --- production: the hook runs and owns the exit ----------------------------
{
  const recorded = [];
  const kinds = [];
  const handle = createFatalProcessEventHandler({
    isProd: true,
    record: (kind) => recorded.push(kind),
    shutdown: (kind) => { kinds.push(kind); },
  });
  const outcome = handle({ kind: 'uncaught-exception', error: new Error('prod crash') });
  assert.deepEqual(outcome, { terminate: true, shutdownCalled: true });
  assert.deepEqual(kinds, ['uncaught-exception']);
  assert.deepEqual(recorded, ['uncaught-exception']);
}

// --- production without a hook, and a throwing hook, still terminate --------
{
  const noHook = createFatalProcessEventHandler({ isProd: true });
  assert.deepEqual(noHook({ kind: 'uncaught-exception', error: new Error('x') }), {
    terminate: true,
    shutdownCalled: false,
  });
  const throwing = createFatalProcessEventHandler({
    isProd: true,
    shutdown: () => { throw new Error('hook failed'); },
  });
  assert.deepEqual(throwing({ kind: 'uncaught-exception', error: new Error('x') }), {
    terminate: true,
    shutdownCalled: false,
  });
}

// --- a throwing recorder must not mask the fatal event ----------------------
{
  let shutdownCalls = 0;
  const handle = createFatalProcessEventHandler({
    isProd: true,
    record: () => { throw new Error('recorder failed'); },
    shutdown: () => { shutdownCalls += 1; },
  });
  assert.deepEqual(handle({ kind: 'unhandled-rejection', error: new Error('x') }), {
    terminate: true,
    shutdownCalled: true,
  });
  assert.equal(shutdownCalls, 1);
}

// --- shutdown gate: no new run is admitted, and it lasts until reset --------
resetUpdateGateForTest();
assert.equal(canAcceptNewRun(), true);
assert.equal(isServerShuttingDown(), false);
beginServerShutdown();
assert.equal(isServerShuttingDown(), true);
assert.equal(canAcceptNewRun(), false);
assert.throws(() => assertCanAcceptNewRun(), (err) => err?.code === 'server_shutting_down');
resetUpdateGateForTest();
assert.equal(isServerShuttingDown(), false);
assert.equal(canAcceptNewRun(), true);
assert.doesNotThrow(() => assertCanAcceptNewRun());

console.log('process-fatal.test.js OK');
