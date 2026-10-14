/**
 * Controller model (leaf S1): delegationController / canChatControlDelegation
 * and the control actions of the MCP delegation tools, on fixtures with
 * controllerChatId set (no production takeover operation exists yet).
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat, deleteChat } from '../lib/persist/chats-persist.js';
import {
  createDelegationRecord,
  getDelegationById,
  listActiveDelegationsForController,
  listDelegationsForController,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { canChatControlDelegation, delegationController } from '../lib/delegation-control.js';
import { canChatSteerDelegation } from '../lib/delegation-service.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { finishDelegation } from '../lib/delegation-service.js';
import { getDelegationWorkflow } from '../lib/persist/delegation-workflows-persist.js';

const workspace = ISOLATED_DATA_DIR;
const mk = (title) => addChat(randomUUID(), title, null, workspace, 'opencode/test', {
  agentTransport: 'opencode',
  sdkMode: 'agent',
});
const from = mk('ctl-from');
const to = mk('ctl-to');
const stranger = mk('ctl-stranger');

// --- pure accessor -----------------------------------------------------
assert.equal(delegationController({ parentChatId: 'a' }), 'a', 'fallback to the historical parent');
assert.equal(delegationController({ parentChatId: 'a', controllerChatId: 'b' }), 'b');
assert.equal(delegationController({ parentChatId: 'a', controllerChatId: '  ' }), 'a');
assert.equal(delegationController(null), '');

function job(controller, overrides = {}) {
  const row = createDelegationRecord({
    parentChatId: from.id,
    controllerChatId: controller,
    workspaceFolder: workspace,
    executor: { transport: 'opencode', model: 'zai-coding-plan/glm-5.3' },
    assignment: 'review',
    executionMode: 'agent',
    ...overrides,
  });
  updateDelegationRecord(row.id, { status: 'completed', runStoppingAt: '', report: 'TASK: review\nVERDICT: PASS', unverified: true });
  return getDelegationById(row.id);
}
const legacy = job('');
const moved = job(to.id);
assert.equal(legacy.controllerChatId, undefined);
assert.equal(moved.controllerChatId, to.id);

// --- caller x {no takeover, after takeover} x action -------------------
const handlersFor = (chat) => createCretliMcpToolHandlers(
  createInProcessMcpClient({ harness: 'opencode', chatId: chat.id, workspaceFolder: workspace }),
  { chatId: chat.id, workspaceFolder: workspace, mode: 'agent' },
);
const callers = { from, to, stranger };
const expected = {
  // [row][caller] -> may control
  legacy: { from: true, to: false, stranger: false },
  moved: { from: false, to: true, stranger: false },
};
const rows = { legacy, moved };
for (const [rowName, perCaller] of Object.entries(expected)) {
  for (const [callerName, allowed] of Object.entries(perCaller)) {
    const row = rows[rowName];
    const caller = callers[callerName];
    assert.equal(canChatControlDelegation(row, caller.id), allowed, `${rowName}/${callerName} control`);
    assert.equal(canChatSteerDelegation(row, caller.id, { dataDir: workspace }), allowed, `${rowName}/${callerName} steer`);
    const handlers = handlersFor(caller);
    // Terminal row of the same shape (fresh per action: rate/ack/cancel mutate).
    const fresh = () => job(row.controllerChatId || '').id;
    const running = () => {
      const created = createDelegationRecord({
        parentChatId: from.id,
        ...(row.controllerChatId ? { controllerChatId: row.controllerChatId } : {}),
        workspaceFolder: workspace,
        executor: { transport: 'opencode', model: 'glm' },
        assignment: 'implement',
      });
      return updateDelegationRecord(created.id, { status: 'running' }).id;
    };
    const actions = {
      wait: () => handlers.delegation_wait({ ids: [row.id], timeout_ms: 50 }),
      show: () => handlers.delegation_show({ delegation_id: row.id }),
      ack: () => handlers.delegation_ack({ delegation_id: fresh(), reason: 'reviewed' }),
      rate: () => handlers.delegation_rate({ delegation_id: fresh(), score: 4 }),
      cancel: () => handlers.delegation_cancel({ delegation_id: running() }),
      // An unknown verify id fails fast inside the runner, after the control gate.
      verify: () => handlers.delegation_verify({ delegation_id: fresh(), ids: ['__no_such_verify_id__'] }),
      // The workflow is keyed by the calling chat; it never reads another
      // chat's row through a delegation's historical parent.
      workflow: async () => {
        const result = await handlers.workflow_update({ role: 'review', round: 1 });
        assert.equal(result?.structuredContent?.workflow?.parentChatId, caller.id, `${rowName}/${callerName}/workflow keyed by the caller`);
        assert.ok(getDelegationWorkflow(caller.id, ''), `${rowName}/${callerName}/workflow persisted under the caller`);
        return result;
      },
    };
    for (const [action, run] of Object.entries(actions)) {
      let isError = false;
      try {
        const result = await run();
        isError = result?.isError === true;
      } catch {
        isError = true;
      }
      // show and workflow are scoped by workspace / calling chat, not by control.
      // cancel also admits the tree root chat (the original starter): that is the
      // documented tree-cancel authority, independent of the controller.
      const treeRoot = action === 'cancel' && row.rootChatId === caller.id;
      const expectOk = action === 'show' || action === 'workflow' ? true : (allowed || treeRoot);
      assert.equal(isError, !expectOk, `${rowName}/${callerName}/${action}`);
    }
  }
}

// --- listing by controller ---------------------------------------------
assert.ok(listDelegationsForController(to.id).some((row) => row.id === moved.id));
assert.ok(!listDelegationsForController(from.id).some((row) => row.id === moved.id));
assert.ok(listDelegationsForController(from.id).some((row) => row.id === legacy.id));
assert.ok(listActiveDelegationsForController(to.id).every((row) => row.status !== 'completed' && delegationController(row) === to.id), 'terminal rows hold no slot');
assert.ok(!listActiveDelegationsForController(from.id).some((row) => row.controllerChatId), 'moved rows are not active for the old parent');

// --- old parent deleted: the new controller still controls -------------
const orphan = job(to.id);
deleteChat(from.id);
const toHandlers = handlersFor(to);
const acked = await toHandlers.delegation_ack({ delegation_id: orphan.id, reason: 'reviewed' });
assert.equal(acked.isError, false, 'ack after the old parent was deleted');
const rated = await toHandlers.delegation_rate({ delegation_id: orphan.id, score: 4 });
assert.equal(rated.isError, false, 'rate after the old parent was deleted');
const running = createDelegationRecord({
  parentChatId: from.id,
  controllerChatId: to.id,
  workspaceFolder: workspace,
  executor: { transport: 'opencode', model: 'glm' },
  assignment: 'implement',
});
updateDelegationRecord(running.id, { status: 'running' });
const cancelled = await toHandlers.delegation_cancel({ delegation_id: running.id });
assert.equal(cancelled.isError, false, 'cancel after the old parent was deleted');

// --- code review phase writes the workflow under the controller --------
// finishDelegation runs the production sync (syncCodeReviewWorkflowAfterFinish).
async function finishCodeReview(controller, leafId) {
  const created = createDelegationRecord({
    parentChatId: from.id,
    ...(controller ? { controllerChatId: controller } : {}),
    workspaceFolder: workspace,
    executor: { transport: 'opencode', model: 'zai-coding-plan/glm-5.3' },
    assignment: 'review',
    executionMode: 'agent',
    leafId,
    reviewSubject: 'code',
    reviewMode: 'audit',
  });
  updateDelegationRecord(created.id, { status: 'running', leafId, reviewSubject: 'code', reviewMode: 'audit' });
  finishDelegation(getDelegationById(created.id), {
    status: 'completed',
    report: 'Audit done.\nTASK: review\nVERDICT: FAIL',
  });
  return getDelegationById(created.id);
}
const leafMoved = randomUUID();
const leafLegacy = randomUUID();
const movedReview = await finishCodeReview(to.id, leafMoved);
assert.equal(movedReview.status, 'completed');
const movedWorkflow = getDelegationWorkflow(to.id, leafMoved);
assert.ok(movedWorkflow, 'workflow row exists under (to, leaf)');
assert.equal(movedWorkflow.codeReviewAuditDone, true, 'audit verdict stored under (to, leaf)');
assert.ok(String(movedWorkflow.lastReviewer || '').length > 0, 'lastReviewer stored under (to, leaf)');
assert.equal(getDelegationWorkflow(from.id, leafMoved), null, 'no row (re)created under (from, leaf)');
const legacyReview = await finishCodeReview('', leafLegacy);
assert.equal(legacyReview.status, 'completed');
assert.ok(getDelegationWorkflow(from.id, leafLegacy), 'legacy row keeps its workflow under (parent, leaf)');
assert.equal(getDelegationWorkflow(to.id, leafLegacy), null);

removeIsolatedDataDir();
console.log('delegation-controller-model.test.js OK');
