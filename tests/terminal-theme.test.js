import assert from 'node:assert/strict';
import test from 'node:test';

import { registerTheme, themeCss, themes } from '../app_front/core/theme/themes/index.js';
import { getTerminalTheme, listenForTerminalThemeChanges } from '../app_front/features/terminal/services/terminalTheme.js';

const CUSTOM = { foreground: '#112233', background: '#001122', red: '#ff0000' };

test('theme with its own palette returns it over the appearance base', () => {
  registerTheme({ id: 'tt-custom', label: 'Custom', appearance: 'dark', tokens: {}, terminal: { ...CUSTOM, bogus: '#fff', green: 'url(x)' } });
  const palette = getTerminalTheme('tt-custom');
  assert.equal(palette.foreground, CUSTOM.foreground);
  assert.equal(palette.background, CUSTOM.background);
  assert.equal(palette.red, CUSTOM.red);
  assert.equal(palette.green, getTerminalTheme('cretli-dark').green);
  assert.equal('bogus' in palette, false);
});

test('theme without a palette falls back by appearance', () => {
  registerTheme({ id: 'tt-plain-light', label: 'Plain light', appearance: 'light', tokens: {} });
  assert.deepEqual(getTerminalTheme('tt-plain-light'), getTerminalTheme('light'));
  assert.deepEqual(getTerminalTheme('cretli-light'), getTerminalTheme('light'));
  assert.deepEqual(getTerminalTheme('cretli-dark'), getTerminalTheme('dark'));
  assert.equal(getTerminalTheme('dark').background, '#1e1e1e');
  assert.equal(getTerminalTheme('light').background, '#f3f3f3');
  assert.equal(getTerminalTheme('unknown-id').background, '#1e1e1e');
});

test('cr-theme-change updates registered terminals', () => {
  let handler;
  globalThis.window = { addEventListener: (name, fn) => { if (name === 'cr-theme-change') handler = fn; } };
  try {
    const terms = [{ options: {} }, { options: {} }];
    listenForTerminalThemeChanges(() => terms);
    handler({ detail: { theme: 'dark', themeId: 'tt-custom' } });
    for (const term of terms) assert.equal(term.options.theme.background, CUSTOM.background);
    handler({ detail: { theme: 'light', themeId: 'cretli-light' } });
    for (const term of terms) assert.equal(term.options.theme.background, '#f3f3f3');
  } finally {
    delete globalThis.window;
  }
});

test('theme syntax palette maps to --cr-code-* tokens', () => {
  const css = themeCss({ tokens: {}, syntax: { keyword: '#abcdef', bogus: '#fff' } });
  assert.equal(css, ':root:root:root{--cr-code-keyword:#abcdef}');
  assert.equal(themeCss(themes.get('cretli-dark')), '');
});
