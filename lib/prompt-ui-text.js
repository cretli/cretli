/**
 * UI/history text for a prompt. The agent still receives the full `text`.
 *
 * @param {unknown} text
 * @param {unknown} displayText
 * @returns {string}
 */
export function resolvePromptUiText(text, displayText) {
  const shown = typeof displayText === 'string' ? displayText.trim() : '';
  if (shown) return shown;
  return typeof text === 'string' ? text.trim() : '';
}

/**
 * @param {unknown} msg
 * @returns {string}
 */
export function readClientDisplayText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  return typeof msg.displayText === 'string' ? msg.displayText.trim() : '';
}

/**
 * Match a queued prompt by agent text or UI display text.
 *
 * @param {{ text?: unknown, displayText?: unknown } | null | undefined} item
 * @param {string} target
 * @returns {boolean}
 */
export function isQueuedPromptText(item, target) {
  const needle = typeof target === 'string' ? target.trim() : '';
  if (!needle || !item) return false;
  if (typeof item.text === 'string' && item.text.trim() === needle) return true;
  return typeof item.displayText === 'string' && item.displayText.trim() === needle;
}

/**
 * @param {{ text?: unknown, displayText?: unknown } | string | null | undefined} item
 * @returns {string}
 */
export function resolveQueuedPromptUiText(item) {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return '';
  return resolvePromptUiText(item.text, item.displayText);
}
