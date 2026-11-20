/**
 * SQLite adapter of the chats facade. It wraps the worker handlers of `lib/storage/chats-store.js`
 * (ADR docs/storage-chats-metadata-decision.md, sections 4 and 6); production is NOT switched to it by this module.
 *
 * Semantics:
 * - The domain rules (normalisation, title source, parent-cycle check, archive gate, ...) are the SAME functions the
 *   legacy adapter runs (`chats-backend-domain.js`), applied to a private copy of the row (or of the few rows an
 *   operation touches). The result is diffed against the committed row and submitted as `chats.update` with
 *   `expectedRevision` (CAS on `revision`).
 * - Every write is a command with a caller-owned `commandId` (and the store's payload digest). On `unknown_commit`
 *   the adapter calls `resolveUnknown` with the same command before anything else: committed => the stored result,
 *   not committed => the same command is retried, unreconcilable / digest mismatch => the error is rethrown
 *   (fail closed).
 * - A CAS conflict re-reads fresh committed state and re-runs the operation, 3 attempts in total, then `CONFLICT`.
 * - The committed-row cache and every observable effect (list broadcast, push, title history, archive listeners) are
 *   published only AFTER the command resolved; a rejected or unknown command publishes nothing.
 *
 * Cross-row parts of `updateChat` (restore of a subtree, widget-pin dedupe) commit through `chats.updateMany`: one
 * transaction, a CAS check on every row, all rows or none. Only rows whose content actually changes are sent; if
 * they exceed the store's batch limits (200 rows / 240 KiB) the operation is rejected up-front with
 * `chats_subtree_too_large` and nothing is written (splitting would break atomicity). `removeChat` cascades to the subtree (handler semantics)
 * where the legacy file code removed only the row; whole-collection reads (`loadChats`, `peekChats`) are paged
 * compatibility reads (docs/storage-chats-b-caller-inventory.md).
 */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  addChatLookupIds,
  applyAutoTitleToRow,
  applyChatUpdates,
  applyReadMarks,
  applySessionField,
  applyTitleLock,
  isTemporaryForkOf,
  migrateWorkspaceIdsOnList,
  planAddChat,
  publishAutoTitle,
  publishChatCreated,
  publishChatRead,
  publishChatUpdated,
  publishTitleLock,
  rotatedSdkChat,
} from './chats-backend-domain.js';
import { CHATS_BATCH_MAX_ITEMS, CHATS_MAX_PAYLOAD_BYTES } from '../storage/chats-store.js';
import { ChatsBackendError } from './chats-backend-marker.js';
import { CHATS_BACKEND_OPERATIONS } from './chats-backend-legacy.js';

export const CHATS_MAX_COMMIT_ATTEMPTS = 3;
const GET_MANY = 200;
const PAGE_LIMIT = 500;
const PARENT_WALK_LIMIT = 64;
const READ_MARK_KEYS = Object.freeze(['lastSeenAt', 'lastFinishedAt']);

/** @param {string} code @param {string} message @returns {Error & { code: string }} */
function codedError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

/** @param {unknown} err @returns {string} */
function conflictKind(err) {
  return String(/** @type {any} */ (err)?.details?.conflictKind ?? '');
}

/**
 * Field-level patch that turns `before` into `after`.
 *
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {{ set: Record<string, any>, unset: string[] }}
 */
export function diffChat(before, after) {
  const set = {};
  const unset = [];
  for (const key of Object.keys(after)) {
    if (key !== 'id' && !(key in before && isDeepStrictEqual(before[key], after[key]))) set[key] = after[key];
  }
  for (const key of Object.keys(before)) {
    if (key !== 'id' && !(key in after)) unset.push(key);
  }
  return { set, unset };
}

/** @param {Record<string, any>} chat @returns {Record<string, any>} */
function cloneChat(chat) {
  return structuredClone(chat);
}

/**
 * @typedef {{
 *   created: typeof publishChatCreated,
 *   updated: typeof publishChatUpdated,
 *   read: typeof publishChatRead,
 *   autoTitle: typeof publishAutoTitle,
 *   titleLock: typeof publishTitleLock,
 * }} ChatsEffects
 */

