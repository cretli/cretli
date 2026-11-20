/** Legacy JSON operations for the Promise facade and tests of the old backend. */
import { legacyTodosSyncApi } from './todos-persist.js';

export * from './todos-persist.js';
/** @param {Parameters<typeof legacyTodosSyncApi.loadTodosData>} args */
export function loadTodosData(...args) { return legacyTodosSyncApi.loadTodosData(...args); }
/** @param {Parameters<typeof legacyTodosSyncApi.saveTodosData>} args */
export function saveTodosData(...args) { return legacyTodosSyncApi.saveTodosData(...args); }
/** @param {Parameters<typeof legacyTodosSyncApi.addTodo>} args */
export function addTodo(...args) { return legacyTodosSyncApi.addTodo(...args); }
/** @param {Parameters<typeof legacyTodosSyncApi.updateTodo>} args */
export function updateTodo(...args) { return legacyTodosSyncApi.updateTodo(...args); }

/*
 * Names for the SQLite backend's private overlay (`todos-backend-sqlite.js`): it runs the same
 * synchronous domain functions against a scratch copy, then commits the diff through the worker.
 * Distinct names keep the sync-API guard inventory exact.
 */
/** @param {Parameters<typeof legacyTodosSyncApi.loadTodosData>} args */
export function overlayLoadTodosData(...args) { return legacyTodosSyncApi.loadTodosData(...args); }
/** @param {Parameters<typeof legacyTodosSyncApi.addTodo>} args */
export function overlayAddTodo(...args) { return legacyTodosSyncApi.addTodo(...args); }
/** @param {Parameters<typeof legacyTodosSyncApi.updateTodo>} args */
export function overlayUpdateTodo(...args) { return legacyTodosSyncApi.updateTodo(...args); }
