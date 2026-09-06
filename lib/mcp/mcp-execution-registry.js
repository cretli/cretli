/**
 * Live MCP execution snapshots. Tokens bind to a session; Plan/Agent mode is
 * read from the current room, never from the tool-call request.
 */

import { randomUUID } from 'crypto';
import { normalizeAgentTransport } from '../agent-transport.js';

/**
 * @typedef {{
 *   sessionId: string,
 *   chatId: string,
 *   workspaceId: string,
 *   workspaceFile: string,
 *   workspaceFolder: string,
 *   harness: string,
 *   incarnation: string,
 *   getMode: () => string,
 * }} McpExecutionSnapshot
 */

/** @type {Map<string, McpExecutionSnapshot>} */
const snapshots = new Map();

/**
 * @param {{ sessionId?: unknown, chatId?: unknown }} parts
 * @returns {string}
 */
export function mcpExecutionKey(parts) {
  const sessionId = String(parts?.sessionId || '').trim();
  const chatId = String(parts?.chatId || '').trim();
  if (sessionId) return `session:${sessionId}`;
  if (chatId) return `chat:${chatId}`;
  return '';
}

/**
 * @param {unknown} raw
 * @returns {'plan' | 'agent' | 'ask' | ''}
 */
export function normalizeMcpExecutionMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  if (mode === 'plan' || mode === 'agent' || mode === 'ask') return mode;
  return '';
}

/**
 * @param {object} context
 * @param {{ getMode?: () => unknown, renew?: boolean }} [options]
 * @returns {McpExecutionSnapshot | null}
 */
export function rememberMcpExecutionContext(context, options = {}) {
  const sessionId = String(context?.sessionId || '').trim();
  const chatId = String(context?.chatId || '').trim();
  const key = mcpExecutionKey({ sessionId, chatId });
  if (!key) return null;
  const previous = lookupMcpExecutionContext({ sessionId, chatId });
  const incarnation = previous && options.renew !== true
    ? previous.incarnation
    : randomUUID();
  const getMode = typeof options.getMode === 'function'
    ? options.getMode
    : (typeof context?.getMode === 'function' ? context.getMode : () => context?.mode);
  /** @type {McpExecutionSnapshot} */
  const snapshot = {
    sessionId,
    chatId,
    workspaceId: String(context?.workspaceId || '').trim(),
    workspaceFile: String(context?.workspaceFile || '').trim(),
    workspaceFolder: String(context?.workspaceFolder || '').trim(),
    harness: normalizeAgentTransport(context?.harness || ''),
    incarnation,
    getMode: () => normalizeMcpExecutionMode(getMode()),
  };
  snapshots.set(key, snapshot);
  if (sessionId && chatId) {
    snapshots.set(mcpExecutionKey({ chatId }), snapshot);
    snapshots.set(mcpExecutionKey({ sessionId }), snapshot);
  }
  return snapshot;
}

/**
 * @param {{ sessionId?: unknown, chatId?: unknown }} parts
 */
export function revokeMcpExecutionContext(parts) {
  const sessionId = String(parts?.sessionId || '').trim();
  const chatId = String(parts?.chatId || '').trim();
  if (sessionId) snapshots.delete(mcpExecutionKey({ sessionId }));
  if (chatId) snapshots.delete(mcpExecutionKey({ chatId }));
}

/**
 * @param {{ sessionId?: unknown, chatId?: unknown }} parts
 * @returns {McpExecutionSnapshot | null}
 */
export function lookupMcpExecutionContext(parts) {
  const sessionId = String(parts?.sessionId || '').trim();
  const chatId = String(parts?.chatId || '').trim();
  if (sessionId) {
    const bySession = snapshots.get(mcpExecutionKey({ sessionId }));
    if (bySession) return bySession;
  }
  if (chatId) {
    const byChat = snapshots.get(mcpExecutionKey({ chatId }));
    if (byChat) return byChat;
  }
  return null;
}

export function resetMcpExecutionRegistryForTests() {
  snapshots.clear();
}
