/**
 * Execution folder resolution.
 *
 * `workspaceFolder` stays the logical project identity (TODO, claims, memory,
 * watcher, scope). `executionFolder` is the directory a runner, write lock,
 * material revision and test verification actually operate on. When a chat or
 * delegation has no explicit execution folder the logical workspace is used, so
 * every existing chat keeps its previous cwd.
 */

import path from 'node:path';
import { resolveSdkCwdForChat } from './workspace.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeExecutionFolder(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

/**
 * Explicit execution folder stored on a chat record, or '' when none is set.
 *
 * @param {object | null | undefined} chat
 * @returns {string}
 */
export function readChatExecutionFolder(chat) {
  return normalizeExecutionFolder(chat?.executionFolder);
}

/**
 * Runner cwd for a chat: its explicit execution folder, else the logical
 * workspace derived from the chat (workspace folder or workspace file).
 *
 * @param {object | null | undefined} chat
 * @param {(workspacePath: string | null) => string} [workspaceDirForAgent]
 * @returns {string}
 */
export function resolveExecutionFolderForChat(chat, workspaceDirForAgent) {
  const explicit = readChatExecutionFolder(chat);
  if (explicit) return explicit;
  if (typeof workspaceDirForAgent === 'function') {
    return resolveSdkCwdForChat(chat, workspaceDirForAgent) || '';
  }
  return normalizeExecutionFolder(chat?.workspaceFolder);
}

/**
 * Frozen execution folder of a delegation record, else its logical workspace.
 *
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function resolveExecutionFolderForRecord(row) {
  const explicit = normalizeExecutionFolder(row?.executionFolder);
  if (explicit) return explicit;
  return normalizeExecutionFolder(row?.workspaceFolder);
}
