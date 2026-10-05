/**
 * Todo list per workspace (CWD) — JSON in data/todos/<sha256-realpath>.json.
 * Shared logic for the HTTP API (UI and external clients).
 */

import { createHash, randomUUID } from 'crypto';
import fs, { mkdirSync, existsSync, realpathSync } from 'fs';
import path from 'path';
import { isValidAgentTransport, normalizeAgentTransport } from '../agent-transport.js';
import { stripTitleJsonTrailer } from '../todo-changelog-text.js';
import {
  collectTodoSubtreeIds,
  isTodoBranchBlocked,
  readTodoParentId,
  renumberTodoSiblings,
  synchronizeTodoParentStatuses,
  TODO_MAX_DEPTH,
  todoNodeDepth,
  todoSubtreeHeight,
  wouldCreateTodoParentCycle,
} from '../todo-tree.js';
import { writeJsonAtomic } from './atomic-write.js';
import { withWorkspaceWatchersFileLock } from './workspace-watchers-persist.js';

/*
 * Store locking: every mutating function below performs load -> modify ->
 * save synchronously under the same cross-process lock as watcher state.
 * The lock is reentrant within this process, so a watcher transaction can
 * claim a todo without a second lock or an ordering deadlock. Every writer
 * uses it, including chat links that preserve the item's CAS revision.
 */

const DATA_VERSION = 3;
export const TODOS_MAX_ITEMS = 500;

/** Suppresses watcher autopilot nudges for internal claim/release writes. */
let todosWatcherNudgeSuppressDepth = 0;

/**
 * Normalized todo documents keyed by file path. A save drops the entry.
 * Callers receive copies so an in-memory edit does not dirty the cache.
 *
 * @type {Map<string, { signature: string, doc: { version: number, updatedAt: string, items: object[], idempotency: Record<string, { hash: string, todoId: string }> } }>}
 */
const todosCache = new Map();

/**
 * @param {string} filePath
 * @returns {string}
 */
function readTodoFileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * @param {{ version: number, updatedAt: string, items: object[], idempotency?: Record<string, { hash: string, todoId: string }> }} doc
 * @returns {{ version: number, updatedAt: string, items: object[], idempotency: Record<string, { hash: string, todoId: string }> }}
 */
function copyTodoDoc(doc) {
  /** @type {Record<string, { hash: string, todoId: string }>} */
  const idempotency = {};
  for (const [key, value] of Object.entries(doc.idempotency || {})) {
    idempotency[key] = { hash: value.hash, todoId: value.todoId };
  }
  return {
    version: doc.version,
    updatedAt: doc.updatedAt,
    items: doc.items.map((row) => ({ ...row })),
    idempotency,
  };
}

/**
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
export function withTodosWatcherNudgeSuppressed(fn) {
  todosWatcherNudgeSuppressDepth += 1;
  try {
    return fn();
  } finally {
    todosWatcherNudgeSuppressDepth -= 1;
  }
}
const MAX_TITLE_LEN = 500;
const MAX_BODY_LEN = 8000;
const MAX_PLAN_MARKDOWN_LEN = 32000;
const MAX_CHANGELOG_ENTRIES = 100;
const MAX_CHANGELOG_TEXT_LEN = 4000;
export const TODO_STATUSES = Object.freeze(['idea', 'ready', 'doing', 'done']);
const ALLOWED_STATUS = new Set(TODO_STATUSES);
const ALLOWED_CHANGELOG_KINDS = new Set(['plan', 'implement', 'note']);
/** Patch keys that only record which chat touched the todo (no revision bump). */
const LINK_ONLY_PATCH_KEYS = new Set(['linkedChatId', 'expectedUpdatedAt', 'strictStatus']);
const TODO_RUN_MODES = new Set(['parallel', 'sequential']);
const TODO_ASSIGNEE_ROLES = new Set(['plan', 'implement', 'review']);

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
 * @param {unknown} raw
 * @returns {'parallel'|'sequential'|undefined}
 */
