/**
 * Workspace-relative chat plan path helpers (no fs — safe for the frontend bundle).
 */

export const CHAT_PLAN_DIR = '.cursor/plans';

/**
 * @param {unknown} chatId
 * @returns {string}
 */
export function sanitizeChatPlanFileId(chatId) {
  const safeId = String(chatId || '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeId || safeId.includes('..')) return '';
  return safeId;
}

/**
 * @param {unknown} chatId
 * @returns {string}
 */
export function buildChatPlanRelativePath(chatId) {
  const safeId = sanitizeChatPlanFileId(chatId);
  if (!safeId) return '';
  return `${CHAT_PLAN_DIR}/cretli-${safeId}.md`;
}

/**
 * English agent prompt that points at the persisted plan file for this chat.
 *
 * @param {unknown} chatId
 * @returns {string}
 */
export function buildApprovedPlanImplementPrompt(chatId) {
  const planFile = buildChatPlanRelativePath(chatId);
  if (!planFile) return 'Implement the approved plan. Read the latest plan file and implement it.';
  return `Implement the approved plan from \`${planFile}\`. Read that file and implement it.`;
}
