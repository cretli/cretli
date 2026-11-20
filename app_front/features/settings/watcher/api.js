/**
 * Workspace-scoped HTTP access and small lookups for the Watcher settings.
 */

import { ws } from './store.js';
import { getCurrentLang } from '../../../i18n/index.js';
import { cretliApiFetch } from '../../../lib/cretliApiRequest.js';
import { getWorkspaceWatcherView, isWorkspaceWatcherRead } from '../../watcher/watcherGetCoalesce.js';
import { getWatcherWorkspaceFolder, scopeWatcherRequestToWorkspace } from '../../watcher/watcherWorkspaceScope.js';

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
export async function watcherApi(path, options = {}) {
  // Every watcher call is workspace-scoped: without an explicit folder the
  // server answers for its own "current cwd", which can be a different
  // workspace than the one the operator opened Settings for.
  const scoped = scopeWatcherRequestToWorkspace(path, options, getWatcherWorkspaceFolder());
  if (isWorkspaceWatcherRead(scoped.path, scoped.options)) return getWorkspaceWatcherView(scoped.path);
  const headers = {
    Accept: 'application/json',
    'Accept-Language': getCurrentLang(),
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
  };
  if (scoped.options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers,
    credentials: 'include',
    body: scoped.options.body !== undefined ? JSON.stringify(scoped.options.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * @param {string} id
 * @returns {string}
 */
export function getTodoTitle(id) {
  return ws.todoTitles.get(String(id || '').trim()) || '';
}

/**
 * Open a chat from a dashboard link. The settings chunk does not statically own
 * the chat module, so it is imported lazily on click; a failure to load or a
 * chat that no longer exists is swallowed (the link is a convenience).
 *
 * @param {string} chatId
 */
export async function openWatcherChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  try {
    const mod = await import('../../chat/index.js');
    if (typeof mod.selectChat === 'function') mod.selectChat(id, { byUser: true });
  } catch {
    // Chat module unavailable — leave the settings panel as-is.
  }
}
