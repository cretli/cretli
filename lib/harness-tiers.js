/**
 * Pure (no imports) so both the server and the front bundle can read it.
 */

/**
 * Support tier per harness, shown in Settings and used for fresh-install defaults.
 * `recommended`: on by default for a new install and featured in docs; `experimental`:
 * newly added, not yet verified in daily use; every other harness is `available`
 * (installed and one switch away). Tiers never remove a harness.
 */
export const HARNESS_TIERS = Object.freeze({
  claude: 'recommended',
  codex: 'recommended',
  deepseek: 'recommended',
  openrouter: 'recommended',
  antigravity: 'experimental',
});

/**
 * @param {unknown} id normalized harness id
 * @returns {'recommended' | 'available' | 'experimental'}
 */
export function harnessTierOf(id) {
  const key = String(id || '').trim().toLowerCase();
  return HARNESS_TIERS[key === 'cursor' ? 'sdk' : key] || 'available';
}
