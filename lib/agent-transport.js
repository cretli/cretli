/** @typedef {'sdk' | 'openrouter' | 'mistral' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen' | 'claude'} AgentTransport */

export const VALID_TRANSPORTS = Object.freeze(['sdk', 'openrouter', 'mistral', 'opencode', 'codebuddy', 'deepseek', 'codex', 'qwen', 'claude']);

/**
 * @param {unknown} value
 * @returns {AgentTransport | ''}
 */
export function parseKnownAgentTransport(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!VALID_TRANSPORTS.includes(raw)) return '';
  return /** @type {AgentTransport} */ (raw);
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
    || transport === 'opencode'
    || transport === 'codebuddy'
    || transport === 'deepseek'
    || transport === 'codex'
    || transport === 'qwen'
    || transport === 'claude';
}

export { VALID_TRANSPORTS as AGENT_TRANSPORTS };
