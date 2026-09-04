/**
 * Pure Markdown helpers for chat plans.
 * Kept free of Node built-ins so the frontend bundle can import them.
 */

/**
 * Keep the longer Markdown source so a short assistant chunk cannot replace a full plan.
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
