import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDelegationFailure, DELEGATION_FAILURE_CLASSES } from '../lib/delegation-failure-class.js';
import { noteDelegationFailureLockout } from '../lib/harness-usage-limits.js';

test('adapter_no_verdict is its own bounded-fallback class with no exclusion scope', () => {
  const byText = classifyDelegationFailure({ error: 'adapter_no_verdict: review produced no VERDICT line' });
  assert.equal(byText.failureClass, 'no_verdict');
  assert.equal(byText.scope, 'none');
  assert.equal(byText.harnessWide, false);
  const byCode = classifyDelegationFailure({ errors: [{ code: 'adapter_no_verdict', message: 'no answer' }] });
  assert.equal(byCode.failureClass, 'no_verdict');
  assert.ok(DELEGATION_FAILURE_CLASSES.includes('no_verdict'));
});

test('no_verdict never creates a lockout; other classes keep their behavior', () => {
  assert.equal(noteDelegationFailureLockout({
    harness: 'mistral', model: 'm', error: 'adapter_no_verdict', workspaceFolder: '/tmp/nv-ws',
  }), false);
  assert.equal(classifyDelegationFailure({ error: '401 Unauthorized' }).failureClass, 'auth');
  assert.equal(classifyDelegationFailure({ error: 'Transport not started' }).failureClass, 'transient_transport');
  assert.equal(classifyDelegationFailure({ error: 'something odd happened' }).failureClass, 'unknown');
  assert.equal(classifyDelegationFailure({ error: '' }).failureClass, 'unknown');
});
