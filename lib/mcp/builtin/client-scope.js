/**
 * Client-side scope helpers for builtin MCP tools.
 */

import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/**
 * @param {object} client
 * @param {string} name
 */
export function requireClientMethod(client, name) {
  if (typeof client[name] !== 'function') {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `${name} is unavailable in this client.`);
  }
}

/**
 * @param {object} client
 * @param {{ chatId: string, workspaceFolder: string, workspaceFile?: string }} input
 */
export async function requireClientChat(client, input) {
  requireClientMethod(client, 'getChat');
  const chatId = String(input.chatId || '').trim();
  if (!chatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
  }
  const chat = await client.getChat({
    chatId,
    workspaceFolder: input.workspaceFolder,
    workspaceFile: input.workspaceFile,
  });
  if (!chat) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Chat not found: ${chatId}`);
  }
  return chat;
}
