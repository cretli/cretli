import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { inspectReviewIndependence } from '../lib/delegation-review-independence-gate.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';

const LEAF = crypto.randomUUID();
const base = { assignment: 'review', reviewSubject: 'code' };

test('rejects a reviewer on the orchestrator base model (effort suffix and alias ignored)', () => {
  const res = inspectReviewIndependence({
    ...base,
    executor: { transport: 'claude', model: 'sonnet::effort=medium' },
    controller: { harness: 'claude', model: 'claude-sonnet-5-5' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'review_not_independent');
});

test('allows another base model, another harness, plan reviews and unknown models', () => {
  const controller = { harness: 'claude', model: 'sonnet' };
  assert.equal(inspectReviewIndependence({ ...base, executor: { transport: 'claude', model: 'opus' }, controller }).ok, true);
  assert.equal(inspectReviewIndependence({ ...base, executor: { transport: 'codex', model: 'sonnet' }, controller }).ok, true);
  assert.equal(inspectReviewIndependence({ ...base, reviewSubject: 'plan', executor: { transport: 'claude', model: 'sonnet' }, controller }).ok, true);
  assert.equal(inspectReviewIndependence({ ...base, executor: { transport: 'claude', model: 'auto' }, controller }).ok, true);
});

test('rejects a reviewer on the leaf implementer base model', () => {
  const parentChatId = `parent-${crypto.randomUUID()}`;
  createDelegationRecord({
    parentChatId,
    childChatId: `child-${crypto.randomUUID()}`,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'testfake', model: 'impl-a' },
    assignment: 'implement',
    status: 'completed',
    leafId: LEAF,
  });
  const same = inspectReviewIndependence({ ...base, controllerChatId: parentChatId, leafId: LEAF, executor: { transport: 'testfake', model: 'impl-a' } });
  assert.equal(same.ok, false);
  assert.equal(same.code, 'review_not_independent');
  const other = inspectReviewIndependence({ ...base, controllerChatId: parentChatId, leafId: LEAF, executor: { transport: 'testfake', model: 'rev-b' } });
  assert.equal(other.ok, true);
});

test('model_pick history hard-excludes the controller model for review only', () => {
  const review = buildModelPickHistory({
    role: 'review', chatId: 'c1', delegations: [], lockouts: [], planLimits: [], freshLimitHits: {},
    controllerModel: 'sonnet::effort=medium',
  });
  assert.ok(review.hardExcludeModels.includes('sonnet::effort=medium'));
  const implement = buildModelPickHistory({
    role: 'implement', chatId: 'c1', delegations: [], lockouts: [], planLimits: [], freshLimitHits: {},
    controllerModel: 'sonnet',
  });
  assert.deepEqual(implement.hardExcludeModels, []);
});
