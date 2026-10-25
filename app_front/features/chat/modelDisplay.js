import { EFFORT_LEVELS, EFFORT_LEVEL_ALIASES, EFFORT_PARAM_KEYS } from '../../../lib/model-effort.js';

/**
 * Human-facing model name and effort for compact pickers. Stored values look like
 * `claude-opus-5-5::effort=medium` (`id::key=value,key=value`); the raw value stays
 * available to callers for tooltips.
 */

/** Tokens whose casing a plain capitalise would get wrong. */
const TOKEN_CASING = Object.freeze({
  gpt: 'GPT',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  mimo: 'MiMo',
  qwen: 'Qwen',
  ai: 'AI',
  oss: 'OSS',
});

const VERSION_PART = /^\d{1,2}(?:\.\d+)*$/;
const DATE_STAMP = /^\d{6,8}$/;

/**
 * @param {string} raw
 * @returns {{ id: string, params: Record<string, string> }}
 */
function splitModelValue(raw) {
  const sep = raw.indexOf('::');
  const id = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  const params = {};
  if (sep !== -1) {
    for (const pair of raw.slice(sep + 2).split(',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      params[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
    }
  }
  return { id, params };
}

/**
 * @param {Record<string, string>} params
 * @returns {string} Canonical effort level or '' when none.
 */
function readEffort(params) {
  for (const key of EFFORT_PARAM_KEYS) {
    const raw = String(params[key] || '').trim().toLowerCase();
    if (!raw) continue;
    const level = EFFORT_LEVEL_ALIASES[raw] || raw;
    // Codex adds `ultra` above `max`; it is display-only here, so it is not a shared level.
    if ((EFFORT_LEVELS.includes(level) || level === 'ultra') && level !== 'none') return level;
  }
  return '';
}

/**
 * @param {string} token
 * @returns {string}
 */
function caseToken(token) {
  const lower = token.toLowerCase();
  if (TOKEN_CASING[lower]) return TOKEN_CASING[lower];
  // `v4`, `r1`, `k2`: a letter-plus-digits tag reads best upper-cased.
  if (/^[a-z]\d+[a-z]?$/.test(lower)) return lower.toUpperCase();
  const brand = Object.keys(TOKEN_CASING).find((key) => lower.startsWith(key) && /^\d/.test(lower.slice(key.length)));
  if (brand) return TOKEN_CASING[brand] + lower.slice(brand.length);
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Turn a catalog id into a readable name: `claude-opus-5-5` -> `Opus 5.5`,
 * `gpt-5.6-sol` -> `GPT-5.6 Sol`, `deepseek-v4-pro` -> `DeepSeek V4 Pro`.
 *
 * @param {string} id
 * @returns {string}
 */
export function prettifyModelId(id) {
  const base = String(id || '').trim();
  if (!base) return '';
  // Router ids carry a vendor path (`anthropic/claude-…`); the last segment is the model.
  const lastSegment = base.split('/').pop() || base;
  const tokens = lastSegment.split(/[-_\s]+/).filter(Boolean);
  // The Claude family name already identifies the vendor in a harness-labelled picker.
  if (tokens[0]?.toLowerCase() === 'claude' && tokens.length > 1) tokens.shift();
  const words = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (DATE_STAMP.test(token)) continue;
    if (VERSION_PART.test(token)) {
      // Runs of short numbers are one dotted version (`5-5` -> `5.5`).
      const parts = [token];
      while (i + 1 < tokens.length && VERSION_PART.test(tokens[i + 1])) {
        parts.push(tokens[i + 1]);
        i += 1;
      }
      const version = parts.join('.');
      // `gpt` + version reads as one word: `GPT-5.6`.
      if (words.length && words[words.length - 1] === 'GPT') words[words.length - 1] = `GPT-${version}`;
      else words.push(version);
      continue;
    }
    words.push(caseToken(token));
  }
  return words.join(' ') || lastSegment;
}

/**
 * @param {unknown} value Stored model value (`id::params`).
 * @param {unknown} [label] Catalog label; used when it is a real display name.
 * @returns {{ name: string, effort: string, id: string }}
 */
export function formatModelDisplay(value, label = '') {
  const raw = String(value || '').trim();
  const { id, params } = splitModelValue(raw);
  const effort = readEffort(params);
  let catalogLabel = String(label || '').trim();
  // Variants are labelled `Opus 5.5 — MEDIUM` / `GPT-6 Astra — Extra High`; effort is shown separately.
  if (Object.keys(params).length) catalogLabel = catalogLabel.replace(/\s+[—–]\s+[^—–]+$/, '').trim();
  // The harness badge already names the vendor (`Claude Opus 5.5` -> `Opus 5.5`).
  catalogLabel = catalogLabel.replace(/^claude\s+(?=\S)/i, '');
  // Catalogs often echo the id as the label; only a distinct label is a display name.
  const labelIsName = catalogLabel
    && !catalogLabel.includes('::')
    && catalogLabel.toLowerCase() !== id.toLowerCase();
  const name = labelIsName ? catalogLabel : prettifyModelId(id);
  return { name: name || raw, effort, id };
}

/** Effort levels from weakest to strongest, including Codex's display-only `ultra`. */
export const EFFORT_DISPLAY_ORDER = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * Filled-bar count (out of four) for an effort level.
 *
 * @param {string} effort
 * @returns {number}
 */
export function effortBarCount(effort) {
  switch (effort) {
    case 'low': return 1;
    case 'medium': return 2;
    case 'high': return 3;
    case 'xhigh':
    case 'max':
    case 'ultra': return 4;
    default: return 0;
  }
}
