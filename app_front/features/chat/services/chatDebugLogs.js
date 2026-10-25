/** URL/localStorage-gated debug logging for auto-title, fork and status flows. */
import { appLogger } from '../../../core/logging/logger.js';
import { readStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';

export function isDebugAutoTitle() {
  if (typeof window === 'undefined') return false;
  const q = typeof window.location !== 'undefined' && window.location.search || '';
  if (/\b(debug|cretli-debug=1)\b/.test(q)) return true;
  try {
    return readStorageValueWithAlias(localStorage, 'cretli-debug-auto-title', '') === '1';
  } catch (_) {
    return false;
  }
}

const AUTO_TITLE_PANEL_TAGS = ['patch', 'patchChat response', 'patchChat error', 'extract regex ok', 'extract line JSON ok', 'timeout', 'request'];

export function debugAutoTitle(...args) {
  if (isDebugAutoTitle()) {
    console.log('[auto-title]', ...args);
    if (args[0] && AUTO_TITLE_PANEL_TAGS.includes(args[0])) {
      appLogger.log('auto-title', ...args);
    }
  }
}

/** Enable fork logs (title / summary): URL ?debug-fork or localStorage 'cretli-debug-fork' = '1'. */
export function isDebugFork() {
  if (typeof window === 'undefined') return false;
  const q = typeof window.location !== 'undefined' && window.location.search || '';
  if (/\bdebug-fork\b/.test(q)) return true;
  try {
    return readStorageValueWithAlias(localStorage, 'cretli-debug-fork', '') === '1';
  } catch (_) {
    return false;
  }
}
export function debugFork(tag, ...args) {
  if (isDebugFork()) {
    console.log('[fork-' + tag + ']', ...args);
    appLogger.log('fork-' + tag, ...args);
  }
}

/** Enable chat status logs (state change + parsing tail): ?debug-status or localStorage 'cretli-debug-status' = '1'. */
export function isDebugStatus() {
  if (typeof window === 'undefined') return false;
  const q = typeof window.location !== 'undefined' && window.location.search || '';
  if (/\bdebug-status\b/.test(q)) return true;
  try {
    return readStorageValueWithAlias(localStorage, 'cretli-debug-status', '') === '1';
  } catch (_) {
    return false;
  }
}
