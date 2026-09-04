import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidGeminiApiKeyFormat } from '../lib/voice/gemini-api-key.js';

const LEGACY_STANDARD_KEY = `AIza${'S'.repeat(35)}`;
const AUTH_KEY = `AQ.Ab${'C'.repeat(40)}`;

test('accepts legacy AIza standard keys and new AQ auth keys', () => {
  assert.equal(isValidGeminiApiKeyFormat(LEGACY_STANDARD_KEY), true);
  assert.equal(isValidGeminiApiKeyFormat(`  ${AUTH_KEY}  `), true);
  assert.equal(isValidGeminiApiKeyFormat(AUTH_KEY), true);
});

test('rejects short prefixes, other vendors, and empty values', () => {
  assert.equal(isValidGeminiApiKeyFormat('AIza'), false);
  assert.equal(isValidGeminiApiKeyFormat('AQ.'), false);
  assert.equal(isValidGeminiApiKeyFormat(`sk-${'x'.repeat(40)}`), false);
  assert.equal(isValidGeminiApiKeyFormat(`ik_live_${'x'.repeat(40)}`), false);
  assert.equal(isValidGeminiApiKeyFormat(''), false);
  assert.equal(isValidGeminiApiKeyFormat(undefined), false);
});
