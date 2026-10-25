/** @param {number} value @returns {number} */
function round(value) {
  return Number(value.toFixed(3));
}

/**
 * A gate row is measurable only with finite actual and budget and enough samples;
 * NaN, Infinity or a missing sample is UNVERIFIED, never PASS and never FAIL.
 * @param {{ id: string, metric: string, workload: string, primary: boolean, n: number | null, minN: number, budget: number | null, actual: number | null, method: string, note?: string }} row
 */
export function gate(row) {
  const measurable = Number.isFinite(row.actual) && Number.isFinite(row.budget) && row.n !== null && row.n !== undefined && row.n >= row.minN;
  const status = !measurable ? 'UNVERIFIED' : /** @type {number} */ (row.actual) <= /** @type {number} */ (row.budget) ? 'PASS' : 'FAIL';
  const rounded = (/** @type {any} */ value) => (typeof value === 'number' && Number.isFinite(value) ? round(value) : value);
  return { ...row, actual: rounded(row.actual), budget: rounded(row.budget), status };
}
