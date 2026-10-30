/**
 * Chat retention: archives technical chats (Workspace Watcher cycles, merge and
 * plan chats, delegation children) that have been idle for N days.
 *
 * Differences from the generic idle sweep in `chat-auto-archive.js`:
 *  - only chats that carry a technical marker are ever candidates; an ordinary
 *    user conversation never qualifies, however old it is;
 *  - chats linked to an open todo and chats with a non-terminal or slot-holding
 *    delegation are skipped (reported with a reason);
 *  - the same plan drives the dry-run report and the apply, so the numbers match;
 *  - apply is rate-limited by a batch limit.
 *
 * Archiving reuses the fail-closed gate and the children-before-parent writer
 * from `chat-archive-policy.js`; it is the normal chat archive flag, so a chat
 * comes back with `updateChat(id, { archived: false })` (the existing restore).
 * Everything is dependency-injected so tests run on a temp copy of the data.
 */

import { loadChats, updateChat } from './persist/chats-persist.js';
import { listDelegationsForController, listDelegationsForChat } from './persist/delegations-persist.js';
import { listTodos } from './persist/todos-store.js';
import { loadSettings, saveSettings } from './persist/settings.js';
import { resolveDataPath } from './runtime-paths.js';
import { collectForkSubtreeIds } from './chat-tree.js';
import { createChatArchiveIdleProbe } from './chat-archive-idle.js';
import { isDelegationSlotOccupied, isTerminalDelegationStatus } from './delegation-status.js';
import {
  archiveFamilyMembers,
  createChatArchivable,
  createFamilyCollector,
  isChatAlreadyArchived,
} from './chat-archive-policy.js';

export const CHAT_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
export const CHAT_RETENTION_DEFAULTS = Object.freeze({ enabled: false, idleDays: 7, batchLimit: 50 });
export const CHAT_RETENTION_MAX_DAYS = 3650;
export const CHAT_RETENTION_MAX_BATCH = 1000;

/** Title prefixes that mark a chat as technical (machine-started). */
const TECHNICAL_TITLE_RE = /^\s*\[(?:Watcher|Merge|Todo plan|Scout)\]/i;

/** @param {unknown} value */
function asString(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * True when the chat is a technical one: marker title or a delegation child.
 *
 * @param {Record<string, any> | null | undefined} chat
 * @returns {boolean}
 */
export function isTechnicalChat(chat) {
  if (!chat || typeof chat !== 'object') return false;
  if (TECHNICAL_TITLE_RE.test(asString(chat.title || chat.name))) return true;
  return Boolean(asString(chat.delegationParentChatId) || asString(chat.delegationRootChatId));
}

/**
 * @param {Record<string, any> | null} [settings]
 * @returns {{ enabled: boolean, idleDays: number, batchLimit: number }}
 */
export function getChatRetentionSettings(settings = null) {
  const raw = /** @type {any} */ (settings || loadSettings()).chatRetention;
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const days = Math.round(Number(cfg.idleDays));
  const batch = Math.round(Number(cfg.batchLimit));
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : CHAT_RETENTION_DEFAULTS.enabled,
    idleDays: days >= 1 && days <= CHAT_RETENTION_MAX_DAYS ? days : CHAT_RETENTION_DEFAULTS.idleDays,
    batchLimit: batch >= 1 && batch <= CHAT_RETENTION_MAX_BATCH ? batch : CHAT_RETENTION_DEFAULTS.batchLimit,
  };
}

/**
 * Validate and persist a partial config patch.
 *
 * @param {Record<string, any>} patch
 * @returns {{ ok: true, config: ReturnType<typeof getChatRetentionSettings> } | { ok: false, error: string }}
 */
