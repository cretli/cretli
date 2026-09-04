import { normalizeAgentTransport } from '../../../lib/agent-transport.js';
import {
  readLocalStorageSafe,
  writeLocalStorageSafe,
} from './chatLocalStorage.js';

export const CHAT_PRESETS_STORAGE_KEY = 'cretli-chat-favorite-presets';
export const CHAT_PRESETS_CHANGED_EVENT = 'cretli-chat-presets-changed';

/**
 * @typedef {{ harness: string, model: string }} ChatPreset
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeModel(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {ChatPreset|null}
 */
export function normalizeChatPreset(value) {
  if (!value || typeof value !== 'object') return null;
  const model = normalizeModel(value.model);
  if (!model) return null;
  return {
    harness: normalizeAgentTransport(value.harness),
    model,
  };
}

/**
 * @param {ChatPreset} preset
 * @returns {string}
 */
export function chatPresetKey(preset) {
  const normalized = normalizeChatPreset(preset);
  if (!normalized) return '';
  return `${normalized.harness}\u0000${normalized.model}`;
}

/**
 * @param {unknown} value
 * @returns {ChatPreset[]}
 */
function normalizePresetList(value) {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.items)
      ? value.items
      : [];
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const preset = normalizeChatPreset(row);
    const key = preset ? chatPresetKey(preset) : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(preset);
  }
  return result;
}

/**
 * @param {string} [storageKey]
 */
export function createChatPresetsStore(storageKey = CHAT_PRESETS_STORAGE_KEY) {
  let presets = null;

  function ensureLoaded() {
    if (presets) return;
    let parsed = [];
    try {
      const raw = readLocalStorageSafe(storageKey, '');
      if (raw) parsed = JSON.parse(raw);
    } catch (_) {
      parsed = [];
    }
    presets = normalizePresetList(parsed);
  }

  function getPresets() {
    ensureLoaded();
    return presets.map((preset) => ({ ...preset }));
  }

  function emitChange() {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(CHAT_PRESETS_CHANGED_EVENT, {
      detail: { presets: getPresets() },
    }));
  }

  function commit(next) {
    presets = normalizePresetList(next);
    writeLocalStorageSafe(storageKey, JSON.stringify(presets), 'chatPresets');
    emitChange();
  }

  /** @param {unknown} value */
  function isFavorite(value) {
    const preset = normalizeChatPreset(value);
    if (!preset) return false;
    return getPresets().some((row) => chatPresetKey(row) === chatPresetKey(preset));
  }

  /**
   * @param {unknown} value
   * @returns {boolean} Whether the preset is favorite after the change.
   */
  function toggleFavorite(value) {
    const preset = normalizeChatPreset(value);
    if (!preset) return false;
    const key = chatPresetKey(preset);
    const current = getPresets();
    const index = current.findIndex((row) => chatPresetKey(row) === key);
    if (index >= 0) {
      current.splice(index, 1);
      commit(current);
      return false;
    }
    commit([...current, preset]);
    return true;
  }

  /** @param {unknown} value */
  function removeFavorite(value) {
    const preset = normalizeChatPreset(value);
    if (!preset) return false;
    const key = chatPresetKey(preset);
    const current = getPresets();
    const next = current.filter((row) => chatPresetKey(row) !== key);
    if (next.length === current.length) return false;
    commit(next);
    return true;
  }

  return {
    getPresets,
    isFavorite,
    toggleFavorite,
    removeFavorite,
  };
}
