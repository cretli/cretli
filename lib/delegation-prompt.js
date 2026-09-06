/**
 * Executor prompt for a delegated plan or message implementation.
 */

import { normalizeDelegationExecutionMode, normalizeDelegationSourceKind } from './delegation-request.js';

export const DELEGATION_PLAN_CONTEXT_LIMIT = 100000;

const EXECUTOR_ROLE = [
  'You are the executor for a Cretli delegated plan.',
  'Implement the attached approved plan in this workspace.',
  'Do not create another Cretli delegation.',
  'If you are blocked or the plan is materially ambiguous, ask the user and stop.',
].join(' ');

const TASK_ROLE = [
  'You are the executor for a Cretli delegated task from a parent chat.',
  'Handle the attached task in this workspace.',
  'Do not create another Cretli delegation.',
  'If you are blocked or the task is materially ambiguous, ask the user and stop.',
].join(' ');

const REPORT_INSTRUCTIONS = [
  'When finished, write a final report covering:',
  '- changes made',
  '- tests run and their results',
  '- deviations from the assignment',
  '- remaining problems',
  'Send the report through the parent mailbox (or wait for the user to pass it).',
].join('\n');

/**
 * @param {unknown} body
 * @param {string} emptyCode
 * @param {string} emptyError
 * @returns {{ ok: true, body: string } | { ok: false, error: string, code: string }}
 */
function requireBoundedBody(body, emptyCode, emptyError) {
  const text = String(body || '').trim();
  if (!text) {
    return { ok: false, error: emptyError, code: emptyCode };
  }
  if (text.length > DELEGATION_PLAN_CONTEXT_LIMIT) {
    return {
      ok: false,
      error: 'The delegated content is too large for the executor context. Shorten it and retry.',
      code: 'plan_too_large',
    };
  }
  return { ok: true, body: text };
}

/**
 * @param {{
 *   planMarkdown?: string,
 *   taskText?: string,
 *   sourceKind?: string,
 *   parentChatId?: string,
 *   delegationId?: string,
 *   mailboxId?: string,
 *   sourceHistorySeq?: number,
 *   workspaceFolder?: string,
 *   extraInstructions?: string,
 *   previousAttemptSummary?: string,
 *   executionMode?: string,
 * }} input
 * @returns {{ ok: true, prompt: string, displayText: string } | { ok: false, error: string, code: string }}
 */
export function buildDelegationExecutorPrompt(input) {
  const sourceKind = normalizeDelegationSourceKind(input?.sourceKind);
  const isTask = sourceKind === 'message' || sourceKind === 'text';
  const bounded = requireBoundedBody(
    isTask ? input?.taskText : input?.planMarkdown,
    isTask ? 'message_empty' : 'plan_empty',
    isTask ? 'Message is empty.' : 'Plan is empty.',
  );
  if (!bounded.ok) return bounded;
  const executionMode = normalizeDelegationExecutionMode(input?.executionMode);
  const workspaceFolder = String(input?.workspaceFolder || '').trim();
  const extraInstructions = String(input?.extraInstructions || '').trim();
  const previousAttemptSummary = String(input?.previousAttemptSummary || '').trim();
  const parentChatId = String(input?.parentChatId || '').trim();
  const delegationId = String(input?.delegationId || '').trim();
  const mailboxId = String(input?.mailboxId || '').trim();
  const sourceHistorySeq = Number(input?.sourceHistorySeq) > 0 ? Number(input.sourceHistorySeq) : 0;
  const heading = isTask ? '[TASK]' : '[APPROVED PLAN COPY]';
  const modeHint = executionMode === 'plan'
    ? 'Stay in Plan mode. Do not edit files. Do not treat this prompt as approval to switch to Agent.'
    : 'Work in Agent mode. You may edit files needed for this assignment.';
  const criteria = isTask
    ? 'Handle the delegated task. Verify the work you can run. Report blockers instead of guessing.'
    : 'Implement the plan. Verify the work you can run. Report blockers instead of guessing.';
  const parts = [
    isTask ? TASK_ROLE : EXECUTOR_ROLE,
    `Execution mode: ${executionMode}. ${modeHint}`,
    workspaceFolder ? `Workspace: ${workspaceFolder}` : '',
    parentChatId ? `Parent chat: ${parentChatId}` : '',
    delegationId ? `Delegation: ${delegationId}` : '',
    mailboxId ? `Mailbox message: ${mailboxId}` : '',
    sourceHistorySeq ? `Source message seq: ${sourceHistorySeq}` : '',
    heading,
    bounded.body,
    extraInstructions ? `[EXTRA INSTRUCTIONS]\n${extraInstructions}` : '',
    previousAttemptSummary
      ? `[PREVIOUS ATTEMPT]\nDo not restart blindly. Continue from this context:\n${previousAttemptSummary}`
      : '',
    '[COMPLETION CRITERIA]',
    criteria,
    REPORT_INSTRUCTIONS,
  ].filter(Boolean);
  return {
    ok: true,
    prompt: parts.join('\n\n'),
    displayText: isTask ? 'Handle the delegated task.' : 'Implement the approved plan.',
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
