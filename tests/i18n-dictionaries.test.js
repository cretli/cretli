import assert from 'node:assert/strict';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

/**
 * Flattens a nested dictionary into dotted keys so both languages can be
 * compared key by key.
 *
 * @param {Record<string, unknown>} dict
 * @param {string} [prefix]
 * @returns {Map<string, string>}
 */
function flatten(dict, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [nested, nestedValue] of flatten(value, path)) out.set(nested, nestedValue);
      continue;
    }
    assert.equal(typeof value, 'string', `${path} must be a string`);
    out.set(path, value);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function readPlaceholders(text) {
  return (text.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort();
}

const actualEn = flatten(en);
const actualPl = flatten(pl);

const missingInPl = [...actualEn.keys()].filter((key) => !actualPl.has(key));
assert.deepEqual(missingInPl, [], `Keys present in en.js but missing in pl.js: ${missingInPl.join(', ')}`);

const missingInEn = [...actualPl.keys()].filter((key) => !actualEn.has(key));
assert.deepEqual(missingInEn, [], `Keys present in pl.js but missing in en.js: ${missingInEn.join(', ')}`);

const emptyValues = [...actualEn.entries()]
  .filter(([, value]) => value.trim().length === 0)
  .map(([key]) => key)
  .concat([...actualPl.entries()].filter(([, value]) => value.trim().length === 0).map(([key]) => `pl:${key}`));
assert.deepEqual(emptyValues, [], `Empty translations: ${emptyValues.join(', ')}`);

// A placeholder missing on one side silently renders "{count}" to the user.
const placeholderMismatches = [];
for (const [key, enValue] of actualEn) {
  const plValue = actualPl.get(key);
  const expected = readPlaceholders(enValue);
  const actual = readPlaceholders(plValue);
  if (expected.join(',') !== actual.join(',')) {
    placeholderMismatches.push(`${key}: en[${expected.join(' ')}] vs pl[${actual.join(' ')}]`);
  }
}
assert.deepEqual(placeholderMismatches, [], `Placeholder mismatches: ${placeholderMismatches.join('; ')}`);

// Polish text left in the English dictionary means a migration was incomplete.
const polishInEnglish = [...actualEn.entries()]
  .filter(([, value]) => /[ąęćńóśźżł]/i.test(value))
  .map(([key, value]) => `${key}: "${value}"`);
assert.deepEqual(polishInEnglish, [], `Polish characters in en.js: ${polishInEnglish.join('; ')}`);

console.log(`i18n-dictionaries.test.js: ok (${actualEn.size} keys)`);
