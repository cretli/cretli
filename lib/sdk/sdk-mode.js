/** @typedef {'agent'|'plan'} SdkConversationMode */

export const SDK_MODE_DEFAULT = 'agent';

/**
 * @param {unknown} value
 * @returns {SdkConversationMode}
 */
export function normalizeSdkMode(value) {
  const s = (value == null ? '' : String(value)).trim().toLowerCase();
  if (s === 'plan') return 'plan';
  return 'agent';
}
