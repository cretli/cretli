import assert from 'node:assert/strict';
import {
  isQueuedPromptText,
  readClientDisplayText,
  resolvePromptUiText,
  resolveQueuedPromptUiText,
} from '../lib/prompt-ui-text.js';
import { buildSdkLocalUserRecord } from '../lib/sdk/sdk-prompt-accept.ts';

const inputFull = 'full agent prompt';
const inputDisplay = 'Short UI line.';
const expectedUi = 'Short UI line.';
const actualUi = resolvePromptUiText(inputFull, inputDisplay);
assert.equal(actualUi, expectedUi);
assert.equal(resolvePromptUiText('[Operator Cretli — Claude]\nactual prompt', 'actual prompt'), 'actual prompt');
assert.deepEqual(buildSdkLocalUserRecord({
  text: resolvePromptUiText('[Operator Cretli — Claude]\nactual prompt', 'actual prompt'),
  origin: { kind: 'operator', clientName: 'Claude' },
  createdAt: '2026-11-04T10:00:00.000Z',
}), {
  kind: 'localUser',
  text: 'actual prompt',
  origin: { kind: 'operator', clientName: 'Claude' },
  createdAt: '2026-11-04T10:00:00.000Z',
});
assert.equal(resolvePromptUiText(inputFull, '  '), inputFull);
assert.equal(resolvePromptUiText(inputFull, undefined), inputFull);
assert.equal(resolvePromptUiText('  keep  ', ''), 'keep');

assert.equal(readClientDisplayText({ displayText: '  shown  ' }), 'shown');
assert.equal(readClientDisplayText({ text: inputFull }), '');
assert.equal(readClientDisplayText(null), '');

const inputQueued = { text: inputFull, displayText: inputDisplay };
assert.equal(isQueuedPromptText(inputQueued, inputFull), true);
assert.equal(isQueuedPromptText(inputQueued, inputDisplay), true);
assert.equal(isQueuedPromptText(inputQueued, 'other'), false);
assert.equal(resolveQueuedPromptUiText(inputQueued), expectedUi);
assert.equal(resolveQueuedPromptUiText({ text: inputFull }), inputFull);
assert.equal(resolveQueuedPromptUiText(inputDisplay), inputDisplay);

console.log('All prompt UI text tests passed.');
