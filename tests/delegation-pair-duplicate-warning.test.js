import assert from 'node:assert/strict';
import test from 'node:test';
import { readPairDuplicateReviewerWarning, readPairSameBaseModelWarning } from '../lib/delegation-service.js';

const members = [
  { harness: 'claude', model: 'claude-opus-5-5::effort=low' },
  { harness: 'claude', model: 'claude-sonnet-5-5::effort=low' },
];
const leafId = 'd0b4c109-4ed4-4486-9cb2-abfb499a046a';

/** @param {string} model */
function reviewRow(model) {
  return {
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    executor: { transport: 'claude', model },
  };
}

test('repeating a pair member alias warns about the missing member', () => {
  const warning = readPairDuplicateReviewerWarning({
    delegations: [reviewRow('claude-opus-5-5::effort=low')],
    leafId,
    subject: 'code',
    harness: 'claude',
    model: 'opus::effort=low',
    members,
  });
  assert.equal(warning?.code, 'pair_duplicate_reviewer');
  assert.equal(warning.missing_members.length, 1);
  assert.match(warning.missing_members[0].model, /sonnet/);
});

test('first reviewer and the second distinct member do not warn', () => {
  const base = { leafId, subject: 'code', harness: 'claude', members };
  assert.equal(readPairDuplicateReviewerWarning({ ...base, delegations: [], model: 'opus' }), null);
  assert.equal(readPairDuplicateReviewerWarning({
    ...base,
    delegations: [reviewRow('claude-opus-5-5')],
    model: 'claude-sonnet-5-5',
  }), null);
});

test('pair preflight: two efforts of one base model cannot form a distinct pair', () => {
  const warning = readPairSameBaseModelWarning([
    { harness: 'codex', model: 'gpt-6-luna::effort=low' },
    { harness: 'codex', model: 'gpt-6-luna::effort=medium' },
  ]);
  assert.equal(warning?.code, 'pair_unsatisfiable');
  assert.equal(warning.reason, 'same_base_model');
  assert.match(warning.message, /gpt-6-luna/);
  assert.equal(readPairSameBaseModelWarning([
    { harness: 'codex', model: 'gpt-6-luna::effort=low' },
    { harness: 'claude', model: 'claude-opus-5-5' },
  ]), null);
  assert.equal(readPairSameBaseModelWarning([{ harness: 'codex', model: 'gpt-6-luna' }]), null);
});
