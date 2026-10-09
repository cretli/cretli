/**
 * Pure view helpers for the Git panel context indicator.
 *
 * Kept free of DOM and API access so the routing/formatting contract can be
 * unit tested without a browser or a running server.
 */

import { buildGitScopeKey, normalizeGitScope } from './gitScope.js';

/**
 * @param {string} id
 * @returns {string}
 */
export function shortGitId(id) {
  const raw = String(id ?? '').trim();
  return raw ? raw.slice(0, 8) : '';
}

/**
 * Scope for a chat: its explicit execution folder is resolved server-side, so
 * the client only sends the chat id (and the workspace as a fallback).
 *
 * @param {object | null | undefined} chat
 * @param {string} [fallbackWorkspaceFolder]
 * @returns {{ chatId: string, todoId: string, workspaceFolder: string }}
 */
export function resolveChatGitScope(chat, fallbackWorkspaceFolder = '') {
  return normalizeGitScope({
    chatId: chat?.id || '',
    todoId: chat?.todoId || '',
    workspaceFolder: chat?.workspaceFolder || fallbackWorkspaceFolder || '',
  });
}

/**
 * Scope for a TODO card.
 *
 * @param {object | null | undefined} todo
 * @param {string} [workspaceFolder]
 * @returns {{ chatId: string, todoId: string, workspaceFolder: string }}
 */
export function resolveTodoGitScope(todo, workspaceFolder = '') {
  return normalizeGitScope({
    todoId: todo?.id || '',
    workspaceFolder: workspaceFolder || todo?.workspaceFolder || '',
  });
}

/**
 * @param {object | null | undefined} info
 * @returns {'worktree' | 'todo' | 'chat' | 'workspace' | 'global'}
 */
export function deriveGitContextKind(info) {
  if (!info) return 'global';
  if (info.isWorktree === true || String(info.source || '') === 'worktree') return 'worktree';
  if (info.todoId) return 'todo';
  if (info.chatId) return 'chat';
  if (info.workspaceFolder) return 'workspace';
  return 'global';
}

/**
 * True when there is a chat/TODO context worth a compact indicator. The plain
 * global workspace gets no badge (there is nothing task-specific to show).
 *
 * @param {object | null | undefined} info
 * @returns {boolean}
 */
export function shouldShowGitContextBadge(info) {
  const kind = deriveGitContextKind(info);
  return kind === 'worktree' || kind === 'todo' || kind === 'chat';
}

/**
 * @param {object | null | undefined} info
 * @returns {string}
 */
export function resolveGitBranch(info) {
  return String(info?.worktree?.branch || info?.branch || '').trim();
}

/**
 * Label for the compact indicator. `t` is injected so tests can assert keys
 * without loading the i18n bundle.
 *
 * @param {object | null | undefined} info
 * @param {(key: string, vars?: object) => string} t
 * @returns {{ kind: string, tone: string, label: string, title: string, branch: string }}
 */
export function deriveGitContextBadge(info, t) {
  const translate = typeof t === 'function' ? t : (key) => key;
  const kind = deriveGitContextKind(info);
  const branch = resolveGitBranch(info);
  const tone = kind === 'worktree' ? 'worktree' : kind === 'todo' ? 'todo' : 'chat';
  const label = kind === 'worktree'
    ? translate('git.contextWorktree')
    : kind === 'todo'
      ? translate('git.contextTodo')
      : translate('git.contextChat');
  const title = branch
    ? translate('git.contextBadgeTitle', { context: label, branch })
    : translate('git.contextBadgeNoBranch', { context: label });
  return { kind, tone, label, branch, title };
}

/**
 * Detail rows for the panel: context, project, branch, base, changes, task and
 * integration state. Empty values are dropped by the renderer.
 *
 * @param {object | null | undefined} info
 * @param {(key: string, vars?: object) => string} t
 * @returns {Array<{ key: string, label: string, value: string, tone?: string }>}
 */
export function buildGitDetailRows(info, t) {
  const translate = typeof t === 'function' ? t : (key) => key;
  if (!info) return [];
  const kind = deriveGitContextKind(info);
  /** @type {Array<{ key: string, label: string, value: string, tone?: string }>} */
  const rows = [];
  const contextLabel = kind === 'worktree'
    ? translate('git.contextWorktree')
    : kind === 'todo'
      ? translate('git.contextTodo')
      : kind === 'chat'
        ? translate('git.contextChat')
        : translate('git.contextGlobal');
  rows.push({ key: 'context', label: translate('git.contextLabel'), value: contextLabel });
  if (info.workspaceFolder && (kind === 'worktree' || kind === 'todo' || kind === 'chat')) {
    rows.push({ key: 'workspace', label: translate('git.mainProject'), value: String(info.workspaceFolder) });
  }
  if (kind === 'worktree') {
    if (info.worktree?.worktreePath) {
      rows.push({ key: 'worktree', label: translate('git.worktreePath'), value: String(info.worktree.worktreePath) });
    }
    if (info.worktree?.baseCommit) {
      rows.push({
        key: 'base',
        label: translate('git.baseCommit'),
        value: shortGitId(info.worktree.baseCommit),
        tone: 'muted',
      });
    }
  }
  if (info.branch) {
    const ahead = info.aheadBehind ? ` (${info.aheadBehind})` : '';
    rows.push({ key: 'branch', label: translate('git.branchLabel'), value: `${info.branch}${ahead}` });
  }
  const changedCount = Array.isArray(info.statusShort) ? info.statusShort.length : 0;
  rows.push({
    key: 'changes',
    label: translate('git.changes'),
    value: String(changedCount),
    tone: changedCount > 0 ? 'warn' : 'muted',
  });
  if (info.todo?.title || info.todoId) {
    rows.push({
      key: 'todo',
      label: translate('git.relatedTask'),
      value: String(info.todo?.title || shortGitId(info.todoId)),
    });
  }
  const integrationState = info.todo?.integration?.state || info.worktree?.integrationState || '';
  if (integrationState) {
    rows.push({
      key: 'integration',
      label: translate('git.integrationState'),
      value: translate(`git.integration.${integrationState}`),
      tone: integrationState === 'ready' ? 'warn' : integrationState === 'integrated' ? 'ok' : 'muted',
    });
  }
  return rows.filter((row) => String(row.value || '').trim() !== '');
}

/**
 * A response is stale when the scope key captured at request time no longer
 * matches the live scope key.
 *
 * @param {string} requestKey
 * @param {string} currentKey
 * @returns {boolean}
 */
export function isStaleGitResponse(requestKey, currentKey) {
  return requestKey !== currentKey;
}

export { buildGitScopeKey };
