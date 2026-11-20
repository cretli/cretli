import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppScssSource } from './helpers/app-scss-source.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const html = read('public/index.html');
const partials = ['widgets', 'mcp'].map((name) => [name, read(`app_front/css/features/settings/_${name}.scss`)]);

test('Widgets and MCP panels opt into .cr-form', () => {
  assert.match(html, /<section class="settings-section cr-form" data-settings-tab="widgets"/);
  assert.match(html, /<section class="settings-section cr-form" data-settings-tab="mcp"/);
});

test('Widgets and MCP rules live in their own app.scss partials on tokens', () => {
  const appScss = readAppScssSource();
  assert.match(appScss, /@use '\.\/features\/settings\/widgets';/);
  assert.match(appScss, /@use '\.\/features\/settings\/mcp';/);
  for (const [name, src] of partials) {
    for (const m of src.matchAll(/font-size:\s*([^;]+);/g)) {
      assert.match(m[1].trim(), /var\(--cr-font-size-(xs|sm|md|lg|xl)\)/, `${name} font-size ${m[1]}`);
    }
    assert.doesNotMatch(src, /font-size:[^;]*px/, `${name} has no px font-size`);
    assert.doesNotMatch(src, /!important/, `${name} has no !important`);
    // Input look comes from .cr-form: no duplicated control styling here.
    assert.doesNotMatch(src, /--cr-input-bg|--cr-border-control|appearance:/, `${name} has no input styling`);
  }
  // The legacy widget rules are gone from the global partial.
  const global = read('app_front/css/base/_global.scss');
  assert.doesNotMatch(global, /\.widget-(installation|panel)-/);
});
