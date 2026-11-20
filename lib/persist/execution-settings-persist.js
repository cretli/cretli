/**
 * Durable per-workspace execution settings (`data/execution-settings.json`).
 *
 * Holds the worktree layout (`root`, `namespace`, `branchPrefix`,
 * `directoryPrefix`, `prepareCommand`) and the default `executionMode` that both
 * the Workspace Watcher cycle and the manual "run todo" start read. It is
 * independent of the watcher row, so it exists even when the watcher was never
 * enabled.
 *
 * Shape: `{ v: 1, updatedAt, items: { "<normalizedWorkspaceFolder>": record } }`
 * where a record is `{ executionMode?, worktree?: {...}, updatedAt }`. A field
 * that is absent was never saved; `prepareCommand: []` is an explicit "run
 * nothing" and must stay empty.
 */

import fs from 'node:fs';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeDelegationWorkspaceKey } from '../delegation-workspace-guard.js';

export const EXECUTION_SETTINGS_SCHEMA_VERSION = 1;
export const EXECUTION_MODES = Object.freeze(['project', 'worktree']);
const DIRTY_POLICIES = Object.freeze(['block', 'head', 'snapshot']);
const LAYOUT_STRING_KEYS = Object.freeze(['root', 'namespace', 'branchPrefix', 'directoryPrefix']);

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Fail-closed check of one layout field. `namespace` and `directoryPrefix` end
 * up in a filesystem path, so they must be a single safe segment.
 *
 * @param {string} field
 * @param {string} value trimmed, non-empty
 * @returns {boolean}
 */
export function isSafeLayoutValue(field, value) {
  if (typeof value !== 'string' || !value || CONTROL_CHARS.test(value)) return false;
  if (field === 'namespace' || field === 'directoryPrefix') {
    return SAFE_SEGMENT.test(value) && !value.split('.').every((part) => part === '') && !value.includes('..');
  }
  if (field === 'branchPrefix') {
    return !value.includes('..') && !value.startsWith('/') && !/[\s\\~^:?*[]/.test(value) && !value.includes('@{');
  }
  if (field === 'root') return true;
  return false;
}

/**
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
function settingsPath(options = {}) {
  const dir = String(options.dataDir ?? '').trim();
  return dir ? `${dir.replace(/[\\/]+$/, '')}/execution-settings.json` : resolveDataPath('execution-settings.json');
}

/**
 * @param {any} value
 * @returns {string[] | null} argv, or null when the value is not an array
 */
function normalizeArgv(value) {
  if (!Array.isArray(value)) return null;
  return value.map((part) => String(part ?? '').trim()).filter(Boolean);
}

/**
 * Normalize a (possibly partial) record. Unknown keys are dropped; invalid
 * values are ignored rather than stored.
 *
 * @param {unknown} raw
 * @returns {{ executionMode?: 'project' | 'worktree', worktree?: Record<string, any> }}
 */
export function normalizeExecutionSettingsRecord(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  /** @type {Record<string, any>} */
  const out = {};
  const mode = String(source.executionMode ?? '').trim();
  if (EXECUTION_MODES.includes(mode)) out.executionMode = mode;
  const wt = source.worktree && typeof source.worktree === 'object' && !Array.isArray(source.worktree)
    ? source.worktree
    : null;
  if (wt) {
    /** @type {Record<string, any>} */
    const worktree = {};
    for (const key of LAYOUT_STRING_KEYS) {
      if (typeof wt[key] === 'string' && wt[key].trim() && isSafeLayoutValue(key, wt[key].trim())) worktree[key] = wt[key].trim();
    }
    const argv = normalizeArgv(wt.prepareCommand);
    if (argv) worktree.prepareCommand = argv;
    if (DIRTY_POLICIES.includes(wt.dirtyPolicy)) worktree.dirtyPolicy = wt.dirtyPolicy;
    if (Object.keys(worktree).length > 0) out.worktree = worktree;
  }
  return out;
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {{ v: number, updatedAt: string, items: Record<string, Record<string, any>> }}
 */
function readDocument(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(options), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.items && typeof parsed.items === 'object') {
      return { v: EXECUTION_SETTINGS_SCHEMA_VERSION, updatedAt: String(parsed.updatedAt || ''), items: parsed.items };
    }
  } catch {
    // Missing or unreadable file: behave as "nothing saved".
  }
  return { v: EXECUTION_SETTINGS_SCHEMA_VERSION, updatedAt: '', items: {} };
}

