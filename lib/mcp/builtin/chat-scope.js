/**
 * Workspace scope for builtin chat MCP tools.
 * Default is the calling chat's workspace. Cross-workspace needs scope=all.
 */

import { findChatByRef } from '../../remote-api-client.js';
import { isChatInWorkspace, resolveCretliToolContext } from './tool-context.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/**
 * @param {unknown} raw
 * @returns {'workspace' | 'all'}
 */
export function normalizeMcpChatScope(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'all') return 'all';
  return 'workspace';
}

/**
 * @param {object[]} chats
 * @param {string} workspaceFolder
 * @param {string} [workspaceFile]
 * @param {string} [needle]
 */
export function filterChatsForWorkspace(chats, workspaceFolder, workspaceFile = '', needle = '') {
  const rows = Array.isArray(chats) ? chats : [];
  const scoped = rows.filter((chat) => isChatInWorkspace(chat, workspaceFolder, workspaceFile));
  const text = String(needle || '').trim().toLowerCase();
  if (!text) return scoped;
  return scoped.filter((chat) => {
    const hay = `${chat.workspaceFolder || ''} ${chat.workspaceFile || ''}`.toLowerCase();
    return hay.includes(text);
  });
}

/**
 * @param {object[]} chats
 * @param {string} [needle]
 */
export function filterChatsByWorkspaceNeedle(chats, needle = '') {
  const rows = Array.isArray(chats) ? chats : [];
  const text = String(needle || '').trim().toLowerCase();
  if (!text) return rows;
  return rows.filter((chat) => {
    const hay = `${chat.workspaceFolder || ''} ${chat.workspaceFile || ''}`.toLowerCase();
    return hay.includes(text);
  });
}

/**
 * @param {object[]} chats
 * @param {object} session
 * @param {{ scope?: unknown, workspace?: unknown }} [args]
 */
export function listChatsForMcpScope(chats, session, args = {}) {
  const ctx = resolveCretliToolContext(session);
  const scope = normalizeMcpChatScope(args.scope);
  const needle = String(args.workspace || '').trim();
  if (scope === 'all') return filterChatsByWorkspaceNeedle(chats, needle);
  return filterChatsForWorkspace(chats, ctx.workspaceFolder, ctx.workspaceFile, needle);
}

/**
 * Resolve a chat ref inside the allowed scope. A known id outside the
 * workspace is OUT_OF_SCOPE unless scope=all.
 *
 * @param {object} client
 * @param {object} session
 * @param {{ chat?: unknown, scope?: unknown, workspace?: unknown }} args
 * @param {{ includeArchived?: boolean }} [options]
 */
export async function resolveScopedChatOrError(client, session, args, options = {}) {
  const ref = String(args?.chat || '').trim();
  if (!ref) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat is required.');
  }
  const includeArchived = options.includeArchived !== false;
  const chats = await client.listChats({ includeArchived });
  const scoped = listChatsForMcpScope(chats, session, args);
  const scopedHit = findChatByRef(scoped, ref);
  if (scopedHit.chat) return { chat: scopedHit.chat };
  const globalHit = findChatByRef(chats, ref);
  if (globalHit.chat) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.OUT_OF_SCOPE,
      `Chat "${ref}" is outside the current workspace. Pass scope=all to read another workspace.`,
    );
  }
  const matches = scopedHit.matches || [];
  if (matches.length === 0) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `No chat found for "${ref}".`);
  }
  const list = matches.slice(0, 10).map((chat) => `- ${chat.id.slice(0, 8)} ${chat.title || '(untitled)'}`);
  throw new CretliMcpToolError(
    MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
    `Ambiguous reference "${ref}" — ${matches.length} candidates:\n${list.join('\n')}`,
  );
}
