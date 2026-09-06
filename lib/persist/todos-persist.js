/**
 * Todo list per workspace (CWD) — JSON in data/todos/<sha256-realpath>.json.
 * Shared logic for the HTTP API (UI and external clients).
 */

import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, existsSync, realpathSync } from 'fs';
import path from 'path';
import { normalizeAgentTransport } from '../agent-transport.js';
import { stripTitleJsonTrailer } from '../todo-changelog-text.js';
import { writeJsonAtomic } from './atomic-write.js';

const DATA_VERSION = 2;
export const TODOS_MAX_ITEMS = 500;
const MAX_TITLE_LEN = 500;
const MAX_BODY_LEN = 8000;
const MAX_PLAN_MARKDOWN_LEN = 32000;
const MAX_CHANGELOG_ENTRIES = 100;
const MAX_CHANGELOG_TEXT_LEN = 4000;
export const TODO_STATUSES = Object.freeze(['idea', 'ready', 'doing', 'done']);
const ALLOWED_STATUS = new Set(TODO_STATUSES);
const ALLOWED_CHANGELOG_KINDS = new Set(['plan', 'implement', 'note']);

/**
 * @param {string} cwd
 * @returns {string|null}
 */
export function workspaceKeyFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const trimmed = cwd.trim();
  if (!trimmed) return null;
  try {
    const rp = realpathSync(trimmed);
    return createHash('sha256').update(rp, 'utf8').digest('hex');
  } catch {
    return createHash('sha256').update(path.resolve(trimmed), 'utf8').digest('hex');
  }
}

function todosDir(dataDir) {
  return path.join(dataDir, 'todos');
}

function todosFilePath(dataDir, key) {
  if (!key) return null;
  return path.join(todosDir(dataDir), `${key}.json`);
}

function ensureTodosDir(dataDir) {
  const dir = todosDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * @param {unknown} t
 * @returns {string}
 */
function normalizeTitle(t) {
  const s = t != null ? String(t).trim() : '';
  if (!s) return '';
  return s.length > MAX_TITLE_LEN ? s.slice(0, MAX_TITLE_LEN) : s;
}

/**
 * @param {unknown} b
 * @returns {string}
 */
function normalizeBody(b) {
  if (b == null || b === '') return '';
  const s = String(b);
  return s.length > MAX_BODY_LEN ? s.slice(0, MAX_BODY_LEN) : s;
}

/**
 * @param {unknown} s
 * @returns {'idea'|'ready'|'doing'|'done'}
 */
function normalizeStatus(s) {
  const v = s != null ? String(s).trim().toLowerCase() : 'idea';
  return ALLOWED_STATUS.has(v) ? v : 'idea';
}

/**
 * Reject unknown statuses instead of coercing them to idea.
 *
 * @param {unknown} raw
 * @returns {'idea'|'ready'|'doing'|'done'}
 */
export function parseTodoStatus(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!ALLOWED_STATUS.has(value)) {
    const err = new Error(`Invalid todo status "${String(raw ?? '')}"`);
    err.code = 'VALIDATION';
    throw err;
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function normalizeChatId(value) {
  if (value == null || value === '') return undefined;
  const s = String(value).trim();
  return s || undefined;
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function normalizeLinkedChatId(value) {
  if (value == null || value === '') return undefined;
  const s = String(value).trim();
  return s || undefined;
}

/**
 * @param {unknown} planInput
 * @returns {{ markdown: string, updatedAt: string, sourceChatId?: string, approvedAt?: string }|undefined}
 */
function normalizePlan(planInput) {
  if (!planInput || typeof planInput !== 'object') return undefined;
  const source = /** @type {Record<string, unknown>} */ (planInput);
  const markdownRaw = source.markdown != null ? String(source.markdown) : '';
  const markdown = markdownRaw.length > MAX_PLAN_MARKDOWN_LEN
    ? markdownRaw.slice(0, MAX_PLAN_MARKDOWN_LEN)
    : markdownRaw;
  if (!markdown.trim()) return undefined;
  const updatedAt = typeof source.updatedAt === 'string' && source.updatedAt.trim()
    ? source.updatedAt.trim()
    : new Date().toISOString();
  const plan = {
    markdown,
    updatedAt,
  };
  const sourceChatId = normalizeChatId(source.sourceChatId);
  if (sourceChatId) plan.sourceChatId = sourceChatId;
  if (typeof source.approvedAt === 'string' && source.approvedAt.trim()) {
    plan.approvedAt = source.approvedAt.trim();
  }
  return plan;
}

/**
 * @param {unknown} kind
 * @returns {'plan'|'implement'|'note'}
 */
function normalizeChangelogKind(kind) {
  const value = kind != null ? String(kind).trim().toLowerCase() : 'note';
  return ALLOWED_CHANGELOG_KINDS.has(value) ? value : 'note';
}

/**
 * @param {unknown} entry
 * @returns {{ at: string, kind: 'plan'|'implement'|'note', text: string, chatId?: string }|null}
 */
function normalizeChangelogEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const source = /** @type {Record<string, unknown>} */ (entry);
  const textRaw = stripTitleJsonTrailer(source.text != null ? String(source.text) : '');
  const text = textRaw.length > MAX_CHANGELOG_TEXT_LEN
    ? textRaw.slice(0, MAX_CHANGELOG_TEXT_LEN)
    : textRaw;
  if (!text.trim()) return null;
  const at = typeof source.at === 'string' && source.at.trim()
    ? source.at.trim()
    : new Date().toISOString();
  const row = {
    at,
    kind: normalizeChangelogKind(source.kind),
    text,
  };
  const chatId = normalizeChatId(source.chatId);
  if (chatId) row.chatId = chatId;
  return row;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeLinkedChatIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    const chatId = normalizeLinkedChatId(item);
    if (!chatId || seen.has(chatId)) continue;
    seen.add(chatId);
    out.push(chatId);
  }
  return out;
}

/**
 * @param {unknown} items
 * @returns {Array<{ at: string, kind: 'plan'|'implement'|'note', text: string, chatId?: string }>}
 */
function normalizeChangelog(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => normalizeChangelogEntry(entry))
    .filter(Boolean)
    .slice(0, MAX_CHANGELOG_ENTRIES);
}

