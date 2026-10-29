import test from 'node:test';
import assert from 'node:assert/strict';
import { createThemeGalleryState, themeRadioTarget } from '../app_front/features/settings/themeGalleryState.js';

function setup() {
  const values = new Map();
  const selected = [];
  let preference = 'dracula';
  const state = createThemeGalleryState({
    getTheme: () => preference,
    setTheme: (id) => { selected.push(id); preference = id; values.set('cretli-theme', id); },
    getSystemTheme: (appearance) => values.get(`cretli-theme-${appearance}`) || `cretli-${appearance}`,
    storage: { setItem: (key, value) => values.set(key, value) },
  });
  return { state, values, selected };
}

test('a gallery selection calls the shared setTheme with the exact definition id', () => {
  const { state, selected } = setup();
  state.select('nord');
  assert.deepEqual(selected, ['nord']);
  assert.equal(state.preference(), 'nord');
});

test('system mode persists both appearance slots before activating system', () => {
  const { state, values } = setup();
  state.mode('system');
  assert.equal(values.get('cretli-theme'), 'system');
  assert.equal(values.get('cretli-theme-dark'), 'cretli-dark');
  assert.equal(values.get('cretli-theme-light'), 'cretli-light');
  state.system('dark', 'dracula');
  state.system('light', 'github-light');
  state.mode('fixed');
  assert.equal(state.preference(), 'dracula');
  state.mode('system');
  assert.equal(values.get('cretli-theme-dark'), 'dracula');
  assert.equal(values.get('cretli-theme-light'), 'github-light');
  assert.equal(state.preference(), 'system');
});

test('radio keyboard navigation selects adjacent tiles, wraps and supports Home/End and activation', () => {
  const ids = ['cretli-dark', 'dracula', 'cretli-light'];
  const { state } = setup();
  let index = 0;
  for (const [key, expected] of [['ArrowRight', 1], ['ArrowDown', 2], ['ArrowRight', 0], ['ArrowLeft', 2], ['ArrowUp', 1], ['Home', 0], ['End', 2], ['Enter', 2], [' ', 2]]) {
    index = themeRadioTarget(key, index, ids.length);
    state.select(ids[index]);
    assert.equal(index, expected);
    assert.equal(state.preference(), ids[expected]);
  }
  assert.equal(themeRadioTarget('Tab', index, ids.length), null);
});