/**
 * @param {{
 *   store: ReturnType<typeof import('../storage/chats-store.js').createChatsStore>,
 *   effects?: Partial<ChatsEffects>,
 *   newCommandId?: () => string,
 *   cacheLimit?: number,
 * }} options `effects` and `newCommandId` are test seams
 * @returns {Record<string, (...args: any[]) => Promise<any>> & { cacheStats: () => { entries: number }, peekCachedRevision: (id: string) => number | null }}
 */
export function createSqliteChatsBackend(options) {
  const { store } = options;
  const newCommandId = options.newCommandId ?? (() => randomUUID());
  const cacheLimit = options.cacheLimit ?? 500;
  /** @type {ChatsEffects} */
  const effects = {
    created: publishChatCreated, updated: publishChatUpdated, read: publishChatRead,
    autoTitle: publishAutoTitle, titleLock: publishTitleLock, ...options.effects,
  };

  /** Committed rows only, keyed by id: `{ revision, chat }`. Filled from worker replies, never speculatively. @type {Map<string, { revision: number, chat: Record<string, any> }>} */
  const cache = new Map();

  /** @param {string} id @param {number} revision @param {Record<string, any>} chat */
  function cachePut(id, revision, chat) {
    cache.delete(id);
    cache.set(id, { revision, chat: cloneChat(chat) });
    if (cache.size > cacheLimit) cache.delete(/** @type {string} */ (cache.keys().next().value));
  }

  /**
   * One write command with `unknown_commit` reconciliation. Returns the handler result.
   *
   * @param {'add' | 'update' | 'updateMany' | 'remove' | 'archive' | 'markRead' | 'importBatch'} operation
   * @param {Record<string, any>} payload
   * @returns {Promise<any>}
   */
  async function write(operation, payload) {
    const commandId = newCommandId();
    /** @type {unknown} */
    let lastUnknown;
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const reply = await /** @type {any} */ (store)[operation]({ commandId, ...payload });
        return reply.result;
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'unknown_commit') throw err;
        lastUnknown = err;
        // Throws for an unreconcilable command or a digest mismatch: the caller sees the failure (fail closed).
        const verdict = await store.resolveUnknown({ commandId, operation, ...payload, error: err });
        if (verdict.outcome === 'committed') return verdict.result;
        // not committed: the very same command (id + payload) is safe to submit again.
      }
    }
    throw lastUnknown;
  }

  /** @param {string} id @returns {Promise<{ chat: Record<string, any>, revision: number } | null>} */
  async function readFresh(id) {
    const row = await store.get({ id });
    if (!row) { cache.delete(id); return null; }
    cachePut(id, row.revision, row.chat);
    return { chat: cloneChat(row.chat), revision: row.revision };
  }

  /** @param {string[]} ids @returns {Promise<Map<string, { chat: Record<string, any>, revision: number, position: number }>>} */
  async function readMany(ids) {
    const out = new Map();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += GET_MANY) {
      const res = await store.getMany({ ids: unique.slice(i, i + GET_MANY) });
      for (const row of res.chats) {
        cachePut(row.chat.id, row.revision, row.chat);
        out.set(row.chat.id, { chat: cloneChat(row.chat), revision: row.revision, position: row.position });
      }
    }
    return out;
  }

  /** Paged read of the whole collection in legacy order (position). Compatibility read, not a hot path. */
  async function readAll() {
    const ids = [];
    let cursor = null;
    let storeRevision = 0;
    do {
      const page = await store.page({ archived: 'all', limit: PAGE_LIMIT, cursor });
      for (const item of page.items) ids.push(item.id);
      storeRevision = page.storeRevision;
      cursor = page.nextCursor;
    } while (cursor);
    const rows = await readMany(ids);
    const chats = [...rows.values()].sort((a, b) => a.position - b.position).map((r) => r.chat);
    return { chats, revision: String(storeRevision) };
  }

  /**
   * Retry wrapper: `attempt()` returns the outcome or throws; a CAS conflict re-runs it on fresh state.
   *
   * @template T
   * @param {() => Promise<T>} attempt
   * @returns {Promise<T>}
   */
  async function withCasRetry(attempt) {
    for (let n = 1; n <= CHATS_MAX_COMMIT_ATTEMPTS; n += 1) {
      try {
        return await attempt();
      } catch (err) {
        if (conflictKind(err) !== 'chat_cas') throw err;
        cache.clear();
      }
    }
    throw codedError('CONFLICT', 'Chats were updated by another writer; retry the request');
  }

  /**
   * Commit the patch of one row. Returns the new revision.
   *
   * @param {string} id
   * @param {number} expectedRevision
   * @param {Record<string, any>} before
   * @param {Record<string, any>} after
   * @returns {Promise<number | null>} null when nothing differs
   */
  async function commitRow(id, expectedRevision, before, after) {
    const { set, unset } = diffChat(before, after);
    if (Object.keys(set).length === 0 && unset.length === 0) return null;
    const result = await write('update', { id, expectedRevision, set, unset });
    cachePut(id, result.revision, after);
    return result.revision;
  }

  /**
   * Single-row mutation: fresh read, domain function on a private copy, one CAS command, effects after COMMIT.
   *
   * @template T
   * @param {string} id
   * @param {(chat: Record<string, any>) => { write: boolean, value: any, after?: (chat: Record<string, any>) => void }} run
   * @param {T} missing value for an unknown chat
   * @returns {Promise<T>}
   */
  function mutateOne(id, run, missing) {
    return withCasRetry(async () => {
      const row = await readFresh(id);
      if (!row) return missing;
      const before = cloneChat(row.chat);
      const plan = run(row.chat);
      if (!plan.write) return plan.value;
      await commitRow(id, row.revision, before, row.chat);
      plan.after?.(row.chat);
      return plan.value;
    });
  }

  const backend = {
    async pageChats(query = {}) {
      const scope = query.scope?.widgetInstallationId
        ? { widget: { installationId: query.scope.widgetInstallationId, pageSessionId: query.scope.widgetPageSessionId || '', workspaceFile: query.scope.workspaceFile || '', workspaceFolder: query.scope.workspaceFolder || '' } }
        : query.scope;
      const result = await store.page({ scope, archived: query.archived, limit: query.limit, cursor: query.cursor });
      // The index rows carry only list columns and light_json; extra_json fields (delegation ids, pick purpose, ...)
      // are needed by DTOs and route gates, so the page is hydrated with one batched getMany per GET_MANY ids.
      const listRows = [...result.items, ...(result.ancestors || [])];
      const full = await readMany(listRows.map((row) => row.id));
      const hydrate = (row) => {
        const { lastActivityAt: _a, revision: _r, position: _p, ancestor: _anc, ...light } = row;
        return full.get(row.id)?.chat || light;
      };
      const items = result.items.map(hydrate);
      const ancestors = result.ancestors ? result.ancestors.map(hydrate) : undefined;
      return {
        ...result, items, ...(ancestors ? { ancestors } : {}),
        chats: [...items, ...(ancestors || [])], revision: String(result.storeRevision),
      };
    },
    async chatCounts(query = {}) {
      const scope = query.scope?.widgetInstallationId
        ? { widget: { installationId: query.scope.widgetInstallationId, pageSessionId: query.scope.widgetPageSessionId || '', workspaceFile: query.scope.workspaceFile || '', workspaceFolder: query.scope.workspaceFolder || '' } }
        : query.scope;
      const [counts, archivedCounts] = await Promise.all([store.counts({ scope }), store.archivedCountsByWorkspace({ scope })]);
      return { ...counts, archivedCounts: archivedCounts.counts, revision: String(counts.storeRevision) };
    },
    loadChats: async () => (await readAll()).chats,
    loadChatsSnapshot: async () => readAll(),
    readChatsStrict: async () => readAll(),
    peekChatsSnapshot: async () => readAll(),
    peekChats: async () => (await readAll()).chats,

    async peekChatsByIds(ids) {
      const wanted = [...ids].map((id) => String(id || '').trim()).filter(Boolean);
      const missing = wanted.filter((id) => !cache.has(id));
      const fetched = missing.length > 0 ? await readMany(missing) : new Map();
      const out = [];
      for (const id of wanted) {
        const hit = fetched.get(id)?.chat ?? cache.get(id)?.chat;
        if (hit) out.push(cloneChat(hit));
      }
      return out;
    },

    async getChatById(id) {
      const key = String(id || '').trim();
      if (!key) return null;
      const row = await readFresh(key);
      return row ? row.chat : null;
    },

    async getChatByCursorSessionId(cursorSessionId) {
      const row = await store.byCursorSession({ cursorSessionId });
      if (!row) return null;
      cachePut(row.chat.id, row.revision, row.chat);
      return cloneChat(row.chat);
    },

    async saveChats() {
      throw codedError('chats_save_all_unsupported', 'The sqlite chats backend has no whole-collection write; use the row operations');
    },

    async addChat(cursorSessionId, title, workspaceFile, workspaceFolder, model, extras = null) {
      return withCasRetry(async () => {
        const ids = addChatLookupIds(extras);
        const found = ids.length > 0 ? await readMany(ids) : new Map();
        const total = (await store.counts({})).total;
        const view = { find: (/** @type {string} */ id) => found.get(id)?.chat, total };
        const plan = planAddChat(view, cursorSessionId, title, workspaceFile, workspaceFolder, model, extras);
        if ('existing' in plan) return plan.existing;
        try {
          const result = await write('add', { chat: plan.entry });
          cachePut(plan.entry.id, result.revision, plan.entry);
        } catch (err) {
          if (conflictKind(err) !== 'chat_exists') throw err;
          // Lost a race on the same reserved id: the winner's row is the answer, exactly as for a repeated call.
          const existing = await readFresh(plan.entry.id);
          if (existing) return existing.chat;
          throw err;
        }
        effects.created(plan.entry);
        return plan.entry;
      });
    },

    async removeChat(id) {
      await withCasRetry(async () => {
        const row = await readFresh(id);
        if (!row) return;
        await write('remove', { id, expectedRevision: row.revision });
        // The handler removes the subtree; drop what this process may still hold of it.
        cache.clear();
      });
    },

    async deleteTemporaryForkChats(parentChatId, forkKind) {
      const candidates = [];
      let afterId;
      do {
        const page = await store.children({ parentId: parentChatId, afterId });
        for (const item of page.items) if (isTemporaryForkOf(item, parentChatId, forkKind)) candidates.push(item.id);
        afterId = page.nextAfterId ?? undefined;
      } while (afterId);
      if (candidates.length === 0) return [];
      const rows = await readMany(candidates);
      const doomed = [];
      for (const id of candidates) {
        const row = rows.get(id);
        if (!row) continue;
        await withCasRetry(async () => {
          const fresh = await readFresh(id);
          if (!fresh) return;
          await write('remove', { id, expectedRevision: fresh.revision });
          doomed.push(row.chat);
        });
      }
      cache.clear();
      return doomed;
    },

    async updateChat(id, updates) {
      return withCasRetry(async () => {
        const root = await readFresh(id);
        if (!root) return null;
        const members = new Map([[id, root]]);
        const note = (/** @type {Map<string, any>} */ rows) => { for (const [k, v] of rows) if (!members.has(k)) members.set(k, v); };

        if (Object.prototype.hasOwnProperty.call(updates, 'forkParentChatId')) {
          // The new parent and its ancestors: existence, cycle and "parent archived" checks need exactly these rows.
          let next = updates.forkParentChatId == null ? '' : String(updates.forkParentChatId).trim();
          for (let hops = 0; next && hops < PARENT_WALK_LIMIT && !members.has(next); hops += 1) {
            const row = await readFresh(next);
            if (!row) break;
            members.set(next, row);
            next = typeof row.chat.forkParentChatId === 'string' ? row.chat.forkParentChatId.trim() : '';
          }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'archived')) {
          const ids = [];
          let afterId;
          do {
            const page = await store.subtree({ id, afterId });
            for (const item of page.items) ids.push(item.id);
            afterId = page.nextAfterId ?? undefined;
          } while (afterId);
          note(await readMany(ids));
        }
        const pinned = typeof updates.widgetPinnedUrl === 'string' ? updates.widgetPinnedUrl.trim() : '';
        const widgetKey = { installationId: root.chat.widgetInstallationId, pageSessionId: root.chat.widgetPageSessionId };
        if (pinned && widgetKey.installationId && typeof widgetKey.pageSessionId === 'string') {
          // Pin dedupe is limited to the widget scope of this chat: the handlers have no index on the pinned URL.
          const ids = [];
          let cursor = null;
          do {
            const page = await store.page({ scope: { widget: widgetKey }, archived: 'all', limit: PAGE_LIMIT, cursor });
            for (const item of page.items) if (item.widgetPinnedUrl && !members.has(item.id)) ids.push(item.id);
            cursor = page.nextCursor;
          } while (cursor);
          note(await readMany(ids));
        }

        const order = [id, ...[...members.keys()].filter((key) => key !== id)];
        const list = order.map((key) => /** @type {any} */ (members.get(key)).chat);
        const befores = list.map(cloneChat);
        const info = applyChatUpdates(list, 0, id, updates);
        list[0].updatedAt = new Date().toISOString();
        // All affected rows commit in ONE `chats.updateMany` transaction with a CAS check on every row's revision:
        // a stale row or a failure on any row leaves every row unchanged (then CAS conflicts re-run the whole operation).
        const batch = [];
        for (let i = 0; i < order.length; i += 1) {
          const { set, unset } = diffChat(befores[i], list[i]);
          if (Object.keys(set).length === 0 && unset.length === 0) continue;
          batch.push({ id: order[i], expectedRevision: /** @type {any} */ (members.get(order[i])).revision, set, unset });
        }
        if (batch.length > CHATS_BATCH_MAX_ITEMS
          || Buffer.byteLength(JSON.stringify({ updates: batch }), 'utf8') > CHATS_MAX_PAYLOAD_BYTES) {
          // Explicit, fail-closed boundary: one atomic command cannot carry more than the store's batch limits, and
          // splitting it would break atomicity. Checked before any write, so zero rows change.
          throw codedError('chats_subtree_too_large', `Update would change ${batch.length} chats in one transaction (limit ${CHATS_BATCH_MAX_ITEMS} rows / ${CHATS_MAX_PAYLOAD_BYTES} bytes); nothing was changed`);
        }
        if (batch.length === 1) {
          const [only] = batch;
          const result = await write('update', only);
          cachePut(only.id, result.revision, list[order.indexOf(only.id)]);
        } else if (batch.length > 1) {
          const result = await write('updateMany', { updates: batch });
          const revisions = new Map(result.rows.map((/** @type {any} */ r) => [r.id, r.revision]));
          for (let i = 0; i < order.length; i += 1) {
            if (revisions.has(order[i])) cachePut(order[i], revisions.get(order[i]), list[i]);
          }
        }
        effects.updated(id, list[0], updates, info);
        return { ...list[0] };
      });
    },

    async markChatReadState(id, marks = {}) {
      return withCasRetry(async () => {
        const row = await readFresh(id);
        if (!row) return null;
        const previous = { ...row.chat };
        const state = applyReadMarks(row.chat, marks);
        if (!state) return null;
        const changed = {};
        for (const key of READ_MARK_KEYS) if (row.chat[key] !== previous[key]) changed[key] = row.chat[key];
        const result = await write('markRead', { id, expectedRevision: row.revision, marks: changed });
        cachePut(id, result.revision, row.chat);
        effects.read(id, state);
        return state;
      });
    },

    async applyAutoTitle(id, title, options = {}) {
      return mutateOne(id, (chat) => {
        const outcome = applyAutoTitleToRow(chat, title, options);
        if (!outcome.applied) return { write: false, value: { applied: false, skipped: outcome.skipped, chat } };
        return {
          write: true,
          value: { applied: true, chat: { ...chat } },
          after: (committed) => effects.autoTitle(id, committed, outcome.nextTitle, options.reason),
        };
      }, { applied: false, skipped: 'not_found', chat: null });
    },

    async setChatTitleLocked(id, locked) {
      return mutateOne(id, (chat) => {
        if (!applyTitleLock(chat, locked)) return { write: false, value: chat };
        return { write: true, value: { ...chat }, after: (committed) => effects.titleLock(id, committed) };
      }, null);
    },

    async setChatSessionField(id, field, value) {
      return mutateOne(id, (chat) => {
        if (!applySessionField(chat, field, value)) return { write: false, value: chat };
        return { write: true, value: { ...chat } };
      }, null);
    },

    async rotateChatSdkSession(id) {
      return withCasRetry(async () => {
        const row = await readFresh(id);
        if (!row) return null;
        const next = rotatedSdkChat(row.chat);
        await commitRow(id, row.revision, row.chat, next);
        return { ...next };
      });
    },

    async migrateChatWorkspaceIds(settings, options = {}) {
      const { chats } = await readAll();
      const before = new Map(chats.map((chat) => [chat.id, cloneChat(chat)]));
      const report = migrateWorkspaceIdsOnList(chats, settings, options);
      if (!report.dryRun) {
        const updates = chats.filter((chat) => !isDeepStrictEqual(before.get(chat.id), chat));
        for (let offset = 0; offset < updates.length; offset += CHATS_BATCH_MAX_ITEMS) {
          const batch = updates.slice(offset, offset + CHATS_BATCH_MAX_ITEMS);
          for (let attempt = 0; attempt < CHATS_MAX_COMMIT_ATTEMPTS; attempt += 1) {
            const rows = await readMany(batch.map((chat) => chat.id));
            const active = batch.filter((chat) => rows.has(chat.id) && !String(rows.get(chat.id).chat.workspaceId || '').trim());
            if (active.length === 0) break;
            const updateMany = active.map((chat) => {
              const row = rows.get(chat.id);
              return { id: chat.id, expectedRevision: row.revision, set: { workspaceId: chat.workspaceId }, unset: [] };
            });
            try {
              const result = await write('updateMany', { updates: updateMany });
              const revisions = new Map((result.rows || []).map((row) => [row.id, row.revision]));
              for (const chat of active) {
                const row = rows.get(chat.id);
                cachePut(chat.id, revisions.get(chat.id) ?? row.revision + 1, { ...row.chat, workspaceId: chat.workspaceId });
              }
              break;
            } catch (err) {
              if (!['chat_cas', 'chat_not_found'].includes(conflictKind(err)) || attempt + 1 >= CHATS_MAX_COMMIT_ATTEMPTS) throw err;
            }
          }
        }
      }
      return report;
    },

    async importChatsBatch(entries) {
      const existing = await readMany(entries.map((entry) => entry.id));
      const ids = new Set(existing.keys());
      const addedEntries = entries.filter((entry) => {
        if (ids.has(entry.id)) return false;
        ids.add(entry.id);
        return true;
      });
      if (addedEntries.length === 0) {
        return { added: 0, addedIds: [], revision: (await store.page({ archived: 'all', limit: 1, cursor: null })).storeRevision };
      }
      const addedIds = [];
      let result = null;
      try {
        for (let offset = 0; offset < addedEntries.length; offset += CHATS_BATCH_MAX_ITEMS) {
          const batch = addedEntries.slice(offset, offset + CHATS_BATCH_MAX_ITEMS);
          result = await write('importBatch', { chats: batch });
          for (const entry of batch) {
            addedIds.push(String(entry.id));
            cachePut(entry.id, 1, entry);
          }
        }
      } catch (err) {
        await backend.rollbackImportedChats(addedIds);
        throw err;
      }
      return { ...(result || {}), added: addedIds.length, addedIds, revision: result?.storeRevision ?? (await store.page({ archived: 'all', limit: 1, cursor: null })).storeRevision };
    },

    async rollbackImportedChats(ids) {
      for (let offset = 0; offset < ids.length; offset += CHATS_BATCH_MAX_ITEMS) {
        for (const id of ids.slice(offset, offset + CHATS_BATCH_MAX_ITEMS)) {
          const row = await readFresh(id);
          if (!row) continue;
          await write('remove', { id, expectedRevision: row.revision });
          cache.delete(id);
        }
      }
    },

    cacheStats: () => ({ entries: cache.size }),
    peekCachedRevision: (id) => cache.get(id)?.revision ?? null,
  };

  for (const name of CHATS_BACKEND_OPERATIONS) {
    if (typeof /** @type {any} */ (backend)[name] !== 'function') throw new ChatsBackendError('chats_backend_incomplete', `The sqlite chats backend is missing ${name}`);
  }
  return /** @type {any} */ (Object.freeze(backend));
}
