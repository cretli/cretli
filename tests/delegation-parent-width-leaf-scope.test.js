/**
 * Regression: `parentWidthConflict` is a module-level function, so it must not
 * read the factory-scoped `deps`. The leaf-scope resolver used to read
 * `deps.dataDir`, which threw `ReferenceError: deps is not defined` whenever a
 * start carried a leaf id and the parent already had an active implement row.
 * The injected `dataDir` now travels through the `parentWidthConflict` input.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
// The scratch workspace is not a git repository; the leaf checkpoint would try
// to capture its manifest and fail before the width gate is reached.
process.env.CRETLI_LEAF_MATERIAL_CHECKPOINT = '0';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { addTodo } from '../lib/persist/todos-persist.js';
import {
  createDelegationService,
  finishDelegation,
  releaseDelegationRunSlot,
} from '../lib/delegation-service.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { patchMockChatRun, registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-parent-width-leaf-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
  dataDir: ISOLATED_DATA_DIR,
});

const parent = addChat(crypto.randomUUID(), 'parent-width-leaf', null, project, 'testfake/test', {
  agentTransport: 'testfake',
  sdkMode: 'agent',
});

// A real leaf with a scope makes `resolveLeafScopePaths` read the injected
// data dir through `getTodoById` + `collectTodoLeafScopePaths`.
const incomingLeaf = addTodo(ISOLATED_DATA_DIR, project, {
  title: 'Incoming leaf',
  status: 'doing',
  body: '## Leaf scope\n- lib/incoming.js\n',
}).item;
assert.ok(incomingLeaf?.id);

function releaseRunning(resultOrRow) {
  const job = resultOrRow?.delegation || resultOrRow;
  if (!job?.id) return;
  const latest = getDelegationById(job.id) || job;
  finishDelegation(latest, { status: 'completed', report: 'released' });
  if (latest.childChatId) patchMockChatRun(latest.childChatId, { busy: false, waitingForInput: false });
  releaseDelegationRunSlot(getDelegationById(latest.id) || latest);
}

// Unattributed implement first: it leaves an active non-review row for the
// parent, so the next leaf-scoped start reaches the parallel-implement width
// assessment and calls the leaf-scope resolver.
const first = await service.createAndStart({
  parentChatId: parent.id,
  sourceKind: 'text',
  taskText: 'First implement holds the parent slot.',
  assignment: 'implement',
  executor: { transport: 'testfake', model: 'testfake/test' },
  idempotencyKey: 'parent-width-leaf-first',
});
assert.equal(first.ok, true, JSON.stringify(first));

let second;
try {
  second = await service.createAndStart({
    parentChatId: parent.id,
    leafId: incomingLeaf.id,
    sourceKind: 'text',
    taskText: 'Leaf-scoped implement reaches the width resolver.',
    assignment: 'implement',
    executor: { transport: 'testfake', model: 'testfake/test' },
    idempotencyKey: 'parent-width-leaf-second',
  });
} catch (err) {
  assert.fail(`leaf-scoped start threw: ${err && err.stack ? err.stack : String(err)}`);
}
// The active unattributed implement row has no leaf id, so the parallel path is
// exclusive and the new job is parked; the point is that the resolver ran
// without a ReferenceError.
assert.equal(second.ok, true, JSON.stringify(second));
assert.equal(second.queued, true);
assert.equal(second.queueConflict.code, 'active_delegation_exists');

releaseRunning(first);
releaseRunning(getDelegationById(second.delegation.id));

console.log('delegation-parent-width-leaf-scope.test.js OK');
