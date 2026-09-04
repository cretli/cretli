/**
 * Resolve which chat/harness created or last synced a Todo.
 */

import { normalizeAgentTransport } from './agent-transport.js';
import { readChatPlanFile, stripChatPlanComment } from './chat-plan-persist.js';
import { buildChangelogExcerpt } from './todo-changelog-text.js';

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
 * @param {Array<{ id?: string, title?: string, agentTransport?: string }>} chats
 * @returns {{ id: string, title: string, agentTransport: string } | null}
 */
export function resolveTodoSourceChat(item, chats = []) {
  const chatId = resolveTodoSourceChatId(item);
  if (!chatId) return null;
  const chat = Array.isArray(chats) ? chats.find((entry) => entry?.id === chatId) : null;
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
 * @param {Array<{ id?: string, title?: string, agentTransport?: string }>} chats
 * @param {string} [cwd]
 * @returns {unknown[]}
 */
export function enrichTodoItemsWithSourceChat(items, chats = [], cwd = '') {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const hydrated = hydrateTodoPlanMarkdown(item, cwd);
    const sanitized = sanitizeTodoChangelog(hydrated);
    const sourceChat = resolveTodoSourceChat(sanitized, chats);
    if (!sourceChat) return sanitized;
    return { ...sanitized, sourceChat };
  });
}
