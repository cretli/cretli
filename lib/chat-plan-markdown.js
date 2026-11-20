/**
 * Pure Markdown helpers for chat plans.
 * Kept free of Node built-ins so the frontend bundle can import them.
 */

const PROGRESS_PLAN_RE =
  /^(okay[,.]?\s+|ok[,.]?\s+)?(i['’]m |i am |let me |working on |analyzing |drafting |thinking |starting |i will |i['’]ll )/i;

/**
 * Keep the longer Markdown source so a short assistant chunk cannot replace a full plan.
 * Use only while merging fragments of the same turn.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {string}
 */
export function pickRicherPlanMarkdown(left, right) {
  const leftText = stripChatPlanComment(left);
  const rightText = stripChatPlanComment(right);
  return leftText.length >= rightText.length ? leftText : rightText;
}

/**
 * Drop the Cretli plan marker comment for UI preview.
 *
 * @param {unknown} markdown
 * @returns {string}
 */
export function stripChatPlanComment(markdown) {
  return String(markdown || '')
    .replace(/<!--\s*cretli-chat-plan:[^>]*-->/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {unknown} markdown
 * @returns {boolean}
 */
export function isProgressPlanComment(markdown) {
  const text = stripChatPlanComment(markdown);
  if (!text) return true;
  const hasHeading = /^#{1,6}\s+\S/m.test(text);
  const hasList = /^[-*+]\s+\S/m.test(text) || /^\d+\.\s+\S/m.test(text);
  if (hasHeading || hasList) return false;
  if (PROGRESS_PLAN_RE.test(text) && text.length < 400) return true;
  if (text.length < 40) return true;
  return false;
}

/**
 * @param {unknown} markdown
 * @returns {boolean}
 */
export function isCompletePlanMarkdown(markdown) {
  const text = stripChatPlanComment(markdown);
  if (!text || isProgressPlanComment(text)) return false;
  const hasHeading = /^#{1,6}\s+\S/m.test(text);
  const listItems = text.match(/^[-*+]\s+\S/gm) || [];
  const numbered = text.match(/^\d+\.\s+\S/gm) || [];
  if (hasHeading && (text.length >= 16 || listItems.length + numbered.length >= 1)) return true;
  if (listItems.length + numbered.length >= 2) return true;
  if (text.length >= 200 && text.includes('\n')) return true;
  return false;
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isFailedPlanRunStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'error' ||
    normalized === 'cancelled' ||
    normalized === 'interrupted' ||
    normalized.includes('fail') ||
    normalized.includes('cancel') ||
    normalized.includes('error')
  );
}

/**
 * Decide whether a captured turn should replace the persisted plan.
 *
 * @param {{
 *   existingBody?: unknown,
 *   incomingBody?: unknown,
 *   existingTurnId?: unknown,
 *   incomingTurnId?: unknown,
 *   runStatus?: unknown,
 * }} input
 * @returns {{ action: 'keep' } | { action: 'write', body: string, bumpRevision: boolean }}
 */
export function resolvePlanCommit(input) {
  const incoming = stripChatPlanComment(input?.incomingBody);
  const existing = stripChatPlanComment(input?.existingBody);
  if (!incoming) return { action: 'keep' };
  if (isFailedPlanRunStatus(input?.runStatus)) return { action: 'keep' };
  if (isProgressPlanComment(incoming)) return { action: 'keep' };
  const existingTurnId = String(input?.existingTurnId || '').trim();
  const incomingTurnId = String(input?.incomingTurnId || '').trim();
  const sameTurn = Boolean(existingTurnId && incomingTurnId && existingTurnId === incomingTurnId);
  if (!existing) {
    return { action: 'write', body: incoming, bumpRevision: true };
  }
  if (sameTurn) {
    const richer = pickRicherPlanMarkdown(existing, incoming);
    if (richer === existing) return { action: 'keep' };
    return { action: 'write', body: richer, bumpRevision: false };
  }
  if (!isCompletePlanMarkdown(incoming)) return { action: 'keep' };
  return { action: 'write', body: incoming, bumpRevision: true };
}
