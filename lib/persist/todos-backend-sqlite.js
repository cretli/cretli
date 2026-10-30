/**
 * SQLite backend of the todos facade (`lib/persist/todos-store.js`), selected by the
 * `todos-backend.json` marker. It sits on the storage worker's todos handlers
 * (`lib/storage/todos-store.js`); production is NOT switched to it by this module.
 *
 * Semantics. The domain rules (title/body/status normalisation, tree invariants, idempotency,
 * activity, review snapshots, leaf auto-close) live in `todos-persist.js` and stay there. Each
 * mutation therefore runs the very same legacy function against a PRIVATE OVERLAY: a scratch
 * copy of the workspace document that only this request can see. The overlay result is diffed
 * against the committed document and submitted as ONE worker transaction (`todos.batch`, or
 * `todos.importDocument` for a reorder/oversized diff) with `expectedUpdatedAt` CAS per item and a
 * document-level CAS. Everything observable happens after the worker resolved:
 *
 * - the committed cache is never written before COMMIT; after a successful command the entry is
 *   invalidated and rebuilt from the committed rows on the next read (also after a restart);
 * - the autopilot nudge collected from the overlay run is published after COMMIT only;
 * - a CAS conflict against another writer re-runs the operation on fresh committed state
 *   (bounded), then surfaces as `CONFLICT`; a rejected command changes nothing.
 *
 * Reads never ask the worker for a whole document in one result: a cache miss rebuilds the committed
 * document from byte-bounded pages (`todos.exportPage`), so the 4 MiB worker result cap is independent of the
 * workspace size. The overlay scratch file is kept while the committed revision is unchanged, so a no-op command
 * (the legacy function wrote nothing) neither rewrites the document nor submits anything to the worker, and
 * the diff compares rows structurally instead of serialising them.
 *
 * Known limits (see docs/storage-contract.md, "Todos SQLite backend"): the facade contract returns whole
 * documents, so a changing command still writes the overlay on the main thread, and
 * `commitWatcherTodoCommand` spans the watcher JSON document and the SQLite todo, so it is
 * version-checked with a compensating restore rather than one transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  forgetTodosDocumentCache,
  workspaceKeyFromCwd,
  withTodosWatcherNudgeSuppressed,
  withTodosNudgeSink,
} from './todos-persist.js';
import {
  overlayAddTodo as legacyAddTodo,
  overlayLoadTodosData as legacyLoadTodosData,
  overlayUpdateTodo as legacyUpdateTodo,
  deleteTodo as legacyDeleteTodo,
  writeTodoReview as legacyWriteTodoReview,
  writeTodoReviewBatch as legacyWriteTodoReviewBatch,
  closeTodoLeafIfEligible as legacyCloseTodoLeafIfEligible,
} from './todos-legacy-adapter.js';
import {
  createMoveError, listMoveBlockers, requireTargetFolder, TODO_MOVE_ERROR_CODES, unlinkSourceChats,
} from './todos-legacy-move-adapter.js';
import {
  loadWorkspaceWatchersDocument, mutateWorkspaceWatcherRow, normalizeWorkspaceFolder, withWorkspaceWatchersFileLock,
  workspaceWatchersDocumentCasToken,
} from './workspace-watchers-persist.js';
import { collectTodoSubtreeIds } from '../todo-tree.js';
import { TODOS_BATCH_MAX_OPS } from '../storage/todos-store.js';

/** Conflict kinds that mean "another writer changed the document": re-run on fresh state. */
const RETRYABLE_KINDS = new Set(['todo_cas', 'todo_doc_cas', 'todo_exists', 'todo_not_found']);
const MAX_COMMIT_ATTEMPTS = 3;

