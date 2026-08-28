import { appLogger } from '../../logger.js';
import {
  readStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isQuotaExceededStorageError(error) {
  if (!error) return false;
  const maybeName = typeof error === 'object' && 'name' in error ? String(error.name || '') : '';
  const maybeMessage = typeof error === 'object' && 'message' in error ? String(error.message || '') : String(error);
  const text = `${maybeName} ${maybeMessage}`.toLowerCase();
  return text.includes('quotaexceeded') || text.includes('quota exceeded');
}

/**
 * @param {number} [limit]
 * @returns {{ available: boolean, count: number, totalChars: number, largestKeys: Array<{ key: string, size: number }> }}
 */
export function collectLocalStorageDiagnostics(limit = 8) {
  if (typeof localStorage === 'undefined') {
    return { available: false, count: 0, totalChars: 0, largestKeys: [] };
  }
  const entries = [];
  let totalChars = 0;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      const value = key ? localStorage.getItem(key) || '' : '';
      const size = (key ? key.length : 0) + value.length;
      totalChars += size;
      entries.push({ key, size });
    }
  } catch (_) {
    return { available: true, count: -1, totalChars: -1, largestKeys: [] };
  }
  entries.sort((left, right) => right.size - left.size);
  return {
    available: true,
    count: entries.length,
    totalChars,
    largestKeys: entries.slice(0, Math.max(1, limit)),
  };
}

/**
 * @param {string} key
 * @param {string} [fallbackValue]
 * @returns {string}
 */
export function readLocalStorageSafe(key, fallbackValue = '') {
  if (typeof localStorage === 'undefined') return fallbackValue;
  try {
    return readStorageValueWithAlias(localStorage, key, fallbackValue);
  } catch (_) {
    return fallbackValue;
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @param {string} context
 * @returns {boolean}
 */
export function writeLocalStorageSafe(key, value, context) {
  if (typeof localStorage === 'undefined') return false;
  try {
    writeStorageValueWithAlias(localStorage, key, value);
    return true;
  } catch (error) {
    appLogger.log('chat-storage', 'localStorage write failed', {
      context,
      key,
      valueLength: String(value || '').length,
      error: String(error),
      quotaExceeded: isQuotaExceededStorageError(error),
      diagnostics: collectLocalStorageDiagnostics(),
    });
    return false;
  }
}
