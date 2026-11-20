import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createOpenCodePromptRunWaiter,
  notifyOpenCodePromptRunEnd,
  submitOpenCodePromptAndWait,
} from '../opencode-prompt-run.js';

test('first-event timeout ends a run even when the HTTP submission never returns', async () => {
  const waiter = createOpenCodePromptRunWaiter({}, 1000, 20);
  await assert.rejects(submitOpenCodePromptAndWait(waiter, () => new Promise(() => {}), () => {
    assert.fail('A pending submission cannot be accepted');
  }), { code: 'adapter_timeout' });
});

test('acknowledged cancellation settles a pending submission and ignores a late HTTP response', async () => {
  const room = {};
  const waiter = createOpenCodePromptRunWaiter(room, 1000, 1000);
  let resolveSubmission;
  let accepted = false;
  const submission = new Promise((resolve) => { resolveSubmission = resolve; });
  const result = submitOpenCodePromptAndWait(waiter, () => submission, () => { accepted = true; });
  notifyOpenCodePromptRunEnd(room, { status: 'cancelled' });
  assert.deepEqual(await result, { status: 'cancelled' });
  resolveSubmission({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, false);
});

test('accepted submission still waits for model completion', async () => {
  const room = {};
  const waiter = createOpenCodePromptRunWaiter(room, 1000, 1000);
  let accepted = false;
  const result = submitOpenCodePromptAndWait(waiter, async () => ({}), () => { accepted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, true);
  notifyOpenCodePromptRunEnd(room, { status: 'completed' });
  assert.deepEqual(await result, { status: 'completed' });
});

test('submission error is surfaced immediately and a later waiter rejection is observed', async () => {
  const room = {};
  const waiter = createOpenCodePromptRunWaiter(room, 1000, 1000);
  const failure = new Error('fetch failed');
  await assert.rejects(submitOpenCodePromptAndWait(waiter, async () => { throw failure; }, () => {
    assert.fail('Failed submission cannot be accepted');
  }), failure);
  room._promptRunWaiter.reject(failure);
  await new Promise((resolve) => setImmediate(resolve));
});