export function updateChatRetentionSettings(patch) {
  const settings = loadSettings();
  const next = { ...getChatRetentionSettings(settings) };
  const input = patch && typeof patch === 'object' ? patch : {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
    next.enabled = input.enabled;
  }
  if (input.idleDays !== undefined) {
    const v = Math.round(Number(input.idleDays));
    if (!(v >= 1 && v <= CHAT_RETENTION_MAX_DAYS)) return { ok: false, error: `idleDays must be 1..${CHAT_RETENTION_MAX_DAYS}` };
    next.idleDays = v;
  }
  if (input.batchLimit !== undefined) {
    const v = Math.round(Number(input.batchLimit));
    if (!(v >= 1 && v <= CHAT_RETENTION_MAX_BATCH)) return { ok: false, error: `batchLimit must be 1..${CHAT_RETENTION_MAX_BATCH}` };
    next.batchLimit = v;
  }
  saveSettings(/** @type {any} */ ({ ...settings, chatRetention: next }));
  return { ok: true, config: next };
}

/**
 * Chat ids referenced by open (not done) todos, per workspace folder.
 *
 * @param {string} dataDir
 * @param {string} cwd
 * @param {typeof listTodos} listTodosFn
 * @returns {Promise<Set<string>>}
 */
async function loadOpenTodoChatIds(dataDir, cwd, listTodosFn) {
  const doc = await listTodosFn(dataDir, cwd);
  const ids = new Set();
  for (const item of Array.isArray(doc?.items) ? doc.items : []) {
    if (item?.status === 'done') continue;
    for (const id of [item.chatId, item.orchestratorChatId, item.claimedByChatId, ...(item.linkedChatIds || [])]) {
      const s = asString(id);
      if (s) ids.add(s);
    }
  }
  return ids;
}

/**
 * Compute the retention plan without writing anything. Both the dry-run report
 * and the apply consume this plan.
 *
 * @param {{
 *   config?: { idleDays: number, batchLimit: number },
 *   dataDir?: string,
 *   now?: number,
 *   limit?: number,
 *   deps?: Record<string, any>,
 * }} [options]
 * @returns {Promise<{
 *   idleDays: number, batchLimit: number, now: number,
 *   technicalIdle: number, eligible: number, selected: number, estimatedBytes: number,
 *   chats: { id: string, title: string, updatedAt: string, bytes: number }[],
 *   skipped: Record<string, number>, skippedTotal: number, reason: string,
 *   groups: Record<string, any>[][],
 * }>}
 */
