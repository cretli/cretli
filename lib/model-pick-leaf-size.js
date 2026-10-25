/**
 * Classify todo leaf bodies for implement model selection (flash allowed only on small stages).
 */

import { readEnvAlias } from './env-alias.js';

/** @typedef {'small' | 'large'} LeafSizeClass */

export const LEAF_SIZE_SMALL = 'small';
export const LEAF_SIZE_LARGE = 'large';

const DEFAULT_LEAF_SIZE_MAX_FILES = 3;
const DEFAULT_LARGE_KEYWORDS = Object.freeze([
  'migracja',
  'kontrakt',
  'refaktor modułu',
]);

// Matches file paths (root-level or nested) without consuming the separators
// around them, so every path on a single line is counted (the old pattern
// required a directory segment and ate the trailing separator, undercounting).
// A path must contain at least one letter before its extension, which keeps
// version numbers like "v18.0" from matching. Lookbehind/lookahead only check
// for an adjacent path character, so URLs ("foo.com/a.js") are excluded and a
// trailing sentence period ("./a.js.") does not block the match. Glob
// characters adjacent to a match (`x*.test.js`) reject it: it is a fragment.
const LEAF_FILE_PATH_PATTERN = /(?<![A-Za-z0-9_@./*?{}-])((?:(?:[A-Za-z0-9_@.-]+\/)*)[A-Za-z0-9_@.-]*[A-Za-z][A-Za-z0-9_@.-]*\.(?:js|mjs|cjs|ts|tsx|jsx|scss|css|md|json|html|php|py|rb|go|rs|toml|yaml|yml|vue|svelte))(?![A-Za-z0-9_@/*-])/gi;

/**
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {{ maxFiles: number, largeKeywords: string[] }}
 */
export function loadLeafSizeConfig(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const maxRaw = readEnvAlias({
    current: 'CRETLI_LEAF_SIZE_MAX_FILES',
    legacy: 'CURSOR_REMOTE_LEAF_SIZE_MAX_FILES',
    defaultValue: String(DEFAULT_LEAF_SIZE_MAX_FILES),
    env,
  });
  const parsedMax = Number.parseInt(String(maxRaw || '').trim(), 10);
  const maxFiles = Number.isFinite(parsedMax) && parsedMax >= 0
    ? parsedMax
    : DEFAULT_LEAF_SIZE_MAX_FILES;
  const keywordsRaw = readEnvAlias({
    current: 'CRETLI_LEAF_SIZE_LARGE_KEYWORDS',
    legacy: 'CURSOR_REMOTE_LEAF_SIZE_LARGE_KEYWORDS',
    defaultValue: DEFAULT_LARGE_KEYWORDS.join('|'),
    env,
  });
  const largeKeywords = String(keywordsRaw || '')
    .split('|')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return {
    maxFiles,
    largeKeywords: largeKeywords.length > 0 ? largeKeywords : [...DEFAULT_LARGE_KEYWORDS],
  };
}

/**
 * @param {unknown} leafBody
 * @param {{ exists?: (relativePath: string) => boolean }} [options]
 * @returns {string[]}
 */
export function listExistingFilePathsInLeafBody(leafBody, options = {}) {
  const text = String(leafBody || '');
  if (!text.trim()) return [];
  const exists = typeof options?.exists === 'function' ? options.exists : null;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const paths = [];
  for (const match of text.matchAll(LEAF_FILE_PATH_PATTERN)) {
    const raw = String(match[1] || '').trim();
    if (!raw || raw.includes('://')) continue;
    // A bare extension fragment (`.test.js` left over from `tests/x*.test.js`)
    // names no file; the glob guards in the pattern already drop the rest.
    if (!raw.includes('/') && raw.startsWith('.')) continue;
    if (exists && !exists(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(raw);
  }
  return paths;
}

/**
 * @param {unknown} leafBody
 * @param {{ maxFiles?: number, largeKeywords?: string[], env?: Record<string, string | undefined>, exists?: (relativePath: string) => boolean }} [options]
 * @returns {LeafSizeClass}
 */
export function classifyLeafSize(leafBody, options = {}) {
  const config = loadLeafSizeConfig({ env: options.env });
  const maxFiles = Number.isFinite(Number(options.maxFiles))
    ? Math.max(0, Math.floor(Number(options.maxFiles)))
    : config.maxFiles;
  const keywords = Array.isArray(options.largeKeywords) && options.largeKeywords.length > 0
    ? options.largeKeywords.map((word) => String(word || '').trim().toLowerCase()).filter(Boolean)
    : config.largeKeywords;
  const normalizedBody = String(leafBody || '').toLowerCase();
  for (const keyword of keywords) {
    if (keyword && normalizedBody.includes(keyword)) return LEAF_SIZE_LARGE;
  }
  // When an `exists` predicate is supplied the classifier is workspace-aware:
  // only paths that actually exist are counted, so a body naming only
  // non-existent files is treated as having no file list (= large).
  const files = listExistingFilePathsInLeafBody(leafBody, { exists: options.exists });
  if (files.length === 0) return LEAF_SIZE_LARGE;
  if (files.length > maxFiles) return LEAF_SIZE_LARGE;
  return LEAF_SIZE_SMALL;
}
