/**
 * Every built-in transport. This tuple is the single source of truth: the
 * `AgentTransport` type is derived from it.
 */
const TRANSPORT_TUPLE = /** @type {const} */ (['sdk', 'openrouter', 'mistral', 'zai', 'mimo', 'opencode', 'codebuddy', 'deepseek', 'codex', 'qwen', 'claude']);

/** @typedef {typeof TRANSPORT_TUPLE[number]} AgentTransport */

/**
 * Exported as `readonly string[]` so callers can test any string with
 * `.includes()`; use `parseKnownAgentTransport` to narrow to `AgentTransport`.
 *
 * @type {readonly string[]}
 */
export const VALID_TRANSPORTS = Object.freeze(TRANSPORT_TUPLE);

/**
 * Core harnesses: Claude, Cursor (`sdk`) and Codex. The other transports are
 * moving to optional plugins (docs/ts-migration-and-core-harnesses-plan.md, D1).
 */
export const CORE_AGENT_TRANSPORTS = Object.freeze(/** @type {const} */ (['claude', 'sdk', 'codex']));

/** @typedef {typeof CORE_AGENT_TRANSPORTS[number]} CoreAgentTransport */

/** @type {readonly string[]} */
const CORE_TRANSPORT_IDS = CORE_AGENT_TRANSPORTS;

/**
 * Transport ids registered by tests only (see tests/fixtures/fake-transport.js).
 * Always empty in production: nothing under lib/ calls the registration
 * function, and it refuses to run when NODE_ENV is "production". It is kept out
 * of {@link VALID_TRANSPORTS} on purpose so user-visible lists, Settings and
 * catalogs never include a test transport.
 *
 * Maps a test transport id to the built-in id whose per-transport policy
 * tables (capabilities, traits, session fields) it mirrors, or to itself.
 *
 * @type {Map<string, string>}
 */
const TEST_TRANSPORT_IDS = new Map();

/**
 * Test-only: make `parseKnownAgentTransport` and friends accept an extra id.
 * `options.profileOf` names a built-in transport whose static per-transport
 * policy (adapter capabilities, review traits, session-id field, ...) the test
 * transport mirrors, so core tests keep exercising realistic policy without
 * naming that harness.
 *
 * @param {string} id
 * @param {{ profileOf?: string }} [options]
 * @returns {void}
 */
export function registerTestAgentTransport(id, options = {}) {
  // `process` is absent from the front-end type environment that also imports this file.
  const nodeEnv = /** @type {any} */ (globalThis).process?.env?.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new Error('registerTestAgentTransport is test-only');
  }
  const token = String(id || '').trim().toLowerCase();
  if (!token || VALID_TRANSPORTS.includes(token)) {
    throw new Error(`invalid test transport id: ${id}`);
  }
  const profileOf = String(options.profileOf || '').trim().toLowerCase();
  TEST_TRANSPORT_IDS.set(token, profileOf && VALID_TRANSPORTS.includes(profileOf) ? profileOf : token);
}

/**
 * Test-only counterpart of {@link registerTestAgentTransport}.
 *
 * @param {string} id
 * @returns {void}
 */
export function unregisterTestAgentTransport(id) {
  TEST_TRANSPORT_IDS.delete(String(id || '').trim().toLowerCase());
}

/**
 * Resolve the id used for static per-transport policy lookups. Identity for
 * every built-in transport; only a test-registered transport can differ.
 *
 * @param {unknown} transport
 * @returns {string}
 */
export function resolveAgentTransportProfile(transport) {
  const token = String(transport || '').trim().toLowerCase();
  return TEST_TRANSPORT_IDS.get(token) || token;
}

/**
 * @param {string} token already trimmed and lower-cased
 * @returns {boolean} true for a built-in or a test-registered transport id
 */
export function isRegisteredAgentTransportId(token) {
  return VALID_TRANSPORTS.includes(token) || TEST_TRANSPORT_IDS.has(token);
}

/**
 * @param {unknown} value
 * @returns {AgentTransport | ''}
 */
export function parseKnownAgentTransport(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isRegisteredAgentTransportId(raw)) return '';
  return /** @type {AgentTransport} */ (raw);
}

/**
 * Exact match only: unlike `normalizeAgentTransport`, an unknown value is not
 * treated as `sdk`.
 *
 * @param {unknown} value
 * @returns {value is CoreAgentTransport}
 */
export function isCoreAgentTransport(value) {
  return typeof value === 'string' && CORE_TRANSPORT_IDS.includes(value);
}

/**
 * @param {unknown} value
 * @returns {AgentTransport}
 */
export function normalizeAgentTransport(value) {
  return parseKnownAgentTransport(value) || 'sdk';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidAgentTransport(value) {
  return parseKnownAgentTransport(value) !== '';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {AgentTransport}
 */
export function getChatAgentTransport(chat) {
  if (!chat || typeof chat !== 'object') return 'sdk';
  return normalizeAgentTransport(chat.agentTransport);
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isSdkChat(chat) {
  return getChatAgentTransport(chat) === 'sdk';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isOpenRouterChat(chat) {
  return getChatAgentTransport(chat) === 'openrouter';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isMistralChat(chat) {
  return getChatAgentTransport(chat) === 'mistral';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isZaiChat(chat) {
  return getChatAgentTransport(chat) === 'zai';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isMimoChat(chat) {
  return getChatAgentTransport(chat) === 'mimo';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isOpenCodeChat(chat) {
  return getChatAgentTransport(chat) === 'opencode';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isCodeBuddyChat(chat) {
  return getChatAgentTransport(chat) === 'codebuddy';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isDeepSeekChat(chat) {
  return getChatAgentTransport(chat) === 'deepseek';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isCodexChat(chat) {
  return getChatAgentTransport(chat) === 'codex';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isQwenChat(chat) {
  return getChatAgentTransport(chat) === 'qwen';
}

/**
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function isClaudeChat(chat) {
  return getChatAgentTransport(chat) === 'claude';
}

/**
 * True only for chat objects that declare a harness transport.
 * A PTY terminal (no agentTransport) must stay on the raw `{ type: 'input' }` path.
 *
 * @param {{ agentTransport?: string } | null | undefined} chat
 * @returns {boolean}
 */
export function usesHarnessWebSocket(chat) {
  if (!chat || typeof chat !== 'object') return false;
  if (typeof chat.agentTransport !== 'string' || !chat.agentTransport.trim()) return false;
  const transport = normalizeAgentTransport(chat.agentTransport);
  return transport === 'sdk'
    || transport === 'openrouter'
    || transport === 'mistral'
    || transport === 'zai'
    || transport === 'mimo'
    || transport === 'opencode'
    || transport === 'codebuddy'
    || transport === 'deepseek'
    || transport === 'codex'
    || transport === 'qwen'
    || transport === 'claude';
}

export { VALID_TRANSPORTS as AGENT_TRANSPORTS };
