/**
 * Theme IDs are independent of their dark/light appearance.
 * The preference is persisted in localStorage; the resolved theme lands on <html>.
 */
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { themes, themeCss } from './themes/index.js';
import { createThemeGalleryState } from '../../features/settings/themeGalleryState.js';

const THEME_KEY = 'cretli-theme';
const THEME_DARK = 'cretli-dark';
const THEME_SYSTEM = 'system';
const THEME_CHANGE_EVENT = 'cr-theme-change';

let fallbackPreference = null;
let systemMediaQuery = null;
let systemChangeListener = null;
let storageListener = false;

export function normalizeTheme(value, appearance = 'dark') {
  if (value === 'dark' || value === 'light') return `cretli-${value}`;
  if (value === THEME_SYSTEM || themes.has(value)) return value;
  return `cretli-${appearance}`;
}

export function getSystemTheme(appearance) {
  try {
    const id = normalizeTheme(localStorage.getItem(`cretli-theme-${appearance}`), appearance);
    // A single-appearance theme cannot fill both system slots; keep the OS base in the other slot.
    if (themes.get(id)?.appearance === appearance) return id;
  } catch {}
  return `cretli-${appearance}`;
}

export function getResolvedThemeId(value = getTheme()) {
  const preference = normalizeTheme(value);
  return preference === THEME_SYSTEM ? getSystemTheme(prefersLight() ? 'light' : 'dark') : preference;
}

export function getTheme() {
  if (fallbackPreference) return fallbackPreference;
  if (typeof localStorage === 'undefined') return THEME_DARK;
  try {
    const saved = readStorageValueWithAlias(localStorage, THEME_KEY, '');
    const preference = normalizeTheme(saved);
    if (saved && saved !== preference) {
      try { writeStorageValueWithAlias(localStorage, THEME_KEY, preference); } catch {}
    }
    return preference;
  } catch {
    return THEME_DARK;
  }
}

export function setTheme(value) {
  const preference = normalizeTheme(value);
  fallbackPreference = preference;

  if (typeof localStorage !== 'undefined') {
    try {
      writeStorageValueWithAlias(localStorage, THEME_KEY, preference);
      fallbackPreference = null;
    } catch {
      // Persisting failed, but the theme must still change for the current session.
    }
  }

  applyTheme(preference);
}

function getSystemMediaQuery() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  try {
    return window.matchMedia('(prefers-color-scheme: light)');
  } catch {
    return null;
  }
}

function prefersLight() {
  return getSystemMediaQuery()?.matches === true;
}

/**
 * Resolves a preference to an effective theme: 'system' follows the OS setting.
 */
export function getResolvedTheme(theme = getTheme()) {
  return themes.get(getResolvedThemeId(theme)).appearance;
}

export function applyTheme(theme = getTheme()) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;

  const preference = normalizeTheme(theme);
  const resolvedTheme = getResolvedTheme(preference);
  const useLight = resolvedTheme === 'light';
  const themeId = getResolvedThemeId(preference);
  const definition = themes.get(themeId);
  root.dataset.themeId = themeId;
  let style = document.getElementById('cr-theme-vars');
  if (!style) {
    style = document.createElement('style');
    style.id = 'cr-theme-vars';
    document.head.appendChild(style);
  }
  style.textContent = themeCss(definition);
  try {
    const cache = {};
    for (const appearance of ['dark', 'light']) {
      const id = definition.appearance === appearance ? themeId : getSystemTheme(appearance);
      const entry = themes.get(id);
      cache[appearance] = { themeId: id, css: themeCss(entry), themeColor: entry.themeColor };
    }
    localStorage.setItem('cretli-theme-cache', JSON.stringify(cache));
  } catch {}

  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
  document.body?.classList.toggle('theme-light', useLight);

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute('content', definition.themeColor);

  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(
      new window.CustomEvent(THEME_CHANGE_EVENT, {
        detail: { preference, theme: resolvedTheme, themeId },
      }),
    );
  }
}

function listenForSystemThemeChanges() {
  if (systemMediaQuery || systemChangeListener) return;

  const mediaQuery = getSystemMediaQuery();
  if (!mediaQuery) return;

  const listener = () => {
    if (getTheme() !== THEME_SYSTEM) return;
    applyTheme(THEME_SYSTEM);
  };

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', listener);
  } else if (typeof mediaQuery.addListener === 'function') {
    mediaQuery.addListener(listener);
  } else {
    return;
  }

  systemMediaQuery = mediaQuery;
  systemChangeListener = listener;
}

/**
 * Initializes the theme: applies the stored one and, for 'system', watches the OS preference.
 */
export function initTheme() {
  applyTheme();
  listenForSystemThemeChanges();
  if (!storageListener && window.addEventListener) {
    window.addEventListener('storage', (event) => {
      if (event.key === null || ['cretli-theme', 'cursor-remote-theme', 'cretli-theme-dark', 'cretli-theme-light'].includes(event.key)) {
        fallbackPreference = null;
        applyTheme();
      }
    });
    storageListener = true;
  }
}

/** Initializes the Settings gallery on the shared theme runtime. */
export async function initThemeSelect() {
  const gallery = /** @type {HTMLElement & { controller?: unknown, systemTheme?: unknown } | null} */ (
    document.getElementById('theme-gallery')
  );
  if (!gallery) return;
  await import('../../features/settings/themeGallery.js');
  gallery.controller = createThemeGalleryState({ getTheme, setTheme, getSystemTheme, storage: localStorage });
  gallery.systemTheme = getSystemTheme;
}
