/**
 * When to pull the eight harness model catalogs (slow CodeBuddy / OpenCode / SDK).
 *
 * @param {'boot' | 'settings' | 'new-chat' | 'models-changed' | 'lang'} reason
 * @returns {boolean}
 */
export function shouldLoadHarnessModelCatalogs(reason) {
  return reason === 'settings' || reason === 'models-changed';
}

/**
 * Pick the value for a harness `<select>` after its options were rebuilt.
 * Keep the current value when it is still available; otherwise fall back to the default, then
 * to the first option. Never returns a value that is not in `options`.
 *
 * @param {{ current?: unknown, options?: unknown[], fallback?: unknown }} [params]
 * @returns {string}
 */
export function resolveHarnessSelectValue(params = {}) {
  const values = Array.isArray(params.options) ? params.options.map((value) => String(value)) : [];
  const current = typeof params.current === 'string' ? params.current : '';
  if (current && values.includes(current)) return current;
  const fallback = typeof params.fallback === 'string' ? params.fallback : '';
  if (fallback && values.includes(fallback)) return fallback;
  return values[0] || '';
}
