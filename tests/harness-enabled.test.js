import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_TRANSPORTS } from '../lib/agent-transport.js';
import {
  DEFAULT_HARNESS_ORDER,
  isHarnessEnabled,
  listEnabledHarnesses,
  normalizeEnabledHarnesses,
  normalizeHarnessOrder,
} from '../lib/harness-enabled.js';

test('missing or full list means every harness is enabled', () => {
  assert.equal(normalizeEnabledHarnesses(undefined), null);
  assert.equal(normalizeEnabledHarnesses(AGENT_TRANSPORTS.slice()), null);
  assert.deepEqual(listEnabledHarnesses(undefined), DEFAULT_HARNESS_ORDER.slice());
  assert.equal(isHarnessEnabled('opencode', undefined), true);
});

test('a subset hides the other harnesses', () => {
  const actual = normalizeEnabledHarnesses(['sdk', 'opencode', 'sdk']);
  assert.deepEqual(actual, ['sdk', 'opencode']);
  assert.equal(isHarnessEnabled('sdk', actual), true);
  assert.equal(isHarnessEnabled('codex', actual), false);
  assert.deepEqual(listEnabledHarnesses(actual), ['opencode', 'sdk']);
});

test('normalizeHarnessOrder keeps a custom prefix and fills the rest', () => {
  const actual = normalizeHarnessOrder(['codex', 'sdk', 'codex', 'nope']);
  assert.equal(actual[0], 'codex');
  assert.equal(actual[1], 'sdk');
  assert.deepEqual(new Set(actual), new Set(DEFAULT_HARNESS_ORDER));
});

test('listEnabledHarnesses follows a custom order', () => {
  const inputEnabled = ['sdk', 'qwen', 'opencode'];
  const inputOrder = ['qwen', 'sdk', 'opencode'];
  const actual = listEnabledHarnesses(inputEnabled, inputOrder);
  assert.deepEqual(actual, ['qwen', 'sdk', 'opencode']);
});

test('empty or invalid input stays all-enabled so a save cannot lock the user out', () => {
  assert.equal(normalizeEnabledHarnesses([]), null);
  assert.equal(normalizeEnabledHarnesses('opencode'), null);
});
