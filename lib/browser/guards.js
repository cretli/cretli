/**
 * Browser action guards.
 *
 * Plan/ask conversations are read-only: list/state/screenshot/console/network/
 * DOM pulls are allowed, while navigation, input, tab mutation and storage
 * changes require agent mode. Agent tool entry points must also pass explicit
 * browserSessionId + browserTabId so an empty id list can never widen the scope
 * to every session.
 */

import { normalizeSdkMode, parseExplicitSdkMode, isReadOnlySdkMode } from '../sdk/sdk-mode.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { loadChats } from '../persist/chats-persist.js';

/** Actions that never change browser state. */
export const BROWSER_READ_ACTIONS = Object.freeze(new Set([
  'status',
  'list-sessions',
  'list-tabs',
  'state',
  'screenshot',
  'console',
  'network',
  'dom',
  'policy-read',
]));

/** Actions that change browser state and require agent mode. */
export const BROWSER_MUTATION_ACTIONS = Object.freeze(new Set([
  'create-session',
  'close-session',
  'create-tab',
  'close-tab',
  'select-tab',
  'navigate',
  'back',
  'forward',
  'reload',
  'input',
  'download',
  'permission',
  'policy-write',
]));

/**
 * @param {unknown} action
 * @returns {boolean}
 */
export function isBrowserMutationAction(action) {
  return BROWSER_MUTATION_ACTIONS.has(String(action || '').trim());
}

/**
 * @param {unknown} action
 * @returns {boolean}
 */
export function isBrowserReadAction(action) {
  return BROWSER_READ_ACTIONS.has(String(action || '').trim());
}

/**
 * @param {unknown} chatId
 * @returns {string} '' when the chat is missing/unknown
 */
export function resolveChatMode(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return '';
  const chat = loadChats().find((entry) => entry && entry.id === id);
  return chat ? normalizeSdkMode(chat.sdkMode) : '';
}

/**
 * Effective mode for a Browser request.
 * A persisted chat mode always wins (a plan-mode run cannot be lifted by
 * passing mode=agent); an explicit mode is only used without a chatId.
 * @param {{ mode?: unknown, chatId?: unknown }} [input]
 * @returns {string} 'plan' | 'ask' | 'agent' | ''
 */
export function resolveBrowserMode(input = {}) {
  const fromChat = resolveChatMode(input.chatId);
  if (fromChat) return fromChat;
  return parseExplicitSdkMode(input.mode);
}

/**
 * @typedef {Object} BrowserGuardDecision
 * @property {boolean} allowed
 * @property {string} code
 * @property {string} reason
 * @property {string} mode
 */

/**
 * @param {{ action?: unknown, mode?: unknown, chatId?: unknown, source?: 'ui'|'agent', assignment?: unknown }} [input]
 * @returns {BrowserGuardDecision}
 */
export function evaluateBrowserActionGuard(input = {}) {
  const action = String(input.action || '').trim();
  if (!isBrowserReadAction(action) && !isBrowserMutationAction(action)) {
    return { allowed: false, code: 'unknown-action', reason: `Unknown browser action: ${action || '(empty)'}`, mode: '' };
  }
  if (isBrowserReadAction(action)) {
    return { allowed: true, code: 'read-allowed', reason: 'read-only action', mode: resolveBrowserMode(input) };
  }
  // Fail closed: a mutation must be authorized by an explicit mode or by the
  // persisted mode of a known chat. Empty mode must never fall through to the
  // normalizeSdkMode('') => agent default, or the panel could mutate in plan mode.
  const mode = resolveBrowserMode(input);
  if (!mode) {
    return {
      allowed: false,
      code: 'mode-required',
      reason: 'Browser mutations require an explicit plan/ask/agent mode or a chatId with a known mode.',
      mode: '',
    };
  }
  if (isReadOnlySdkMode(mode)) {
    return {
      allowed: false,
      code: 'plan-mode-readonly',
      reason: 'Plan/ask mode allows read-only browser actions only.',
      mode,
    };
  }
  if (isReviewReadOnlyAssignment(input.assignment)) {
    return {
      allowed: false,
      code: 'review-mode-readonly',
      reason: 'Review assignments allow read-only browser actions only.',
      mode,
    };
  }
  return { allowed: true, code: 'mutation-allowed', reason: 'agent mode', mode: mode || 'agent' };
}

/**
 * Throws a structured error when a browser action is not allowed.
 * @param {{ action?: unknown, mode?: unknown, chatId?: unknown, assignment?: unknown }} [input]
 * @returns {BrowserGuardDecision}
 */
export function assertBrowserActionAllowed(input = {}) {
  const decision = evaluateBrowserActionGuard(input);
  if (!decision.allowed) {
    const error = new Error(decision.reason);
    // @ts-ignore attach machine-readable fields
    error.code = decision.code;
    // @ts-ignore
    error.status = 403;
    throw error;
  }
  return decision;
}

/**
 * Agent tool entry point contract: mutations and reads both need explicit ids.
 * @param {{ browserSessionId?: unknown, browserTabId?: unknown }} [input]
 * @returns {boolean}
 */
export function hasExplicitBrowserTarget(input = {}) {
  const sessionId = String(input.browserSessionId || '').trim();
  const tabId = String(input.browserTabId || '').trim();
  return Boolean(sessionId && tabId);
}
