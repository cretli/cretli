import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTodoReviewTaskText,
  resolveTodoReviewParentChatId,
} from '../app_front/features/todo/todoReviewStart.js';

test('review parent prefers the orchestrator chat and falls back to the linked chat', () => {
  assert.equal(resolveTodoReviewParentChatId({ orchestratorChatId: 'orch', chatId: 'linked' }), 'orch');
  assert.equal(resolveTodoReviewParentChatId({ chatId: 'linked' }), 'linked');
  assert.equal(resolveTodoReviewParentChatId({ orchestratorChatId: '  ', chatId: '' }), '');
  assert.equal(resolveTodoReviewParentChatId(null), '');
});

test('code review text names the todo, its requirements and asks for a VERDICT line', () => {
  const inputItem = { id: 'abc12345', title: 'Add export', body: 'Export CSV.', plan: { markdown: 'Step 1' } };
  const actualText = buildTodoReviewTaskText(inputItem, 'code');
  assert.match(actualText, /implementation of TODO abc12345: Add export/);
  assert.match(actualText, /Requirements:\nExport CSV\./);
  assert.match(actualText, /git diff/);
  assert.doesNotMatch(actualText, /Step 1/);
  assert.match(actualText, /VERDICT: PASS, VERDICT: FAIL or VERDICT: BLOCKED/);
});

test('plan review text includes the plan markdown and placeholders when it is missing', () => {
  const inputItem = { id: 'abc12345', title: 'Add export', body: '', plan: { markdown: 'Step 1: parse' } };
  const actualPlanText = buildTodoReviewTaskText(inputItem, 'plan');
  assert.match(actualPlanText, /plan of TODO abc12345/);
  assert.match(actualPlanText, /Plan:\nStep 1: parse/);
  assert.match(actualPlanText, /Requirements:\n\(no description\)/);

  const actualEmptyPlanText = buildTodoReviewTaskText({ id: 'x', title: 't' }, 'plan');
  assert.match(actualEmptyPlanText, /Plan:\n\(no plan\)/);
});
