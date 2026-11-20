/**
 * Browser plan-mode guard tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_MUTATION_ACTIONS,
  BROWSER_READ_ACTIONS,
  assertBrowserActionAllowed,
  evaluateBrowserActionGuard,
  hasExplicitBrowserTarget,
  isBrowserMutationAction,
  isBrowserReadAction,
} from '../lib/browser/guards.js';

test('read actions are allowed in every mode', () => {
  for (const action of BROWSER_READ_ACTIONS) {
    assert.equal(isBrowserReadAction(action), true);
    assert.equal(evaluateBrowserActionGuard({ action, mode: 'plan' }).allowed, true, action);
    assert.equal(evaluateBrowserActionGuard({ action, mode: 'agent' }).allowed, true, action);
  }
});

test('mutations are blocked in plan/ask and allowed in agent', () => {
  for (const action of BROWSER_MUTATION_ACTIONS) {
    assert.equal(isBrowserMutationAction(action), true);
    assert.equal(evaluateBrowserActionGuard({ action, mode: 'plan' }).allowed, false, action);
    assert.equal(evaluateBrowserActionGuard({ action, mode: 'ask' }).allowed, false, action);
    assert.equal(evaluateBrowserActionGuard({ action, mode: 'agent' }).allowed, true, action);
  }
});

test('unknown actions are rejected', () => {
  const decision = evaluateBrowserActionGuard({ action: 'browser_evaluate' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'unknown-action');
});

test('assertBrowserActionAllowed throws a 403-shaped error', () => {
  assert.throws(
    () => assertBrowserActionAllowed({ action: 'navigate', mode: 'plan' }),
    (err) => err.code === 'plan-mode-readonly' && err.status === 403,
  );
});

test('agent tools require explicit session and tab ids', () => {
  assert.equal(hasExplicitBrowserTarget({ browserSessionId: 's', browserTabId: 't' }), true);
  assert.equal(hasExplicitBrowserTarget({ browserSessionId: 's' }), false);
  assert.equal(hasExplicitBrowserTarget({}), false);
});
