/**
 * Pure helpers for starting a manual review of a Todo from its card
 * (`docs/todo-review-contract.md` §3, §5.2). Browser-safe and free of DOM access
 * so the request shape is covered by `node:test`.
 */

/** @type {readonly ('code'|'plan')[]} */
export const TODO_REVIEW_SUBJECTS = Object.freeze(['code', 'plan']);

/**
 * The review is recorded under the orchestrator when there is one, otherwise under
 * the linked chat. Empty means the todo has no chat to delegate from.
 *
 * @param {{ orchestratorChatId?: unknown, chatId?: unknown } | null | undefined} item
 * @returns {string}
 */
export function resolveTodoReviewParentChatId(item) {
  return String(item?.orchestratorChatId || item?.chatId || '').trim();
}

/**
 * @param {{ id?: unknown, title?: unknown, body?: unknown, plan?: { markdown?: unknown } | null } | null | undefined} item
 * @param {'code'|'plan'} subject
 * @returns {string}
 */
export function buildTodoReviewTaskText(item, subject) {
  const id = String(item?.id || '').trim();
  const title = String(item?.title || '').trim();
  const body = String(item?.body || '').trim() || '(no description)';
  const header = `TODO ${id}: ${title}`;
  const rules = 'Do not edit files or change todo status. Run relevant checks when you can.';
  const verdict = 'End your report with exactly one line: VERDICT: PASS, VERDICT: FAIL or VERDICT: BLOCKED.';
  if (subject === 'plan') {
    const plan = String(item?.plan?.markdown || '').trim() || '(no plan)';
    return [
      `Review the plan of ${header} before implementation.`,
      `Requirements:\n${body}`,
      `Plan:\n${plan}`,
      'Check that the plan covers the requirements, is concrete and can be verified.',
      rules,
      verdict,
    ].join('\n\n');
  }
  return [
    `Review the implementation of ${header}.`,
    `Requirements:\n${body}`,
    'Inspect the workspace changes for this task (git status and git diff) and check them against the requirements.',
    rules,
    verdict,
  ].join('\n\n');
}
