/**
 * Client-side scope helpers for builtin MCP tools.
 */

import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES, NO_CALLING_CHAT_HINT } from './errors.js';

/**
 * @param {Record<string, any>} client
 * @param {string} name
 */
export function requireClientMethod(client, name) {
  if (typeof client[name] !== 'function') {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `${name} is unavailable in this client.`);
  }
}

/**
 * @param {Record<string, any>} client
 * @param {{ chatId: string, workspaceFolder: string, workspaceFile?: string }} input
 */
export async function requireClientChat(client, input) {
  requireClientMethod(client, 'getChat');
  const chatId = String(input.chatId || '').trim();
  if (!chatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `chat_id is required. ${NO_CALLING_CHAT_HINT}`);
  }
  const chat = await client.getChat({
    chatId,
    workspaceFolder: input.workspaceFolder,
    workspaceFile: input.workspaceFile,
    .../** @type {any} */ ({ skipWorkspace: /** @type {any} */ (input).skipWorkspace === true }),
  });
  if (!chat) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Chat not found: ${chatId}`);
  }
  return chat;
}