/**
 * @param {Array<{ at: string, kind: string, text: string, chatId?: string }>} current
 * @param {{ kind?: string, text?: string, chatId?: string }} entry
 * @returns {Array<{ at: string, kind: string, text: string, chatId?: string }>}
 */
function appendChangelogEntries(current, entry) {
  const normalized = normalizeChangelogEntry({
    ...entry,
    at: new Date().toISOString(),
  });
  if (!normalized) return current;
  const next = [...current, normalized];
  if (next.length <= MAX_CHANGELOG_ENTRIES) return next;
  return next.slice(next.length - MAX_CHANGELOG_ENTRIES);
}

/**
 * @param {string[]} current
 * @param {string|undefined} chatId
 * @returns {string[]}
 */
function appendLinkedChatId(current, chatId) {
  const normalizedChatId = normalizeLinkedChatId(chatId);
  if (!normalizedChatId) return current;
  if (current.includes(normalizedChatId)) return current;
  return [normalizedChatId, ...current].slice(0, MAX_CHANGELOG_ENTRIES);
}

/**
 * @param {string} raw
 * @returns {{ items?: unknown[] } | null}
 */
function parseDocument(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.items)) return null;
  return data;
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @returns {{ version: number, updatedAt: string, items: Array<{ id: string, title: string, body: string, status: string, createdAt: string, updatedAt: string }> }}
 */
export function loadTodosData(dataDir, cwd) {
  const key = workspaceKeyFromCwd(cwd);
  if (!key) {
    const err = new Error('No workspace folder');
    err.code = 'NO_WORKSPACE';
    throw err;
  }
  const filePath = todosFilePath(dataDir, key);
  if (!filePath || !existsSync(filePath)) {
    return {
      version: DATA_VERSION,
      updatedAt: new Date().toISOString(),
      items: [],
      idempotency: {},
    };
  }
  const raw = readFileSync(filePath, 'utf8');
  const doc = parseDocument(raw);
  if (!doc) {
    return {
      version: DATA_VERSION,
      updatedAt: new Date().toISOString(),
      items: [],
      idempotency: {},
    };
  }
  const items = doc.items
    .filter((it) => it && typeof it === 'object' && it.id)
    .map((it) => {
      const row = {
        id: String(it.id),
        title: normalizeTitle(it.title) || '(untitled)',
        body: normalizeBody(it.body),
        status: normalizeStatus(it.status),
        createdAt: typeof it.createdAt === 'string' ? it.createdAt : new Date().toISOString(),
        updatedAt: typeof it.updatedAt === 'string' ? it.updatedAt : new Date().toISOString(),
      };
      const chatId = normalizeChatId(it.chatId);
      if (chatId) row.chatId = chatId;
      const plan = normalizePlan(it.plan);
      if (plan) row.plan = plan;
      const changelog = normalizeChangelog(it.changelog);
      if (changelog.length) row.changelog = changelog;
      const linkedChatIds = normalizeLinkedChatIds(it.linkedChatIds);
      if (linkedChatIds.length) row.linkedChatIds = linkedChatIds;
      const sourceHarness = typeof it.sourceHarness === 'string' ? it.sourceHarness.trim() : '';
      if (sourceHarness) row.sourceHarness = normalizeAgentTransport(sourceHarness);
      return row;
    });
  return {
    version: DATA_VERSION,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
    items,
    idempotency: normalizeIdempotencyMap(doc.idempotency),
  };
}

