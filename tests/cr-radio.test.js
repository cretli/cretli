import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const radio = readFileSync(new URL('../app_front/components/ui/cr-radio.js', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../app_front/components/ui/index.js', import.meta.url), 'utf8');

test('cr-radio is registered once and exported through the UI barrel', () => {
  assert.match(radio, /customElements\.define\('cr-radio'/);
  assert.match(barrel, /import '\.\/cr-radio\.js'/);
});

test('cr-radio mirrors the cr-checkbox events and shares the choice styles', () => {
  assert.match(radio, /new CustomEvent\('cr-change'/);
  assert.match(radio, /choiceControlStyles/);
});
