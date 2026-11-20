import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VALID_TRANSPORTS,
  parseKnownAgentTransport,
  normalizeAgentTransport,
  registerTestAgentTransport,
  resolveAgentTransportProfile,
} from '../lib/agent-transport.js';
import { listHarnesses, isKnownHarness } from '../lib/agent-harness/registry.ts';
import {
  DEFAULT_HARNESS_ORDER,
  normalizeEnabledHarnesses,
  normalizeHarnessOrder,
} from '../lib/harness-enabled.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

// Without the fixture the fake transport is unknown everywhere.
assert.equal(parseKnownAgentTransport('testfake'), '');
assert.equal(normalizeAgentTransport('testfake'), 'sdk');
assert.equal(isKnownHarness('testfake'), false);
assert.equal(resolveAgentTransportProfile('opencode'), 'opencode');
// Settings normalizers must not let an unregistered test id into persisted settings.
assert.deepEqual(normalizeEnabledHarnesses(['testfake', 'claude']), ['claude']);
assert.equal(normalizeEnabledHarnesses(['testfake']), null);
assert.deepEqual(normalizeHarnessOrder(['testfake', 'claude']), ['claude', ...DEFAULT_HARNESS_ORDER.filter((id) => id !== 'claude')]);

// Production code never loads the fixture or calls the registration hook.
const registrars = walk(path.join(root, 'lib'))
  .concat(path.join(root, 'server.js'))
  .filter((file) => /registerTestAgentTransport|fake-transport/.test(readFileSync(file, 'utf8')))
  .map((file) => path.relative(root, file));
assert.deepEqual(registrars, ['lib/agent-transport.js']);

// Registering the fixture makes the id resolvable but never user-visible.
const { FAKE_TRANSPORT, FAKE_TRANSPORT_B } = await import('./fixtures/fake-transport.js');
assert.equal(parseKnownAgentTransport(FAKE_TRANSPORT), FAKE_TRANSPORT);
assert.equal(normalizeAgentTransport(FAKE_TRANSPORT_B), FAKE_TRANSPORT_B);
assert.equal(isKnownHarness(FAKE_TRANSPORT), true);
assert.equal(VALID_TRANSPORTS.includes(FAKE_TRANSPORT), false);
assert.equal(listHarnesses().some((meta) => meta.transport === FAKE_TRANSPORT), false);
assert.equal(normalizeHarnessOrder([FAKE_TRANSPORT]).length, DEFAULT_HARNESS_ORDER.length + 1, 'registered test id is accepted by the order normalizer only in-process');

// A built-in id cannot be shadowed, and production refuses the hook.
assert.throws(() => registerTestAgentTransport('opencode'), /invalid test transport id/);
const prev = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
try {
  assert.throws(() => registerTestAgentTransport('late-fake'), /test-only/);
} finally {
  if (prev === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prev;
}
console.log('fake-transport-isolation.test.js OK');
