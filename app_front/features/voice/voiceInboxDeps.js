/**
 * Real dependencies of the `inbox` voice tool (notification store, Scout proposal routes).
 *
 * Kept apart from `voiceInboxTools.js` so the handlers stay free of DOM and network in unit tests;
 * `commandHandlers.js` imports this module lazily.
 */

import { appendVoiceSessionEvent } from './voiceSessionLog.js';

const SCOUT_LIST_PATH = '/api/workspace-watcher/scout?status=pending&max=8';

/** @returns {Promise<any>} the notification store, or null before it is created */
async function notificationStore() {
  return (await import('../notifications/notificationStore.js')).getNotificationStore() || null;
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function scoutApi(path, options) {
  const { watcherApi } = await import('../settings/watcher/api.js');
  return watcherApi(path, options);
}

/**
 * @returns {import('./voiceInboxTools.js').InboxToolDeps}
 */
export function buildInboxDeps() {
  return {
    async getContext() {
      const scope = await import('../watcher/watcherWorkspaceScope.js');
      const { getActiveChatIdValue } = await import('../chat/index.js');
      return { workspaceFolder: scope.normalizeWatcherWorkspaceFolder(scope.getWatcherWorkspaceFolder()), chatId: String(getActiveChatIdValue() || '') };
    },
    async getNotificationState() {
      return (await notificationStore())?.getState() || null;
    },
    async markNotificationRead(id) {
      const store = await notificationStore();
      return store ? store.markRead(id) : { ok: false, error: 'Notifications are not loaded yet' };
    },
    async markAllNotificationsRead() {
      const store = await notificationStore();
      return store ? store.markAllRead() : { ok: false, error: 'Notifications are not loaded yet' };
    },
    async dismissNotification(id) {
      const store = await notificationStore();
      return store ? store.dismiss(id) : { ok: false, error: 'Notifications are not loaded yet' };
    },
    async listScoutProposals() {
      const res = await scoutApi(SCOUT_LIST_PATH);
      return res.status < 400 && res.json?.ok !== false ? res.json : null;
    },
    async decideScoutProposal(decision, id) {
      const res = await scoutApi('/api/workspace-watcher/scout', { method: 'POST', body: { action: decision, ids: [id] } });
      const ok = res.json?.ok === true;
      appendVoiceSessionEvent('tool.scout_decision', { decision, proposalId: id, ok });
      return ok ? { ok: true } : { ok: false, error: res.json?.error || 'Could not record the decision' };
    },
  };
}
