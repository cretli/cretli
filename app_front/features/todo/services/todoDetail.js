import * as api from '../../../core/api/index.js';
import { mergeCachedDetail } from '../todoDetailCache.js';
import { getChatsList, getTerminalStateMetaPublic } from '../../chat/index.js';
import { resolveTodoStatusIcon } from '../todoStatusIcon.js';
import { hasApprovedAncestorPlan } from '../state/todoStage.js';
import { getTodoWorkspaceFolder, todoWorkspaceMatches } from '../todoWorkspaceScope.js';
import { S, detailCache, detailInFlight } from '../state/todoPanelState.js';
import { closeEditor, openEditor } from '../views/todoEditor.js';
import { renderList } from '../views/todoListRender.js';
import { openLatestTodoChat } from '../views/todoRowMenu.js';

/**
 * @param {string} id
 * @returns {object | null}
 */
/** Feeds the editor card with the origin todo and the follow-ups created from this one. */
export function applyEditorRelatedTodos(item) {
  const sourceId = String(item?.sourceTodoId || '');
  const source = sourceId ? S.latestItems.find((row) => String(row?.id || '') === sourceId) : null;
  S.editorCard.sourceTodo = sourceId ? { id: sourceId, title: source?.title || '' } : null;
  S.editorCard.followUps = S.latestItems
    .filter((row) => String(row?.sourceTodoId || '') === String(item.id))
    .map((row) => ({ id: row.id, title: row.title }));
}

/**
 * @param {Record<string, any>} item
 * @returns {Record<string, any>}
 */
export function applyCachedDetail(item) {
  return mergeCachedDetail(item, detailCache.get(String(item?.id || '')));
}

/**
 * Remember the heavy fields of a full (non-lean) item, e.g. a PATCH response.
 *
 * @param {Record<string, any>} item
 */
export function rememberDetail(item) {
  if (!item?.id || item.listSlim === true) return;
  detailCache.set(String(item.id), {
    updatedAt: String(item.updatedAt || ''),
    body: item.body,
    plan: item.plan,
    changelog: item.changelog,
    review: item.review,
    execution: item.execution,
    integrationSummary: item.integrationSummary,
    worktree: item.worktree,
    integration: item.integration,
    leafMaterial: item.leafMaterial,
    chats: Array.isArray(item.chats) ? item.chats : undefined,
    chatTitles: new Map((Array.isArray(item.chats) ? item.chats : []).map((chat) => [String(chat?.id || ''), String(chat?.title || '')])),
  });
}

/**
 * Fetch the complete todo and fold it into the in-memory list.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true when the item now carries full detail
 */
export function loadTodoDetail(id) {
  const todoId = String(id || '');
  const pending = detailInFlight.get(todoId);
  if (pending) return pending;
  const folder = getTodoWorkspaceFolder();
  const promise = api.getTodo(todoId, folder).then((data) => {
    if (!data?.ok || !data.item || !todoWorkspaceMatches(folder)) return false;
    rememberDetail(data.item);
    const index = S.latestItems.findIndex((row) => String(row?.id || '') === todoId);
    if (index >= 0 && S.latestItems[index].listSlim === true) {
      // The fetched detail is newer than the lean row, so adopt it as is; going
      // through applyCachedDetail would reject it when chats moved since the list.
      S.latestItems[index] = data.item;
    }
    return findItem(todoId)?.listSlim !== true;
  }).catch(() => false).finally(() => {
    detailInFlight.delete(todoId);
  });
  detailInFlight.set(todoId, promise);
  return promise;
}

/**
 * Item with complete detail, loading it when the list row is lean.
 *
 * @param {string} id
 * @returns {Promise<Record<string, any> | null>}
 */
export async function findItemWithDetail(id) {
  const item = findItem(id);
  if (!item || item.listSlim !== true) return item || null;
  await loadTodoDetail(id);
  return findItem(id);
}

/**
 * @param {string} id
 * @returns {Record<string, any> | undefined}
 */
export function findItem(id) {
  if (!todoWorkspaceMatches(S.latestWorkspaceFolder)) return null;
  return S.latestItems.find((item) => String(item?.id || '') === id) || null;
}

/**
 * @param {object | null} item
 * @returns {{ id: string, title: string, status: string } | null}
 */
export function summarizeTodo(item) {
  if (!item?.id) return null;
  return {
    id: String(item.id),
    title: String(item.title || ''),
    status: String(item.status || ''),
  };
}

/**
 * Load one todo into the in-memory list when the panel has not fetched it yet.
 *
 * @param {string} id
 * @returns {Promise<object | null>}
 */
export async function ensureTodoLoaded(id) {
  const todoId = String(id || '').trim();
  if (!todoId) return null;
  const cached = findItem(todoId);
  if (cached) return cached;
  const folder = getTodoWorkspaceFolder();
  const data = await api.getTodos(folder, { slim: true });
  if (!todoWorkspaceMatches(folder) || !data?.ok || !Array.isArray(data.items)) return null;
  if (data.cwd && folder && !todoWorkspaceMatches(data.requestedFolder || data.cwd, folder)) return null;
  S.latestWorkspaceFolder = folder;
  S.latestItems = data.items.map(applyCachedDetail);
  if (S.listEl) renderList(data);
  return findItem(todoId);
}

/**
 * Open the Todo panel on one task.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function openTodo(id) {
  const item = await ensureTodoLoaded(id);
  if (!item) return false;
  S.showPanelFn('todo');
  openEditor(String(item.id));
  return true;
}

/**
 * Open the newest chat for a todo, or start an agent when none exists.
 *
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function continueTodo(id) {
  const item = await ensureTodoLoaded(id);
  if (!item) return false;
  openLatestTodoChat(item);
  return true;
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, title: string, status: string } | null>}
 */
export async function loadTodoSummary(id) {
  const item = await ensureTodoLoaded(id);
  return summarizeTodo(item);
}

export function syncEditorItem() {
  if (!S.editorCard || !S.editorTodoId) return;
  const item = findItem(S.editorTodoId);
  if (!item) {
    closeEditor();
    return;
  }
  if (item.listSlim === true) {
    // A refresh replaced the full item with a lean row; keep the card on its
    // current item until the detail for the new revision arrives.
    void loadTodoDetail(S.editorTodoId).then((ok) => { if (ok) syncEditorItem(); });
    return;
  }
  S.editorCard.item = item;
  S.editorCard.statusIcon = resolveTodoStatusIcon(item, S.latestItems, getChatsList(), getTerminalStateMetaPublic);
  S.editorCard.planInherited = hasApprovedAncestorPlan(S.latestItems, item);
  S.editorCard.hasChildren = S.latestItems.some((row) => row.parentId === item.id);
  applyEditorRelatedTodos(item);
}
