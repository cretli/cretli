/**
 * Compact harness badge: a two-letter monogram on a semantic tone. Monograms
 * instead of vendor logos keep the public UI free of third-party trademarks.
 * Tones map to the `--cr-<tone>` / `-bg` / `-border` token triplets.
 */

/** @typedef {'info' | 'success' | 'warn' | 'plan' | 'status' | 'neutral' | 'error'} HarnessBadgeTone */

/** @type {Readonly<Record<string, { text: string, tone: HarnessBadgeTone }>>} */
const HARNESS_BADGES = Object.freeze({
  claude: { text: 'Cl', tone: 'warn' },
  codex: { text: 'Cx', tone: 'success' },
  sdk: { text: 'Cu', tone: 'info' },
  openrouter: { text: 'OR', tone: 'plan' },
  opencode: { text: 'OC', tone: 'neutral' },
  codebuddy: { text: 'CB', tone: 'status' },
  deepseek: { text: 'DS', tone: 'info' },
  mistral: { text: 'Mi', tone: 'warn' },
  zai: { text: 'Z', tone: 'status' },
  mimo: { text: 'MM', tone: 'error' },
  qwen: { text: 'Qw', tone: 'plan' },
});

/**
 * @param {string} harnessId
 * @param {string} [label] Display label used to derive a monogram for unknown ids.
 * @returns {{ text: string, tone: HarnessBadgeTone }}
 */
export function getHarnessBadge(harnessId, label = '') {
  const id = String(harnessId || '').trim().toLowerCase();
  if (HARNESS_BADGES[id]) return HARNESS_BADGES[id];
  const source = String(label || id || '?').replace(/[^A-Za-z0-9]/g, '');
  return { text: source.slice(0, 2) || '?', tone: 'neutral' };
}
