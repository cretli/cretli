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
} from './todos-persist.js';
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
    moveTodo: (input) => moveTodoTree(input),
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
export const batch = defaultStore.batch;

export const writeTodoReview = defaultStore.writeTodoReview;
export const writeTodoReviewBatch = defaultStore.writeTodoReviewBatch;
export const closeTodoLeafIfEligible = defaultStore.closeTodoLeafIfEligible;
