/**
 * `@todo` token in the chat composer. The token is a picker trigger, not message
 * text. The selected todo is sent later as a `cretli-ref todo=<id>` line.
 */
import { formatTodoRef } from '../../../lib/todo-ref.js';
import { flattenTodoTree } from '../todo/todoTreeView.js';

/** Statuses kept when the picker hides finished tasks. Ideas stay, done does not. */
export const TODO_MENTION_OPEN_STATUSES = ['idea', 'ready', 'doing'];

const STATUS_LABEL_KEYS = {
  idea: 'todo.statusIdea',
  ready: 'todo.statusReady',
  doing: 'todo.statusDoing',
  done: 'todo.statusDone',
};

/**
 * @param {string} source
 * @param {unknown} caret
 * @returns {number}
 */
function clampCaret(source, caret) {
  const index = Number(caret);
  if (!Number.isFinite(index) || index < 0) return source.length;
  if (index > source.length) return source.length;
  return index;
}

/**
 * @param {unknown} status
 * @returns {string}
 */
export function todoStatusLabelKey(status) {
  return STATUS_LABEL_KEYS[String(status || '')] || '';
}

/**
 * Mention under the caret on the current line: `@todo` or `@todo query`.
 *
 * @param {unknown} text
 * @param {unknown} caret
 * @returns {{ query: string, start: number, end: number } | null}
 */
export function parseTodoMention(text, caret) {
  const source = String(text ?? '');
  const index = clampCaret(source, caret);
  const lineStart = source.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const before = source.slice(lineStart, index);
  const match = /(?:^|\s)@todo(?=$|\s)(?:\s+(.*))?$/i.exec(before);
  if (!match) return null;
  const at = before.toLowerCase().lastIndexOf('@todo');
  if (at < 0) return null;
  return {
    query: String(match[1] || '').trim(),
    start: lineStart + at,
    end: index,
  };
}

/**
 * Drop the mention token and leave the caret where that token started.
 *
 * @param {unknown} text
 * @param {{ start: number, end: number } | null | undefined} mention
 * @returns {{ text: string, caret: number }}
 */
export function removeTodoMention(text, mention) {
  const source = String(text ?? '');
  if (!mention || !Number.isInteger(mention.start) || !Number.isInteger(mention.end)) {
    return { text: source, caret: source.length };
  }
  const left = source.slice(0, mention.start).replace(/[ \t]+$/, '');
  const right = source.slice(mention.end).replace(/^[ \t]+/, '');
  const needsSpace = left.length > 0 && right.length > 0 && !left.endsWith('\n') && !right.startsWith('\n');
  const next = needsSpace ? `${left} ${right}` : `${left}${right}`;
  return { text: next, caret: left.length + (needsSpace ? 1 : 0) };
}

/**
 * Append the agent pointer once. Empty text becomes just that line.
 *
 * @param {unknown} text
 * @param {unknown} todoId
 * @returns {string}
 */
const INLINE_TODO_REF_RE = /cretli-ref\s+todo=([0-9a-f]{8,}(?:-[0-9a-f]{1,12})*)/ig;

/**
 * Pull todo pointers out of a user message, including a pointer glued to the
 * previous sentence. The agent still receives the original text.
 *
 * @param {unknown} text
 * @returns {{ text: string, todoIds: string[] }}
 */
export function extractTodoRefsFromMessage(text) {
  const source = String(text ?? '');
  /** @type {string[]} */
  const todoIds = [];
  const stripped = source.replace(INLINE_TODO_REF_RE, (_match, id) => {
    const todoId = String(id || '').toLowerCase();
    if (todoId && !todoIds.includes(todoId)) todoIds.push(todoId);
    return '';
  });
  const visible = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return { text: visible, todoIds };
}

export function appendTodoRef(text, todoId) {
  const ref = formatTodoRef(todoId);
  const source = String(text ?? '').trimEnd();
  if (!ref) return source;
  const alreadyPresent = source.split('\n').some((line) => line.trim() === ref);
  if (alreadyPresent) return source;
  if (!source) return ref;
  return `${source}\n${ref}`;
}

/**
 * @param {unknown} items
 * @param {{ query?: string, statuses?: string[] | null }} [options]
 * @returns {object[]}
 */
