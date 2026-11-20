/** A failed code review on an integration-ready leaf is needs-human `review_failed`, not `integration_ready`. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isTodoIntegrationBlockedByReview } from '../lib/todo-integration-state.js';
import { classifyWorkspaceDoingTodo } from '../lib/workspace-watcher-recovery.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const classify = (item) => classifyWorkspaceDoingTodo({
  item, index: new Map(), delegations: [], cycles: [], childParentIds: new Set(), now: 0,
  isCycleChatAlive: () => false, probe: () => ({}),
});

test('integration-ready + review.code failed -> review_failed', () => {
  const r = classify({ id: 'a', status: 'doing', integration: { state: 'ready' }, review: { code: { state: 'failed' } } });
  assert.equal(r.state, 'user_action');
  assert.equal(r.reason, 'review_failed');
});

test('integration-ready + review passed stays integration_ready', () => {
  const r = classify({ id: 'a', status: 'doing', integration: { state: 'ready' }, review: { code: { state: 'passed' } } });
  assert.equal(r.reason, 'integration_ready');
});

test('review_failed attention is never manually releasable', async () => {
  const { canManualReleaseDoingTodo } = await import('../lib/workspace-watcher-todo-recover.js');
  assert.equal(canManualReleaseDoingTodo({ state: 'user_action', reason: 'review_failed' }), false);
});

test('integration is blocked by review only for ready + failed', () => {
  const todo = (integrationState, reviewState) => ({
    integration: { state: integrationState },
    review: { code: { state: reviewState } },
  });
  assert.equal(isTodoIntegrationBlockedByReview(todo('ready', 'failed')), true);
  for (const reviewState of ['passed', 'unknown', 'none']) {
    assert.equal(isTodoIntegrationBlockedByReview(todo('ready', reviewState)), false);
  }
  for (const integrationState of ['', 'integrated', 'rejected']) {
    assert.equal(isTodoIntegrationBlockedByReview(todo(integrationState, 'failed')), false);
  }
});

test('todo card and row label ready + failed honestly while preserving ready + passed', () => {
  const card = readSource('app_front/components/ui/cr-todo-card.js');
  const row = readSource('app_front/features/todo/views/todoRowRender.js');
  for (const source of [card, row]) {
    assert.match(source, /isTodoIntegrationBlockedByReview/);
    assert.match(source, /todo\.integrationReviewFailed/);
    assert.match(source, /todo\.integrationReviewFailedHint/);
    assert.match(source, /todo\.integrationReady/);
    assert.match(source, /todo\.integrationReadyHint/);
  }
  assert.match(card, /reviewBlocked[\s\S]*integrationReviewFailed[\s\S]*awaiting \? t\('todo\.integrationReady'/);
  assert.match(card, /reviewBlocked \? 'todo\.integrationReviewFailed' : 'todo\.integrationReady'/);
  assert.match(row, /isSmartMerging[\s\S]*isIntegrationApplied[\s\S]*isIntegrationReviewBlocked[\s\S]*integrationReviewFailed[\s\S]*integrationReady/);
});
