import assert from 'node:assert/strict';
import {
  buildContextSeedPayload,
  CONTEXT_SEED_BEGIN,
  CONTEXT_SEED_END,
  parseContextSeedPayload,
} from '../app_front/lib/context-seed-payload.js';

const inputSummary = 'Naprawiono meter kontekstu i alert >100%.';
const inputUserText = 'masz jakis kontekst w tym czacie?';

const builtPayload = buildContextSeedPayload(inputSummary, inputUserText);

assert.ok(builtPayload.startsWith(`${CONTEXT_SEED_BEGIN}\n`));
assert.ok(builtPayload.includes(`${CONTEXT_SEED_END}\n`));
assert.ok(builtPayload.includes(inputSummary));
assert.ok(builtPayload.endsWith(inputUserText));

const parsedBuilt = parseContextSeedPayload(builtPayload);
assert.equal(parsedBuilt.hasSeed, true);
assert.equal(parsedBuilt.summary, inputSummary);
assert.equal(parsedBuilt.userText, inputUserText);

const parsedPlain = parseContextSeedPayload(inputUserText);
assert.equal(parsedPlain.hasSeed, false);
assert.equal(parsedPlain.userText, inputUserText);

const parsedEmptySeed = parseContextSeedPayload(buildContextSeedPayload('', inputUserText));
assert.equal(parsedEmptySeed.hasSeed, false);
assert.equal(parsedEmptySeed.userText, inputUserText);

console.log('context-seed-payload.test.js: ok');