/** @param {string} code @param {string} message @returns {Error & { code: string }} */
function codedError(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

/** Deep equality that ignores object key order (a legacy rewrite may reorder keys); never serialises. */
function sameValue(a, b) {
  return a === b || isDeepStrictEqual(a, b);
}

/**
 * Operations that turn `raw` (committed document or null) into `post`.
 *
 * @param {string} workspaceKey
 * @param {Record<string, any> | null} raw
 * @param {Record<string, any>} post
 * @returns {{ ops: Record<string, any>[], inverse: Record<string, any>[], needsImport: boolean, changed: boolean }}
 */
export function diffDocuments(workspaceKey, raw, post) {
  const rawItems = raw?.items ?? [];
  const postItems = post.items ?? [];
  const rawById = new Map(rawItems.map((item) => [item.id, item]));
  const postById = new Map(postItems.map((item) => [item.id, item]));
  /** @type {Record<string, any>[]} */
  const ops = [];
  /** @type {Record<string, any>[]} */
  const inverse = [];
  const keptRaw = rawItems.filter((item) => postById.has(item.id)).map((item) => item.id);
  const keptPost = postItems.filter((item) => rawById.has(item.id)).map((item) => item.id);
  const prefixKept = postItems.slice(0, keptPost.length).every((item) => rawById.has(item.id));
  const needsImport = keptRaw.join('\u0000') !== keptPost.join('\u0000') || !prefixKept;
  let changed = false;
  for (const item of rawItems) {
    if (postById.has(item.id)) continue;
    changed = true;
    ops.push({ op: 'delete', workspaceKey, id: item.id, expectedUpdatedAt: item.updatedAt });
    inverse.push({ op: 'add', workspaceKey, item });
  }
  for (const item of postItems) {
    const before = rawById.get(item.id);
    if (!before) {
      changed = true;
      ops.push({ op: 'add', workspaceKey, item });
      inverse.push({ op: 'delete', workspaceKey, id: item.id, expectedUpdatedAt: item.updatedAt });
      continue;
    }
    if (sameValue(before, item)) continue;
    changed = true;
    const set = {};
    const unset = [];
    const undo = {};
    const undoUnset = [];
    for (const key of Object.keys(item)) {
      if (key !== 'id' && !sameValue(before[key], item[key])) {
        set[key] = item[key];
        if (key in before) undo[key] = before[key]; else undoUnset.push(key);
      }
    }
    for (const key of Object.keys(before)) {
      if (key !== 'id' && !(key in item)) { unset.push(key); undo[key] = before[key]; }
    }
    ops.push({ op: 'update', workspaceKey, id: item.id, expectedUpdatedAt: before.updatedAt, set, unset });
    inverse.push({ op: 'update', workspaceKey, id: item.id, expectedUpdatedAt: item.updatedAt, set: undo, unset: undoUnset });
  }
  const metaChanged = !raw || raw.updatedAt !== post.updatedAt || raw.version !== post.version
    || !sameValue(raw.idempotency ?? {}, post.idempotency ?? {});
  return { ops, inverse, needsImport: needsImport || ops.length + 1 > TODOS_BATCH_MAX_OPS, changed: changed || metaChanged };
}

/**
 * @param {{
 *   store: ReturnType<typeof import('../storage/todos-store.js').createTodosStore>,
 *   dataDir: string,
 *   scratchDir?: string,
 *   nudge?: (dataDir: string, cwd: string, previousDoc: any, nextDoc: any) => void,
 *   afterCommitHook?: (key: string) => void | Promise<void>,
 * }} options `afterCommitHook` is a test seam that runs between COMMIT and the cache/nudge publication
 * @returns {import('./todos-store.js').TodosBackend & { close: () => void, cacheStats: () => { entries: number }, workStats: () => Record<string, number> }}
 */
export function createSqliteTodosBackend(options) {
  const { store, dataDir } = options;
  const scratchDir = options.scratchDir ?? fs.mkdtempSync(path.join(path.resolve(dataDir), '.todos-overlay-'));
  const ownsScratch = !options.scratchDir;
  fs.mkdirSync(path.join(scratchDir, 'todos'), { recursive: true });
  const publishNudge = options.nudge ?? ((dir, cwd, previousDoc, nextDoc) => {
    void import('../workspace-watcher-nudge.js').then(({ maybeScheduleWorkspaceWatcherAfterTodosSave }) => {
      maybeScheduleWorkspaceWatcherAfterTodosSave(dir, cwd, previousDoc, nextDoc);
    }).catch(() => {});
  });

  /** Committed cache: only ever filled from rows the worker returned. @type {Map<string, { stamp: string, raw: Record<string, any> | null, norm: Record<string, any> | null }>} */
  const cache = new Map();
  /** Main-thread whole-document work, for diagnostics and the ADR serialization gate. */
  const counters = { pagedExports: 0, exportPages: 0, scratchWrites: 0, overlayReads: 0, noopCommands: 0, committedCommands: 0 };
  /** @type {Map<string, Promise<unknown>>} */
  const chains = new Map();

  /** Serialise async sections per workspace key inside this process (cross-process safety is the CAS). */
  function serialize(keys, fn) {
    const ordered = [...new Set(keys)].sort();
    const run = async () => {
      const previous = ordered.map((k) => chains.get(k) ?? Promise.resolve());
      await Promise.all(previous.map((p) => p.catch(() => {})));
      return fn();
    };
    const result = run();
    const tail = result.catch(() => {});
    for (const k of ordered) {
      chains.set(k, tail);
      void tail.then(() => { if (chains.get(k) === tail) chains.delete(k); });
    }
    return result;
  }

  /** @param {string} cwd */
  function keyOf(cwd) {
    const key = workspaceKeyFromCwd(cwd);
    if (!key) throw codedError('NO_WORKSPACE', 'No workspace folder');
    return key;
  }

  const scratchFile = (key) => path.join(scratchDir, 'todos', `${key}.json`);

  /** Committed stamp the scratch file currently mirrors, per workspace key (absent = scratch is dirty or empty). */
  const scratchStamp = new Map();

  /** Write the private overlay for one workspace (null = no document). */
  function materialize(key, cwd, raw) {
    forgetTodosDocumentCache(scratchDir, cwd);
    scratchStamp.delete(key);
    if (raw === null) fs.rmSync(scratchFile(key), { force: true });
    else {
      fs.writeFileSync(scratchFile(key), JSON.stringify(raw));
      counters.scratchWrites += 1;
    }
  }

  /** Cheap identity of the scratch file: a legacy save replaces it atomically, which changes inode, mtime or size. */
  function scratchSignature(key) {
    try {
      const st = fs.statSync(scratchFile(key), { bigint: true });
      return `${st.ino}:${st.size}:${st.mtimeNs}`;
    } catch {
      return 'absent';
    }
  }

  function readOverlay(key) {
    try {
      return JSON.parse(fs.readFileSync(scratchFile(key), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Committed document straight from the worker (cached by revision). */
  async function committed(key, cwd) {
    const rev = await store.revision({ workspaceKey: key });
    const stamp = rev ? `${rev.docUpdatedAt}\u0000${rev.count}\u0000${rev.docVersion}` : 'absent';
    const hit = cache.get(key);
    if (hit && hit.stamp === stamp) return hit;
    if (rev) counters.pagedExports += 1;
    const raw = rev ? await (store.exportDocumentPaged ?? store.exportDocument)({ workspaceKey: key, onPage: () => { counters.exportPages += 1; } }) : null;
    // The export is the source of truth for the stamp: it may be newer than `rev`.
    const entry = { stamp: raw ? `${raw.updatedAt}\u0000${raw.items.length}\u0000${raw.version}` : 'absent', raw, norm: null };
    cache.set(key, entry);
    void cwd;
    return entry;
  }

  /** Normalised (legacy-loaded) view of a committed document, cached with it. */
  async function committedNormalized(key, cwd) {
    const entry = await committed(key, cwd);
    if (!entry.norm) {
      materialize(key, cwd, entry.raw);
      try {
        entry.norm = legacyLoadTodosData(scratchDir, cwd);
      } finally {
        forgetTodosDocumentCache(scratchDir, cwd);
      }
    }
    return entry.norm;
  }

  /** @param {Record<string, any>[]} ops */
  async function submit(ops, label) {
    const commandId = `todos-${label}-${randomUUID()}`;
    const args = { commandId, ops };
    try {
      return await store.batch(args);
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'unknown_commit') {
        const resolved = await store.resolveUnknown({ ...args, operation: 'batch', error: err });
        if (resolved.outcome === 'committed') return { result: resolved.result, replayed: true };
      }
      throw err;
    }
  }

  async function submitImport(key, doc, expectedDocUpdatedAt) {
    const args = { commandId: `todos-import-${randomUUID()}`, workspaceKey: key, doc, expectedDocUpdatedAt };
    try {
      return await store.importDocument(args);
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'unknown_commit') {
        const resolved = await store.resolveUnknown({ ...args, operation: 'importDocument', error: err });
        if (resolved.outcome === 'committed') return { result: resolved.result, replayed: true };
      }
      throw err;
    }
  }

  /** @returns {boolean} */
  function isRetryable(err) {
    const e = /** @type {any} */ (err);
    return e?.code === 'conflict' && RETRYABLE_KINDS.has(e?.details?.conflictKind);
  }

  /** Publish an invalidation and the deferred nudges, strictly after COMMIT. */
  async function afterCommit(key, nudges) {
    await options.afterCommitHook?.(key);
    cache.delete(key);
    for (const entry of nudges) publishNudge(dataDir, entry.cwd, entry.previousDoc, entry.nextDoc);
  }

  /**
   * Run a synchronous legacy operation on the private overlay and commit its effect.
   *
   * @template T
   * @param {string} cwd
   * @param {(overlayDir: string) => T} run
   * @param {{ label?: string }} [opts]
   * @returns {Promise<{ result: T, committed: boolean, key: string, raw: Record<string, any> | null, post: Record<string, any> | null, nudges: any[] }>}
   */
  function mutate(cwd, run, opts = {}) {
    const key = keyOf(cwd);
    return serialize([key], async () => {
      let lastError;
      for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
        const entry = await committed(key, cwd);
        const raw = entry.raw;
        if (scratchStamp.get(key) !== entry.stamp) {
          materialize(key, cwd, raw);
          scratchStamp.set(key, entry.stamp);
        }
        const before = scratchSignature(key);
        /** @type {any[]} */
        const nudges = [];
        let result;
        let post;
        let untouched = false;
        try {
          result = withTodosNudgeSink((n) => nudges.push(n), () => run(scratchDir));
          untouched = scratchSignature(key) === before;
          post = untouched ? raw : readOverlay(key);
          if (!untouched) counters.overlayReads += 1;
        } finally {
          // A rewritten scratch file no longer mirrors the committed state: drop it. An untouched one is reused.
          if (!untouched) {
            forgetTodosDocumentCache(scratchDir, cwd);
            scratchStamp.delete(key);
            fs.rmSync(scratchFile(key), { force: true });
          }
        }
        if (untouched) { counters.noopCommands += 1; return { result, committed: false, key, raw, post, nudges: [] }; }
        if (!post) return { result, committed: false, key, raw, post: null, nudges: [] };
        const diff = diffDocuments(key, raw, post);
        if (!diff.changed) return { result, committed: false, key, raw, post, nudges: [] };
        const expectedDoc = raw ? raw.updatedAt : '';
        try {
          if (diff.needsImport) {
            await submitImport(key, post, expectedDoc);
          } else {
            await submit([...diff.ops, {
              op: 'docMeta', workspaceKey: key, expectedDocUpdatedAt: expectedDoc,
              meta: { version: post.version, updatedAt: post.updatedAt, idempotency: post.idempotency ?? {} },
            }], opts.label ?? 'mutate');
          }
        } catch (err) {
          if (isRetryable(err)) { lastError = err; cache.delete(key); continue; }
          throw err;
        }
        await afterCommit(key, nudges);
        counters.committedCommands += 1;
        return { result, committed: true, key, raw, post, nudges };
      }
      const conflict = codedError('CONFLICT', 'Todos were updated by another writer; retry the request');
      /** @type {any} */ (conflict).cause = lastError;
      throw conflict;
    });
  }

  const backend = {
    async listTodos(_dataDir, cwd) {
      const key = keyOf(cwd);
      // Reads never wait for a pending write: they see committed rows only.
      return structuredClone(await committedNormalized(key, cwd));
    },
    async getTodo(_dataDir, cwd, id) {
      const key = keyOf(cwd);
      const norm = await committedNormalized(key, cwd);
      const found = norm.items.find((row) => row.id === id);
      return found ? structuredClone(found) : null;
    },
    async addTodo(_dataDir, cwd, input) {
      return (await mutate(cwd, (dir) => legacyAddTodo(dir, cwd, input), { label: 'add' })).result;
    },
    async updateTodo(_dataDir, cwd, id, patch) {
      return (await mutate(cwd, (dir) => legacyUpdateTodo(dir, cwd, id, patch), { label: 'update' })).result;
    },
    async deleteTodo(_dataDir, cwd, id) {
      return (await mutate(cwd, (dir) => legacyDeleteTodo(dir, cwd, id), { label: 'delete' })).result;
    },
    async writeTodoReview(_dataDir, cwd, id, snapshot, opts = {}) {
      return (await mutate(cwd, (dir) => legacyWriteTodoReview(dir, cwd, id, snapshot, opts), { label: 'review' })).result;
    },
    async writeTodoReviewBatch(_dataDir, cwd, entries) {
      return (await mutate(cwd, (dir) => legacyWriteTodoReviewBatch(dir, cwd, entries), { label: 'review-batch' })).result;
    },
    async closeTodoLeafIfEligible(_dataDir, cwd, id, guard) {
      return (await mutate(cwd, (dir) => legacyCloseTodoLeafIfEligible(dir, cwd, id, guard), { label: 'close' })).result;
    },
    async getRevision(_dataDir, cwd) {
      const key = keyOf(cwd);
      const rev = await store.revision({ workspaceKey: key });
      return rev ? `${rev.docUpdatedAt}:${rev.count}:${rev.docVersion}` : '';
    },
    async exportSnapshot(_dataDir, cwd) {
      const key = keyOf(cwd);
      return structuredClone(await committedNormalized(key, cwd));
    },

    /**
     * Move a subtree between workspaces in ONE worker transaction (source rows, target rows,
     * document metadata and receipt together), replacing the legacy two-save partial-commit behaviour.
     */
    async moveTodo(input) {
      const { sourceFolder } = input;
      const targetFolder = requireTargetFolder(input.targetFolder);
      const sourceKey = keyOf(sourceFolder);
      const targetKey = keyOf(targetFolder);
      if (sourceKey === targetKey) {
        throw createMoveError(TODO_MOVE_ERROR_CODES.VALIDATION, 'target workspace folder is the source workspace');
      }
      return serialize([sourceKey, targetKey], async () => {
        const source = await committedNormalized(sourceKey, sourceFolder);
        const root = source.items.find((item) => item.id === input.todoId);
        if (!root) throw createMoveError(TODO_MOVE_ERROR_CODES.NOT_FOUND, `Todo not found: ${input.todoId}`);
        if (String(input.expectedUpdatedAt || '') !== String(root.updatedAt || '')) {
          throw createMoveError(TODO_MOVE_ERROR_CODES.CONFLICT, 'expected_updated_at is stale; re-read the todo');
        }
        const ids = new Set(collectTodoSubtreeIds(source.items, root.id));
        const moved = source.items.filter((item) => ids.has(item.id));
        const blockers = listMoveBlockers({ dataDir: input.dataDir, sourceFolder, items: moved, ids });
        if (blockers.length > 0) throw createMoveError(TODO_MOVE_ERROR_CODES.HAS_HISTORY, 'This tree has run history and cannot move', blockers);
        const target = await committedNormalized(targetKey, targetFolder);
        const clash = target.items.find((item) => ids.has(item.id));
        if (clash) throw createMoveError(TODO_MOVE_ERROR_CODES.CONFLICT, `Target already has todo ${clash.id}`);
        const now = new Date().toISOString();
        const targetRoots = target.items.filter((item) => !String(item.parentId || '').trim()).length;
        const changelog = [
          ...(Array.isArray(root.changelog) ? root.changelog : []),
          { kind: 'note', text: `moved from workspace ${sourceFolder}`, chatId: input.chatId || '', at: now },
        ];
        const movedRoot = { ...root, parentId: '', siblingIndex: targetRoots, updatedAt: now, changelog };
        const sourceEntry = await committed(sourceKey, sourceFolder);
        const targetEntry = await committed(targetKey, targetFolder);
        try {
          await submit([
            {
              op: 'move', sourceWorkspaceKey: sourceKey, targetWorkspaceKey: targetKey, id: root.id,
              expectedUpdatedAt: root.updatedAt, set: { parentId: '', siblingIndex: targetRoots, updatedAt: now, changelog },
            },
            {
              op: 'docMeta', workspaceKey: sourceKey, expectedDocUpdatedAt: sourceEntry.raw ? sourceEntry.raw.updatedAt : '',
              meta: { updatedAt: now },
            },
            {
              op: 'docMeta', workspaceKey: targetKey, expectedDocUpdatedAt: targetEntry.raw ? targetEntry.raw.updatedAt : '',
              meta: { updatedAt: now },
            },
          ], 'move');
        } catch (err) {
          if (isRetryable(err)) {
            cache.delete(sourceKey); cache.delete(targetKey);
            throw createMoveError(TODO_MOVE_ERROR_CODES.CONFLICT, 'Todos changed during the move; re-read and retry');
          }
          throw err;
        }
        await options.afterCommitHook?.(sourceKey);
        cache.delete(sourceKey);
        cache.delete(targetKey);
        unlinkSourceChats(ids);
        return { root: movedRoot, movedIds: [...ids], targetFolder };
      });
    },

    /**
     * Version-checked watcher-row + todo command. The two documents live in different stores, so this is a
     * staged protocol, not one transaction: (1) CAS-check the watcher row and the todo, (2) commit the todo
     * transaction, (3) write the watcher row under its file lock with the same CAS; if (3) is rejected the
     * todo change is compensated with the inverse operations (each CAS'd on the version we committed).
     * No file lock is held across an await. A process crash between (2) and (3) leaves the todo change
     * without the watcher write (reported gap: no journal for the SQLite side yet).
     */
    async commitWatcherTodoCommand(_dataDir, cwd, command) {
      const key = normalizeWorkspaceFolder(command.workspaceFolder || cwd);
      const id = String(command.todoId || '');
      if (!key || !id || typeof command.decide !== 'function') {
        throw codedError('VALIDATION', 'commitWatcherTodoCommand: workspaceFolder, todoId and decide are required');
      }
      if (!Number.isInteger(command.expectedWatcherRevision) || command.expectedWatcherRevision < 0) {
        throw codedError('WATCHER_REVISION_REQUIRED', 'commitWatcherTodoCommand: expectedWatcherRevision (non-negative integer) is required');
      }
      const lockOptions = { dataDir };
      const expectedWatcherUpdatedAt = String(command.expectedWatcherUpdatedAt || '').trim();
      const checkWatcher = () => withWorkspaceWatchersFileLock(() => {
        const watcherDoc = loadWorkspaceWatchersDocument(lockOptions);
        const row = watcherDoc.items[key] || null;
        if (!row) return { ok: false, reason: 'no_row' };
        if (String(row.updatedAt || '').trim() !== expectedWatcherUpdatedAt || Number(watcherDoc.revision) !== command.expectedWatcherRevision) {
          return { ok: false, reason: 'watcher_conflict' };
        }
        return { ok: true, row };
      }, lockOptions);
      const first = checkWatcher();
      if (!first.ok) return first;
      const dbKey = keyOf(cwd);
      const state = structuredClone(await committedNormalized(dbKey, cwd));
      const todo = state.items.find((entry) => entry.id === id) || null;
      if (!todo) return { ok: false, reason: 'todo_not_found' };
      const expectedTodoUpdatedAt = String(command.expectedTodoUpdatedAt || '').trim();
      if (!expectedTodoUpdatedAt || expectedTodoUpdatedAt !== String(todo.updatedAt || '')) return { ok: false, reason: 'todo_conflict' };
      if (typeof command.fence === 'function' && !command.fence({ row: first.row, todo })) return { ok: false, reason: 'fenced' };
      const decision = command.decide({ row: first.row, todo, items: state.items });
      if (!decision) return { ok: false, reason: 'skipped' };
      const todoPatch = decision.todoPatch && typeof decision.todoPatch === 'object' ? decision.todoPatch : null;
      const watcherPatch = decision.watcherPatch && typeof decision.watcherPatch === 'object' ? decision.watcherPatch : null;
      let savedTodo = todo;
      let applied = null;
      if (todoPatch) {
        try {
          applied = await mutate(cwd, (dir) => withTodosWatcherNudgeSuppressed(() => legacyUpdateTodo(
            dir, cwd, id, { ...todoPatch, expectedUpdatedAt: expectedTodoUpdatedAt },
          )), { label: 'watcher-todo' });
        } catch (err) {
          if (/** @type {any} */ (err)?.code === 'CONFLICT') return { ok: false, reason: 'todo_conflict' };
          throw err;
        }
        savedTodo = applied.result.items.find((entry) => entry.id === id) || null;
      }
      const compensate = async () => {
        if (!applied || !applied.committed || !applied.post) return;
        const diff = diffDocuments(applied.key, applied.raw, applied.post);
        const undo = diff.inverse.reverse();
        if (undo.length === 0) return;
        const fresh = await committed(applied.key, cwd);
        await submit([...undo, {
          op: 'docMeta', workspaceKey: applied.key, expectedDocUpdatedAt: fresh.raw ? fresh.raw.updatedAt : '',
          meta: { updatedAt: new Date().toISOString() },
        }], 'watcher-compensate');
        cache.delete(applied.key);
      };
      let savedRow = first.row;
      try {
        if (typeof command.beforeWatcherWrite === 'function') command.beforeWatcherWrite();
        if (watcherPatch) {
          const written = withWorkspaceWatchersFileLock(() => {
            const watcherDoc = loadWorkspaceWatchersDocument(lockOptions);
            const cas = workspaceWatchersDocumentCasToken(watcherDoc);
            if (cas.revision !== command.expectedWatcherRevision) return { ok: false, reason: 'skipped' };
            return mutateWorkspaceWatcherRow(key, (ctx) => {
              if (String(ctx.row.updatedAt || '').trim() !== expectedWatcherUpdatedAt) return false;
              return watcherPatch;
            }, { ...lockOptions, createIfMissing: false });
          }, lockOptions);
          if (!written.ok || !written.row) {
            await compensate();
            return { ok: false, reason: written.reason === 'skipped' ? 'watcher_conflict' : 'watcher_write_failed' };
          }
          savedRow = written.row;
        }
        if (typeof command.afterWatcherWrite === 'function') command.afterWatcherWrite();
      } catch (error) {
        await compensate();
        throw error;
      }
      if (applied && applied.committed) {
        publishNudge(dataDir, cwd, { items: state.items }, applied.result);
      }
      return { ok: true, todo: savedTodo, row: savedRow };
    },

    /** Drop the overlay directory (when this backend created it) and the committed cache. */
    close() {
      cache.clear();
      scratchStamp.clear();
      if (ownsScratch) fs.rmSync(scratchDir, { recursive: true, force: true });
    },
    cacheStats: () => ({ entries: cache.size }),
    /** Counters of whole-document work done on the main thread (scratch writes = JSON.stringify of a document). */
    workStats: () => ({ ...counters }),
  };
  return backend;
}
