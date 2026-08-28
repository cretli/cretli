/**
 * Reads environment variables with support for legacy aliases.
 * Prefer the current key, then fall back to the legacy key.
 *
 * @param {{ current: string, legacy?: string, defaultValue?: string }} options
 * @returns {string}
 */
export function readEnvAlias(options) {
  const currentName = String(options?.current || '').trim();
  const legacyName = String(options?.legacy || '').trim();
  const defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : '';
  if (!currentName) return defaultValue;
  const currentValue = process.env[currentName];
  if (typeof currentValue === 'string' && currentValue !== '') return currentValue;
  if (legacyName) {
    const legacyValue = process.env[legacyName];
    if (typeof legacyValue === 'string' && legacyValue !== '') return legacyValue;
  }
  return defaultValue;
}
