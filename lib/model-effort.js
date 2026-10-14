/** Shared effort-level normalization (no heavy deps; used by catalog meta and delegation). */

/** Canonical effort levels, weakest first. `none` means no effort param. */
export const EFFORT_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Param ids that carry an effort level (same set as `lib/model-strength-sort.js`). */
export const EFFORT_PARAM_KEYS = Object.freeze(['effort', 'reasoning_effort', 'reasoningeffort', 'reasoning']);

export const EFFORT_LEVEL_ALIASES = Object.freeze({
  minimal: 'low',
  'extra-high': 'xhigh',
  extra_high: 'xhigh',
  extrahigh: 'xhigh',
});

/**
 * Single normalization of an effort param across providers: Claude/Codex use
 * `effort`, grok uses `reasoning_effort`, some catalogs use `reasoning`.
 *
 * @param {Array<{ id?: string, value?: string }> | undefined} params
 * @returns {{ level: 'none'|'low'|'medium'|'high'|'xhigh'|'max', key: string }}
 */
export function normalizeEffortParam(params) {
  if (!Array.isArray(params)) return { level: 'none', key: '' };
  for (const row of params) {
    const key = String(row?.id || '').trim().toLowerCase();
    if (!EFFORT_PARAM_KEYS.includes(key)) continue;
    const raw = String(row?.value || '').trim().toLowerCase();
    const value = EFFORT_LEVEL_ALIASES[raw] || raw;
    if (EFFORT_LEVELS.includes(value) && value !== 'none') return { level: value, key };
  }
  return { level: 'none', key: '' };
}
