import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPhase, bootListenTotal } from '../lib/boot-log.js';

test('bootPhase logs the phase name with ms since process start', () => {
  const lines = [];
  const ms = bootPhase('storage-open', { log: (l) => lines.push(l), uptimeMs: () => 1234.6 });
  assert.equal(ms, 1235);
  assert.deepEqual(lines, ['[boot] phase=storage-open +1235']);
});

test('bootListenTotal logs the total time to listen', () => {
  const lines = [];
  bootListenTotal({ log: (l) => lines.push(l), uptimeMs: () => 20000 });
  assert.deepEqual(lines, ['[boot] listen total=20000']);
});

test('server defers history open and delegation boot past listen', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /await openChatHistoryService\(\)/);
  assert.doesNotMatch(src, /^void bootDelegationRuntime/m);
  assert.match(src, /setImmediate\(\(\) => \{ void runDeferredBoot\(\)/);
  assert.match(src, /setDelegationLifecycleState\('initializing'\)/);
});

test('markDeferredBootFailed turns a pre-boot failure into degraded with the cause', async () => {
  const { markDeferredBootFailed } = await import('../lib/delegation-runtime-boot.js');
  const { setDelegationLifecycleState, getDelegationLifecycleSnapshot } = await import('../lib/delegation-lifecycle.js');
  setDelegationLifecycleState('initializing');
  // Mirrors runDeferredBoot: a step before bootDelegationRuntime throws.
  const run = async () => { throw Object.assign(new Error('seed exploded'), { code: 'SEED_FAIL' }); };
  await run().catch((err) => markDeferredBootFailed(err));
  const snap = getDelegationLifecycleSnapshot();
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.acceptingWork, false);
  assert.equal(snap.error.code, 'SEED_FAIL');
  assert.equal(snap.error.message, 'seed exploded');
  setDelegationLifecycleState('initializing');
});

test('server deferred boot catch marks the lifecycle degraded', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /markDeferredBootFailed\(err\)/);
});
