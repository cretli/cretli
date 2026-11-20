import crypto from 'node:crypto';
import { addChat } from '../../lib/persist/chats-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../../lib/persist/delegations-persist.js';
import { ISOLATED_DATA_DIR } from './isolated-data-dir.js';

/** @returns {{ id: string, workspace: string }} a fresh parent chat. */
export function makeParent(label = 'parent') {
  const chat = addChat(crypto.randomUUID(), label, null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  return { id: chat.id, workspace: ISOLATED_DATA_DIR };
}

/**
 * Terminal review delegation attributed to a leaf.
 *
 * @param {{ parentId: string, leafId: string, verdict?: string, subject?: 'code'|'plan',
 *   mode?: string, status?: string, report?: string, planKey?: string, model?: string,
 *   finishedAt?: string, reviewFindings?: object }} input
 */
export function makeReview(input) {
  const record = createDelegationRecord({
    parentChatId: input.parentId,
    workspaceFolder: ISOLATED_DATA_DIR,
    executor: { transport: 'opencode', model: input.model || 'opencode/test' },
    status: input.status || 'completed',
    assignment: 'review',
    reviewSubject: input.subject || 'code',
    reviewMode: input.mode === undefined ? 'audit' : input.mode,
    leafId: input.leafId,
    todoPlanRevisionKey: input.planKey || '',
    sourceText: `review ${crypto.randomUUID()}`,
    idempotencyKey: crypto.randomUUID(),
    reviewFindings: input.reviewFindings,
  });
  const report = input.report !== undefined
    ? input.report
    : (input.verdict ? `Notes\nVERDICT: ${input.verdict}\n` : '');
  const patch = { report, finishedAt: input.finishedAt || new Date().toISOString() };
  if (input.verdict) patch.reportVerdict = input.verdict;
  return updateDelegationRecord(record.id, patch) || record;
}
