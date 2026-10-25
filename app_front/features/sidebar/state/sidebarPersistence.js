import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';

export const SIDEBAR_OPEN_KEY = 'cretli-sidebar-open';
export const SIDEBAR_COLLAPSE_KEY = 'cretli-sidebar-collapsed';
export const SIDEBAR_ARCHIVE_OPEN_KEY = 'cretli-sidebar-archive-open';
export const SIDEBAR_SUBCHAT_EXPANDED_KEY = 'cretli-sidebar-subchat-expanded';
export const SIDEBAR_PIN_KEY = 'cretli-sidebar-pinned';
export const SIDEBAR_WIDTH_KEY = 'cretli-sidebar-width';
export const SIDEBAR_PIN_ACTIVE_WORKSPACE_KEY = 'cretli-sidebar-pin-active-workspace';
export const SIDEBAR_WATCHER_SHOW_ALL_KEY = 'cretli-sidebar-watcher-show-all';

function readFlag(key) {
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, key, '') === '1';
  } catch (_) {
    return false;
  }
}

function writeFlag(key, value) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, key, value ? '1' : '0');
  } catch (_) {}
}

export const readOpenFlag = () => readFlag(SIDEBAR_OPEN_KEY);
export const writeOpenFlag = (value) => writeFlag(SIDEBAR_OPEN_KEY, value);
export const readPinFlag = () => readFlag(SIDEBAR_PIN_KEY);
export const writePinFlag = (value) => writeFlag(SIDEBAR_PIN_KEY, value);
export const readPinActiveWorkspaceFlag = () => readFlag(SIDEBAR_PIN_ACTIVE_WORKSPACE_KEY);
export const writePinActiveWorkspaceFlag = (value) => writeFlag(SIDEBAR_PIN_ACTIVE_WORKSPACE_KEY, value);
export const readWatcherShowAllFlag = () => readFlag(SIDEBAR_WATCHER_SHOW_ALL_KEY);
export const writeWatcherShowAllFlag = (value) => writeFlag(SIDEBAR_WATCHER_SHOW_ALL_KEY, value);

function readSet(key, normalize = (value) => String(value || '').trim()) {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = readStorageValueWithAlias(localStorage, key, '');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map(normalize).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function writeSet(key, values, normalize = (value) => String(value || '').trim()) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, key, JSON.stringify([...values].map(normalize).filter(Boolean)));
  } catch (_) {}
}

export const normalizePath = (value) =>
  typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/$/, '').trim() : '';

export const readCollapsedSet = () => readSet(SIDEBAR_COLLAPSE_KEY, normalizePath);
export const writeCollapsedSet = (values) => writeSet(SIDEBAR_COLLAPSE_KEY, values, normalizePath);
export const readArchiveOpenSet = () => readSet(SIDEBAR_ARCHIVE_OPEN_KEY);
export const writeArchiveOpenSet = (values) => writeSet(SIDEBAR_ARCHIVE_OPEN_KEY, values);
export const readSubchatExpandedSet = () => readSet(SIDEBAR_SUBCHAT_EXPANDED_KEY);
export const writeSubchatExpandedSet = (values) => writeSet(SIDEBAR_SUBCHAT_EXPANDED_KEY, values);

export function readSidebarWidth() {
  if (typeof localStorage === 'undefined') return 0;
  try {
    const value = parseFloat(readStorageValueWithAlias(localStorage, SIDEBAR_WIDTH_KEY, ''));
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  } catch (_) {
    return 0;
  }
}

export function writeSidebarWidth(value, clamp) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, SIDEBAR_WIDTH_KEY, String(clamp(value)));
  } catch (_) {}
}
