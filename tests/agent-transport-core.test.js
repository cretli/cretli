import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_TRANSPORTS,
  CORE_AGENT_TRANSPORTS,
  isCoreAgentTransport,
  parseKnownAgentTransport,
} from '../lib/agent-transport.js';
import { listHarnesses } from '../lib/agent-harness/registry.ts';

test('core transports are Claude, Cursor (sdk) and Codex, all built-in', () => {
  assert.deepEqual([...CORE_AGENT_TRANSPORTS], ['claude', 'sdk', 'codex']);
  for (const transport of CORE_AGENT_TRANSPORTS) {
    assert.ok(AGENT_TRANSPORTS.includes(transport), transport);
  }
  assert.ok(Object.isFrozen(CORE_AGENT_TRANSPORTS));
  assert.ok(Object.isFrozen(AGENT_TRANSPORTS));
});

test('isCoreAgentTransport matches exactly and never falls back to sdk', () => {
  for (const transport of CORE_AGENT_TRANSPORTS) assert.equal(isCoreAgentTransport(transport), true);
  for (const value of ['qwen', 'opencode', 'openrouter', 'cursor', 'SDK', ' sdk', '', null, undefined, 1]) {
    assert.equal(isCoreAgentTransport(value), false, String(value));
  }
});

test('parseKnownAgentTransport still trims and lowercases', () => {
  assert.equal(parseKnownAgentTransport(' Codex '), 'codex');
  assert.equal(parseKnownAgentTransport('cursor'), '');
});

test('the harness registry lists every transport exactly once', () => {
  const listed = listHarnesses().map((entry) => entry.transport);
  assert.deepEqual([...listed].sort(), [...AGENT_TRANSPORTS].sort());
});
