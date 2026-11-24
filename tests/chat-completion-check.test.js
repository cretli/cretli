import test from 'node:test';
import assert from 'node:assert/strict';
import { completionDialogActions, completionFollowupsPayload } from '../app_front/features/chat/services/chatCompletionCheck.js';

test('completed permits only explicit archive and leave', () => {
  assert.deepEqual(completionDialogActions({ verdict: 'completed' }), ['archive', 'leave']);
});
test('needs_action requires open items before offering TODO creation', () => {
  assert.deepEqual(completionDialogActions({ verdict: 'needs_action', openItems: [{ title: 'Fix' }] }), ['followups', 'leave']);
  assert.deepEqual(completionDialogActions({ verdict: 'needs_action', openItems: [] }), ['leave']);
});
test('uncertain, errors and unknown verdicts never authorize archive', () => {
  for (const assessment of [null, {}, { verdict: 'uncertain' }, { verdict: 'error' }, { verdict: 'other' }]) {
    assert.deepEqual(completionDialogActions(assessment), ['leave']);
  }
});
test('retry payload retains original selection and titles after editable state changes', () => {
  const items = [{ index: 0, title: ' First ', checked: true }, { index: 1, title: 'Skip', checked: false }, { index: 2, title: 'Last', checked: true }];
  const payload = completionFollowupsPayload('assessment', items);
  const original = JSON.stringify(payload);
  items[0].title = 'Changed'; items[1].checked = true; items.reverse();
  assert.equal(JSON.stringify(payload), original);
  assert.deepEqual(payload, { assessmentId: 'assessment', items: [{ index: 0, title: 'First' }, { index: 2, title: 'Last' }], confirm: true });
});
