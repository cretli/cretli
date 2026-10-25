/**
 * Durable per-workspace delegation settings (`data/delegation-settings.json`).
 *
 * Shape: `{ v: 1, updatedAt, items: { "<normalizedWorkspaceFolder>": record } }`
 * where a record holds only the fields that were explicitly saved (plus
 * `updatedAt`). A field that is absent falls through to env / default.
 * `scope=server` fields are never stored.
 */

import fs from 'node:fs';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { normalizeDelegationWorkspaceKey } from '../delegation-workspace-key.js';
import { DELEGATION_SETTING_DEFS, getDelegationSettingDef } from '../delegation-settings-schema.js';
import { clearDelegationEnvCache } from '../delegation-settings.js';

export const DELEGATION_SETTINGS_SCHEMA_VERSION = 1;

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
function settingsPath(options = {}) {
  const dir = String(options.dataDir ?? '').trim();
  return dir ? `${dir.replace(/[\\/]+$/, '')}/delegation-settings.json` : resolveDataPath('delegation-settings.json');
}

/**
 * Drop unknown, server-scoped and invalid fields.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeDelegationSettingsRecord(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const def of DELEGATION_SETTING_DEFS) {
    if (def.scope !== 'workspace' || !(def.field in source)) continue;
    const parsed = def.parse(source[def.field]);
    if (parsed.ok) out[def.field] = parsed.value;
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
      return { v: DELEGATION_SETTINGS_SCHEMA_VERSION, updatedAt: String(parsed.updatedAt || ''), items: parsed.items };
    }
  } catch {
    // Missing or unreadable file: behave as "nothing saved".
  }
  return { v: DELEGATION_SETTINGS_SCHEMA_VERSION, updatedAt: '', items: {} };
}

/**
 * @param {string} workspaceFolder
 * @param {{ dataDir?: string }} [options]
 * @returns {(Record<string, unknown> & { updatedAt?: string }) | null}
 */
export function getDelegationSettings(workspaceFolder, options = {}) {
  const key = normalizeDelegationWorkspaceKey(workspaceFolder);
  if (!key) return null;
  const record = readDocument(options).items[key];
  if (!record || typeof record !== 'object') return null;
  return { ...normalizeDelegationSettingsRecord(record), updatedAt: String(record.updatedAt || '') };
}

/**
 * Merge a patch into the saved record. `null` or '' clears a field (back to
 * env / default). Unknown fields, `scope=server` fields and invalid values are
 * rejected with `code: 'VALIDATION'` and nothing is written.
 *
 * @param {string} workspaceFolder
 * @param {Record<string, unknown>} patch
 * @param {{ dataDir?: string }} [options]
 * @returns {Record<string, any> | null}
 */
export function saveDelegationSettings(workspaceFolder, patch, options = {}) {
  const key = normalizeDelegationWorkspaceKey(workspaceFolder);
  const fail = (message) => Object.assign(new Error(message), { code: 'VALIDATION' });
  if (!key) throw fail('workspaceFolder is required');
  const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const doc = readDocument(options);
  const next = normalizeDelegationSettingsRecord(doc.items[key]);
  for (const [field, value] of Object.entries(body)) {
    const def = getDelegationSettingDef(field);
    if (!def) throw fail(`unknown delegation setting: ${field}`);
    if (def.scope !== 'workspace') throw fail(`${field} is a server-wide setting and cannot be saved per workspace`);
    if (value === null || value === '') {
      delete next[field];
      continue;
    }
    const parsed = def.parse(value);
    if (!parsed.ok) throw fail(`invalid value for ${field}`);
    next[field] = parsed.value;
  }
  const now = new Date().toISOString();
  doc.items[key] = { ...next, updatedAt: now };
  doc.updatedAt = now;
  writeJsonAtomic(settingsPath(options), doc);
  clearDelegationEnvCache();
  return getDelegationSettings(workspaceFolder, options);
}