/**
 * @param {unknown} raw
 * @returns {Record<string, { hash: string, todoId: string }>}
 */
function normalizeIdempotencyMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, { hash: string, todoId: string }>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== 'object') continue;
    const hash = String(value.hash || '').trim();
    const todoId = String(value.todoId || '').trim();
    if (!hash || !todoId) continue;
    out[key] = { hash, todoId };
  }
  return out;
}

/**
 * @param {string} dataDir
 * @param {string} key
 * @param {{ version: number, updatedAt: string, items: unknown[] }} doc
 */
function persist(dataDir, key, doc) {
  ensureTodosDir(dataDir);
  const filePath = todosFilePath(dataDir, key);
  const out = {
    version: doc.version,
    updatedAt: doc.updatedAt,
    items: doc.items,
    idempotency: doc.idempotency && typeof doc.idempotency === 'object' ? doc.idempotency : {},
  };
  writeJsonAtomic(filePath, out, 'utf8');
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {{ version: number, updatedAt: string, items: unknown[] }} doc
 */
export function saveTodosData(dataDir, cwd, doc) {
  const key = workspaceKeyFromCwd(cwd);
  if (!key) {
    const err = new Error('No workspace folder');
    err.code = 'NO_WORKSPACE';
    throw err;
  }
  if (doc.items.length > TODOS_MAX_ITEMS) {
    const err = new Error(`Limit of ${TODOS_MAX_ITEMS} items reached`);
    err.code = 'LIMIT';
    throw err;
  }
  doc.updatedAt = new Date().toISOString();
  persist(dataDir, key, doc);
  return doc;
}

/**
 * @param {{ title?: unknown, body?: unknown, status?: unknown }} input
 * @returns {string}
 */
export function hashTodoCreateArgs(input) {
  const status = input.status == null || input.status === ''
    ? 'idea'
    : parseTodoStatus(input.status);
  return JSON.stringify({
    title: normalizeTitle(input.title),
    body: normalizeBody(input.body),
    status,
  });
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {{ title?: string, body?: string, status?: string, idempotencyKey?: string, strictStatus?: boolean }} input
 */
export function addTodo(dataDir, cwd, input = {}) {
  const doc = loadTodosData(dataDir, cwd);
  if (doc.items.length >= TODOS_MAX_ITEMS) {
    const err = new Error(`Limit of ${TODOS_MAX_ITEMS} items reached`);
    err.code = 'LIMIT';
    throw err;
  }
  const now = new Date().toISOString();
  const title = normalizeTitle(input.title);
  if (!title) {
    const err = new Error('Title is required');
    err.code = 'VALIDATION';
    throw err;
  }
  const status = input.strictStatus === true && input.status != null && input.status !== ''
    ? parseTodoStatus(input.status)
    : (input.strictStatus === true && (input.status == null || input.status === '')
      ? 'idea'
      : normalizeStatus(input.status));
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (idempotencyKey) {
    const hash = hashTodoCreateArgs({ title, body: input.body, status });
    const prior = doc.idempotency?.[idempotencyKey];
    if (prior) {
      if (prior.hash !== hash) {
        const err = new Error('Idempotency key was reused with different arguments');
        err.code = 'CONFLICT';
        throw err;
      }
      const existing = doc.items.find((row) => row.id === prior.todoId);
      if (existing) {
        return { ...doc, replayed: true, item: existing };
      }
    }
  }
  const item = {
    id: randomUUID(),
    title,
    body: normalizeBody(input.body),
    status,
    createdAt: now,
    updatedAt: now,
  };
  doc.items.unshift(item);
  if (idempotencyKey) {
    doc.idempotency = {
      ...(doc.idempotency || {}),
      [idempotencyKey]: { hash: hashTodoCreateArgs({ title, body: input.body, status }), todoId: item.id },
    };
  }
  const saved = saveTodosData(dataDir, cwd, doc);
  return { ...saved, item, replayed: false };
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @param {{ title?: string, body?: string, status?: string, expectedUpdatedAt?: string, strictStatus?: boolean, chatId?: string|null, sourceHarness?: string, plan?: { markdown?: string, sourceChatId?: string, approvedAt?: string|null, updatedAt?: string }, appendChangelog?: { kind?: string, text?: string, chatId?: string }, linkedChatId?: string }} patch
 */
export function updateTodo(dataDir, cwd, id, patch = {}) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Missing id');
    err.code = 'VALIDATION';
    throw err;
  }
  const doc = loadTodosData(dataDir, cwd);
  const idx = doc.items.findIndex((it) => it.id === id);
  if (idx < 0) {
    const err = new Error('Item not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const cur = { ...doc.items[idx] };
  const expectedUpdatedAt = String(patch.expectedUpdatedAt || '').trim();
  if (expectedUpdatedAt && expectedUpdatedAt !== String(cur.updatedAt || '')) {
    const err = new Error('Todo was updated by another request');
    err.code = 'CONFLICT';
    err.currentUpdatedAt = cur.updatedAt;
    throw err;
  }
  if (patch.title != null) {
    const t = normalizeTitle(patch.title);
    if (!t) {
      const err = new Error('Title cannot be empty');
      err.code = 'VALIDATION';
      throw err;
    }
    cur.title = t;
  }
  if (patch.body != null) cur.body = normalizeBody(patch.body);
  if (patch.status != null) {
    cur.status = patch.strictStatus === true ? parseTodoStatus(patch.status) : normalizeStatus(patch.status);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'chatId')) {
    const nextChatId = normalizeChatId(patch.chatId);
    if (nextChatId) cur.chatId = nextChatId;
    else delete cur.chatId;
  }
  if (patch.plan != null) {
    const previousPlan = cur.plan && typeof cur.plan === 'object' ? cur.plan : {};
    const mergedPlan = {
      ...previousPlan,
      ...patch.plan,
      updatedAt: new Date().toISOString(),
    };
    if (!String(mergedPlan.markdown || '').trim() && previousPlan.markdown) {
      mergedPlan.markdown = previousPlan.markdown;
    }
    const normalizedPlan = normalizePlan(mergedPlan);
    if (normalizedPlan) cur.plan = normalizedPlan;
    else delete cur.plan;
  }
  if (patch.appendChangelog && typeof patch.appendChangelog === 'object') {
    const currentChangelog = Array.isArray(cur.changelog) ? cur.changelog : [];
    cur.changelog = appendChangelogEntries(currentChangelog, patch.appendChangelog);
  }
  if (patch.linkedChatId) {
    const currentLinked = Array.isArray(cur.linkedChatIds) ? cur.linkedChatIds : [];
    cur.linkedChatIds = appendLinkedChatId(currentLinked, patch.linkedChatId);
  }
  if (patch.sourceHarness != null) {
    const harness = String(patch.sourceHarness || '').trim();
    if (harness) cur.sourceHarness = normalizeAgentTransport(harness);
    else delete cur.sourceHarness;
  }
  cur.updatedAt = new Date().toISOString();
  doc.items[idx] = cur;
  return saveTodosData(dataDir, cwd, doc);
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 */
export function deleteTodo(dataDir, cwd, id) {
  if (!id || typeof id !== 'string') {
    const err = new Error('Missing id');
    err.code = 'VALIDATION';
    throw err;
  }
  const doc = loadTodosData(dataDir, cwd);
  const doomed = doc.items.find((it) => it.id === id);
  if (!doomed) {
    const err = new Error('Item not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  doc.items = doc.items.filter((it) => it.id !== id);
  return { doc: saveTodosData(dataDir, cwd, doc), removed: doomed };
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @returns {{ id: string, title: string, body: string, status: string, chatId?: string, createdAt: string, updatedAt: string } | null}
 */
export function getTodoById(dataDir, cwd, id) {
  if (!id || typeof id !== 'string') return null;
  const doc = loadTodosData(dataDir, cwd);
  return doc.items.find((it) => it.id === id) || null;
}
