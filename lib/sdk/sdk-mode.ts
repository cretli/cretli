export type SdkConversationMode = 'agent' | 'plan' | 'ask';

export const SDK_MODE_DEFAULT = 'agent';

export const SDK_CONVERSATION_MODES: readonly SdkConversationMode[] = Object.freeze(['plan', 'agent', 'ask']);

/**
 * @param {unknown} value
 * @returns {SdkConversationMode}
 */
export function normalizeSdkMode(value: unknown): SdkConversationMode {
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
export function parseExplicitSdkMode(value: unknown): SdkConversationMode | '' {
  const s = (value == null ? '' : String(value)).trim().toLowerCase();
  if (s === 'plan' || s === 'agent' || s === 'ask') return s;
  return '';
}

/**
 * Return whether a mode card should be rendered for a transition.
 * An empty previous mode means that the first valid mode card is renderable.
 *
 * @param {unknown} previousMode
 * @param {unknown} nextMode
 * @returns {boolean}
 */
export function shouldRenderModeChange(previousMode: unknown, nextMode: unknown): boolean {
  const next = parseExplicitSdkMode(nextMode);
  if (!next) return false;
  return parseExplicitSdkMode(previousMode) !== next;
}

/**
 * Plan and Ask both forbid file/shell/MCP mutations. Plan also runs planning.
 *
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isReadOnlySdkMode(mode: unknown): boolean {
  const normalized = normalizeSdkMode(mode);
  return normalized === 'plan' || normalized === 'ask';
}

/**
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isPlanSdkMode(mode: unknown): boolean {
  return normalizeSdkMode(mode) === 'plan';
}

/**
 * @param {unknown} mode
 * @returns {boolean}
 */
export function isAskSdkMode(mode: unknown): boolean {
  return normalizeSdkMode(mode) === 'ask';
}

/**
 * Native Cursor / Qwen / CodeBuddy APIs only accept plan|agent.
 * Ask maps to agent plus a host-side tool policy.
 *
 * @param {unknown} mode
 * @returns {'plan' | 'agent'}
 */
export function toNativeAgentMode(mode: unknown): 'plan' | 'agent' {
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
export function readEnforcedSdkMode(room: any, fallback?: unknown): SdkConversationMode {
  const active = typeof room?._activeRunMode === 'string' ? room._activeRunMode.trim() : '';
  if (active) return normalizeSdkMode(active);
  return normalizeSdkMode(fallback ?? room?.sdkMode);
}

/**
 * @param {object | null | undefined} room
 * @param {unknown} mode
 * @returns {SdkConversationMode}
 */
export function beginEnforcedSdkMode(room: any, mode: unknown): SdkConversationMode {
  const normalized = normalizeSdkMode(mode);
  if (room && typeof room === 'object') room._activeRunMode = normalized;
  return normalized;
}

/**
 * @param {object | null | undefined} room
 */
export function clearEnforcedSdkMode(room: any): void {
  if (room && typeof room === 'object') room._activeRunMode = '';
}
