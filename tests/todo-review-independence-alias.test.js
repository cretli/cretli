import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTodoReviewIndependence } from '../lib/todo-review-state.js';
import { isExcludedDelegationModel } from '../lib/model-pick-gate-primitives.js';

const impl = { harness: 'claude', model: 'sonnet::effort=medium' };

test('alias and numbered id on one harness are the same model', () => {
  const reviewer = { harness: 'claude', model: 'claude-sonnet-5-5::effort=low' };
  assert.equal(classifyTodoReviewIndependence(reviewer, impl), 'same_model_same_harness');
});

test('same model on another harness is independent', () => {
  const reviewer = { harness: 'openrouter', model: 'claude-sonnet-5-5' };
  const claudeImpl = { harness: 'claude', model: 'claude-sonnet-5-5' };
  assert.equal(classifyTodoReviewIndependence(reviewer, claudeImpl), 'same_model_other_harness');
});

test('opus vs sonnet is a different base model', () => {
  const reviewer = { harness: 'claude', model: 'opus' };
  assert.equal(classifyTodoReviewIndependence(reviewer, impl), 'different_base_model');
});

test('implementer exclusion treats alias and numbered id as one model', () => {
  assert.equal(isExcludedDelegationModel('claude-sonnet-5-5', 'sonnet'), true);
  assert.equal(isExcludedDelegationModel('sonnet::effort=low', 'claude-sonnet-5-5'), true);
  assert.equal(isExcludedDelegationModel('opus', 'sonnet'), false);
});