function normalizeRunMode(raw) {
  const value = raw != null ? String(raw).trim().toLowerCase() : '';
  return TODO_RUN_MODES.has(value) ? value : undefined;
}

/**
 * Unknown harness or role drops the whole assignee. Load stays tolerant
 * (invalid stored data disappears); create/update reject beforehand.
 *
 * @param {unknown} raw
 * @returns {{ harness: string, model?: string, role: 'plan'|'implement'|'review' }|undefined}
 */
function normalizeAssignee(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const harness = typeof source.harness === 'string' ? source.harness.trim().toLowerCase() : '';
  if (!isValidAgentTransport(harness)) return undefined;
  const role = typeof source.role === 'string' ? source.role.trim().toLowerCase() : '';
  if (!TODO_ASSIGNEE_ROLES.has(role)) return undefined;
  const assignee = {
    harness: normalizeAgentTransport(harness),
    role: /** @type {'plan'|'implement'|'review'} */ (role),
  };
  const model = typeof source.model === 'string' ? source.model.trim() : '';
  if (model) assignee.model = model;
  return assignee;
}

/**
 * MCP clients bound to the object schema cannot send null, so an assignee
 * with an empty harness also means "clear".
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
function isAssigneeClear(raw) {
  if (raw == null || raw === '') return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  return String(/** @type {Record<string, unknown>} */ (raw).harness ?? '').trim() === '';
}

/**
 * Strict API-side siblingIndex: integer >= 0 or throws.
 *
 * @param {unknown} raw
 * @returns {number|undefined}
 */
