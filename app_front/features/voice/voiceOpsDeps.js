/**
 * Real dependencies of the `ops` voice tool (Git panel API, task runs, quick-command bar).
 *
 * Kept apart from `voiceOpsTools.js` so the handlers stay free of DOM and network in unit tests;
 * `commandHandlers.js` imports this module lazily.
 */

import { deleteTaskRun, getGitCommitPlan, getGitInfo, getTaskRuns, postGitCommit } from '../../core/api/index.js';
import { buildGitScopeKey, getGitScope } from '../git/gitScope.js';
import { getTodoWorkspaceFolder } from '../todo/todoWorkspaceScope.js';
import { getQuickCommands, runQuickCommandText } from '../terminal/components/quickCommands.js';
import { appendVoiceSessionEvent } from './voiceSessionLog.js';

/**
 * The scope the Git panel looks at, falling back to the header workspace folder.
 *
 * @returns {{ chatId: string, todoId: string, workspaceFolder: string }}
 */
function currentGitScope() {
  const scope = getGitScope();
  if (scope.chatId || scope.todoId || scope.workspaceFolder) return scope;
  return { chatId: '', todoId: '', workspaceFolder: getTodoWorkspaceFolder() };
}

/**
 * Where the quick-command bar would deliver a command right now (mirrors the handler in `bootApp.js`):
 * the terminal and tasks panels receive the text with Enter, the chat panel only its send field.
 *
 * @param {Document|null} doc
 * @returns {'keys'|'draft'|'none'}
 */
export function quickCommandTarget(doc) {
  const active = (id) => Boolean(doc?.getElementById(id)?.classList.contains('active'));
  if (active('terminal-panel') || active('tasks-panel')) return 'keys';
  return active('chat-panel') ? 'draft' : 'none';
}

/**
 * @returns {import('./voiceOpsTools.js').OpsToolDeps}
 */
export function buildOpsDeps() {
  return {
    async getContext() {
      const scope = currentGitScope();
      const { getActiveChatIdValue } = await import('../chat/index.js');
      return { workspaceFolder: scope.workspaceFolder, chatId: String(getActiveChatIdValue() || ''), scopeKey: buildGitScopeKey(scope) };
    },
    getGitInfo: () => getGitInfo(currentGitScope()),
    getCommitPlan: () => getGitCommitPlan(currentGitScope()),
    async commitAll(message, fingerprint) {
      const result = await postGitCommit(message, fingerprint, currentGitScope());
      appendVoiceSessionEvent('tool.git_commit', { ok: result?.ok === true, code: result?.code || '' });
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cretli-git-changed', { detail: result }));
      return result?.ok === true
        ? { ok: true, head: result.head }
        : { ok: false, code: result?.code, error: result?.error || 'Could not commit' };
    },
    async listTaskRuns() {
      const data = await getTaskRuns().catch(() => null);
      return data?.ok && Array.isArray(data.runs) ? data.runs : [];
    },
    async stopTaskRun(runId) {
      const result = await deleteTaskRun(runId);
      appendVoiceSessionEvent('tool.task_stop', { runId, ok: result?.ok !== false });
      return result?.ok === false ? { ok: false, error: result.error } : { ok: true };
    },
    listQuickCommands: () => getQuickCommands(),
    getQuickTarget: () => quickCommandTarget(typeof document !== 'undefined' ? document : null),
    async isDraftFieldEmpty() {
      const { getActiveSendInput } = await import('../chat/index.js');
      return !String(getActiveSendInput()?.value || '').trim();
    },
    runQuickCommand: (text) => (runQuickCommandText(text) ? { ok: true } : { ok: false, error: 'No panel can receive the command' }),
  };
}