export async function planChatRetention(options = {}) {
  const cfg = options.config || getChatRetentionSettings();
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const deps = options.deps || {};
  const limit = Math.max(1, Math.round(Number(options.limit) || cfg.batchLimit));
  const idleMs = cfg.idleDays * CHAT_RETENTION_DAY_MS;
  const listChildren = deps.listDelegationsForController || listDelegationsForController;
  const listForChat = deps.listDelegationsForChat || listDelegationsForChat;
  const terminalFn = deps.isTerminalDelegationStatus || isTerminalDelegationStatus;
  const slotFn = deps.isDelegationSlotOccupied || isDelegationSlotOccupied;
  const bytesOf = deps.estimateChatBytes
    || ((chat) => Buffer.byteLength(JSON.stringify(chat) || '', 'utf8'));
  const plan = {
    idleDays: cfg.idleDays, batchLimit: limit, now,
    technicalIdle: 0, eligible: 0, selected: 0, estimatedBytes: 0,
    chats: [], skipped: {}, skippedTotal: 0, reason: 'ok', groups: [],
  };
  const skip = (reason) => {
    plan.skipped[reason] = (plan.skipped[reason] || 0) + 1;
    plan.skippedTotal += 1;
  };

  let chats;
  try {
    chats = (deps.loadChats || loadChats)();
  } catch {
    plan.reason = 'load_failed';
    return plan;
  }
  if (!Array.isArray(chats)) {
    plan.reason = 'load_failed';
    return plan;
  }
  const byId = new Map(chats.map((c) => [asString(c?.id), c]));
  const chatArchivable = createChatArchivable({
    now, graceMs: idleMs, includeArchived: true,
    isChatRunConfirmedIdle: deps.isChatRunConfirmedIdle || createChatArchiveIdleProbe(),
  });
  const { collect } = createFamilyCollector({
    chats, chatArchivable, listDelegationsForController: listChildren,
    isTerminalDelegationStatus: terminalFn, isDelegationSlotOccupied: slotFn, now,
  });

  // Open-todo links are loaded lazily per workspace folder; a failed load
  // protects every chat of that workspace (fail closed).
  const dataDir = options.dataDir || deps.dataDir || resolveDataPath();
  const listTodosFn = deps.listTodos || listTodos;
  /** @type {Map<string, Set<string> | null>} */
  const todoCache = new Map();
  const todoLinks = async (cwd) => {
    if (!todoCache.has(cwd)) {
      try {
        todoCache.set(cwd, await loadOpenTodoChatIds(dataDir, cwd, listTodosFn));
      } catch {
        todoCache.set(cwd, null);
      }
    }
    return todoCache.get(cwd);
  };

  /** @param {Record<string, any>} chat */
  const hasPendingDelegation = (chat) => {
    try {
      const own = listForChat(asString(chat.id));
      const children = listChildren(asString(chat.id));
      return [...(Array.isArray(own) ? own : []), ...(Array.isArray(children) ? children : [])]
        .some((row) => !terminalFn(row?.status) || slotFn(row, now));
    } catch {
      return true;
    }
  };

  /** A delegation child must not be archived while its parent's row is live. */
  const hasLiveParentRow = (chat) => {
    const parentId = asString(chat.delegationParentChatId || chat.forkParentChatId);
    if (!parentId) return false;
    try {
      const rows = listChildren(parentId);
      if (!Array.isArray(rows)) return true;
      return rows.some((row) => asString(row?.childChatId) === asString(chat.id)
        && (!terminalFn(row?.status) || slotFn(row, now)));
    } catch {
      return true;
    }
  };

  const done = new Set();
  for (const chat of chats) {
    const id = asString(chat?.id);
    if (!id || done.has(id) || isChatAlreadyArchived(chat)) continue;
    if (!isTechnicalChat(chat)) continue; // ordinary chats are not even counted
    const updatedMs = Date.parse(asString(chat.updatedAt));
    if (!Number.isFinite(updatedMs)) { skip('invalid_timestamp'); continue; }
    if (now - updatedMs < idleMs) { skip('not_old_enough'); continue; }
    plan.technicalIdle += 1;
    if (!chatArchivable(chat)) { skip('active_or_pinned'); continue; }
    // Open-todo state is per member: each chat is checked against the todo
    // store of its OWN workspace (null = unreadable, fail closed).
    const todoState = async (member) => {
      const links = await todoLinks(asString(member?.workspaceFolder));
      if (links === null) return 'todos_unavailable';
      return links.has(asString(member?.id)) ? 'open_todo' : '';
    };
    const rootTodo = await todoState(chat);
    if (rootTodo) { skip(rootTodo); continue; }
    if (hasPendingDelegation(chat) || hasLiveParentRow(chat)) { skip('pending_delegation'); continue; }
    const family = collect(chat);
    if (!family) { skip('family_busy'); continue; }
    // The store cascades an archive over the fork subtree, so every member
    // must itself be technical, unlinked and delegation-free.
    let blocked = '';
    for (const member of family) {
      const mid = asString(member?.id);
      if (!isTechnicalChat(byId.get(mid) || member)) { blocked = 'family_has_ordinary_chat'; break; }
      blocked = await todoState(byId.get(mid) || member);
      if (blocked) break;
      if (mid !== id && (hasPendingDelegation(member) || hasLiveParentRow(member))) { blocked = 'pending_delegation'; break; }
    }
    if (blocked) { skip(blocked); continue; }
    // `updateChat({ archived: true })` cascades over the whole fork subtree of
    // the written chat. Refuse a family whose cascade reaches a chat that was
    // not vetted above, so plan counts and bytes equal what the store archives.
    const familyIds = new Set(family.map((m) => asString(m?.id)));
    const reach = [...collectForkSubtreeIds(chats, id)].map(asString);
    // Cascade members outside the family are also checked for open todos in
    // their own workspace so the reason is accurate (they are refused below).
    for (const rid of reach) {
      if (familyIds.has(rid) || !byId.has(rid)) continue;
      blocked = await todoState(byId.get(rid));
      if (blocked) break;
    }
    if (blocked) { skip(blocked); continue; }
    if (reach.some((rid) => !familyIds.has(rid) && byId.has(rid) && !isChatAlreadyArchived(byId.get(rid)))) {
      skip('cascade_exceeds_family');
      continue;
    }
    const fresh = family.filter((m) => !isChatAlreadyArchived(m) && !done.has(asString(m?.id)));
    if (!fresh.length) continue;
    plan.eligible += fresh.length;
    if (plan.selected + fresh.length > limit) { skip('batch_limit'); continue; }
    for (const m of fresh) {
      const mid = asString(m.id);
      done.add(mid);
      const bytes = bytesOf(byId.get(mid) || m);
      plan.selected += 1;
      plan.estimatedBytes += bytes;
      plan.chats.push({ id: mid, title: asString(m.title || m.name), updatedAt: asString(m.updatedAt), bytes });
    }
    plan.groups.push(family);
  }
  return plan;
}