/**
 * @param {object | null | undefined} item
 * @param {string} query
 * @param {string[] | null} statuses
 * @returns {boolean}
 */
function matchesTodoMention(item, query, statuses) {
  if (!item || typeof item !== 'object') return false;
  const status = String(item.status || '');
  if (statuses && !statuses.includes(status)) return false;
  if (!query) return true;
  return String(item.title || '').toLowerCase().includes(query);
}

/**
 * Parent id for a fork or a delegation child. Title and summary forks are not work.
 *
 * @param {object | null | undefined} chat
 * @returns {string}
 */
function readWorkParentId(chat) {
  if (!chat || typeof chat !== 'object') return '';
  if (chat.isTemporary === true) return '';
  if (String(chat.archivedAt || '').trim()) return '';
  const kind = String(chat.forkKind || '');
  if (kind === 'title' || kind === 'summary') return '';
  return String(chat.forkParentChatId || chat.delegationParentChatId || '').trim();
}

/**
 * Another chat may continue a todo only when every linked chat and its subchats
 * are idle. The chat that is open now does not block itself.
 *
 * @param {{
 *   todoId?: string,
 *   currentChatId?: string,
 *   chats?: object[],
 *   linkedChatIds?: string[],
 *   isBusy?: (chat: object) => boolean,
 * }} options
 * @returns {{ chatId: string, title: string } | null}
 */
export function resolveTodoContinueBlock(options = {}) {
  const todoId = String(options.todoId || '').trim();
  const currentChatId = String(options.currentChatId || '').trim();
  const chats = Array.isArray(options.chats) ? options.chats : [];
  const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
  if (!todoId) return null;
  /** @type {Map<string, object>} */
  const byId = new Map();
  chats.forEach((chat) => {
    const id = String(chat?.id || '').trim();
    if (id) byId.set(id, chat);
  });
  /** @type {Set<string>} */
  const involved = new Set();
  chats.forEach((chat) => {
    if (String(chat?.todoId || '').trim() === todoId) involved.add(String(chat.id));
  });
  for (const linkedId of Array.isArray(options.linkedChatIds) ? options.linkedChatIds : []) {
    const id = String(linkedId || '').trim();
    if (id && byId.has(id)) involved.add(id);
  }
  const pending = [...involved];
  while (pending.length) {
    const parentId = pending.pop();
    chats.forEach((chat) => {
      const id = String(chat?.id || '').trim();
      if (!id || involved.has(id)) return;
      if (readWorkParentId(chat) !== parentId) return;
      involved.add(id);
      pending.push(id);
    });
  }
  for (const id of involved) {
    if (!id || id === currentChatId) continue;
    const chat = byId.get(id);
    if (!chat || !isBusy(chat)) continue;
    return { chatId: id, title: String(chat.title || '').trim() || id.slice(0, 8) };
  }
  return null;
}

export function filterTodoMentionItems(items, options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  const statuses = Array.isArray(options.statuses) ? options.statuses : null;
  const rows = Array.isArray(items) ? items : [];
  return rows.filter((item) => matchesTodoMention(item, query, statuses));
}

/**
 * Depth-first rows. A parent stays visible when a child matches, so the indent
 * still shows which task it belongs to.
 *
 * @param {unknown} items
 * @param {{ query?: string, statuses?: string[] | null }} [options]
 * @returns {{ item: object, level: number }[]}
 */
export function buildTodoMentionRows(items, options = {}) {
  const query = String(options.query || '').trim().toLowerCase();
  const statuses = Array.isArray(options.statuses) ? options.statuses : null;
  const tree = flattenTodoTree(Array.isArray(items) ? items : [], null);
  /** @type {Map<string, { parentId: string }>} */
  const byId = new Map();
  tree.forEach((row) => {
    const id = String(row.item?.id || '');
    if (!id) return;
    byId.set(id, row);
  });
  /** @type {Set<string>} */
  const visible = new Set();
  tree.forEach((row) => {
    if (!matchesTodoMention(row.item, query, statuses)) return;
    let id = String(row.item?.id || '');
    while (id && !visible.has(id)) {
      visible.add(id);
      id = String(byId.get(id)?.parentId || '');
    }
  });
  return tree
    .filter((row) => visible.has(String(row.item?.id || '')))
    .map((row) => ({ item: row.item, level: row.level }));
}
