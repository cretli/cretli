import assert from 'node:assert/strict';
import test from 'node:test';
import { findAffectedTests } from '../scripts/run-affected-tests.mjs';

test('a direct importer of a changed module is selected', () => {
  const { tests } = findAffectedTests({ changed: ['lib/agent-transport.js'] });
  assert.ok(tests.includes('tests/agent-transport-core.test.js'));
});

test('transitive importers are selected (the room-kernel init cycle of B2 step 1)', () => {
  // room-kernel.test.js reached lib/mcp/adapters/index.js only through
  // room-kernel -> … -> mcp-session; that path broke when the adapter index
  // imported the heavy provider module.
  const { tests } = findAffectedTests({ changed: ['lib/mcp/adapters/index.js'] });
  assert.ok(tests.includes('tests/room-kernel.test.js'));
  assert.ok(tests.includes('tests/mcp-harness-adapters.test.js'));
});

test('source-pinning tests that read a file by path are selected', () => {
  // push-broadcast.test.js reads path.join(root, 'lib', 'ws', 'ws-router.ts').
  const { tests } = findAffectedTests({ changed: ['lib/ws/ws-router.ts'] });
  assert.ok(tests.includes('tests/push-broadcast.test.js'));
});

test('package manifests are reported as global changes', () => {
  const { global } = findAffectedTests({ changed: ['package.json', 'lib/agent-transport.js'] });
  assert.deepEqual(global, ['package.json']);
});
