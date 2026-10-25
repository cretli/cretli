import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { HARNESS_I18N_PACKS_EN } from '../app_front/i18n/harness/packs.en.js';
import { HARNESS_I18N_PACKS_PL } from '../app_front/i18n/harness/packs.pl.js';
import { mergeDictionaries } from '../app_front/i18n/mergeDictionaries.js';

/**
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function readSnapshot(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/**
 * @param {Record<string, unknown>} dict
 * @param {string} [prefix]
 * @returns {Map<string, unknown>}
 */
function flatten(dict, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [nested, nestedValue] of flatten(/** @type {Record<string, unknown>} */ (value), path)) out.set(nested, nestedValue);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

// The merged dictionaries are exactly the pre-pack snapshot: no key lost, renamed or reworded.
// Regenerate the fixtures only for an intentional string change (they hold the merged output).
for (const [lang, dictionary] of [['en', en], ['pl', pl]]) {
  const expected = flatten(readSnapshot(`i18n-snapshot-${lang}.json`));
  const actual = flatten(dictionary);
  const lost = [...expected.keys()].filter((key) => !actual.has(key));
  const added = [...actual.keys()].filter((key) => !expected.has(key));
  const changed = [...expected.keys()].filter((key) => actual.has(key) && actual.get(key) !== expected.get(key));
  assert.deepEqual(lost, [], `${lang}: keys missing from the merged dictionary`);
  assert.deepEqual(added, [], `${lang}: keys not in the snapshot`);
  assert.deepEqual(changed, [], `${lang}: values changed`);
  assert.deepEqual(dictionary, readSnapshot(`i18n-snapshot-${lang}.json`), `${lang}: dictionary differs from the snapshot`);
}

// Each language has the same packs and every pack owns at least one key.
assert.equal(HARNESS_I18N_PACKS_EN.length, HARNESS_I18N_PACKS_PL.length);
for (const [index, pack] of HARNESS_I18N_PACKS_EN.entries()) {
  const enKeys = [...flatten(pack).keys()].sort();
  assert.ok(enKeys.length > 0, 'empty pack');
  assert.deepEqual([...flatten(HARNESS_I18N_PACKS_PL[index]).keys()].sort(), enKeys, 'en and pl packs share keys');
}

// Merge rules: packs extend sections, never replace strings.
assert.deepEqual(
  mergeDictionaries({ a: { x: '1' } }, { a: { y: '2' } }, { b: '3' }),
  { a: { x: '1', y: '2' }, b: '3' },
);
assert.throws(() => mergeDictionaries({ a: { x: '1' } }, { a: { x: '2' } }), /duplicate key a\.x/);
assert.throws(() => mergeDictionaries({ a: '1' }, { a: { x: '2' } }), /collides with a string/);
const base = { a: { x: '1' } };
mergeDictionaries(base, { a: { y: '2' } });
assert.deepEqual(base, { a: { x: '1' } }, 'inputs are not modified');

console.log('i18n-harness-packs.test.js: ok');
