/**
 * `store.todos` facade: a Promise-based API over a pluggable backend.
 *
 * Callers (HTTP routes, MCP tools) await these functions, so a success response
 * is only produced after the mutation Promise resolved. The only backend in this
 * slice is the legacy JSON adapter over `todos-persist.js` (same behavior and
 * the same file locking); a worker-backed backend can replace it later without
 * touching callers.
 *
 * Error contract (every backend): rejections are `Error`s whose `code` is one of
 * `TODOS_STORE_ERROR_CODES`. `CONFLICT` is a stale `expectedUpdatedAt` (CAS),
 * `NOT_FOUND` a missing item, `VALIDATION` rejected input.
 */

import {
  addTodo as legacyAddTodo,
  deleteTodo as legacyDeleteTodo,
  getTodoById as legacyGetTodoById,
  loadTodosData as legacyLoadTodosData,
  updateTodo as legacyUpdateTodo,
  writeTodoReview as legacyWriteTodoReview,
  writeTodoReviewBatch as legacyWriteTodoReviewBatch,
  closeTodoLeafIfEligible as legacyCloseTodoLeafIfEligible,
  commitWatcherTodoCommand as legacyCommitWatcherTodoCommand,
  getTodosFileRevision as legacyGetTodosFileRevision,
} from './todos-legacy-adapter.js';
import { moveTodoTree } from '../todo-move.js';

export const TODOS_STORE_ERROR_CODES = Object.freeze({
  CONFLICT: 'CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
});

/**
 * @typedef {{
 *   listTodos: (dataDir: string, cwd: string) => any,
 *   getTodo: (dataDir: string, cwd: string, id: string) => any,
 *   addTodo: (dataDir: string, cwd: string, input?: Record<string, any>) => any,
 *   updateTodo: (dataDir: string, cwd: string, id: string, patch?: Record<string, any>) => any,
 *   deleteTodo: (dataDir: string, cwd: string, id: string) => any,
 *   writeTodoReview?: (...args: any[]) => any,
 *   writeTodoReviewBatch?: (...args: any[]) => any,
 *   closeTodoLeafIfEligible?: (...args: any[]) => any,
 *   commitWatcherTodoCommand?: (dataDir: string, cwd: string, command: Record<string, any>) => any,
 *   getRevision?: (dataDir: string, cwd: string) => any,
 *   exportSnapshot?: (dataDir: string, cwd: string) => any,
 *   moveTodo: (input: { dataDir: string, sourceFolder: string, targetFolder: string, todoId: string, expectedUpdatedAt: string, chatId?: string }) => any,
 * }} TodosBackend
 */

/**
 * Legacy JSON backend: thin synchronous adapter over `todos-persist.js`.
 *
 * @returns {TodosBackend}
 */
export function createLegacyJsonTodosBackend() {
  return {
    listTodos: (dataDir, cwd) => legacyLoadTodosData(dataDir, cwd),
    getTodo: (dataDir, cwd, id) => legacyGetTodoById(dataDir, cwd, id),
    addTodo: (dataDir, cwd, input) => legacyAddTodo(dataDir, cwd, input),
    updateTodo: (dataDir, cwd, id, patch) => legacyUpdateTodo(dataDir, cwd, id, patch),
    deleteTodo: (dataDir, cwd, id) => legacyDeleteTodo(dataDir, cwd, id),
    writeTodoReview: legacyWriteTodoReview,
    writeTodoReviewBatch: legacyWriteTodoReviewBatch,
    closeTodoLeafIfEligible: legacyCloseTodoLeafIfEligible,
    commitWatcherTodoCommand: legacyCommitWatcherTodoCommand,
    moveTodo: (input) => moveTodoTree(input),
    // The file signature is a backend detail; callers only see an opaque token.
    getRevision: (dataDir, cwd) => legacyGetTodosFileRevision(dataDir, cwd),
    exportSnapshot: (dataDir, cwd) => JSON.parse(JSON.stringify(legacyLoadTodosData(dataDir, cwd))),
  };
}

/** @type {TodosBackend} */
let activeBackend = createLegacyJsonTodosBackend();

/**
 * Swap the backend (tests and a future worker-backed store). Returns the previous one.
 *
 * @param {TodosBackend} backend
 * @returns {TodosBackend}
 */
export function setTodosBackend(backend) {
  const previous = activeBackend;
  activeBackend = backend;
  return previous;
}

/**
 * @param {TodosBackend} [backend]
 */
