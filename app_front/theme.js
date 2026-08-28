/**
 * Theme: dark / light / system.
 * The preference is persisted in localStorage; the resolved theme lands on <html>.
 */
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';

const THEME_KEY = 'cretli-theme';
const THEME_DARK = 'dark';
const THEME_LIGHT = 'light';
const THEME_SYSTEM = 'system';
const THEME_CHANGE_EVENT = 'cr-theme-change';
const DARK_THEME_COLOR = '#1e1e1e';
const LIGHT_THEME_COLOR = '#f3f3f3';

let fallbackPreference = null;
let systemMediaQuery = null;
let systemChangeListener = null;

function normalizeTheme(value) {
  if (value === THEME_LIGHT || value === THEME_SYSTEM) return value;
  return THEME_DARK;
}

export function getTheme() {
  if (fallbackPreference) return fallbackPreference;
  if (typeof localStorage === 'undefined') return THEME_DARK;
  try {
    return normalizeTheme(readStorageValueWithAlias(localStorage, THEME_KEY, ''));
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
  return theme === THEME_LIGHT || (theme === THEME_SYSTEM && prefersLight())
    ? THEME_LIGHT
    : THEME_DARK;
}

export function applyTheme(theme = getTheme()) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;

  const preference = normalizeTheme(theme);
  const resolvedTheme = getResolvedTheme(preference);
  const useLight = resolvedTheme === THEME_LIGHT;

  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
  document.body?.classList.toggle('theme-light', useLight);

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute('content', useLight ? LIGHT_THEME_COLOR : DARK_THEME_COLOR);

  if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
    window.dispatchEvent(
      new window.CustomEvent(THEME_CHANGE_EVENT, {
        detail: { preference, theme: resolvedTheme },
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
}

/**
 * Initializes the theme select in Settings.
 */
export function initThemeSelect() {
  const select = document.getElementById('theme-select');
  if (!select) return;
  select.value = getTheme();
  select.addEventListener('change', () => setTheme(select.value));
}
