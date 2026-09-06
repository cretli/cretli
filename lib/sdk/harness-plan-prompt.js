/**
 * Plan-mode prompt decorations shared by non-SDK harnesses.
 */

import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.js';
import { buildChatPlanPromptContext } from '../chat-plan-persist.js';
import { collectDelegationReportsForPrompt } from '../delegation-report-context.js';
import { isAskSdkMode } from './sdk-mode.js';

export const HARNESS_PLAN_MODE_HINT =
  'You are in plan mode. Analyze and propose changes only; do not run mutating tools until the user confirms. A question-UI approval (implement / yes) or Cretli Build plan is confirmation — then implement; Cretli switches to agent mode and lifts write restrictions. Do not write plan files, todos, or scratch markdown — Cretli persists your plan after this turn.';

export const HARNESS_ASK_MODE_HINT =
  'You are in Ask mode. Answer questions and analyze the codebase using read-only tools. Do not edit files, run mutating commands, write plans, create todos, start implementations, or treat a user "yes" as approval to apply changes. If the user wants changes, tell them to switch to Agent mode.';

/**
 * Prefix a harness prompt with the plan-mode hint and/or the persisted chat plan.
 *
 * @param {unknown} text
 * @param {{
 *   cwd?: string,
 *   chatId?: string,
 *   mode?: string,
 *   transport?: string,
 *   skipPlanHint?: boolean,
 *   reportContext?: string,
 * }} [input]
 * @returns {string}
 */
export function applyHarnessOutboundPrompt(text, input = {}) {
  const prompt = String(text || '');
  const parts = [];
  if (input.skipPlanHint !== true) {
    const mode = String(input.mode || '').trim().toLowerCase();
    if (isAskSdkMode(mode)) {
      parts.push(HARNESS_ASK_MODE_HINT);
    } else {
      const policy = resolveHarnessPlanPolicy(input.transport);
      if (mode === 'plan' && policy.promptHint) {
        parts.push(HARNESS_PLAN_MODE_HINT);
      }
    }
  }
  const chatPlan = buildChatPlanPromptContext({
    cwd: input.cwd,
    chatId: input.chatId,
  });
  if (chatPlan) parts.push(chatPlan);
  const delegationReports = Object.prototype.hasOwnProperty.call(input, 'reportContext')
    ? String(input.reportContext || '')
    : collectDelegationReportsForPrompt(input.chatId).text;
  if (delegationReports) parts.push(delegationReports);
  if (parts.length === 0) return prompt;
  return `${parts.join('\n\n')}\n\n${prompt}`;
}

/**
 * @param {any} room
 * @param {unknown} text
 * @param {string} transport
 * @param {{ skipPlanHint?: boolean }} [options]
 * @returns {string}
 */
export function decorateHarnessPrompt(room, text, transport, options = {}) {
  const collected = collectDelegationReportsForPrompt(room?.chatId);
  if (room) room._delegationReportIdsInPrompt = collected.ids;
  return applyHarnessOutboundPrompt(text, {
    cwd: room?.cwd,
    chatId: room?.chatId,
    mode: room?.sdkMode,
    transport,
    skipPlanHint: options.skipPlanHint === true,
    reportContext: collected.text,
  });
}
