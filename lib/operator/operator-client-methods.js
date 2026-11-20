/**
 * Operator-run methods of the in-process MCP client, kept out of
 * `mcp-inprocess-client.js` (size ratchet). Identity comes from the host chat
 * row of the calling context, never from tool arguments, and is tri-state:
 * a chat whose row cannot be confirmed is `unknown`, which the gate denies.
 */

import './operator-run-chat.js'; // side effect: registers the sync chat-row reader for the identity index
import { appendOperatorAudit } from './operator-audit.js';
import {
  getOperatorRunIdentity,
  getRegisteredOperatorRunId,
  isOperatorRunRow,
  noteChatRowsForOperatorIndex,
} from './operator-run-chat-registry.js';

/**
 * @param {Record<string, any>} context MCP runtime context (`chatId`)
 * @param {{ findChatById: (id: unknown) => Promise<unknown>, dataDir: () => string }} deps
 */
export function createOperatorClientMethods(context, deps) {
  const chatId = String(context?.chatId || '').trim();
  /** @returns {Promise<{ identity: 'operator' | 'normal' | 'unknown', row: Record<string, any> | null }>} */
  const lookup = async () => {
    if (!chatId) return { identity: 'normal', row: null };
    let row = null;
    try {
      row = /** @type {any} */ (await deps.findChatById(chatId));
    } catch {
      return { identity: getOperatorRunIdentity(chatId), row: null };
    }
    if (row && typeof row === 'object') {
      noteChatRowsForOperatorIndex(row);
      return { identity: isOperatorRunRow(row) ? 'operator' : 'normal', row };
    }
    // A missing row confirms nothing: only an identity the index already holds survives, otherwise unknown.
    return { identity: getOperatorRunIdentity(chatId), row: null };
  };
  return {
    /** @returns {Promise<'operator' | 'normal' | 'unknown'>} */
    async getOperatorIdentity() {
      return (await lookup()).identity;
    },
    /** @returns {Promise<boolean>} true for a confirmed operator run */
    async isOperatorRunChat() {
      return (await lookup()).identity === 'operator';
    },
    /** @returns {Promise<{ runId: string, workspaceFolder: string } | null>} */
    async getOperatorRunContext() {
      const { identity, row } = await lookup();
      if (identity !== 'operator') return null;
      return {
        runId: String(row?.operatorRunId || getRegisteredOperatorRunId(chatId) || '').trim(),
        workspaceFolder: String(row?.workspaceFolder || '').trim(),
      };
    },
    /** Store location of this process, so the run protocol tools write where the audit writes. */
    operatorStoreOptions() {
      return { dataDir: deps.dataDir() };
    },
    /** Throws on failure: the gate then denies the call (fail-closed). */
    async recordOperatorAudit(entry) {
      const { row } = await lookup();
      appendOperatorAudit(
        { ...entry, runId: String(row?.operatorRunId || getRegisteredOperatorRunId(chatId) || '') },
        { dataDir: deps.dataDir() },
      );
    },
  };
}