function parseSiblingIndex(raw) {
  if (raw == null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 0) {
    const err = new Error('siblingIndex must be an integer >= 0');
    err.code = 'VALIDATION';
    throw err;
  }
  return value;
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
 * Migration + integrity pass (v2 -> v3 and stray links):
 * - parentId pointing at a missing item (or itself) makes the item a root;
 * - cyclic parent chains are cut;
 * - siblingIndex is renumbered 0..n-1 per sibling group (v2 roots follow
 *   the stored array order).
 * Mutates items in place and returns them.
 *
 * @param {Array<Record<string, unknown>>} items
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeTodoTreeFields(items) {
  const known = new Set(items.map((row) => String(row.id)));
  items.forEach((row) => {
    const parentId = readTodoParentId(row);
    if (!parentId) return;
    if (!known.has(parentId) || parentId === String(row.id)
      || wouldCreateTodoParentCycle(items, String(row.id), parentId)) {
      delete row.parentId;
    }
  });
  return renumberTodoSiblings(items);
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
  const signature = readTodoFileSignature(filePath);
  const cached = todosCache.get(filePath);
  if (cached && signature && cached.signature === signature) return copyTodoDoc(cached.doc);
  const raw = fs.readFileSync(filePath, 'utf8');
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
      const createdByChatId = normalizeChatId(it.createdByChatId);
      if (createdByChatId) row.createdByChatId = createdByChatId;
      const parentId = normalizeChatId(it.parentId);
      if (parentId) row.parentId = parentId;
      if (Number.isInteger(it.siblingIndex) && it.siblingIndex >= 0) {
        row.siblingIndex = it.siblingIndex;
      }
      const assignee = normalizeAssignee(it.assignee);
      if (assignee) row.assignee = assignee;
      const runMode = normalizeRunMode(it.runMode);
      if (runMode) row.runMode = runMode;
      const orchestratorChatId = normalizeChatId(it.orchestratorChatId);
      if (orchestratorChatId) row.orchestratorChatId = orchestratorChatId;
      const claimedByChatId = normalizeChatId(it.claimedByChatId);
      if (claimedByChatId) row.claimedByChatId = claimedByChatId;
      const claimedAt = typeof it.claimedAt === 'string' && it.claimedAt.trim()
        ? it.claimedAt.trim()
        : '';
      if (claimedAt) row.claimedAt = claimedAt;
      if (typeof it.claimLeaseUntil === 'string' && Number.isFinite(Date.parse(it.claimLeaseUntil))) row.claimLeaseUntil = it.claimLeaseUntil;
      if (typeof it.blockedReason === 'string' && it.blockedReason.trim()) row.blockedReason = it.blockedReason.trim();
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
  const normalized = {
    version: DATA_VERSION,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
    items: synchronizeTodoParentStatuses(normalizeTodoTreeFields(items)),
    idempotency: normalizeIdempotencyMap(doc.idempotency),
  };
  if (signature) todosCache.set(filePath, { signature, doc: normalized });
  return copyTodoDoc(normalized);
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
  todosCache.delete(filePath);
  writeJsonAtomic(filePath, out, 'utf8');
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {{ version: number, updatedAt: string, items: unknown[] }} doc
 */
export function saveTodosData(dataDir, cwd, doc) {
  return withWorkspaceWatchersFileLock(() => saveTodosDataUnlocked(dataDir, cwd, doc), { dataDir });
}

function saveTodosDataUnlocked(dataDir, cwd, doc) {
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
  let previousDoc = null;
  if (todosWatcherNudgeSuppressDepth === 0) {
    try {
      previousDoc = loadTodosData(dataDir, cwd);
    } catch {
      previousDoc = null;
    }
  }
  normalizeTodoTreeFields(doc.items);
  synchronizeTodoParentStatuses(doc.items, (item) => {
    const previous = Date.parse(String(item.updatedAt || ''));
    item.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
  });
  doc.version = DATA_VERSION;
  doc.updatedAt = new Date().toISOString();
  persist(dataDir, key, doc);
  if (todosWatcherNudgeSuppressDepth === 0) {
    void import('../workspace-watcher-nudge.js').then(({ maybeScheduleWorkspaceWatcherAfterTodosSave }) => {
      maybeScheduleWorkspaceWatcherAfterTodosSave(dataDir, cwd, previousDoc, doc);
    }).catch(() => {});
  }
  return doc;
}

/**
 * @param {{ title?: unknown, body?: unknown, status?: unknown, parentId?: unknown, assignee?: unknown, siblingIndex?: unknown, runMode?: unknown, orchestratorChatId?: unknown }} input
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
    parentId: normalizeChatId(input.parentId) || undefined,
    assignee: normalizeAssignee(input.assignee),
    siblingIndex: Number.isInteger(input.siblingIndex) ? input.siblingIndex : undefined,
    runMode: normalizeRunMode(input.runMode) || undefined,
    orchestratorChatId: normalizeChatId(input.orchestratorChatId) || undefined,
  });
}

/**
 * First free position at the end of a sibling group.
 *
 * @param {Array<{ id: string, parentId?: string, siblingIndex?: number }>} items
 * @param {string} parentId
 * @returns {number}
 */
function nextSiblingIndex(items, parentId) {
  let max = -1;
  items.forEach((row) => {
    if (readTodoParentId(row) !== parentId) return;
    if (Number.isInteger(row.siblingIndex)) max = Math.max(max, row.siblingIndex);
  });
  return max + 1;
}

/**
 * Place `item` at `desiredIndex` inside its (possibly new) sibling group and
 * renumber that group 0..n-1. Out-of-range indexes clamp to the group size.
 *
 * @param {Array<{ id: string, parentId?: string, siblingIndex?: number }>} items
 * @param {{ id: string, parentId?: string, siblingIndex?: number }} item
 * @param {number} desiredIndex
 */
function placeTodoInSiblingGroup(items, item, desiredIndex) {
  const groupKey = readTodoParentId(item) || '';
  const others = items
    .filter((row) => row?.id && row.id !== item.id && (readTodoParentId(row) || '') === groupKey)
    .sort((a, b) => {
      const ai = Number.isInteger(a.siblingIndex) ? a.siblingIndex : Number.MAX_SAFE_INTEGER;
      const bi = Number.isInteger(b.siblingIndex) ? b.siblingIndex : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  const target = Math.max(0, Math.min(desiredIndex, others.length));
  others.splice(target, 0, item);
  others.forEach((row, index) => {
    row.siblingIndex = index;
  });
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {{ title?: string, body?: string, status?: string, idempotencyKey?: string, strictStatus?: boolean, parentId?: string|null, siblingIndex?: number, assignee?: { harness: string, model?: string, role: 'plan'|'implement'|'review' }|null, runMode?: 'parallel'|'sequential'|null, orchestratorChatId?: string|null, createdByChatId?: string|null, sourceHarness?: string }} input
 */
export function addTodo(dataDir, cwd, input = {}) {
  return withWorkspaceWatchersFileLock(() => addTodoUnlocked(dataDir, cwd, input), { dataDir });
}

function addTodoUnlocked(dataDir, cwd, input) {
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
  const parentId = normalizeChatId(input.parentId);
  if (parentId) {
    const parent = doc.items.find((it) => it.id === parentId);
    if (!parent) {
      const err = new Error('Parent todo not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (todoNodeDepth(doc.items, parentId) + 1 > TODO_MAX_DEPTH) {
      const err = new Error(`Max todo depth is ${TODO_MAX_DEPTH}`);
      err.code = 'VALIDATION';
      throw err;
    }
  }
  const siblingIndex = parseSiblingIndex(input.siblingIndex);
  let assignee;
  if (input.assignee != null) {
    assignee = normalizeAssignee(input.assignee);
    if (!assignee) {
      const err = new Error('Invalid todo assignee');
      err.code = 'VALIDATION';
      throw err;
    }
  }
  let runMode;
  if (input.runMode != null && input.runMode !== '') {
    runMode = normalizeRunMode(input.runMode);
    if (!runMode) {
      const err = new Error('Invalid todo runMode');
      err.code = 'VALIDATION';
      throw err;
    }
  }
  const orchestratorChatId = normalizeChatId(input.orchestratorChatId);
  const createdByChatId = normalizeChatId(input.createdByChatId);
  const sourceHarness = typeof input.sourceHarness === 'string' ? input.sourceHarness.trim() : '';
  const hash = hashTodoCreateArgs({
    title,
    body: input.body,
    status,
    parentId,
    assignee,
    siblingIndex,
    runMode,
    orchestratorChatId,
  });
  if (idempotencyKey) {
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
  if (parentId) item.parentId = parentId;
  // Default position: roots go first in their group (newest on top matches
  // the historical unshift), children append at the end of the parent group.
  item.siblingIndex = siblingIndex != null
    ? siblingIndex
    : (parentId ? nextSiblingIndex(doc.items, parentId) : 0);
  if (assignee) item.assignee = assignee;
  if (runMode) item.runMode = runMode;
  if (orchestratorChatId) item.orchestratorChatId = orchestratorChatId;
  if (createdByChatId) {
    item.createdByChatId = createdByChatId;
    item.linkedChatIds = [createdByChatId];
  }
  if (sourceHarness) item.sourceHarness = normalizeAgentTransport(sourceHarness);
  doc.items.unshift(item);
  if (idempotencyKey) {
    doc.idempotency = {
      ...(doc.idempotency || {}),
      [idempotencyKey]: { hash, todoId: item.id },
    };
  }
  const saved = saveTodosData(dataDir, cwd, doc);
  return { ...saved, item, replayed: false };
}

/**
 * Callers forward optional fields as `undefined` when the client did not send
 * them; only a defined value (including null, which clears) is a change.
 *
 * @param {object} patch
 * @param {string} key
 * @returns {boolean}
 */
function hasPatchValue(patch, key) {
  return Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @param {{ title?: string, body?: string, status?: string, expectedUpdatedAt?: string, strictStatus?: boolean, chatId?: string|null, sourceHarness?: string, plan?: { markdown?: string, sourceChatId?: string, approvedAt?: string|null, updatedAt?: string }, appendChangelog?: { kind?: string, text?: string, chatId?: string }, linkedChatId?: string, parentId?: string|null, siblingIndex?: number|null, assignee?: { harness: string, model?: string, role: 'plan'|'implement'|'review' }|null, runMode?: 'parallel'|'sequential'|null, orchestratorChatId?: string|null, claimedByChatId?: string|null, claimedAt?: string|null }} patch
 */
export function updateTodo(dataDir, cwd, id, patch = {}) {
  return withWorkspaceWatchersFileLock(() => updateTodoUnlocked(dataDir, cwd, id, patch), { dataDir });
}

function updateTodoUnlocked(dataDir, cwd, id, patch) {
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
  const previousStatus = cur.status;
  const expectedUpdatedAt = String(patch.expectedUpdatedAt || '').trim();
  if (expectedUpdatedAt && expectedUpdatedAt !== String(cur.updatedAt || '')) {
    const err = new Error('Todo was updated by another request');
    err.code = 'CONFLICT';
    err.currentUpdatedAt = cur.updatedAt;
    throw err;
  }
  // Adding a chat link is bookkeeping: when it is the only change it must not
  // bump updatedAt, so a concurrent agent's expected_updated_at stays valid.
  const linkOnlyPatch = String(patch.linkedChatId || '').trim() !== ''
    && Object.keys(patch)
      .filter((key) => patch[key] !== undefined)
      .every((key) => LINK_ONLY_PATCH_KEYS.has(key));
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
  if (hasPatchValue(patch, 'chatId')) {
    const nextChatId = normalizeChatId(patch.chatId);
    if (nextChatId) cur.chatId = nextChatId;
    else delete cur.chatId;
  }
  const previousParentId = readTodoParentId(cur) || '';
  if (hasPatchValue(patch, 'parentId')) {
    const nextParentId = normalizeChatId(patch.parentId);
    if (nextParentId) {
      const parent = doc.items.find((it) => it.id === nextParentId);
      if (!parent) {
        const err = new Error('Parent todo not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (wouldCreateTodoParentCycle(doc.items, String(cur.id), nextParentId)) {
        const err = new Error('Todo move would create a cycle');
        err.code = 'VALIDATION';
        throw err;
      }
      // Depth check covers the whole moved subtree, not just this node.
      if (todoNodeDepth(doc.items, nextParentId) + todoSubtreeHeight(doc.items, String(cur.id)) > TODO_MAX_DEPTH) {
        const err = new Error(`Max todo depth is ${TODO_MAX_DEPTH}`);
        err.code = 'VALIDATION';
        throw err;
      }
      cur.parentId = nextParentId;
    } else {
      delete cur.parentId;
    }
  }
  const parentChanged = (readTodoParentId(cur) || '') !== previousParentId;
  const explicitSiblingIndex = hasPatchValue(patch, 'siblingIndex')
    ? parseSiblingIndex(patch.siblingIndex)
    : undefined;
  if (parentChanged || explicitSiblingIndex != null) {
    // Explicit index places the item exactly; a move without an index
    // appends at the end of the (new) sibling group.
    placeTodoInSiblingGroup(doc.items, cur, explicitSiblingIndex != null ? explicitSiblingIndex : Number.MAX_SAFE_INTEGER);
  }
  if (hasPatchValue(patch, 'assignee')) {
    if (isAssigneeClear(patch.assignee)) delete cur.assignee;
    else {
      const nextAssignee = normalizeAssignee(patch.assignee);
      if (!nextAssignee) {
        const err = new Error('Invalid todo assignee');
        err.code = 'VALIDATION';
        throw err;
      }
      cur.assignee = nextAssignee;
    }
  }
  if (hasPatchValue(patch, 'runMode')) {
    if (patch.runMode == null || patch.runMode === '') delete cur.runMode;
    else {
      const nextRunMode = normalizeRunMode(patch.runMode);
      if (!nextRunMode) {
        const err = new Error('Invalid todo runMode');
        err.code = 'VALIDATION';
        throw err;
      }
      cur.runMode = nextRunMode;
    }
  }
  if (hasPatchValue(patch, 'orchestratorChatId')) {
    const nextOrchestratorChatId = normalizeChatId(patch.orchestratorChatId);
    if (nextOrchestratorChatId) cur.orchestratorChatId = nextOrchestratorChatId;
    else delete cur.orchestratorChatId;
  }
  // Claim fields ride the normal CAS path: they are written together with the
  // status flip and bump updatedAt, so a competing claim sees a stale token.
  if (hasPatchValue(patch, 'claimedByChatId')) {
    const nextClaimedByChatId = normalizeChatId(patch.claimedByChatId);
    if (nextClaimedByChatId) cur.claimedByChatId = nextClaimedByChatId;
    else delete cur.claimedByChatId;
  }
  if (hasPatchValue(patch, 'claimedAt')) {
    const nextClaimedAt = typeof patch.claimedAt === 'string' && patch.claimedAt.trim()
      ? patch.claimedAt.trim()
      : '';
    if (nextClaimedAt) cur.claimedAt = nextClaimedAt;
    else delete cur.claimedAt;
  }
  if (hasPatchValue(patch, 'claimLeaseUntil')) {
    const until = String(patch.claimLeaseUntil || '').trim();
    if (until && !Number.isFinite(Date.parse(until))) {
      const err = new Error('Invalid claim lease expiry'); err.code = 'VALIDATION'; throw err;
    }
    if (until) cur.claimLeaseUntil = until;
    else delete cur.claimLeaseUntil;
  }
  if (patch.status != null) delete cur.blockedReason;
  if (hasPatchValue(patch, 'blockedReason')) {
    if (String(patch.blockedReason || '').trim()) cur.blockedReason = String(patch.blockedReason).trim();
    else delete cur.blockedReason;
  }
  if (cur.status === 'done' || (hasPatchValue(patch, 'claimedByChatId') && !cur.claimedByChatId)) {
    delete cur.claimedByChatId;
    delete cur.claimedAt;
    delete cur.claimLeaseUntil;
  }
  if (patch.plan != null) {
    const previousPlan = cur.plan && typeof cur.plan === 'object' ? cur.plan : {};
    const previousMarkdown = String(previousPlan.markdown || '');
    const mergedPlan = {
      ...previousPlan,
      ...patch.plan,
      updatedAt: new Date().toISOString(),
    };
    if (!String(mergedPlan.markdown || '').trim() && previousMarkdown) {
      mergedPlan.markdown = previousMarkdown;
    }
    // Approval binds to plan content: editing the markdown drops a stored
    // approvedAt unless the same patch re-approves it explicitly.
    const reapproved = patch.plan.approvedAt != null && String(patch.plan.approvedAt).trim() !== '';
    if (!reapproved && previousPlan.approvedAt && String(mergedPlan.markdown || '') !== previousMarkdown) {
      delete mergedPlan.approvedAt;
    }
    const normalizedPlan = normalizePlan(mergedPlan);
    if (normalizedPlan) cur.plan = normalizedPlan;
    else delete cur.plan;
  }
  if (patch.appendChangelog && typeof patch.appendChangelog === 'object') {
    const currentChangelog = Array.isArray(cur.changelog) ? cur.changelog : [];
    cur.changelog = appendChangelogEntries(currentChangelog, patch.appendChangelog);
  }
  let linkedChatChanged = false;
  if (patch.linkedChatId) {
    const currentLinked = Array.isArray(cur.linkedChatIds) ? cur.linkedChatIds : [];
    const nextLinked = appendLinkedChatId(currentLinked, patch.linkedChatId);
    if (nextLinked !== currentLinked) {
      cur.linkedChatIds = nextLinked;
      linkedChatChanged = true;
    }
  }
  if (patch.sourceHarness != null) {
    const harness = String(patch.sourceHarness || '').trim();
    if (harness) cur.sourceHarness = normalizeAgentTransport(harness);
    else delete cur.sourceHarness;
  }
  if (linkOnlyPatch && !linkedChatChanged) {
    // Duplicate link: no file write, no revision bump.
    return doc;
  }
  if (linkOnlyPatch) {
    doc.items[idx] = cur;
    return saveTodosData(dataDir, cwd, doc);
  }
  // CAS tokens must advance even when two updates occur in the same millisecond.
  const previousUpdatedAt = Date.parse(String(cur.updatedAt || ''));
  cur.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0)).toISOString();
  doc.items[idx] = cur;
  if (cur.status === 'doing' && previousStatus !== 'doing' && patch.status != null
    && isTodoBranchBlocked(doc.items, cur)) {
    const err = new Error('Complete earlier subtasks and approve the parent plan before starting this task');
    err.code = 'VALIDATION';
    throw err;
  }
  if (patch.status != null && cur.status === 'done') {
    const descendants = collectTodoSubtreeIds(doc.items, id).slice(1);
    if (descendants.some((childId) => doc.items.find((row) => row.id === childId)?.status !== 'done')) {
      const err = new Error('Complete all subtasks before completing their parent');
      err.code = 'VALIDATION';
      throw err;
    }
  }
  // A container has no status of its own. "Ready" means every idea draft in
  // the subtree is now claimable; doing and done stay as they are.
  if (patch.status != null && cur.status === 'ready') {
    const promotedAt = Date.now();
    for (const childId of collectTodoSubtreeIds(doc.items, id).slice(1)) {
      const child = doc.items.find((row) => row.id === childId);
      if (!child || child.status !== 'idea') continue;
      child.status = 'ready';
      const previous = Date.parse(String(child.updatedAt || ''));
      child.updatedAt = new Date(Math.max(promotedAt, Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    }
  }
  return saveTodosData(dataDir, cwd, doc);
}

/**
 * Record that a chat worked on a todo without touching the item revision.
 * Idempotent: a chat already in `linkedChatIds` writes nothing.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} todoId
 * @param {string} chatId
 * @returns {{ changed: boolean, item: object|null, doc: object|null }}
 */
export function linkTodoChat(dataDir, cwd, todoId, chatId) {
  return withWorkspaceWatchersFileLock(() => linkTodoChatUnlocked(dataDir, cwd, todoId, chatId), { dataDir });
}

function linkTodoChatUnlocked(dataDir, cwd, todoId, chatId) {
  const id = String(todoId || '').trim();
  const linkId = String(chatId || '').trim();
  if (!id || !linkId) return { changed: false, item: null, doc: null };
  const doc = loadTodosData(dataDir, cwd);
  const idx = doc.items.findIndex((it) => it.id === id);
  if (idx < 0) return { changed: false, item: null, doc };
  const cur = doc.items[idx];
  const currentLinked = Array.isArray(cur.linkedChatIds) ? cur.linkedChatIds : [];
  const nextLinked = appendLinkedChatId(currentLinked, linkId);
  if (nextLinked === currentLinked) return { changed: false, item: cur, doc };
  const updated = { ...cur, linkedChatIds: nextLinked };
  doc.items[idx] = updated;
  return { changed: true, item: updated, doc: saveTodosData(dataDir, cwd, doc) };
}

/**
 * Removes the item and its whole subtree. Returns every removed item so
 * callers can clean up per-item links (chat.todoId).
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {string} id
 * @returns {{ doc: object, removed: object, removedItems: object[] }}
 */
export function deleteTodo(dataDir, cwd, id) {
  return withWorkspaceWatchersFileLock(() => deleteTodoUnlocked(dataDir, cwd, id), { dataDir });
}

function deleteTodoUnlocked(dataDir, cwd, id) {
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
  const removedIds = new Set(collectTodoSubtreeIds(doc.items, id));
  const removedItems = doc.items.filter((it) => removedIds.has(it.id));
  doc.items = doc.items.filter((it) => !removedIds.has(it.id));
  return { doc: saveTodosData(dataDir, cwd, doc), removed: doomed, removedItems };
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
