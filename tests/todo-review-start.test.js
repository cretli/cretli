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

test('code review loads live requirements and asks for a VERDICT line', () => {
  const inputItem = { id: 'abc12345', title: 'Add export', body: 'Export CSV.', plan: { markdown: 'Step 1' } };
  const actualText = buildTodoReviewTaskText(inputItem, 'code');
  assert.match(actualText, /implementation of TODO abc12345: Add export/);
  assert.match(actualText, /todo_show with todo_id="abc12345"/);
  assert.match(actualText, /field=body and field=plan/);
  assert.match(actualText, /every next_cursor/);
  assert.doesNotMatch(actualText, /Export CSV\./);
  assert.match(actualText, /git diff/);
  assert.doesNotMatch(actualText, /Step 1/);
  assert.match(actualText, /VERDICT: PASS, VERDICT: FAIL or VERDICT: BLOCKED/);
});

test('plan review loads the current plan and reports missing or changed material', () => {
  const inputItem = { id: 'abc12345', title: 'Add export', body: '', plan: { markdown: 'Step 1: parse' } };
  const actualPlanText = buildTodoReviewTaskText(inputItem, 'plan');
  assert.match(actualPlanText, /plan of TODO abc12345/);
  assert.match(actualPlanText, /field=body and field=plan/);
  assert.doesNotMatch(actualPlanText, /Step 1: parse|\(no description\)/);
  assert.match(actualPlanText, /If no plan exists for a plan review, report BLOCKED/);
  assert.match(actualPlanText, /changed revision instead of a PASS/);

  const actualEmptyPlanText = buildTodoReviewTaskText({ id: 'x', title: 't' }, 'plan');
  assert.match(actualEmptyPlanText, /todo_show with todo_id="x"/);
  assert.match(actualEmptyPlanText, /If no plan exists for a plan review, report BLOCKED/);
});

test('both review subjects remain bounded with large saved material', () => {
  const inputItem = {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    title: 'Large title '.repeat(1000),
    body: 'BODY_SENTINEL '.repeat(10000),
    plan: { markdown: 'PLAN_SENTINEL '.repeat(10000) },
  };
  for (const subject of ['code', 'plan']) {
    const actualText = buildTodoReviewTaskText(inputItem, subject);
    assert.ok(actualText.length < 1500);
    assert.doesNotMatch(actualText, /BODY_SENTINEL|PLAN_SENTINEL/);
    assert.match(actualText, /Do not edit files or change todo status/);
    assert.match(actualText, /VERDICT: PASS, VERDICT: FAIL or VERDICT: BLOCKED/);
  }
});
