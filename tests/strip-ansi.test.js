import assert from 'node:assert/strict';
import { stripAnsi } from '../app_front/features/chat/chatTitleParsing.js';

const esc = String.fromCharCode(27);
const inputRaw = `${esc}[2m${esc}[34mLocalCursorRulesService load completed${esc}[0m`;
const actualText = stripAnsi(inputRaw);
const expectedText = 'LocalCursorRulesService load completed';

assert.equal(actualText, expectedText);
assert.equal(stripAnsi('plain'), 'plain');
assert.equal(stripAnsi(''), '');

console.log('strip-ansi.test.js: ok');
