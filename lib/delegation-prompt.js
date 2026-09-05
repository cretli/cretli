/**
 * Executor prompt for a delegated plan implementation.
 */

export const DELEGATION_PLAN_CONTEXT_LIMIT = 100000;

const EXECUTOR_ROLE = [
  'You are the executor for a Cretli delegated plan.',
  'Implement the attached approved plan in this workspace.',
  'Work in Agent mode. Do not create another Cretli delegation.',
  'If you are blocked or the plan is materially ambiguous, ask the user and stop.',
].join(' ');

const REPORT_INSTRUCTIONS = [
  'When finished, write a final report covering:',
  '- changes made',
  '- tests run and their results',
  '- deviations from the plan',
  '- remaining problems',
].join('\n');

/**
 * @param {{
 *   planMarkdown: string,
 *   workspaceFolder?: string,
 *   extraInstructions?: string,
 *   previousAttemptSummary?: string,
 * }} input
 * @returns {{ ok: true, prompt: string, displayText: string } | { ok: false, error: string, code: string }}
 */
export function buildDelegationExecutorPrompt(input) {
  const planMarkdown = String(input?.planMarkdown || '').trim();
  if (!planMarkdown) {
    return { ok: false, error: 'Plan is empty.', code: 'plan_empty' };
  }
  if (planMarkdown.length > DELEGATION_PLAN_CONTEXT_LIMIT) {
    return {
      ok: false,
      error: 'The approved plan is too large for the executor context. Shorten it and retry.',
      code: 'plan_too_large',
    };
  }
  const workspaceFolder = String(input?.workspaceFolder || '').trim();
  const extraInstructions = String(input?.extraInstructions || '').trim();
  const previousAttemptSummary = String(input?.previousAttemptSummary || '').trim();
  const parts = [
    EXECUTOR_ROLE,
    workspaceFolder ? `Workspace: ${workspaceFolder}` : '',
    '[APPROVED PLAN COPY]',
    planMarkdown,
    extraInstructions ? `[USER INSTRUCTIONS]\n${extraInstructions}` : '',
    previousAttemptSummary
      ? `[PREVIOUS ATTEMPT]\nDo not restart blindly. Continue from this context:\n${previousAttemptSummary}`
      : '',
    '[COMPLETION CRITERIA]',
    'Implement the plan. Verify the work you can run. Report blockers instead of guessing.',
    REPORT_INSTRUCTIONS,
  ].filter(Boolean);
  return {
    ok: true,
    prompt: parts.join('\n\n'),
    displayText: 'Implement the approved plan.',
  };
}

/**
 * @param {object} delegation
 * @returns {string}
 */
export function buildDelegationParentReportContext(delegation) {
  if (!delegation || typeof delegation !== 'object') return '';
  const status = String(delegation.status || '').trim();
  const report = String(delegation.report || '').trim();
  const error = String(delegation.error || '').trim();
  const lines = [
    '[DELEGATED EXECUTION REPORT]',
    `Delegation ${delegation.id} finished with status ${status}.`,
    'The planner should treat this as unverified until the user reviews it.',
  ];
  if (report) lines.push(report);
  if (error) lines.push(`Error: ${error}`);
  return lines.join('\n');
}
