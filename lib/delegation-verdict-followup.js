/**
 * One-shot VERDICT follow-up for reviews that ended with a report but no
 * VERDICT line. The verdict is never derived from prose: only an explicit
 * VERDICT line in the reply counts.
 */

import { HARNESSES_SUPPORTING_VERDICT_FOLLOWUP } from './delegation-adapter-capabilities.js';
import { resolveAgentTransportProfile } from './agent-transport.js';
import { describeIncompleteDelegationReport } from './delegation-verdict.js';

export const VERDICT_FOLLOWUP_PROMPT = 'Reply with only one line: `VERDICT: PASS`, `VERDICT: FAIL` or `VERDICT: BLOCKED`. Do not add anything else.';
export const VERDICT_FOLLOWUP_DISPLAY = 'Requesting the missing VERDICT line';

/**
 * @param {{ assignment?: unknown, report?: unknown, harness?: unknown, used?: unknown }} input
 * @returns {boolean}
 */
export function shouldRequestVerdictFollowUp(input = {}) {
  if (String(input.assignment || '').trim().toLowerCase() !== 'review') return false;
  if (Number(input.used) > 0) return false;
  if (!HARNESSES_SUPPORTING_VERDICT_FOLLOWUP.includes(resolveAgentTransportProfile(input.harness))) return false;
  return describeIncompleteDelegationReport(String(input.report || '')) === 'missing_verdict';
}

/**
 * Queue the follow-up on a room ahead of other prompts. Returns true when queued.
 *
 * @param {any} room
 * @param {{ assignment?: unknown, report?: unknown, harness?: unknown }} input
 * @returns {boolean}
 */
export function queueVerdictFollowUp(room, input) {
  if (!room || typeof room !== 'object') return false;
  if (!shouldRequestVerdictFollowUp({ ...input, used: room._verdictFollowUps })) return false;
  room._verdictFollowUps = (Number(room._verdictFollowUps) || 0) + 1;
  if (!Array.isArray(room.pendingPrompts)) room.pendingPrompts = [];
  room.pendingPrompts.unshift({
    text: VERDICT_FOLLOWUP_PROMPT,
    mode: room.sdkMode,
    displayText: VERDICT_FOLLOWUP_DISPLAY,
  });
  room._verdictFollowUpQueued = true;
  return true;
}
