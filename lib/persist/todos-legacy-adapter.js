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
