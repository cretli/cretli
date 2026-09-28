import {
  CHAT_PRESETS_CHANGED_EVENT,
  createChatPresetsStore,
} from './chatPresets.js';

const presetsStore = createChatPresetsStore();

/**
 * @param {unknown} harness
 * @returns {string}
 */
function normalizeHarness(harness) {
  return String(harness || '').trim().toLowerCase();
}

/**
 * @param {string} harness
 * @param {string} model
 * @returns {boolean}
 */
export function isFavoriteModel(harness, model) {
  return presetsStore.isFavorite({
    harness: normalizeHarness(harness),
    model: String(model || '').trim(),
  });
}

/**
 * @param {string} harness
 * @returns {boolean}
 */
export function hasFavoriteHarness(harness) {
  const id = normalizeHarness(harness);
  return id !== '' && presetsStore.getPresets().some((preset) => preset.harness === id);
}

/**
 * @param {string} harness
 * @param {string} model
 * @returns {boolean}
 */
export function toggleFavoriteModel(harness, model) {
  return presetsStore.toggleFavorite({
    harness: normalizeHarness(harness),
    model: String(model || '').trim(),
  });
}

/**
 * @param {() => void} callback
 * @returns {() => void}
 */
export function subscribeToFavoriteModelChanges(callback) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const listener = () => callback();
  window.addEventListener(CHAT_PRESETS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHAT_PRESETS_CHANGED_EVENT, listener);
}

export function favoriteStarHtml() {
  return '<span class="model-favorite-star mdi mdi-star" aria-label="Favorite" title="Favorite"></span>';
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {boolean} active
 * @returns {string}
 */
export function favoriteModelButtonHtml(harness, model, active) {
  const escapeAttribute = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const icon = active ? 'mdi-star' : 'mdi-star-outline';
  const label = active ? 'Remove favorite model' : 'Add favorite model';
  return '<button type="button" class="model-favorite-toggle'
    + (active ? ' is-active' : '')
    + '" data-favorite-harness="' + escapeAttribute(harness)
    + '" data-favorite-model="' + escapeAttribute(model)
    + '" aria-pressed="' + (active ? 'true' : 'false')
    + '" aria-label="' + label + '" title="' + label + '">'
    + '<span class="mdi ' + icon + '" aria-hidden="true"></span>'
    + '</button>';
}

/**
 * @param {Element} listEl
 * @param {() => void} render
 */
export function bindFavoriteModelList(listEl, render) {
  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.model-favorite-toggle');
    if (!(button instanceof HTMLElement)) return;
    const harness = String(button.dataset.favoriteHarness || '').trim();
    const model = String(button.dataset.favoriteModel || '').trim();
    if (!harness || !model) return;
    event.preventDefault();
    event.stopPropagation();
    toggleFavoriteModel(harness, model);
    render();
  });
}
