import {
  CONTEXT_PICKER_RECENT_LS_KEY,
  CONTEXT_PICKER_RECENT_MAX,
} from '../../config.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';

/**
 * @param {unknown} raw
 * @returns {Array<{ id: string, usedAt: number }>}
 */
export function normalizeRecentEntries(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  /** @type {Array<{ id: string, usedAt: number }>} */
  const entries = [];
  const seen = new Set();

  for (const entry of raw) {
    const id = typeof entry === 'string'
      ? entry
      : typeof entry?.id === 'string'
        ? entry.id
        : '';
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const usedAt = typeof entry?.usedAt === 'number' && Number.isFinite(entry.usedAt)
      ? entry.usedAt
      : 0;
    entries.push({ id, usedAt });
  }

  return entries.slice(0, CONTEXT_PICKER_RECENT_MAX);
}

/**
 * @returns {Array<{ id: string, usedAt: number }>}
 */
export function loadRecentEntries() {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  try {
    const raw = JSON.parse(readStorageValueWithAlias(localStorage, CONTEXT_PICKER_RECENT_LS_KEY, '[]') || '[]');
    return normalizeRecentEntries(raw);
  } catch {
    return [];
  }
}

/**
 * @param {Array<{ id: string, usedAt: number }>} entries
 * @returns {void}
 */
export function saveRecentEntries(entries) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    writeStorageValueWithAlias(
      localStorage,
      CONTEXT_PICKER_RECENT_LS_KEY,
      JSON.stringify(normalizeRecentEntries(entries)),
    );
  } catch {
    // localStorage may be unavailable in private mode.
  }
}

/**
 * @param {string} id
 * @returns {Array<{ id: string, usedAt: number }>}
 */
export function touchRecentEntry(id) {
  if (typeof id !== 'string' || id === '') {
    return loadRecentEntries();
  }

  const now = Date.now();
  const next = [
    { id, usedAt: now },
    ...loadRecentEntries().filter((entry) => entry.id !== id),
  ];
  saveRecentEntries(next);
  return next;
}

/**
 * @param {Array<{ id: string, usedAt: number }>} entries
 * @returns {Map<string, number>}
 */
export function buildRecentRankMap(entries) {
  const rank = new Map();
  entries.forEach((entry, index) => {
    rank.set(entry.id, index);
  });
  return rank;
}

/**
 * @param {Array<{ id: string, label: string }>} items
 * @param {Map<string, number>} recentRank
 * @returns {Array<object>}
 */
export function sortItemsByRecent(items, recentRank) {
  if (!recentRank.size) {
    return items;
  }

  return [...items].sort((left, right) => {
    const leftRank = recentRank.has(left.id)
      ? recentRank.get(left.id)
      : Number.POSITIVE_INFINITY;
    const rightRank = recentRank.has(right.id)
      ? recentRank.get(right.id)
      : Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return String(left.label).localeCompare(String(right.label), undefined, { sensitivity: 'base' });
  });
}

/**
 * @param {Array<{ id: string }>} allItems
 * @param {Array<{ id: string, usedAt: number }>} recentEntries
 * @param {number} maxCount
 * @returns {Array<object>}
 */
export function pickRecentItems(allItems, recentEntries, maxCount) {
  if (!recentEntries.length || !allItems.length || maxCount <= 0) {
    return [];
  }

  const byId = new Map(allItems.map((item) => [item.id, item]));
  /** @type {Array<object>} */
  const picked = [];

  for (const entry of recentEntries) {
    const item = byId.get(entry.id);
    if (!item) {
      continue;
    }
    picked.push(item);
    if (picked.length >= maxCount) {
      break;
    }
  }

  return picked;
}
