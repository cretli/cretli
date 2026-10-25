/**
 * Nearest-rank percentile of a numeric sample.
 *
 * @param {number[]} values
 * @param {number} p Percentile in (0, 100].
 * @returns {number} 0 for an empty sample.
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}
