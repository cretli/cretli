/**
 * Decide whether the chat-delete confirmation modal can be skipped.
 *
 * @param {object} [input]
 * @param {boolean} [input.skipConfirm]
 * @param {boolean} [input.forceConfirm]
 * @param {boolean} [input.skipPreference]
 * @param {boolean} [input.isAgentWorking]
 * @returns {boolean}
 */
export function shouldSkipChatDeleteConfirm(input = {}) {
  if (input.forceConfirm === true) return false;
  if (input.isAgentWorking === true && input.skipConfirm !== true) return false;
  return input.skipConfirm === true || input.skipPreference === true;
}