/** Strip the internal groups from a plan for API output. */
function publicPlan(plan) {
  const { groups: _groups, ...rest } = plan;
  return rest;
}

/**
 * Dry-run report: what an apply would archive right now.
 *
 * @param {Parameters<typeof planChatRetention>[0]} [options]
 */
export async function reportChatRetention(options = {}) {
  return { dryRun: true, ...publicPlan(await planChatRetention(options)) };
}

/**
 * Archive the planned chats (at most `batchLimit`). Never throws on a single
 * failing write; failures are counted.
 *
 * @param {Parameters<typeof planChatRetention>[0]} [options]
 */
export async function applyChatRetention(options = {}) {
  const plan = await planChatRetention(options);
  const updateChatFn = options.deps?.updateChat || updateChat;
  const done = new Set();
  const archived = [];
  const wasArchived = new Set((options.deps?.loadChats || loadChats)()
    .filter((c) => isChatAlreadyArchived(c)).map((c) => asString(c?.id)));
  let failed = 0;
  for (const family of plan.groups) {
    const r = archiveFamilyMembers(family, { updateChat: updateChatFn, done });
    failed += r.skipped;
  }
  // Report what the store really archived (the write cascades over fork
  // subtrees), not what each write call claimed.
  const after = new Map((options.deps?.loadChats || loadChats)().map((c) => [asString(c?.id), c]));
  const planned = new Set(plan.chats.map((c) => c.id));
  for (const id of planned) if (isChatAlreadyArchived(after.get(id))) archived.push(id);
  const unexpected = [...after.values()].filter((c) => isChatAlreadyArchived(c)
    && !planned.has(asString(c.id)) && !wasArchived.has(asString(c.id))).map((c) => asString(c.id));
  const bytes = new Map(plan.chats.map((c) => [c.id, c.bytes]));
  return {
    dryRun: false,
    ...publicPlan(plan),
    archived: archived.length,
    archivedIds: archived,
    failed,
    unexpected,
    archivedBytes: archived.reduce((sum, id) => sum + (bytes.get(id) || 0), 0),
  };
}

/** Restore a retained chat from the archive (the existing single-action restore). */
export function restoreRetainedChat(chatId, deps = {}) {
  return (deps.updateChat || updateChat)(chatId, { archived: false });
}
