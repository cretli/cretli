/**
 * Codex exec cannot reject one shell call and keep the same process alive.
 * Review still aborts that turn (the command may already be starting), then
 * queues a follow-up so the reviewer continues read-only instead of the job
 * ending as a user cancel.
 */

import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { REVIEW_GUARD_USER_MESSAGE } from '../sdk/sdk-guard-messages.ts';

/** Two follow-ups, then a further denied command ends the review. */
export const CODEX_REVIEW_GUARD_RESUME_MAX = 2;

export const CODEX_REVIEW_GUARD_RESUME_DISPLAY =
  'Review denied one shell command. Continuing read-only.';

export function canResumeCodexReviewAfterGuard(input: { assignment?: unknown, resumesUsed?: unknown } = {}): boolean {
  if (!isReviewReadOnlyAssignment(input.assignment)) return false;
  const used = Number(input.resumesUsed);
  const resumesUsed = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  return resumesUsed < CODEX_REVIEW_GUARD_RESUME_MAX;
}

export function buildCodexReviewGuardResumePrompt(): string {
  return [
    REVIEW_GUARD_USER_MESSAGE,
    'Continue the review from the evidence you already have. Do not retry the denied command.',
  ].join('\n\n');
}

/** Delegation error code when a review ends after the last allowed guard resume. */
export const CODEX_REVIEW_GUARD_EXHAUSTED_CODE = 'review_guard_exhausted';

/** Loose view of a denied tool item (shape differs per Codex event). */
interface GuardToolItem {
  name?: unknown;
  toolName?: unknown;
  tool?: unknown;
  kind?: unknown;
  command?: unknown;
  input?: { command?: unknown } | null;
  args?: { command?: unknown } | null;
}

export function describeDeniedGuardTool(item: unknown): string {
  const tool: GuardToolItem = (item as GuardToolItem | null) || {};
  const name = String(tool.name || tool.toolName || tool.tool || tool.kind || 'unknown').trim() || 'unknown';
  const command = String(tool.command || tool.input?.command || tool.args?.command || '').trim();
  return command ? `${name}: ${command.slice(0, 200)}` : name;
}

export function buildReviewGuardExhaustedMessage(denied: unknown): string {
  const what = String(denied || '').trim() || 'unknown';
  return `[${CODEX_REVIEW_GUARD_EXHAUSTED_CODE}] Read-only review guard denied a tool call after ${CODEX_REVIEW_GUARD_RESUME_MAX} resumes (denied: ${what}). The reviewer kept running disallowed commands.`;
}
