import assert from 'node:assert/strict';
import {
  buildSummaryPrompt,
  tryExtractSummaryAndTitleFromBuffer,
} from '../lib/fork-title.js';

const prompt = buildSummaryPrompt('User asked to refactor module X.');
assert.ok(prompt.includes('User asked to refactor module X.'));
assert.ok(prompt.includes('"summary"'));

const parsed = tryExtractSummaryAndTitleFromBuffer(
  'Here is the result:\n{"summary":"User wants module X refactored.","title":"Refactor module X"}\n'
);
assert.equal(parsed?.summary, 'User wants module X refactored.');
assert.equal(parsed?.title, 'Refactor module X');

const fromCodeBlock = tryExtractSummaryAndTitleFromBuffer(
  '```json\n{"summary":"Done.","title":"Done task"}\n```'
);
assert.equal(fromCodeBlock?.summary, 'Done.');

// Must match EXAMPLE_SUMMARY / EXAMPLE_TITLE in lib/fork-title.js verbatim.
const exampleOnly = tryExtractSummaryAndTitleFromBuffer(
  '{"summary":"The user asks for a refactor of module X. The agent proposes a step-by-step approach.","title":"Refactor module X"}'
);
assert.equal(exampleOnly, null, 'Prompt example JSON should be ignored');

console.log('fork-title-summary.test.js: ok');