/**
 * @param {string} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {{ executionMode?: string, worktree?: Record<string, any>, updatedAt?: string } | null}
 */
export function getExecutionSettings(workspaceFolder, options = {}) {
  const key = normalizeDelegationWorkspaceKey(workspaceFolder);
  if (!key) return null;
  const record = readDocument(options).items[key];
  if (!record || typeof record !== 'object') return null;
  return { ...normalizeExecutionSettingsRecord(record), updatedAt: String(record.updatedAt || '') };
}

/**
 * Merge a patch into the saved record. `worktree` fields merge one by one; a
 * string layout field set to '' removes that field (back to proposal/legacy),
 * while `prepareCommand: []` is stored as an explicit empty argv.
 *
 * @param {string} workspaceFolder
 * @param {{ executionMode?: unknown, worktree?: unknown }} patch
 * @param {{ dataDir?: string }} [options]
 * @returns {Record<string, any>}
 */
export function saveExecutionSettings(workspaceFolder, patch, options = {}) {
  const key = normalizeDelegationWorkspaceKey(workspaceFolder);
  if (!key) throw Object.assign(new Error('workspaceFolder is required'), { code: 'VALIDATION' });
  const doc = readDocument(options);
  const current = normalizeExecutionSettingsRecord(doc.items[key]);
  const next = { ...current, worktree: { ...(current.worktree || {}) } };
  if (patch?.executionMode !== undefined) {
    const mode = String(patch.executionMode ?? '').trim();
    if (mode === '') delete next.executionMode;
    else if (EXECUTION_MODES.includes(mode)) next.executionMode = mode;
    else throw Object.assign(new Error(`executionMode must be one of ${EXECUTION_MODES.join(', ')}`), { code: 'VALIDATION' });
  }
  const wt = patch?.worktree;
  if (wt && typeof wt === 'object' && !Array.isArray(wt)) {
    for (const field of LAYOUT_STRING_KEYS) {
      if (wt[field] === undefined) continue;
      if (typeof wt[field] !== 'string') throw Object.assign(new Error(`worktree.${field} must be a string`), { code: 'VALIDATION' });
      const value = wt[field].trim();
      if (value && !isSafeLayoutValue(field, value)) throw Object.assign(new Error(`worktree.${field} contains unsafe characters or path segments`), { code: 'VALIDATION' });
      if (value) next.worktree[field] = value;
      else delete next.worktree[field];
    }
    if (wt.dirtyPolicy !== undefined) {
      if (!DIRTY_POLICIES.includes(wt.dirtyPolicy)) throw Object.assign(new Error(`worktree.dirtyPolicy must be one of ${DIRTY_POLICIES.join(', ')}`), { code: 'VALIDATION' });
      next.worktree.dirtyPolicy = wt.dirtyPolicy;
    }
    if (wt.prepareCommand !== undefined) {
      const argv = normalizeArgv(wt.prepareCommand);
      if (!argv) throw Object.assign(new Error('worktree.prepareCommand must be an argv array'), { code: 'VALIDATION' });
      next.worktree.prepareCommand = argv;
    }
  }
  if (Object.keys(next.worktree).length === 0) delete next.worktree;
  const now = new Date().toISOString();
  doc.items[key] = { ...next, updatedAt: now };
  doc.updatedAt = now;
  writeJsonAtomic(settingsPath(options), doc);
  return getExecutionSettings(workspaceFolder, options);
}
