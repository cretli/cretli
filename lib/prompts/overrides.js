/**
 * Prompt block overrides: user text replacing the default of an *editable*
 * registry block. Hard blocks (git history, `data/`, plan gate, review policy)
 * can never be overridden. The active overrides live in memory so prompt
 * builders resolve them synchronously. Browser-safe (no node: imports): the
 * front bundle reaches it through lib/todo-execution-prompt.js; persistence is
 * in ./overrides-store.js (server only).
 */
import { PROMPT_BLOCKS } from './blocks.js';

/** Registry blocks that are safety rules: read-only in the UI and rejected by the API. */
export const HARD_PROMPT_BLOCK_KEYS = Object.freeze([
  'planGateAncestor',
  'noCommitPush',
  'noPushDestructive',
  'noDataDir',
  'reviewerPolicy',
]);

export const MAX_OVERRIDE_CHARS = 1200;

/** @type {Map<string, string>} */
const overrides = new Map();

/** @param {string} key */
export function isHardPromptBlock(key) {
  return HARD_PROMPT_BLOCK_KEYS.includes(key);
}

/** @param {string} key */
export function isEditablePromptBlock(key) {
  return Object.hasOwn(PROMPT_BLOCKS, key) && !isHardPromptBlock(key);
}

/**
 * Effective text of a block: the override for an editable block, else the default.
 *
 * @param {string} key
 * @returns {string}
 */
export function getPromptBlock(key) {
  if (isEditablePromptBlock(key) && overrides.has(key)) return /** @type {string} */ (overrides.get(key));
  return PROMPT_BLOCKS[key];
}

/** @returns {Record<string, string>} */
export function listPromptOverrides() {
  return Object.fromEntries(overrides);
}

/**
 * @param {string} key
 * @param {unknown} text
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function setPromptOverride(key, text) {
  if (!Object.hasOwn(PROMPT_BLOCKS, key)) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Unknown prompt block.' };
  if (isHardPromptBlock(key)) return { ok: false, status: 403, code: 'HARD_BLOCK', error: 'This block is a hard safety rule and cannot be overridden.' };
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return { ok: false, status: 400, code: 'VALIDATION', error: 'Override text must be a non-empty string.' };
  if (value.length > MAX_OVERRIDE_CHARS) return { ok: false, status: 400, code: 'VALIDATION', error: `Override text is limited to ${MAX_OVERRIDE_CHARS} characters.` };
  overrides.set(key, value);
  return { ok: true };
}

/** @param {string} key */
export function resetPromptOverride(key) {
  if (!Object.hasOwn(PROMPT_BLOCKS, key)) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Unknown prompt block.' };
  overrides.delete(key);
  return { ok: true };
}

/** Test helper: drop every override. */
export function clearPromptOverrides() {
  overrides.clear();
}

/**
 * Replace all in-memory overrides (used by the server-side store on load);
 * entries that are no longer editable are ignored.
 *
 * @param {Record<string, unknown>} entries
 */
export function replacePromptOverrides(entries) {
  overrides.clear();
  for (const [key, text] of Object.entries(entries || {})) {
    if (isEditablePromptBlock(key) && typeof text === 'string' && text.trim()) overrides.set(key, text.trim());
  }
}
