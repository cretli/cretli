/** Persisted Files panel preferences (localStorage, with legacy key aliases). */
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';

const LS_PREVIEW_H = 'cretli-files-preview-height';
const LS_SHOW_HIDDEN_FILES = 'cretli-files-show-hidden';
const LS_PREVIEW_FONT_SCALE = 'cretli-files-preview-font-scale';

export const PREVIEW_H_MIN = 88;
export const PREVIEW_H_DEFAULT = 220;
export const PREVIEW_FONT_SCALE_MIN = 0.6;
export const PREVIEW_FONT_SCALE_MAX = 3;
export const PREVIEW_FONT_SCALE_DEFAULT = 1;

export function getSavedPreviewHeight() {
  try {
    const n = parseInt(readStorageValueWithAlias(localStorage, LS_PREVIEW_H, ''), 10);
    if (Number.isFinite(n) && n >= PREVIEW_H_MIN) return n;
  } catch (_) {}
  return PREVIEW_H_DEFAULT;
}

export function savePreviewHeight(px) {
  try {
    writeStorageValueWithAlias(localStorage, LS_PREVIEW_H, String(px));
  } catch (_) {}
}

export function getSavedPreviewFontScale() {
  try {
    const n = parseFloat(readStorageValueWithAlias(localStorage, LS_PREVIEW_FONT_SCALE, ''));
    if (Number.isFinite(n) && n >= PREVIEW_FONT_SCALE_MIN && n <= PREVIEW_FONT_SCALE_MAX) return n;
  } catch (_) {}
  return PREVIEW_FONT_SCALE_DEFAULT;
}

export function savePreviewFontScale(scale) {
  try {
    writeStorageValueWithAlias(localStorage, LS_PREVIEW_FONT_SCALE, String(scale));
  } catch (_) {}
}

export function clampPreviewFontScale(v) {
  if (!Number.isFinite(v)) return PREVIEW_FONT_SCALE_DEFAULT;
  return Math.min(PREVIEW_FONT_SCALE_MAX, Math.max(PREVIEW_FONT_SCALE_MIN, v));
}

export function getShowHiddenFilesEnabled() {
  try {
    return readStorageValueWithAlias(localStorage, LS_SHOW_HIDDEN_FILES, '') === '1';
  } catch (_) {
    return false;
  }
}

export function setShowHiddenFilesEnabled(enabled) {
  try {
    writeStorageValueWithAlias(localStorage, LS_SHOW_HIDDEN_FILES, enabled ? '1' : '0');
  } catch (_) {}
}
