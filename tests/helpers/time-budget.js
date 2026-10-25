/**
 * Wall-clock budgets for performance regression tests. The numbers in the tests
 * are tuned for a developer machine; hosted CI runners (CI=true) are shared and
 * several times slower, so the same budget is multiplied there. A genuine
 * regression (the quadratic cases these tests guard) still exceeds it by orders
 * of magnitude.
 *
 * @param {number} ms budget on a developer machine
 * @returns {number}
 */
export function budgetMs(ms) {
  const scale = Number(process.env.CRETLI_TEST_TIME_SCALE) || (process.env.CI ? 3 : 1);
  return ms * scale;
}
