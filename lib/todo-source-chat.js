/**
 * Resolve which chat/harness created or last synced a Todo.
 */

import { normalizeAgentTransport } from './agent-transport.js';
import { readChatPlanFile, stripChatPlanComment } from './chat-plan-persist.js';
import { buildChangelogExcerpt } from './todo-changelog-text.js';
import { isChatInWorkspace } from './mcp/builtin/tool-context.js';

/**
 * @typedef {{ byId: Map<string, object>, byTodoId: Map<string, object[]> }} TodoChatIndex
 */

/**
 * Build a per-request chat lookup (id -> chat, todoId -> chats) optionally
 * limited to one workspace. Building it once keeps every todo in a list call
 * from re-scanning the global chat store.
 *
 * @param {Array<object>} [chats]
 * @param {{ workspaceFolder?: string, workspaceFile?: string }} [scope]
 * @returns {TodoChatIndex}
 */
export function buildTodoChatIndex(chats = [], scope = {}) {
  const byId = new Map();
  const byTodoId = new Map();
  const workspaceFolder = String(scope?.workspaceFolder || '').trim();
  const workspaceFile = String(scope?.workspaceFile || '').trim();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (!chat || typeof chat !== 'object') continue;
    const id = String(chat.id || '').trim();
    if (!id) continue;
    if ((workspaceFolder || workspaceFile) && !isChatInWorkspace(chat, workspaceFolder, workspaceFile)) continue;
    byId.set(id, chat);
    const todoId = String(chat.todoId || '').trim();
    if (!todoId) continue;
    const bucket = byTodoId.get(todoId);
    if (bucket) bucket.push(chat);
    else byTodoId.set(todoId, [chat]);
  }
  return { byId, byTodoId };
}

/**
 * @param {unknown} value
 * @returns {TodoChatIndex}
 */
function asTodoChatIndex(value) {
  if (value && value.byId instanceof Map && value.byTodoId instanceof Map) return value;
  return buildTodoChatIndex(Array.isArray(value) ? value : []);
}

/**
 * @param {unknown} item
 * @returns {string}
 */
