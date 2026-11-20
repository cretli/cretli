/**
 * Workspace integration lock and the bulk-integrate batch store.
 *
 * One JSON document under the data dir holds every batch record plus one lock
 * record per workspace. The lock serialises every flow that writes the logical
 * workspace on behalf of an integration: a bulk batch (`owner: 'batch'`) or a
 * single smart-merge / verify / git-branch merge (`owner: 'single'`).
 *
 * This module has no dependency on the integration code itself, so the lib
 * release points (`reportSmartMergeOutcome`, confirm, no-code, reject) can call
 * it without an import cycle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { probeChatRunLiveness } from './chat-run-service.js';

export const INTEGRATE_BATCH_STORE_FILE = 'integrate-batches.json';

/**
 * A just-started single flow has an idle chat until the browser sends the first
 * prompt; an idle probe inside this window is not release evidence.
 */
export const SINGLE_LOCK_IDLE_GRACE_MS = 60_000;

/**
 * A `single` lock that never got a chat (the start request died between taking
 * the lock and binding the chat) is reclaimable after this age.
 */
export const SINGLE_LOCK_ORPHAN_TTL_MS = 10 * 60_000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function integrateBatchStorePath(dataDir) {
  return path.join(dataDir, INTEGRATE_BATCH_STORE_FILE);
}

/**
 * @param {string} dataDir
 * @returns {{ version: number, batches: Record<string, Record<string, any>>, locks: Record<string, Record<string, any>> }}
 */
export function readIntegrateBatchStore(dataDir) {
  const empty = { version: 1, batches: {}, locks: {} };
  if (!dataDir) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(integrateBatchStorePath(dataDir), 'utf8'));
    return {
      version: 1,
      batches: parsed?.batches && typeof parsed.batches === 'object' ? parsed.batches : {},
      locks: parsed?.locks && typeof parsed.locks === 'object' ? parsed.locks : {},
    };
  } catch {
    return empty;
  }
}

/**
 * Read-modify-write the store. The callback mutates the document in place and
 * may return a value; a callback that throws writes nothing.
 *
 * @template T
 * @param {string} dataDir
 * @param {(doc: ReturnType<typeof readIntegrateBatchStore>) => T} mutate
 * @returns {T}
 */
export function mutateIntegrateBatchStore(dataDir, mutate) {
  const doc = readIntegrateBatchStore(dataDir);
  const result = mutate(doc);
  writeJsonAtomic(integrateBatchStorePath(dataDir), doc);
  return result;
}

/**
 * @param {string} workspaceFolder
 * @returns {string}
 */
function lockKey(workspaceFolder) {
  return path.resolve(readString(workspaceFolder) || '.');
}

/**
 * Current lock of a workspace. A `single` lock is released lazily here when its
 * chat is confirmed idle (past the grace window) or when it never got a chat
 * (past the orphan TTL). Unknown liveness (e.g. after a restart) and a busy
 * chat keep the lock: only positive idle evidence or an explicit clear frees it.
 *
 * @param {{ dataDir: string, workspaceFolder: string, now?: number, deps?: { isChatRunConfirmedIdle?: (input: { chatId: string }) => boolean, probeChatRunLiveness?: (input: { chatId: string }) => Record<string, any>, idleGraceMs?: number, orphanTtlMs?: number } }} input
 * @returns {Record<string, any> | null}
 */
export function getIntegrationLock(input) {
  const key = lockKey(input.workspaceFolder);
  const doc = readIntegrateBatchStore(input.dataDir);
  const lock = doc.locks[key] || null;
  if (!lock) return null;
  if (lock.owner !== 'single') return lock;
  const deps = input.deps || {};
  const age = (input.now ?? Date.now()) - Date.parse(lock.since || '');
  const release = () => {
    mutateIntegrateBatchStore(input.dataDir, (next) => {
      delete next.locks[key];
    });
    return null;
  };
  if (!lock.chatId) {
    const orphanTtl = Number.isFinite(deps.orphanTtlMs) ? deps.orphanTtlMs : SINGLE_LOCK_ORPHAN_TTL_MS;
    return age >= orphanTtl ? release() : lock;
  }
  const grace = Number.isFinite(deps.idleGraceMs) ? deps.idleGraceMs : SINGLE_LOCK_IDLE_GRACE_MS;
  if (!(age >= grace)) return lock;
  let live = { known: false, busy: false };
  try {
    if (typeof deps.isChatRunConfirmedIdle === 'function') {
      live = deps.isChatRunConfirmedIdle({ chatId: lock.chatId }) === true
        ? { known: true, busy: false }
        : { known: false, busy: false };
    } else {
      const probe = typeof deps.probeChatRunLiveness === 'function' ? deps.probeChatRunLiveness : probeChatRunLiveness;
      const result = probe({ chatId: lock.chatId });
      live = { known: result?.known === true, busy: result?.busy === true };
    }
  } catch {
    live = { known: false, busy: false };
  }
  if (live.known && !live.busy) return release();
  return lock;
}

