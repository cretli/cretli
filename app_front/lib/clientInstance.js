/**
 * Stable client instance identity (one browser profile / PWA install).
 */

import { isStandalonePwa } from './mobileClient.js';
import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from './storageKeyAlias.js';

export const CLIENT_INSTANCE_ID_LS_KEY = 'cretli-client-instance-id';
export const CLIENT_INSTANCE_LABEL_LS_KEY = 'cretli-client-instance-label';
export const CLIENT_INSTANCE_ID_COOKIE = 'cretli-client-instance-id';

/** @type {string|null} */
let cachedInstanceId = null;

/**
 * @returns {string}
 */
function createInstanceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ci-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {Storage|null|undefined} storage
 * @returns {string}
 */
function readInstanceIdFromStorage(storage) {
  if (!storage) return '';
  try {
    const existing = readStorageValueWithAlias(storage, CLIENT_INSTANCE_ID_LS_KEY, '');
    if (existing && String(existing).trim()) return String(existing).trim();
  } catch {
    // ignore
  }
  return '';
}

/**
 * @returns {string}
 */
function readInstanceIdFromCookie() {
  if (typeof document === 'undefined') return '';
  const parts = document.cookie ? document.cookie.split(';') : [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${CLIENT_INSTANCE_ID_COOKIE}=`)) continue;
    const value = decodeURIComponent(trimmed.slice(CLIENT_INSTANCE_ID_COOKIE.length + 1)).trim();
    if (value) return value;
  }
  return '';
}

/**
 * @param {string} id
 */
function persistInstanceIdToCookie(id) {
  if (typeof document === 'undefined' || !id) return;
  try {
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${CLIENT_INSTANCE_ID_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  } catch {
    // ignore
  }
}

/**
 * @param {string} id
 */
function persistInstanceId(id) {
  if (!id) return;
  if (typeof localStorage !== 'undefined') {
    try {
      writeStorageValueWithAlias(localStorage, CLIENT_INSTANCE_ID_LS_KEY, id);
    } catch {
      // ignore — memory cache keeps this tab stable
    }
  }
  persistInstanceIdToCookie(id);
  if (typeof sessionStorage !== 'undefined') {
    try {
      writeStorageValueWithAlias(sessionStorage, CLIENT_INSTANCE_ID_LS_KEY, id);
    } catch {
      // ignore
    }
  }
}

/**
 * @returns {string}
 */
export function getClientInstanceId() {
  if (cachedInstanceId) return cachedInstanceId;
  const fromLocal = readInstanceIdFromStorage(typeof localStorage !== 'undefined' ? localStorage : null);
  if (fromLocal) {
    cachedInstanceId = fromLocal;
    persistInstanceId(fromLocal);
    return cachedInstanceId;
  }
  const fromCookie = readInstanceIdFromCookie();
  if (fromCookie) {
    cachedInstanceId = fromCookie;
    persistInstanceId(fromCookie);
    return cachedInstanceId;
  }
  const fromSession = readInstanceIdFromStorage(typeof sessionStorage !== 'undefined' ? sessionStorage : null);
  if (fromSession) {
    cachedInstanceId = fromSession;
    persistInstanceId(fromSession);
    return cachedInstanceId;
  }
  const next = createInstanceId();
  cachedInstanceId = next;
  persistInstanceId(next);
  return cachedInstanceId;
}

/**
 * Resets in-memory cache (tests only).
 */
export function resetClientInstanceForTests() {
  cachedInstanceId = null;
}

/**
 * @returns {'pwa' | 'browser' | 'embed'}
 */
export function getClientInstanceKind() {
  if (typeof window === 'undefined') return 'browser';
  if (document.body?.classList.contains('embed-mode')) return 'embed';
  if (isStandalonePwa()) return 'pwa';
  return 'browser';
}

/**
 * @param {string} [ua]
 * @returns {string}
 */
function inferPlatformLabel(ua = '') {
  const value = String(ua || '');
  if (/Android/i.test(value)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(value)) return 'iOS';
  if (/Windows/i.test(value)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(value)) return 'macOS';
  if (/Linux/i.test(value)) return 'Linux';
  return 'Unknown';
}

/**
 * @param {string} [ua]
 * @returns {string}
 */
function inferBrowserLabel(ua = '') {
  const value = String(ua || '');
  if (/Edg\//i.test(value)) return 'Edge';
  if (/Chrome\//i.test(value) && !/Edg\//i.test(value)) return 'Chrome';
  if (/Firefox\//i.test(value)) return 'Firefox';
  if (/Safari/i.test(value) && !/Chrome/i.test(value)) return 'Safari';
  return 'Browser';
}

/**
 * @returns {string}
 */
export function buildDefaultClientInstanceLabel() {
  const kind = getClientInstanceKind();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const platform = inferPlatformLabel(ua);
  const browser = inferBrowserLabel(ua);
  if (kind === 'pwa') return `PWA · ${platform}`;
  if (kind === 'embed') return `Embed · ${platform}`;
  return `${browser} · ${platform}`;
}

/**
 * @returns {string}
 */
export function getClientInstanceLabel() {
  if (typeof localStorage !== 'undefined') {
    try {
      const custom = readStorageValueWithAlias(localStorage, CLIENT_INSTANCE_LABEL_LS_KEY, '');
      if (custom && String(custom).trim()) return String(custom).trim().slice(0, 80);
    } catch {
      // ignore
    }
  }
  return buildDefaultClientInstanceLabel();
}

/**
 * @param {string} label
 */
export function setClientInstanceLabel(label) {
  if (typeof localStorage === 'undefined') return;
  const normalized = String(label || '').trim().slice(0, 80);
  try {
    if (!normalized) removeStorageValueWithAlias(localStorage, CLIENT_INSTANCE_LABEL_LS_KEY);
    else writeStorageValueWithAlias(localStorage, CLIENT_INSTANCE_LABEL_LS_KEY, normalized);
  } catch {
    // ignore
  }
}

/**
 * @returns {string}
 */
export function getClientUserAgentShort() {
  if (typeof navigator === 'undefined') return '';
  return String(navigator.userAgent || '').slice(0, 500);
}

/**
 * Initializes client instance id in localStorage.
 */
export function initClientInstance() {
  getClientInstanceId();
}