export function createTodosStore(backend) {
  const be = () => backend || activeBackend;
  return {
    /** @returns {Promise<{ items: Record<string, any>[], [k: string]: any }>} */
    async listTodos(dataDir, cwd) {
      return be().listTodos(dataDir, cwd);
    },
    /** @returns {Promise<Record<string, any> | null>} */
    async getTodo(dataDir, cwd, id) {
      if (!id || typeof id !== 'string') return null;
      return be().getTodo(dataDir, cwd, id) || null;
    },
    async addTodo(dataDir, cwd, input = {}) {
      return be().addTodo(dataDir, cwd, input);
    },
    async updateTodo(dataDir, cwd, id, patch = {}) {
      return be().updateTodo(dataDir, cwd, id, patch);
    },
    /** @returns {Promise<{ doc: Record<string, any>, removed: Record<string, any>, removedItems: Record<string, any>[] }>} */
    async deleteTodo(dataDir, cwd, id) {
      return be().deleteTodo(dataDir, cwd, id);
    },
    async writeTodoReview(dataDir, cwd, id, snapshot, options = {}) {
      return be().writeTodoReview(dataDir, cwd, id, snapshot, options);
    },
    async writeTodoReviewBatch(dataDir, cwd, entries) {
      return be().writeTodoReviewBatch(dataDir, cwd, entries);
    },
    async closeTodoLeafIfEligible(dataDir, cwd, id, guard) {
      return be().closeTodoLeafIfEligible(dataDir, cwd, id, guard);
    },
    /**
     * Atomic versioned watcher-row + todo command (CAS on both versions, fence,
     * rollback). `decide` and `fence` must be synchronous. See
     * `commitWatcherTodoCommand` in todos-persist.js.
     */
    async commitWatcherTodoCommand(dataDir, cwd, command) {
      return be().commitWatcherTodoCommand(dataDir, cwd, command);
    },
    /**
     * Opaque revision token of the committed workspace document. Changes whenever
     * the committed todos change; empty string when there is no committed state.
     * Compare for equality only (no ordering, no format guarantee).
     *
     * @returns {Promise<string>}
     */
    async getRevision(dataDir, cwd) {
      const b = be();
      return typeof b.getRevision === 'function' ? String((await b.getRevision(dataDir, cwd)) || '') : '';
    },
    /**
     * Logical export of the committed workspace document (a detached JSON copy,
     * independent of the backend storage layout). Used as a rollback point.
     *
     * @returns {Promise<{ items: Record<string, any>[], [k: string]: any }>}
     */
    async exportSnapshot(dataDir, cwd) {
      const b = be();
      if (typeof b.exportSnapshot === 'function') return b.exportSnapshot(dataDir, cwd);
      return JSON.parse(JSON.stringify(await b.listTodos(dataDir, cwd)));
    },
    async moveTodo(input) {
      return be().moveTodo(input);
    },
    /**
     * Run operations in order and resolve with one result per operation. The first
     * failing operation rejects and later operations are not run; operations already
     * applied stay applied (the legacy backend has no multi-command transaction).
     *
     * @param {string} dataDir
     * @param {string} cwd
     * @param {Array<{ op: 'add', input?: Record<string, any> } | { op: 'update', id: string, patch?: Record<string, any> } | { op: 'delete', id: string }>} ops
     * @returns {Promise<any[]>}
     */
    async batch(dataDir, cwd, ops) {
      const results = [];
      for (const entry of ops || []) {
        if (entry.op === 'add') results.push(await be().addTodo(dataDir, cwd, entry.input || {}));
        else if (entry.op === 'update') results.push(await be().updateTodo(dataDir, cwd, entry.id, entry.patch || {}));
        else if (entry.op === 'delete') results.push(await be().deleteTodo(dataDir, cwd, entry.id));
        else {
          /** @type {Error & { code?: string }} */
          const err = new Error(`Unknown batch op: ${String(/** @type {any} */ (entry)?.op)}`);
          err.code = TODOS_STORE_ERROR_CODES.VALIDATION;
          throw err;
        }
      }
      return results;
    },
  };
}

const defaultStore = createTodosStore();

export const listTodos = defaultStore.listTodos;
export const getTodo = defaultStore.getTodo;
export const addTodo = defaultStore.addTodo;
export const updateTodo = defaultStore.updateTodo;
export const deleteTodo = defaultStore.deleteTodo;
export const moveTodo = defaultStore.moveTodo;
export const getRevision = defaultStore.getRevision;
export const exportSnapshot = defaultStore.exportSnapshot;
export const batch = defaultStore.batch;

export const writeTodoReview = defaultStore.writeTodoReview;
export const writeTodoReviewBatch = defaultStore.writeTodoReviewBatch;
export const closeTodoLeafIfEligible = defaultStore.closeTodoLeafIfEligible;
export const commitWatcherTodoCommand = defaultStore.commitWatcherTodoCommand;
