/** @typedef {'sdk' | 'openrouter' | 'opencode'} AgentTransport */

const VALID_TRANSPORTS = Object.freeze(['sdk', 'openrouter', 'opencode']);

/**
 * @param {unknown} value
 * @returns {AgentTransport}
 */
export function normalizeAgentTransport(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'openrouter') return 'openrouter';
  if (raw === 'opencode') return 'opencode';
  return 'sdk';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidAgentTransport(value) {
  const normalized = normalizeAgentTransport(value);
  return VALID_TRANSPORTS.includes(normalized);
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
export function isOpenCodeChat(chat) {
  return getChatAgentTransport(chat) === 'opencode';
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
  return transport === 'sdk' || transport === 'openrouter' || transport === 'opencode';
}

export { VALID_TRANSPORTS as AGENT_TRANSPORTS };