/**
 * Take the workspace lock. Idempotent for the same owner/batch/todo.
 *
 * @param {{ dataDir: string, workspaceFolder: string, owner: 'batch' | 'single', batchId?: string, todoId?: string, chatId?: string, now?: string, deps?: Record<string, any> }} input
 * @returns {{ ok: boolean, lock: Record<string, any> | null }}
 */
export function acquireIntegrationLock(input) {
  const existing = getIntegrationLock(input);
  const batchId = readString(input.batchId);
  const todoId = readString(input.todoId);
  if (existing) {
    const same = existing.owner === input.owner
      && readString(existing.batchId) === batchId
      && readString(existing.todoId) === todoId;
    if (!same) return { ok: false, lock: existing };
  }
  const lock = {
    owner: input.owner,
    ...(batchId ? { batchId } : {}),
    todoId,
    chatId: readString(input.chatId),
    since: existing?.since || input.now || new Date().toISOString(),
  };
  mutateIntegrateBatchStore(input.dataDir, (doc) => {
    doc.locks[lockKey(input.workspaceFolder)] = lock;
  });
  return { ok: true, lock };
}

/**
 * Refuse-or-pass check used by the mutating routes.
 *
 * @param {{ dataDir: string, workspaceFolder: string, deps?: Record<string, any> }} input
 * @returns {{ ok: boolean, lock?: Record<string, any> }}
 */
export function checkIntegrationUnlocked(input) {
  const lock = getIntegrationLock(input);
  return lock ? { ok: false, lock } : { ok: true };
}

/**
 * Update the chat bound to the current lock (after the route created it).
 *
 * @param {{ dataDir: string, workspaceFolder: string, batchId?: string, todoId?: string, chatId: string }} input
 * @returns {boolean}
 */
export function bindIntegrationLockChat(input) {
  const key = lockKey(input.workspaceFolder);
  return mutateIntegrateBatchStore(input.dataDir, (doc) => {
    const lock = doc.locks[key];
    if (!lock) return false;
    if (input.batchId && readString(lock.batchId) !== readString(input.batchId)) return false;
    lock.chatId = readString(input.chatId);
    return true;
  });
}

/**
 * Release a `single` lock when it belongs to one of the named todos. A batch
 * lock is never released here: only a terminal batch state does that.
 *
 * @param {{ dataDir?: string, workspaceFolder?: string, todoIds?: string[] }} input
 * @returns {boolean}
 */
export function releaseSingleIntegrationLock(input = {}) {
  if (!input.dataDir || !input.workspaceFolder) return false;
  try {
    const key = lockKey(input.workspaceFolder);
    const doc = readIntegrateBatchStore(input.dataDir);
    const lock = doc.locks[key];
    if (!lock || lock.owner !== 'single') return false;
    const ids = new Set((input.todoIds || []).map(readString).filter(Boolean));
    if (!ids.has(readString(lock.todoId))) return false;
    delete doc.locks[key];
    writeJsonAtomic(integrateBatchStorePath(input.dataDir), doc);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the lock of a terminal batch.
 *
 * @param {{ dataDir: string, workspaceFolder: string, batchId: string }} input
 * @returns {boolean}
 */
export function releaseBatchIntegrationLock(input) {
  const key = lockKey(input.workspaceFolder);
  return mutateIntegrateBatchStore(input.dataDir, (doc) => {
    const lock = doc.locks[key];
    if (!lock || lock.owner !== 'batch' || readString(lock.batchId) !== readString(input.batchId)) return false;
    delete doc.locks[key];
    return true;
  });
}

/**
 * Explicit operator clear of a `single` lock (or an orphan batch lock whose
 * batch is missing or terminal). A still-running agent may keep writing.
 *
 * @param {{ dataDir: string, workspaceFolder: string }} input
 * @returns {{ ok: boolean, reason?: string, cleared?: Record<string, any> }}
 */
export function clearIntegrationLock(input) {
  const key = lockKey(input.workspaceFolder);
  const doc = readIntegrateBatchStore(input.dataDir);
  const lock = doc.locks[key];
  if (!lock) return { ok: false, reason: 'no_lock' };
  if (lock.owner === 'batch') {
    const batch = doc.batches[readString(lock.batchId)];
    const terminal = !batch || ['completed', 'cancelled', 'abandoned'].includes(batch.status);
    if (!terminal) return { ok: false, reason: 'batch_owned', batchId: lock.batchId };
  }
  delete doc.locks[key];
  writeJsonAtomic(integrateBatchStorePath(input.dataDir), doc);
  return { ok: true, cleared: lock };
}
