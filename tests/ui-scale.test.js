import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  UI_SCALE_DEFAULT_PERCENT,
  UI_SCALE_PERCENTS,
  normalizeUiScalePercent,
} from '../app_front/core/theme/uiScale.js';

const ROOT = new URL('../', import.meta.url);

test('normalizeUiScalePercent accepts presets and falls back to the default', () => {
  assert.equal(normalizeUiScalePercent('85'), 85);
  assert.equal(normalizeUiScalePercent(100), 100);
  for (const invalid of [null, undefined, '', 'abc', '87', '0', '1000']) {
    assert.equal(normalizeUiScalePercent(invalid), UI_SCALE_DEFAULT_PERCENT);
  }
});

test('root scale is limited to wide fine-pointer screens and uses the same default', async () => {
  const scss = await readFile(new URL('app_front/css/base/_global.scss', ROOT), 'utf8');
  const rule = scss.match(/@media ([^{]+)\{\s*html:not\(:has\(> body\.embed-mode\)\) \{\s*font-size: ([^;]+);/);
  assert.ok(rule, 'scoped root font-size rule is present');
  assert.equal(rule[1].trim(), '(min-width: 769px) and (hover: hover) and (pointer: fine)');
  assert.equal(rule[2], `calc(100% * var(--cr-ui-scale, ${UI_SCALE_DEFAULT_PERCENT / 100}))`);
});

test('the inline bootstrap keeps the preset list of the runtime module', async () => {
  const html = await readFile(new URL('public/index.html', ROOT), 'utf8');
  const presets = html.match(/\[([\d, ]+)\]\.indexOf\(percent\)/);
  assert.ok(presets, 'inline ui scale bootstrap is present');
  assert.deepEqual(presets[1].split(',').map(Number), [...UI_SCALE_PERCENTS]);
  assert.ok(html.indexOf('--cr-ui-scale') < html.search(/<link rel="stylesheet"/));
});
