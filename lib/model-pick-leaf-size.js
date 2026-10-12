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

const LEAF_FILE_PATH_PATTERN = /(?:^|[\s([`'"\u2013\u2014-])((?:[\w@.-]+\/)+[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|scss|css|md|json|html|php|py|rb|go|rs|toml|yaml|yml|vue|svelte))(?:[`'"\s)\],.:;]|$)/gim;

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
 * @returns {string[]}
 */
export function listExistingFilePathsInLeafBody(leafBody) {
  const text = String(leafBody || '');
  if (!text.trim()) return [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const paths = [];
  for (const match of text.matchAll(LEAF_FILE_PATH_PATTERN)) {
    const raw = String(match[1] || '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
    if (!raw || raw.includes('://')) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(raw);
  }
  return paths;
}

/**
 * @param {unknown} leafBody
 * @param {{ maxFiles?: number, largeKeywords?: string[], env?: Record<string, string | undefined> }} [options]
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
  const files = listExistingFilePathsInLeafBody(leafBody);
  if (files.length === 0) return LEAF_SIZE_LARGE;
  if (files.length > maxFiles) return LEAF_SIZE_LARGE;
  return LEAF_SIZE_SMALL;
}
