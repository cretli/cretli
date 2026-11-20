import { themes, isColor } from '../../../core/theme/themes/index.js';

const THEME_CHANGE_EVENT = 'cr-theme-change';

const DARK_TERMINAL_THEME = Object.freeze({
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#094771',
  selectionForeground: '#d4d4d4',
  selectionInactiveBackground: '#37373d',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
});

const LIGHT_TERMINAL_THEME = Object.freeze({
  foreground: '#333333',
  background: '#f3f3f3',
  cursor: '#333333',
  cursorAccent: '#f3f3f3',
  selectionBackground: '#cfe3f7',
  selectionForeground: '#333333',
  selectionInactiveBackground: '#dddddd',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#d0d7de',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#ffffff',
});

function getCurrentAppearance() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement?.dataset.theme === 'light' ? 'light' : 'dark';
}

function getCurrentThemeId() {
  if (typeof document === 'undefined') return undefined;
  return document.documentElement?.dataset.themeId;
}

/**
 * Returns the xterm palette for a theme.
 * @param {string} [theme] A registered theme id, or an appearance ('dark' | 'light'). Defaults to the active theme.
 */
export function getTerminalTheme(theme = getCurrentThemeId() || getCurrentAppearance()) {
  const definition = themes.get(theme);
  const appearance = definition ? definition.appearance : theme === 'light' ? 'light' : 'dark';
  const base = appearance === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
  const custom = {};
  for (const [key, value] of Object.entries(definition?.terminal || {})) {
    if (key in base && isColor(value)) custom[key] = value;
  }
  return { ...base, ...custom };
}

export function listenForTerminalThemeChanges(getTerminals) {
  if (typeof window === 'undefined' || typeof getTerminals !== 'function') return;

  window.addEventListener(THEME_CHANGE_EVENT, (/** @type {any} */ event) => {
    for (const term of getTerminals()) {
      if (!term?.options) continue;
      term.options.theme = getTerminalTheme(event.detail?.themeId || event.detail?.theme);
    }
  });
}
