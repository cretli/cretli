/**
 * Unit tests for the explicit local-harness enable list normalizer.
 *
 * These tests are pure: no filesystem, no plugin discovery, no HTTP. Discovery
 * membership is exercised through the injectable `discoveredLocalIds` input.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_TRANSPORTS } from '../lib/agent-transport.js';
import { HARNESS_RESERVED_IDS } from '../lib/agent-harness/harness-plugin-contract.js';
import {
  ENABLED_LOCAL_HARNESSES_FIELD,
  isValidLocalHarnessId,
  normalizeEnabledLocalHarnesses,
  validateEnabledLocalHarnessesUpdate,
} from '../lib/agent-harness/enabled-local-harnesses.js';

test('the settings field name is the separate local list', () => {
  assert.equal(ENABLED_LOCAL_HARNESSES_FIELD, 'enabledLocalHarnesses');
});

test('isValidLocalHarnessId accepts plugin ids and rejects builtins/reserved', () => {
  for (const id of ['alpha', 'my-harness', 'a1', 'x-y-z', '  Alpha  ', 'MY-HARNESS']) {
    assert.equal(isValidLocalHarnessId(id), true, `expected valid: ${JSON.stringify(id)}`);
  }
  for (const id of ['', '   ', 'sdk', 'SDK', 'cursor', 'Cursor', ...AGENT_TRANSPORTS]) {
    assert.equal(isValidLocalHarnessId(id), false, `expected reserved/invalid: ${JSON.stringify(id)}`);
  }
  for (const id of ['has space', 'UPPER_CASE', '-leading', 'trailing-', '1starts-with-digit', 'dot.name', null, 42, {}]) {
    assert.equal(isValidLocalHarnessId(id), false, `expected malformed: ${JSON.stringify(id)}`);
  }
  assert.deepEqual([...HARNESS_RESERVED_IDS].sort(), ['codebuddy', 'codex', 'cursor', 'deepseek', 'claude', 'mistral', 'openrouter', 'opencode', 'qwen', 'sdk'].sort());
});

test('normalize trims, lowercases, dedupes and preserves first-seen order', () => {
  assert.deepEqual(
    normalizeEnabledLocalHarnesses(['  Beta ', 'alpha', 'BETA', 'alpha', 'gamma']),
    ['beta', 'alpha', 'gamma'],
  );
});

test('normalize drops malformed, reserved and non-string entries instead of failing', () => {
  const raw = ['alpha', 'sdk', 'cursor', 'bad id', 42, null, '', '   ', 'opencode', 'beta'];
  assert.deepEqual(normalizeEnabledLocalHarnesses(raw), ['alpha', 'beta']);
});

test('normalize treats a non-array saved value as empty', () => {
  for (const raw of [undefined, null, 'alpha', 42, {}, { alpha: true }]) {
    assert.deepEqual(normalizeEnabledLocalHarnesses(raw), [], JSON.stringify(raw));
  }
});

test('validate requires an array and accepts an empty clear', () => {
  const notArray = validateEnabledLocalHarnessesUpdate('alpha', { discoveredLocalIds: ['alpha'] });
  assert.equal(notArray.ok, false);
  assert.equal(notArray.code, 'not_array');

  const cleared = validateEnabledLocalHarnessesUpdate([], { discoveredLocalIds: [] });
  assert.deepEqual(cleared, { ok: true, ids: [] });
});

test('validate normalizes and de-duplicates discovered ids', () => {
  const result = validateEnabledLocalHarnessesUpdate(
    ['  Alpha ', 'beta', 'ALPHA', 'beta'],
    { discoveredLocalIds: ['alpha', 'beta', 'gamma'] },
  );
  assert.deepEqual(result, { ok: true, ids: ['alpha', 'beta'] });
});

test('validate rejects reserved, malformed, blank and non-string entries', () => {
  const discoveredLocalIds = ['alpha', ...AGENT_TRANSPORTS, 'cursor'];
  const cases = [
    { raw: ['sdk'], code: 'reserved_id' },
    { raw: ['cursor'], code: 'reserved_id' },
    { raw: ['bad id'], code: 'invalid_id' },
    { raw: ['-leading'], code: 'invalid_id' },
    { raw: [''], code: 'invalid_id' },
    { raw: ['   '], code: 'invalid_id' },
    { raw: [null], code: 'invalid_id' },
    { raw: [42], code: 'invalid_id' },
  ];
  for (const { raw, code } of cases) {
    const result = validateEnabledLocalHarnessesUpdate(raw, { discoveredLocalIds });
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.code, code, JSON.stringify(raw));
  }
});

test('validate requires every non-empty id to be currently discovered', () => {
  const result = validateEnabledLocalHarnessesUpdate(['alpha', 'ghost'], {
    discoveredLocalIds: ['alpha'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_discovered');
});

test('validate rejects any non-empty id when discovery is empty or missing', () => {
  for (const options of [{}, { discoveredLocalIds: [] }, undefined]) {
    const result = validateEnabledLocalHarnessesUpdate(['alpha'], options);
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.equal(result.code, 'not_discovered');
  }
});

test('validate accepts a non-empty update only for discovered ids', () => {
  const result = validateEnabledLocalHarnessesUpdate(['alpha'], {
    discoveredLocalIds: new Set(['alpha', 'beta']),
  });
  assert.deepEqual(result, { ok: true, ids: ['alpha'] });
});

console.log('enabled-local-harnesses.test.js OK');
