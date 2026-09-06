/** @typedef {'agent'|'plan'|'ask'} SdkConversationMode */

export const SDK_MODE_DEFAULT = 'agent';

/** @type {readonly SdkConversationMode[]} */
export const SDK_CONVERSATION_MODES = Object.freeze(['plan', 'agent', 'ask']);

/**
 * @param {unknown} value
 * @returns {SdkConversationMode}
 */
export function normalizeSdkMode(value) {
  const s = (value == null ? '' : String(value)).trim().toLowerCase();
  if (s === 'plan' || s === 'ask') return s;
  return 'agent';
}

/**
 * True when `value` is already one of the three conversation modes.
 * Unknown values stay empty instead of falling back to agent (history / WS).
 *
 * @param {unknown} value
 * @returns {SdkConversationMode | ''}
 */
export function parseExplicitSdkMode(value) {
  const s = (value == null ? '' : String(value)).trim().toLowerCase();
  if (s === 'plan' || s === 'agent' || s === 'ask') return s;
  return '';
}

/**
 * Plan and Ask both forbid file/shell/MCP mutations. Plan also runs planning.
 *
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isReadOnlySdkMode(mode) {
  const normalized = normalizeSdkMode(mode);
  return normalized === 'plan' || normalized === 'ask';
}

/**
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isPlanSdkMode(mode) {
  return normalizeSdkMode(mode) === 'plan';
}

/**
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isAskSdkMode(mode) {
  return normalizeSdkMode(mode) === 'ask';
}

/**
 * Native Cursor / Qwen / CodeBuddy APIs only accept plan|agent.
 * Ask maps to agent plus a host-side tool policy.
 *
 * @param {unknown} mode
 * @returns {'plan' | 'agent'}
 */
export function toNativeAgentMode(mode) {
  return isPlanSdkMode(mode) ? 'plan' : 'agent';
}

/**
 * Mode that started the in-flight run, if any. Dropdown changes must not
 * lift that run's restrictions.
 *
 * @param {object | null | undefined} room
 * @param {unknown} [fallback]
 * @returns {SdkConversationMode}
 */
export function readEnforcedSdkMode(room, fallback) {
  const active = typeof room?._activeRunMode === 'string' ? room._activeRunMode.trim() : '';
  if (active) return normalizeSdkMode(active);
  return normalizeSdkMode(fallback ?? room?.sdkMode);
}

/**
 * @param {object | null | undefined} room
 * @param {unknown} mode
 * @returns {SdkConversationMode}
 */
export function beginEnforcedSdkMode(room, mode) {
  const normalized = normalizeSdkMode(mode);
  if (room && typeof room === 'object') room._activeRunMode = normalized;
  return normalized;
}

/**
 * @param {object | null | undefined} room
 */
export function clearEnforcedSdkMode(room) {
  if (room && typeof room === 'object') room._activeRunMode = '';
}
