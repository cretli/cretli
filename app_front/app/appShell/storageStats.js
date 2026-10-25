/** Browser storage inspection and clearing helpers for the Settings storage tools. */
import { applyChatAuthSessionBoundary } from '../../features/chat/chatSessionBoundary.js';
import { t } from '../../i18n/index.js';

export const APP_STORAGE_PREFIXES = Object.freeze(['cretli-', 'cursor-remote-', 'cr-debug-overlay']);
const APP_IDB_NAMES = Object.freeze([
  'cretli-chat-metadata',
  'cretli-sdk-chat',
  'cretli-chat-buffers',
  'cretli-preferences',
  'cretli-push-inbox',
]);

export function formatBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '0 B';
  if (num < 1024) return `${Math.round(num)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = num / 1024;
  let idx = 0;
  while (current >= 1024 && idx < units.length - 1) {
    current /= 1024;
    idx += 1;
  }
  const rounded = current >= 10 ? Math.round(current) : Math.round(current * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

export function formatPercent(value, total) {
  const base = Number(total);
  if (!Number.isFinite(base) || base <= 0) return '—';
  const part = Number(value);
  if (!Number.isFinite(part) || part <= 0) return '0%';
  const ratio = Math.max(0, Math.min(1, part / base));
  const percent = ratio * 100;
  if (percent >= 10) return `${Math.round(percent)}%`;
  return `${Math.round(percent * 10) / 10}%`;
}

function isAppStorageKey(key) {
  if (!key || typeof key !== 'string') return false;
  return APP_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function collectLocalStorageStats() {
  if (typeof localStorage === 'undefined') {
    return { allBytes: 0, appBytes: 0, allCount: 0, appItems: [] };
  }
  let allBytes = 0;
  let appBytes = 0;
  let allCount = 0;
  const appItems = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    allCount += 1;
    let value = '';
    try {
      value = localStorage.getItem(key) || '';
    } catch (_) {
      value = '';
    }
    const bytes = (String(key).length + String(value).length) * 2;
    allBytes += bytes;
    if (!isAppStorageKey(key)) continue;
    appBytes += bytes;
    appItems.push({ key, bytes });
  }
  appItems.sort((a, b) => b.bytes - a.bytes);
  return { allBytes, appBytes, allCount, appItems };
}

export function collectSessionStorageStats() {
  if (typeof sessionStorage === 'undefined') {
    return { allBytes: 0, appBytes: 0, allCount: 0, appItems: [] };
  }
  let allBytes = 0;
  let appBytes = 0;
  let allCount = 0;
  const appItems = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (!key) continue;
    allCount += 1;
    let value = '';
    try {
      value = sessionStorage.getItem(key) || '';
    } catch (_) {
      value = '';
    }
    const bytes = (String(key).length + String(value).length) * 2;
    allBytes += bytes;
    if (!isAppStorageKey(key)) continue;
    appBytes += bytes;
    appItems.push({ key, bytes });
  }
  appItems.sort((a, b) => b.bytes - a.bytes);
  return { allBytes, appBytes, allCount, appItems };
}

export async function readStorageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return { quota: 0, usage: 0, usageDetails: {}, hasUsageDetails: false };
  }
  try {
    const est = await navigator.storage.estimate();
    const usageDetails = est?.usageDetails && typeof est.usageDetails === 'object'
      ? est.usageDetails
      : {};
    return {
      quota: Number(est?.quota) || 0,
      usage: Number(est?.usage) || 0,
      usageDetails,
      hasUsageDetails: Object.keys(usageDetails).length > 0,
    };
  } catch (_) {
    return { quota: 0, usage: 0, usageDetails: {}, hasUsageDetails: false };
  }
}

export async function listIndexedDbNames() {
  if (typeof indexedDB === 'undefined') return [];
  if (typeof indexedDB.databases !== 'function') return APP_IDB_NAMES.slice();
  try {
    const rows = await indexedDB.databases();
    const names = rows
      .map((row) => (typeof row?.name === 'string' ? row.name.trim() : ''))
      .filter((name) => name);
    return Array.from(new Set(names));
  } catch (_) {
    return APP_IDB_NAMES.slice();
  }
}

export async function listCacheStorageNames() {
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return [];
  try {
    const names = await caches.keys();
    return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
  } catch (_) {
    return [];
  }
}

export function clearLocalStorageAppData() {
  if (typeof localStorage !== 'undefined') {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!isAppStorageKey(key || '')) continue;
      keys.push(String(key));
    }
    for (const key of keys) {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
    }
  }
  // Task 2.1: dropping the persisted activity maps must also drop the RAM copy,
  // and the fresh session marker keeps later writes re-importable.
  void applyChatAuthSessionBoundary({ reason: 'clear-local-data' });
}

export function clearSessionStorageAppData() {
  if (typeof sessionStorage === 'undefined') return;
  const keys = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (!isAppStorageKey(key || '')) continue;
    keys.push(String(key));
  }
  for (const key of keys) {
    try {
      sessionStorage.removeItem(key);
    } catch (_) {}
  }
}

export async function clearIndexedDbAppData() {
  if (typeof indexedDB !== 'undefined') {
    const known = new Set(APP_IDB_NAMES);
    const discovered = await listIndexedDbNames();
    for (const name of discovered) {
      if (!name || !name.startsWith('cretli-')) continue;
      known.add(name);
    }
    await Promise.all(
      [...known].map(
        (name) =>
          new Promise((resolve) => {
            try {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            } catch (_) {
              resolve();
            }
          })
      )
    );
  }
}

export async function clearCacheStorageAppData() {
  if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => typeof name === 'string' && (name.includes('cretli') || name.includes('cursor-remote')))
          .map((name) => caches.delete(name))
      );
    } catch (_) {}
  }
}

export async function clearAppStorageData() {
  clearLocalStorageAppData();
  clearSessionStorageAppData();
  await Promise.all([
    clearIndexedDbAppData(),
    clearCacheStorageAppData(),
  ]);
}

export function collectCookieStats() {
  if (typeof document === 'undefined') return { count: 0, bytes: 0 };
  const raw = String(document.cookie || '');
  if (!raw) return { count: 0, bytes: 0 };
  const parts = raw.split(';').map((part) => part.trim()).filter((part) => part);
  return {
    count: parts.length,
    bytes: raw.length * 2,
  };
}

export function getBrowserEnvironmentLines() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return ['-'];
  const lines = [];
  const timezone = Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone || '—';
  const platform = navigator.userAgentData?.platform || navigator.platform || '—';
  const online = navigator.onLine ? t('common.yes') : t('common.no');
  const touchPoints = Number(navigator.maxTouchPoints) || 0;
  const dpr = Number(window.devicePixelRatio) || 1;
  const viewport = `${window.innerWidth}x${window.innerHeight}`;
  const screenSize = `${window.screen?.width || 0}x${window.screen?.height || 0}`;
  const memoryGb = Number(navigator.deviceMemory) || 0;
  const cores = Number(navigator.hardwareConcurrency) || 0;
  const languages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages.join(', ')
    : (navigator.language || '—');
  lines.push(`UA: ${navigator.userAgent || '—'}`);
  lines.push(`Platform: ${platform}`);
  lines.push(`Online: ${online}`);
  lines.push(`Language(s): ${languages}`);
  lines.push(`Timezone: ${timezone}`);
  lines.push(`Viewport: ${viewport} (DPR ${dpr})`);
  lines.push(`Screen: ${screenSize}`);
  lines.push(`Touch points: ${touchPoints}`);
  lines.push(`CPU cores: ${cores || '—'}`);
  lines.push(`Device memory: ${memoryGb > 0 ? `${memoryGb} GB` : '—'}`);
  lines.push(`Cookies enabled: ${navigator.cookieEnabled ? t('common.yes') : t('common.no')}`);
  lines.push(`Standalone/PWA: ${(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone) ? t('common.yes') : t('common.no')}`);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection) {
    const downlink = Number(connection.downlink);
    const rtt = Number(connection.rtt);
    const effectiveType = connection.effectiveType || '—';
    lines.push(`Network: ${effectiveType}, downlink ${Number.isFinite(downlink) ? `${downlink} Mb/s` : '—'}, RTT ${Number.isFinite(rtt) ? `${rtt} ms` : '—'}`);
    if (typeof connection.saveData === 'boolean') {
      lines.push(`Data saver: ${connection.saveData ? t('common.yes') : t('common.no')}`);
    }
  } else {
    lines.push('Network: —');
  }
  const perfMem = typeof performance !== 'undefined' ? performance.memory : null;
  if (perfMem && Number.isFinite(perfMem.usedJSHeapSize) && Number.isFinite(perfMem.jsHeapSizeLimit)) {
    lines.push(`JS heap: ${formatBytes(perfMem.usedJSHeapSize)} / ${formatBytes(perfMem.jsHeapSizeLimit)}`);
  }
  return lines;
}

export async function readStoragePersistence() {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
    return '—';
  }
  try {
    const persisted = await navigator.storage.persisted();
    return persisted ? t('common.yes') : t('common.no');
  } catch (_) {
    return '—';
  }
}
