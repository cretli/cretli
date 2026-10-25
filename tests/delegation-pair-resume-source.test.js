import test from 'node:test';
import assert from 'node:assert/strict';
import { findPairResumeSource } from '../lib/delegation-session-resume.js';
import { buildReviewerPoolInstruction } from '../lib/todo-execution-prompt.js';

const row = (id, over = {}) => ({
  id,
  assignment: 'review',
  parentChatId: 'p1',
  status: 'completed',
  childChatId: `c-${id}`,
  reviewSubject: 'plan',
  leafId: 'leaf',
  queuedAt: `2026-10-15T14:0${id}:00Z`,
  executor: { transport: 'codex', model: 'gpt-6.1-sol::effort=low' },
  ...over,
});
const base = {
  parentChatId: 'p1',
  reviewSubject: 'plan',
  leafId: 'leaf',
  executor: { transport: 'codex', model: 'gpt-6.1-sol::effort=low' },
};

test('findPairResumeSource picks the newest matching finished review', () => {
  const delegations = [row('1'), row('3'), row('2')];
  assert.equal(findPairResumeSource({ ...base, delegations }), '3');
});

test('findPairResumeSource ignores other model, parent, subject, leaf and unfinished rows', () => {
  const delegations = [
    row('1', { executor: { transport: 'codex', model: 'other' } }),
    row('2', { parentChatId: 'p2' }),
    row('3', { reviewSubject: 'code' }),
    row('4', { leafId: 'x' }),
    row('5', { status: 'running' }),
  ];
  assert.equal(findPairResumeSource({ ...base, delegations }), '');
});

test('reviewer pool instruction depends on strict', () => {
  const members = [{ harness: 'codex', model: 'a' }, { harness: 'claude', model: 'b' }];
  assert.match(buildReviewerPoolInstruction(members), /Do not use resume_session_of/);
  assert.match(buildReviewerPoolInstruction(members, { strict: true }), /STRICT PAIR/);
});
