import assert from 'node:assert/strict';
import {
  splitTrailingTitleJson,
  tryExtractStandaloneTitleJson,
} from '../app_front/features/chat/chatTitleParsing.js';

const inputBare = 'Done the restart cleanup.\n{"title": "Restart: i18n, production gate, clean API"}';
const actualBare = splitTrailingTitleJson(inputBare);
assert.equal(actualBare.title, 'Restart: i18n, production gate, clean API');
assert.equal(actualBare.text, 'Done the restart cleanup.');

const inputFenced = [
  'Restart still works locally.',
  '',
  '```json',
  '{"title": "Restart: i18n, production gate, clean API"}',
  '```',
].join('\n');
const actualFenced = splitTrailingTitleJson(inputFenced);
assert.equal(actualFenced.title, 'Restart: i18n, production gate, clean API');
assert.equal(actualFenced.text, 'Restart still works locally.');

const inputTitleOnly = '{"title": "Updated documentation in .cursor/rules"}';
const actualTitleOnly = splitTrailingTitleJson(inputTitleOnly);
assert.equal(actualTitleOnly.title, 'Updated documentation in .cursor/rules');
assert.equal(actualTitleOnly.text, '');

const inputNoTitle = 'Just a normal answer.\nNo JSON here.';
const actualNoTitle = splitTrailingTitleJson(inputNoTitle);
assert.equal(actualNoTitle.title, null);
assert.equal(actualNoTitle.text, inputNoTitle);

const inputMidTitle = '{"title": "Should stay visible"}\nThen more text.';
const actualMidTitle = splitTrailingTitleJson(inputMidTitle);
assert.equal(actualMidTitle.title, null);

assert.equal(
  tryExtractStandaloneTitleJson(inputFenced),
  'Restart: i18n, production gate, clean API'
);

console.log('chat-title-parsing.test.js: ok');
