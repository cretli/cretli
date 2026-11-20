import assert from 'node:assert/strict';
import {
  isCompletePlanMarkdown,
  isProgressPlanComment,
  resolvePlanCommit,
} from '../lib/chat-plan-markdown.js';

assert.equal(isProgressPlanComment('Let me draft the plan after I look around.'), true);
assert.equal(isCompletePlanMarkdown('# Fix toolbar\n\n- a\n- b'), true);
assert.equal(isCompletePlanMarkdown('too short'), false);

const keepProgress = resolvePlanCommit({
  existingBody: '# Full plan\n\n- a\n- b',
  incomingBody: 'Working on the plan now.',
  existingTurnId: 't1',
  incomingTurnId: 't2',
  runStatus: 'completed',
});
assert.equal(keepProgress.action, 'keep');

const keepFailed = resolvePlanCommit({
  existingBody: '# Full plan\n\n- a',
  incomingBody: '# New plan\n\n- z',
  existingTurnId: 't1',
  incomingTurnId: 't2',
  runStatus: 'cancelled',
});
assert.equal(keepFailed.action, 'keep');

const replaceShorter = resolvePlanCommit({
  existingBody: '# Long plan\n\n## Extra\n\nLots of text that we no longer want.',
  incomingBody: '# Short plan\n\n- do it',
  existingTurnId: 't1',
  incomingTurnId: 't2',
  runStatus: 'completed',
});
assert.equal(replaceShorter.action, 'write');
assert.match(replaceShorter.body, /Short plan/);

const richerSameTurn = resolvePlanCommit({
  existingBody: '# Plan\n\n- a',
  incomingBody: '# Plan\n\n- a\n- b',
  existingTurnId: 't9',
  incomingTurnId: 't9',
  runStatus: 'completed',
});
assert.equal(richerSameTurn.action, 'write');
assert.match(richerSameTurn.body, /- b/);

console.log('chat-plan-commit.test.js OK');
