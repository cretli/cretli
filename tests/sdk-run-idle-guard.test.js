import assert from 'node:assert/strict';
import {
  readSdkRunStreamStep,
  resolveConfiguredSdkRunIdleTimeoutMs,
  resolveSdkRunIdleTimeoutMs,
  SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS,
  withAbortOnly,
} from '../lib/sdk/sdk-run-idle-guard.js';

assert.equal(SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS, 300000);
assert.equal(resolveConfiguredSdkRunIdleTimeoutMs(undefined), SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS);
assert.equal(resolveConfiguredSdkRunIdleTimeoutMs('120'), 120000);
assert.equal(resolveConfiguredSdkRunIdleTimeoutMs('3000'), 3000000);
assert.equal(resolveConfiguredSdkRunIdleTimeoutMs('abc'), SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS);
assert.equal(resolveSdkRunIdleTimeoutMs(undefined), SDK_RUN_IDLE_TIMEOUT_DEFAULT_MS);
assert.equal(resolveSdkRunIdleTimeoutMs('45000'), 45000);
assert.equal(resolveSdkRunIdleTimeoutMs('-1', 12345), 12345);
assert.equal(resolveSdkRunIdleTimeoutMs('abc', 23456), 23456);

const resolvedImmediately = await withAbortOnly(Promise.resolve('ok'));
assert.equal(resolvedImmediately, 'ok');

const abortController = new AbortController();
const abortPromise = withAbortOnly(new Promise(() => {}), abortController.signal);
abortController.abort();
// Expected message comes from sdk-run-idle-guard.js.
await assert.rejects(
  () => abortPromise,
  (err) => err instanceof Error && err.message === 'Cancelled by the user'
);

const immediateIterator = {
  async next() {
    return { done: false, value: 'event' };
  },
};
const immediateResult = await readSdkRunStreamStep(immediateIterator, 100);
assert.equal(immediateResult.timedOut, false);
assert.deepEqual(immediateResult.step, { done: false, value: 'event' });

const neverResolvingIterator = {
  next() {
    return new Promise(() => {});
  },
};
const streamTimeoutStartAt = Date.now();
const timeoutResult = await readSdkRunStreamStep(neverResolvingIterator, 25);
const timeoutElapsedMs = Date.now() - streamTimeoutStartAt;
assert.equal(timeoutResult.timedOut, true);
assert.equal(timeoutResult.step, null);
assert.ok(timeoutElapsedMs >= 20);

let deferredResolve = null;
let nextCalls = 0;
const iteratorWithPendingStep = {
  next() {
    nextCalls += 1;
    return new Promise((resolve) => {
      deferredResolve = resolve;
    });
  },
};
const firstPendingTimeout = await readSdkRunStreamStep(iteratorWithPendingStep, 10);
const secondPendingTimeout = await readSdkRunStreamStep(iteratorWithPendingStep, 10);
assert.equal(firstPendingTimeout.timedOut, true);
assert.equal(secondPendingTimeout.timedOut, true);
assert.equal(nextCalls, 1);
deferredResolve?.({ done: false, value: 'chunk-1' });
const resolvedAfterTimeouts = await readSdkRunStreamStep(iteratorWithPendingStep, 10);
assert.equal(resolvedAfterTimeouts.timedOut, false);
assert.deepEqual(resolvedAfterTimeouts.step, { done: false, value: 'chunk-1' });
assert.equal(nextCalls, 1);

console.log('All sdk-run-idle-guard tests passed.');
