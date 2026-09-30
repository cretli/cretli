/**
 * Explicit local-harness enable list (`settings.enabledLocalHarnesses`).
 *
 * Built-in transports keep their own `settings.enabledHarnesses` setting and
 * its backward-compatible "missing / empty / full list means every built-in is
 * on" invariant. This module owns the *separate*, opt-in list for discovered
 * local plugins: a missing value simply means "no local plugin enabled", and
 * only an explicitly saved id turns a local provider on. The two lists never
 * bleed into each other.
 *
 * The module is deliberately split into a pure syntax layer and a
 * discovery-aware validation layer so neither one touches the filesystem:
 *
 *  - {@link normalizeEnabledLocalHarnesses} trims, lowercases, de-duplicates
 *    and filters a saved value by the shared plugin id pattern and the
 *    reserved-id set. GET uses it to keep exposing syntactically valid saved
 *    ids even when the plugin is currently missing, so a temporarily absent
 *    plugin does not destroy the user's saved choice.
 *  - {@link validateEnabledLocalHarnessesUpdate} additionally requires every
 *    non-empty id to be part of the caller-supplied set of currently
 *    discovered local ids. The caller owns discovery through the server-only
 *    plugin root; this module never reads a path, an env var, or a manifest.
 */

import {
  HARNESS_PLUGIN_ID_PATTERN,
  HARNESS_RESERVED_IDS,
} from './harness-plugin-contract.js';

/** Persisted settings field that holds explicit local harness ids. */
export const ENABLED_LOCAL_HARNESSES_FIELD = 'enabledLocalHarnesses';

/** Built-in transports plus the legacy `cursor` alias are never local ids. */
const RESERVED_LOCAL_HARNESS_IDS = new Set(HARNESS_RESERVED_IDS);

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalLocalHarnessId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Whether one candidate is syntactically a usable local harness id: a
 * non-empty string matching the shared plugin id pattern and not reserved by a
 * built-in transport (or the legacy `cursor` alias).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidLocalHarnessId(value) {
  const id = canonicalLocalHarnessId(value);
  if (!id) return false;
  if (!HARNESS_PLUGIN_ID_PATTERN.test(id)) return false;
  return !RESERVED_LOCAL_HARNESS_IDS.has(id);
}

/**
 * Lenient syntax normalization of a saved value: trim, lowercase, drop
 * non-strings / blanks / malformed / reserved ids, de-duplicate and preserve
 * first-seen order. A non-array value is treated as "nothing saved".
 *
 * Never throws and never touches discovery, so it is safe on the GET path even
 * when the plugin root is missing or a saved plugin disappeared.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeEnabledLocalHarnesses(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  /** @type {string[]} */
  const ids = [];
  for (const item of raw) {
    if (!isValidLocalHarnessId(item)) continue;
    const id = canonicalLocalHarnessId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Strict PATCH validation for the `enabledLocalHarnesses` setting.
 *
 * Contract:
 *  - the field must be an array; `[]` is valid and means "clear";
 *  - every entry must be a string, non-blank, match the plugin id pattern and
 *    not be a reserved/built-in id;
 *  - every non-empty id must be currently discovered.
 *
 * Atomicity is the caller's responsibility: apply the returned `ids` (or clear
 * the field) only when `ok` is true. A rejected update must not be persisted,
 * not even partially.
 *
 * @param {unknown} raw
 * @param {{ discoveredLocalIds?: Iterable<string> }} [options]
 * @returns {{ ok: true, ids: string[] } | { ok: false, code: string, error: string }}
 */
export function validateEnabledLocalHarnessesUpdate(raw, options = {}) {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'not_array',
      error: 'enabledLocalHarnesses must be an array of harness ids',
    };
  }

  const discovered = new Set();
  if (options.discoveredLocalIds) {
    for (const value of options.discoveredLocalIds) {
      const id = canonicalLocalHarnessId(value);
      if (id) discovered.add(id);
    }
  }

  const seen = new Set();
  /** @type {string[]} */
  const ids = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return {
        ok: false,
        code: 'invalid_id',
        error: 'enabledLocalHarnesses entries must be strings',
      };
    }
    const id = item.trim().toLowerCase();
    if (!id) {
      return {
        ok: false,
        code: 'invalid_id',
        error: 'enabledLocalHarnesses entries must not be blank',
      };
    }
    if (!HARNESS_PLUGIN_ID_PATTERN.test(id)) {
      return {
        ok: false,
        code: 'invalid_id',
        error: `"${id}" is not a valid harness plugin id`,
      };
    }
    if (RESERVED_LOCAL_HARNESS_IDS.has(id)) {
      return {
        ok: false,
        code: 'reserved_id',
        error: `"${id}" is reserved by a built-in harness`,
      };
    }
    if (seen.has(id)) continue;
    if (!discovered.has(id)) {
      return {
        ok: false,
        code: 'not_discovered',
        error: `Local harness "${id}" is not available`,
      };
    }
    seen.add(id);
    ids.push(id);
  }

  return { ok: true, ids };
}
