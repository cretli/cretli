import test from 'node:test';
import assert from 'node:assert/strict';
import { swipeNeighbour } from '../app_front/features/chat/modelSwipeNav.js';
import { encodeNewChatModelChoice as enc } from '../app_front/features/chat/newChatModelOptions.js';

const row = (model, variantOf, variantRank, extra = {}) => ({
  value: enc('claude', model), variantOf, variantRank, ...extra,
});
const options = [
  row('opus::low', 'opus', 0), row('opus::medium', 'opus', 1), row('opus::high', 'opus', 2),
  row('sonnet::medium', 'sonnet', 1), row('sonnet::high', 'sonnet', 2),
  row('haiku', undefined, undefined),
  { value: enc('codex', 'gpt'), variantOf: undefined },
];

test('effort axis walks variants of one model and stops at the ends', () => {
  assert.equal(swipeNeighbour(options, 'claude', 'opus::medium', 'effort', 1).model, 'opus::high');
  assert.equal(swipeNeighbour(options, 'claude', 'opus::medium', 'effort', -1).model, 'opus::low');
  assert.equal(swipeNeighbour(options, 'claude', 'opus::high', 'effort', 1), null);
  assert.equal(swipeNeighbour(options, 'claude', 'haiku', 'effort', 1), null);
});

test('model axis keeps the thinking level or the closest one', () => {
  assert.equal(swipeNeighbour(options, 'claude', 'opus::high', 'model', 1).model, 'sonnet::high');
  assert.equal(swipeNeighbour(options, 'claude', 'opus::low', 'model', 1).model, 'sonnet::medium');
  assert.equal(swipeNeighbour(options, 'claude', 'sonnet::high', 'model', -1).model, 'opus::high');
});

test('model axis crosses harnesses, skips disabled rows and stops at the ends', () => {
  const next = swipeNeighbour(options, 'claude', 'haiku', 'model', 1);
  assert.deepEqual([next.harness, next.model], ['codex', 'gpt']);
  assert.equal(swipeNeighbour(options, 'codex', 'gpt', 'model', 1), null);
  assert.equal(swipeNeighbour(options, 'claude', 'opus::low', 'model', -1), null);
  const disabled = options.map((r) => (r.variantOf === 'sonnet' ? { ...r, disabled: true } : r));
  assert.equal(swipeNeighbour(disabled, 'claude', 'opus::high', 'model', 1).model, 'haiku');
});
