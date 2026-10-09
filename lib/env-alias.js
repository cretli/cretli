/**
 * Reads environment variables with support for legacy aliases.
 * Prefer the current key, then fall back to the legacy key.
 *
 * `env` defaults to `process.env`; passing an explicit object makes a resolver
 * testable without mutating the real environment (see browser owner lease TTL).
 *
 * @param {{ current: string, legacy?: string, defaultValue?: string, env?: Record<string, string|undefined> }} options
 * @returns {string}
 */
export function readEnvAlias(options) {
  const currentName = String(options?.current || '').trim();
  const legacyName = String(options?.legacy || '').trim();
  const defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : '';
  if (!currentName) return defaultValue;
  const env = options?.env && typeof options.env === 'object' ? options.env : process.env;
  const currentValue = env[currentName];
  if (typeof currentValue === 'string' && currentValue !== '') return currentValue;
  if (legacyName) {
    const legacyValue = env[legacyName];
    if (typeof legacyValue === 'string' && legacyValue !== '') return legacyValue;
  }
  return defaultValue;
}
