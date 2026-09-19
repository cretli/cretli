/**
 * Executor prompt for a delegated plan, review, or message assignment.
 */

import {
  normalizeDelegationAssignment,
  normalizeDelegationExecutionMode,
  normalizeDelegationSourceKind,
} from './delegation-request.js';

export const DELEGATION_PLAN_CONTEXT_LIMIT = 100000;
export const DELEGATION_REPORT_CONTEXT_LIMIT = 8000;

const DISPLAY_TEXT_MAX = 120;

const IMPLEMENT_PLAN_ROLE = [
  'You are the executor for a Cretli delegated plan.',
  'Implement the attached approved plan in this workspace.',
  'Do not create another Cretli delegation.',
  'If you are blocked or the plan is materially ambiguous, ask the user and stop.',
].join(' ');

const IMPLEMENT_TASK_ROLE = [
  'You are the executor for a Cretli delegated task from a parent chat.',
  'Handle the attached task in this workspace.',
  'Do not create another Cretli delegation.',
  'If you are blocked or the task is materially ambiguous, ask the user and stop.',
].join(' ');

const REVIEW_ROLE = [
  'You are the reviewer for a Cretli delegated assignment from a parent chat.',
  'Verify the attached plan or task against this workspace.',
  'Do not implement. Do not edit files. Do not create another Cretli delegation.',
  'If you are blocked or the assignment is materially ambiguous, ask the user and stop.',
].join(' ');

const REPORT_BULLETS = [
  'When finished, write a final report covering:',
  '- findings or changes made',
  '- tests run and their results',
  '- deviations from the assignment',
  '- remaining problems',
  '- blockers',
  '- artifacts',
].join('\n');

/**
 * Agent can call MCP. Plan/Ask cannot, so the runtime delivers the report.
 *
 * @param {'plan' | 'agent'} executionMode
 * @returns {string}
 */
function buildReportInstructions(executionMode) {
  if (executionMode === 'agent') {
    return `${REPORT_BULLETS}\nSend the report through delegation_reply with reply_kind=final_report. Pass a stable idempotency_key and the executing attempt_id/run_id.`;
  }
  return `${REPORT_BULLETS}\nThe system will deliver the final report to the parent.`;
}

const ASSIGNMENT_OVERRIDE = [
  'If [ASSIGNMENT] conflicts with the default role, follow [ASSIGNMENT].',
  'Do not implement unless that block asks you to.',
].join(' ');

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
 * @param {string} extra
 * @param {string} fallback
 * @returns {string}
 */
function buildDisplayText(extra, fallback) {
  const line = extra.split('\n').map((row) => row.trim()).find(Boolean) || '';
  if (!line) return fallback;
  if (line.length <= DISPLAY_TEXT_MAX) return line;
  return `${line.slice(0, DISPLAY_TEXT_MAX - 1)}…`;
}

/**
 * @param {{ isTask: boolean, assignment: 'review' | 'implement' }} input
 * @returns {string}
 */
function buildRole(input) {
  if (input.assignment === 'review') return REVIEW_ROLE;
  return input.isTask ? IMPLEMENT_TASK_ROLE : IMPLEMENT_PLAN_ROLE;
}

/**
 * @param {{ isTask: boolean, assignment: 'review' | 'implement' }} input
 * @returns {string}
 */
function buildCriteria(input) {
  if (input.assignment === 'review') {
    return 'Review the assignment against the repository. Report what is correct, what is wrong, and what is missing. Do not implement.';
  }
  if (input.isTask) {
    return 'Handle the delegated task. Verify the work you can run. Report blockers instead of guessing.';
  }
  return 'Implement the plan. Verify the work you can run. Report blockers instead of guessing.';
}

/**
 * @param {'plan' | 'agent'} executionMode
 * @param {'review' | 'implement'} assignment
 * @returns {string}
 */
function buildModeHint(executionMode, assignment) {
  if (executionMode === 'plan') {
    return 'Stay in Plan mode. Do not edit files. Do not treat this prompt as approval to switch to Agent.';
  }
  if (assignment === 'review') {
    return 'You may use read-only tools. Do not edit files, commit, or treat this as approval to implement.';
  }
  return 'Work in Agent mode. You may edit files needed for this assignment.';
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
 *   assignment?: string,
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
  const assignment = normalizeDelegationAssignment(input?.assignment, executionMode);
  const extraInstructions = String(input?.extraInstructions || '').trim();
  const previousAttemptSummary = String(input?.previousAttemptSummary || '').trim();
  const heading = isTask ? '[TASK]' : '[APPROVED PLAN COPY]';
  const fallbackDisplay = assignment === 'review'
    ? (isTask ? 'Review the delegated task.' : 'Review the approved plan.')
    : (isTask ? 'Handle the delegated task.' : 'Implement the approved plan.');
  const parts = [
    buildRole({ isTask, assignment }),
    extraInstructions ? `[ASSIGNMENT]\n${extraInstructions}\n\n${ASSIGNMENT_OVERRIDE}` : '',
    `Execution mode: ${executionMode}. Assignment: ${assignment}. ${buildModeHint(executionMode, assignment)}`,
    String(input?.workspaceFolder || '').trim() ? `Workspace: ${String(input.workspaceFolder).trim()}` : '',
    String(input?.parentChatId || '').trim() ? `Parent chat: ${String(input.parentChatId).trim()}` : '',
    String(input?.delegationId || '').trim() ? `Delegation: ${String(input.delegationId).trim()}` : '',
    String(input?.mailboxId || '').trim() ? `Mailbox message: ${String(input.mailboxId).trim()}` : '',
    Number(input?.sourceHistorySeq) > 0 ? `Source message seq: ${Number(input.sourceHistorySeq)}` : '',
    heading,
    bounded.body,
    previousAttemptSummary
      ? `[PREVIOUS ATTEMPT]\nDo not restart blindly. Continue from this context:\n${previousAttemptSummary}`
      : '',
    '[COMPLETION CRITERIA]',
    buildCriteria({ isTask, assignment }),
    buildReportInstructions(executionMode),
  ].filter(Boolean);
  return {
    ok: true,
    prompt: parts.join('\n\n'),
    displayText: buildDisplayText(extraInstructions, fallbackDisplay),
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
  const attemptId = String(delegation.attemptId || '').trim();
  let body = report;
  let truncated = false;
  if (body.length > DELEGATION_REPORT_CONTEXT_LIMIT) {
    body = `${body.slice(0, DELEGATION_REPORT_CONTEXT_LIMIT)}\n…[truncated]`;
    truncated = true;
  }
  const lines = [
    '[DELEGATED EXECUTION REPORT]',
    `Delegation ${delegation.id} finished with status ${status}.`,
    attemptId ? `Attempt: ${attemptId}` : '',
    'The planner should treat this as unverified until the user reviews it.',
    'Declarations by the executor are not facts until reviewed.',
  ].filter(Boolean);
  if (body) lines.push(body);
  if (error) lines.push(`Error: ${error}`);
  if (truncated) {
    lines.push(`Full report is available via delegation_show for ${delegation.id}.`);
  }
  return lines.join('\n');
}
