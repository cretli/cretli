import assert from 'node:assert/strict';
import { hostExecutionEnvironment, resolveExecutionEnvironment } from '../lib/worktree/execution-environment.ts';

assert.equal(resolveExecutionEnvironment().id, 'host');
assert.equal(resolveExecutionEnvironment({ environment: 'inherit' }), hostExecutionEnvironment);
assert.equal(resolveExecutionEnvironment({ policyDefault: 'host' }), hostExecutionEnvironment);
assert.throws(() => resolveExecutionEnvironment({ environment: 'container' }), /Unknown execution environment/);
assert.equal(hostExecutionEnvironment.kind, 'host');
assert.deepEqual(await hostExecutionEnvironment.probe(), { available: true });
const handle = await hostExecutionEnvironment.prepare({});
assert.equal(handle, undefined);
await hostExecutionEnvironment.stop(handle);
console.log('execution-environment.test.js OK');
