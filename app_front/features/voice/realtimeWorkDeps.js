/**
 * Real dependencies of the `work` voice tool (todos, Watcher, delegations). Split from `realtimeTools.js` to keep
 * that file inside the front-size ratchet.
 */

import { getTodos, getWorkspaceDelegations, postDelegationCancel } from '../../core/api/index.js';
import { getTodoWorkspaceFolder } from '../todo/todoWorkspaceScope.js';
import { resolveTodoStartHarness } from '../todo/todoTreeView.js';
import { appendVoiceSessionEvent } from './voiceSessionLog.js';

/**
 * Scoped JSON call to the Workspace Watcher API (same scoping as the Todo bar).
 *
 * @param {string} path
 * @param {{ method?: string }} [options]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function watcherRequest(path, options = {}) {
  const scope = await import('../watcher/watcherWorkspaceScope.js');
  const { cretliApiFetch } = await import('../../lib/cretliApiRequest.js');
  const scoped = scope.scopeWatcherRequestToWorkspace(path, options, scope.getWatcherWorkspaceFolder());
  const res = await cretliApiFetch(scoped.path, {
    method: scoped.options.method || 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/**
 * Todo / Watcher / delegation tools. Harness and model for a started todo come
 * from the todo's assignee and the new-chat harness select, never from a
 * catalog listing.
 */
export function buildWorkToolDeps({ findActiveChat, loadChatModule }) {
  return {
    async getContext() {
      const chat = findActiveChat(await loadChatModule());
      const trigger = typeof document !== 'undefined' ? document.getElementById('header-workspace-trigger') : null;
      // Capture both halves of the workspace pair at step one: the confirmation
      // is bound to this file/folder pair, not to the header at confirm time.
      return {
        workspaceFile: trigger?.dataset?.workspaceFile || '',
        workspaceFolder: getTodoWorkspaceFolder(),
        chatId: chat?.id || '',
      };
    },
    async listTodos() {
      const data = await getTodos(getTodoWorkspaceFolder());
      return Array.isArray(data?.items) ? data.items : [];
    },
    async startTodo({ todo, context }) {
      // Both values come from the context bound at step one (getContext), never
      // from the header trigger, so the server-validated pair always matches.
      const workspaceFile = context?.workspaceFile || '';
      const workspaceFolder = context?.workspaceFolder || '';
      if (!workspaceFile || !workspaceFolder) return { ok: false, error: 'No workspace is selected' };
      const select = typeof document !== 'undefined' ? document.getElementById('chat-new-harness-select') : null;
      const agentTransport = resolveTodoStartHarness(todo, String(select?.value || 'sdk').trim() || 'sdk');
      const panel = await import('../todo/index.js');
      const outcome = await panel.startTodoAgentForVoice(todo.id, { workspaceFile, workspaceFolder, agentTransport });
      appendVoiceSessionEvent('tool.todo_start', { todoId: todo.id, ok: outcome?.ok === true });
      if (!outcome?.ok) return { ok: false, error: outcome?.error || 'Could not start the todo' };
      return { ok: true, state: 'started' };
    },
    async getWatcherView() {
      const res = await watcherRequest('/api/workspace-watcher');
      return res.json?.ok ? res.json : null;
    },
    async setWatcherPaused(paused) {
      const res = await watcherRequest(`/api/workspace-watcher/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
      if (res.status >= 400 || res.json?.ok === false) {
        return { ok: false, error: res.json?.error || 'Could not change the watcher' };
      }
      import('../watcher/watcherPanel.js').then((panel) => panel.refreshWatcherPanel()).catch(() => {});
      return { ok: true };
    },
    async listDelegations() {
      const data = await getWorkspaceDelegations({ workspaceFolder: getTodoWorkspaceFolder(), limit: 30 });
      return Array.isArray(data?.delegations) ? data.delegations : [];
    },
    async cancelDelegation(id) {
      const data = await postDelegationCancel(id);
      appendVoiceSessionEvent('tool.delegation_cancel', { delegationId: id, ok: data?.ok !== false });
      return data?.ok === false ? { ok: false, error: data.error } : { ok: true };
    },
  };
}
