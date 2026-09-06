/**
 * Resolve the workspace of the calling chat. Never use the UI's global CWD.
 * Does not read local chat files — folder comes from the session or stdio env.
 */

import path from 'path';
import { resolveSdkCwdForChat } from '../../workspace.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import { getBuiltinMcpRuntimeDeps } from './runtime-deps.js';

/**
 * @param {object} session
 * @returns {{
 *   chatId: string,
 *   workspaceId: string,
 *   workspaceFolder: string,
 *   workspaceFile: string,
 *   harness: string,
 *   mode: string,
 * }}
 */
export function resolveCretliToolContext(session) {
  const chatId = String(session?.chatId || '').trim();
  const workspaceId = String(session?.workspaceId || '').trim();
  const harness = String(session?.harness || '').trim();
  const mode = String(session?.mode || '').trim();
  const sessionFile = String(session?.workspaceFile || '').trim();
  const sessionFolder = String(session?.workspaceFolder || '').trim();
  const envFolder = String(process.env.CRETLI_MCP_WORKSPACE || '').trim();
  const envFile = String(process.env.CRETLI_MCP_WORKSPACE_FILE || '').trim();
  const folder = sessionFolder || envFolder;
  if (!folder) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.WORKSPACE_REQUIRED,
      'This tool needs the chat workspace folder. Set CRETLI_MCP_WORKSPACE for standalone stdio.',
    );
  }
  return {
    chatId,
    workspaceId,
    workspaceFolder: path.resolve(folder),
    workspaceFile: sessionFile || envFile,
    harness,
    mode,
  };
}

/**
 * @param {object} chat
 * @param {string} workspaceFolder
 * @param {string} [workspaceFile]
 */
export function isChatInWorkspace(chat, workspaceFolder, workspaceFile = '') {
  if (!chat) return false;
  const folder = String(workspaceFolder || '').trim();
  const chatFolder = String(chat.workspaceFolder || '').trim();
  if (folder && chatFolder) return path.resolve(chatFolder) === path.resolve(folder);
  const file = String(workspaceFile || '').trim();
  const chatFile = String(chat.workspaceFile || '').trim();
  if (file && chatFile) return path.resolve(chatFile) === path.resolve(file);
  if (folder && chatFile) {
    const deps = getBuiltinMcpRuntimeDeps();
    const resolved = resolveSdkCwdForChat(chat, (p) => (p && deps.workspaceDirForAgent ? deps.workspaceDirForAgent(p) : ''));
    return resolved ? path.resolve(resolved) === path.resolve(folder) : false;
  }
  return false;
}
