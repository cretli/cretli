const LEGACY_PREFIX = 'cursor-remote-';
const CURRENT_PREFIX = 'cretli-';
let didRunLegacyCleanup = false;

/**
 * @param {string} key
 * @returns {string}
 */
export function toCurrentStorageKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key.startsWith(CURRENT_PREFIX)) return key;
  if (key.startsWith(LEGACY_PREFIX)) {
    return CURRENT_PREFIX + key.slice(LEGACY_PREFIX.length);
  }
  return key;
}

/**
 * @param {string} key
 * @returns {string}
 */
export function toLegacyStorageKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (key.startsWith(LEGACY_PREFIX)) return key;
  if (key.startsWith(CURRENT_PREFIX)) {
    return LEGACY_PREFIX + key.slice(CURRENT_PREFIX.length);
  }
  return key;
}

/**
 * @param {Storage} storage
 * @param {string} key
 * @param {string} fallbackValue
 * @returns {string}
 */
export function readStorageValueWithAlias(storage, key, fallbackValue = '') {
  maybeCleanupLegacyAliasesOnce(storage);
  const currentKey = toCurrentStorageKey(key);
  const legacyKey = toLegacyStorageKey(currentKey);
  const currentValue = storage.getItem(currentKey);
  if (currentValue != null) return currentValue;
  const legacyValue = legacyKey !== currentKey ? storage.getItem(legacyKey) : null;
  if (legacyValue == null) return fallbackValue;
  return legacyValue;
}

/**
 * @param {Storage} storage
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
export function writeStorageValueWithAlias(storage, key, value) {
  maybeCleanupLegacyAliasesOnce(storage);
  const currentKey = toCurrentStorageKey(key);
  const legacyKey = toLegacyStorageKey(currentKey);
  storage.setItem(currentKey, value);
  if (legacyKey === currentKey) return;
  const legacyValue = storage.getItem(legacyKey);
  if (legacyValue == null) return;
  storage.setItem(legacyKey, value);
}

/**
 * @param {Storage} storage
 * @param {string} key
 * @returns {void}
 */
export function removeStorageValueWithAlias(storage, key) {
  const currentKey = toCurrentStorageKey(key);
  const legacyKey = toLegacyStorageKey(currentKey);
  storage.removeItem(currentKey);
  if (legacyKey !== currentKey) storage.removeItem(legacyKey);
}

/**
 * Removes legacy `cursor-remote-*` entries that are exact duplicates of
 * their current `cretli-*` counterparts.
 *
 * @param {Storage} storage
 * @returns {{ removed: number }}
 */
export function cleanupLegacyStorageAliases(storage) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') {
    return { removed: 0 };
  }
  /** @type {string[]} */
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === 'string' && key) keys.push(key);
  }
  let removed = 0;
  for (const legacyKey of keys) {
    if (!legacyKey.startsWith(LEGACY_PREFIX)) continue;
    const currentKey = toCurrentStorageKey(legacyKey);
    if (!currentKey || currentKey === legacyKey) continue;
    const currentValue = storage.getItem(currentKey);
    if (currentValue == null) continue;
    const legacyValue = storage.getItem(legacyKey);
    if (legacyValue !== currentValue) continue;
    storage.removeItem(legacyKey);
    removed += 1;
  }
  return { removed };
}

/**
 * @param {Storage} storage
 * @returns {void}
 */
function maybeCleanupLegacyAliasesOnce(storage) {
  if (didRunLegacyCleanup) return;
  didRunLegacyCleanup = true;
  try {
    cleanupLegacyStorageAliases(storage);
  } catch (_) {
    // ignore
  }
}