export function resolveTodoSourceChatId(item) {
  if (!item || typeof item !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (item);
  const direct = String(row.chatId || '').trim();
  if (direct) return direct;
  const plan = row.plan && typeof row.plan === 'object'
    ? /** @type {Record<string, unknown>} */ (row.plan)
    : null;
  const fromPlan = String(plan?.sourceChatId || '').trim();
  if (fromPlan) return fromPlan;
  const linked = Array.isArray(row.linkedChatIds) ? row.linkedChatIds : [];
  const firstLinked = typeof linked[0] === 'string' ? linked[0].trim() : '';
  return firstLinked;
}

/**
 * @param {unknown} item
 * @param {TodoChatIndex | Array<{ id?: string, title?: string, agentTransport?: string }>} chatsOrIndex
 * @returns {{ id: string, title: string, agentTransport: string } | null}
 */
export function resolveTodoSourceChat(item, chatsOrIndex = []) {
  const chatId = resolveTodoSourceChatId(item);
  if (!chatId) return null;
  const chat = asTodoChatIndex(chatsOrIndex).byId.get(chatId) || null;
  const storedHarness = item && typeof item === 'object'
    ? String(/** @type {Record<string, unknown>} */ (item).sourceHarness || '').trim()
    : '';
  return {
    id: chatId,
    title: String(chat?.title || '').trim(),
    agentTransport: normalizeAgentTransport(chat?.agentTransport || storedHarness),
  };
}

/**
 * Every chat that created, planned, executed, orchestrated, delegated, or was
 * linked to a todo. One entry per chat with all of its roles.
 *
 * @param {unknown} item
 * @param {TodoChatIndex | Array<object>} chatsOrIndex
 * @returns {Array<{ id: string, title: string, harness: string, roles: string[], lastAt: string, deleted: boolean }>}
 */
export function resolveTodoChats(item, chatsOrIndex = []) {
  if (!item || typeof item !== 'object') return [];
  const row = /** @type {Record<string, any>} */ (item);
  const index = asTodoChatIndex(chatsOrIndex);
  /** @type {Map<string, { roles: Set<string>, chat: object | null }>} */
  const found = new Map();
  const add = (chatId, role) => {
    const id = String(chatId || '').trim();
    if (!id) return;
    let entry = found.get(id);
    if (!entry) {
      entry = { roles: new Set(), chat: index.byId.get(id) || null };
      found.set(id, entry);
    }
    entry.roles.add(role);
  };
  add(row.createdByChatId, 'creator');
  const plan = row.plan && typeof row.plan === 'object' ? row.plan : {};
  add(plan.sourceChatId, 'planner');
  add(row.chatId, 'executor');
  add(row.orchestratorChatId, 'orchestrator');
  for (const chatId of Array.isArray(row.linkedChatIds) ? row.linkedChatIds : []) {
    add(chatId, 'linked');
  }
  /** @type {Map<string, string>} */
  const lastChangelogAt = new Map();
  for (const entry of Array.isArray(row.changelog) ? row.changelog : []) {
    const id = String(entry?.chatId || '').trim();
    if (!id) continue;
    const at = String(entry?.at || '').trim();
    if (at > (lastChangelogAt.get(id) || '')) lastChangelogAt.set(id, at);
  }
  for (const id of lastChangelogAt.keys()) add(id, 'linked');
  const todoId = String(row.id || '').trim();
  if (todoId) {
    for (const chat of index.byTodoId.get(todoId) || []) {
      add(chat.id, 'linked');
      if (String(chat.delegationId || '').trim()) add(chat.id, 'delegate');
    }
  }
  const entries = [...found.entries()].map(([id, entry]) => {
    const chatUpdatedAt = entry.chat ? String(entry.chat.updatedAt || entry.chat.createdAt || '').trim() : '';
    const changelogAt = lastChangelogAt.get(id) || '';
    const lastAt = chatUpdatedAt > changelogAt ? chatUpdatedAt : changelogAt;
    return {
      id,
      title: entry.chat ? String(entry.chat.title || '').trim() : '',
      harness: entry.chat ? normalizeAgentTransport(entry.chat.agentTransport || entry.chat.harness || '') : '',
      roles: [...entry.roles],
      lastAt,
      deleted: !entry.chat,
    };
  });
  entries.sort((left, right) => {
    if (left.lastAt !== right.lastAt) return left.lastAt > right.lastAt ? -1 : 1;
    return left.id < right.id ? -1 : (left.id > right.id ? 1 : 0);
  });
  return entries;
}

/**
 * @param {unknown} item
 * @returns {unknown}
 */
function sanitizeTodoChangelog(item) {
  if (!item || typeof item !== 'object') return item;
  const row = /** @type {Record<string, unknown>} */ (item);
  if (!Array.isArray(row.changelog)) return item;
  const changelog = row.changelog
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const rec = /** @type {Record<string, unknown>} */ (entry);
      const text = buildChangelogExcerpt(rec.text);
      if (!text) return null;
      return { ...rec, text };
    })
    .filter(Boolean);
  return { ...row, changelog };
}

/**
 * Prefer the workspace plan file when it has more Markdown than the stored excerpt.
 *
 * @param {unknown} item
 * @param {string} cwd
 * @returns {unknown}
 */
export function hydrateTodoPlanMarkdown(item, cwd = '') {
  if (!item || typeof item !== 'object') return item;
  const row = /** @type {Record<string, unknown>} */ (item);
  const chatId = resolveTodoSourceChatId(row);
  const storedPlan = row.plan && typeof row.plan === 'object'
    ? /** @type {Record<string, unknown>} */ (row.plan)
    : {};
  const storedMarkdown = stripChatPlanComment(storedPlan.markdown);
  const fileMarkdown = chatId && cwd
    ? stripChatPlanComment(readChatPlanFile({ cwd, chatId }))
    : '';
  const markdown = fileMarkdown.length >= storedMarkdown.length ? fileMarkdown : storedMarkdown;
  if (!markdown) return item;
  return {
    ...row,
    plan: { ...storedPlan, markdown },
  };
}

/**
 * @param {unknown[]} items
 * @param {TodoChatIndex | Array<{ id?: string, title?: string, agentTransport?: string }>} chatsOrIndex
 * @param {string} [cwd]
 * @returns {unknown[]}
 */
export function enrichTodoItemsWithSourceChat(items, chatsOrIndex = [], cwd = '') {
  if (!Array.isArray(items)) return [];
  const index = asTodoChatIndex(chatsOrIndex);
  return items.map((item) => {
    const hydrated = hydrateTodoPlanMarkdown(item, cwd);
    const sanitized = sanitizeTodoChangelog(hydrated);
    const sourceChat = resolveTodoSourceChat(sanitized, index);
    const chats = resolveTodoChats(sanitized, index);
    const enriched = { ...sanitized, chats };
    if (!sourceChat) return enriched;
    return { ...enriched, sourceChat };
  });
}
