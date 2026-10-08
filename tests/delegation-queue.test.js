import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  acceptDelegationFinalReport,
  createDelegationService,
  finishDelegation,
  inspectDelegationSlot,
  releaseDelegationRunSlot,
} from '../lib/delegation-service.js';
import {
  resolveDelegationGlobalLimit,
  resolveDelegationWorkspaceWriteConflict,
} from '../lib/delegation-workspace-guard.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { isTerminalDelegationStatus } from '../lib/delegation-status.js';
import { toCretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from '../lib/mcp/builtin/errors.js';
import {
  patchMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-delegation-queue-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

const previousFanout = process.env.CRETLI_DELEGATION_REVIEW_FANOUT;
const previousQueueMax = process.env.CRETLI_DELEGATION_QUEUE_MAX;

function parent(title) {
  return addChat(crypto.randomUUID(), title, null, project, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
}

function startImplement(p, text, key) {
  return service.createAndStart({
    parentChatId: p.id,
    sourceKind: 'text',
    taskText: text || 'queue task',
    assignment: 'implement',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: key || crypto.randomUUID(),
  });
}

function startReview(p, text, key) {
  return service.createAndStart({
    parentChatId: p.id,
    sourceKind: 'text',
    taskText: text || 'queue review',
    assignment: 'review',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: key || crypto.randomUUID(),
  });
}

// Park a running job so its slot frees without a stop-grace wait.
function releaseRunning(resultOrRow) {
  const job = resultOrRow?.delegation || resultOrRow;
  if (!job?.id) return;
  const latest = getDelegationById(job.id) || job;
  if (latest.status === 'queued') {
    finishDelegation(latest, { status: 'cancelled' });
    return;
  }
  finishDelegation(latest, { status: 'completed', report: 'released' });
  if (latest.childChatId) patchMockChatRun(latest.childChatId, { busy: false, waitingForInput: false });
  releaseDelegationRunSlot(getDelegationById(latest.id) || latest);
}

function freshParent(label) {
  return addChat(crypto.randomUUID(), label, null, project, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
}

try {
  delete process.env.CRETLI_DELEGATION_REVIEW_FANOUT;
  delete process.env.CRETLI_DELEGATION_QUEUE_MAX;

  // (1) A second implement on a busy parent is QUEUED, not a hard 409.
  {
    const p = parent('queue-basic');
    const first = await startImplement(p, 'first');
    assert.equal(first.ok, true);
    const second = await startImplement(p, 'second', 'queue-basic-2');
    assert.equal(second.ok, true);
    assert.equal(second.status, 202);
    assert.equal(second.queued, true);
    assert.equal(second.queueConflict.code, 'active_delegation_exists');
    assert.equal(second.delegation.status, 'queued');
    // A parked row has no child run yet.
    const parkedChild = getDelegationById(second.delegation.id);
    assert.equal(parkedChild.status, 'queued');

    // (2) After the first job is terminal and its slot frees, drain starts it.
    releaseRunning(first);
    const drained = await service.drainQueue({ parentChatId: p.id });
    assert.equal(drained.started.includes(second.delegation.id), true);
    const started = getDelegationById(second.delegation.id);
    assert.equal(started.status !== 'queued', true, started.status);
    assert.ok(started.runId, 'drained job should carry a run id');
    releaseRunning(started);
  }

  // (3) FIFO: the oldest queued job starts first; the next stays parked.
  {
    const p = parent('queue-fifo');
    const running = await startImplement(p, 'head');
    assert.equal(running.ok, true);
    const q1 = await startImplement(p, 'q1', 'queue-fifo-1');
    assert.equal(q1.queued, true);
    const q2 = await startImplement(p, 'q2', 'queue-fifo-2');
    assert.equal(q2.queued, true);
    assert.equal(
      String(q1.delegation.createdAt) <= String(q2.delegation.createdAt),
      true,
      'q1 must be older than q2',
    );

    releaseRunning(running);
    const drain1 = await service.drainQueue({ parentChatId: p.id });
    assert.equal(drain1.started.includes(q1.delegation.id), true);
    assert.equal(drain1.started.includes(q2.delegation.id), false);
    assert.equal(getDelegationById(q1.delegation.id).status !== 'queued', true);
    assert.equal(getDelegationById(q2.delegation.id).status, 'queued');

    releaseRunning(getDelegationById(q1.delegation.id));
    const drain2 = await service.drainQueue({ parentChatId: p.id });
    assert.equal(drain2.started.includes(q2.delegation.id), true);
    releaseRunning(getDelegationById(q2.delegation.id));
  }

  // (4) review_fanout_full is a queueable conflict too (fanout default 2).
  {
    const p = parent('queue-fanout');
    const a = await startReview(p, 'ra', 'queue-fanout-a');
    const b = await startReview(p, 'rb', 'queue-fanout-b');
    assert.equal(a.ok && b.ok, true);
    const c = await startReview(p, 'rc', 'queue-fanout-c');
    assert.equal(c.ok, true);
    assert.equal(c.queued, true);
    assert.equal(c.queueConflict.code, 'review_fanout_full');
    assert.equal(getDelegationById(c.delegation.id).status, 'queued');
    releaseRunning(a);
    const drain = await service.drainQueue({ parentChatId: p.id });
    assert.equal(drain.started.includes(c.delegation.id), true);
    releaseRunning(getDelegationById(c.delegation.id));
    releaseRunning(b);
  }

  // (5) Exceeding CRETLI_DELEGATION_QUEUE_MAX returns a hard 409 queue_full.
  {
    process.env.CRETLI_DELEGATION_QUEUE_MAX = '2';
    const p = parent('queue-cap');
    const running = await startImplement(p, 'cap-head', 'queue-cap-head');
    assert.equal(running.ok, true);
    const q1 = await startImplement(p, 'cap-1', 'queue-cap-1');
    const q2 = await startImplement(p, 'cap-2', 'queue-cap-2');
    assert.equal(q1.queued && q2.queued, true);
    const q3 = await startImplement(p, 'cap-3', 'queue-cap-3');
    assert.equal(q3.ok, false);
    assert.equal(q3.status, 409);
    assert.equal(q3.code, 'queue_full');
    const mapped = toCretliMcpToolError({ code: 'queue_full', message: q3.error, status: 409 });
    assert.equal(mapped.code, MCP_BUILTIN_ERROR_CODES.CONFLICT);
    delete process.env.CRETLI_DELEGATION_QUEUE_MAX;
    releaseRunning(running);
    const drain = await service.drainQueue({ parentChatId: p.id });
    assert.equal(drain.started.includes(q1.delegation.id), true);
    releaseRunning(getDelegationById(q1.delegation.id));
    releaseRunning(q2.delegation);
  }

  // (6) retry with the slot held stays a hard 409 parent_busy (never queued).
  {
    const p = freshParent('queue-retry');
    const jobX = await startImplement(p, 'retry-x', 'queue-retry-x');
    assert.equal(jobX.ok, true);
    releaseRunning(jobX);
    const jobY = await startImplement(p, 'retry-y', 'queue-retry-y');
    assert.equal(jobY.ok, true);
    const retried = await service.retry(jobX.delegation.id);
    assert.equal(retried.ok, false);
    assert.equal(retried.code, 'parent_busy');
    releaseRunning(jobY);
  }

  // (7) Idempotency replay of a parked row while the slot is held: success, not 409.
  {
    const p = parent('queue-replay-busy');
    const head = await startImplement(p, 'head', 'queue-replay-head');
    assert.equal(head.ok, true);
    const parked = await startImplement(p, 'parked', 'queue-replay-parked');
    assert.equal(parked.queued, true);
    const replayBusy = await startImplement(p, 'parked', 'queue-replay-parked');
    assert.equal(replayBusy.ok, true);
    assert.equal(replayBusy.replayed, true);
    assert.equal(replayBusy.queued, true);
    assert.notEqual(replayBusy.status, 409);
    releaseRunning(head);
  }

  // (8) Replay must not jump ahead of an older queued sibling when the slot is free.
  {
    const p = parent('queue-replay-fifo');
    const running = await startImplement(p, 'run', 'queue-replay-fifo-run');
    const older = await startImplement(p, 'older', 'queue-replay-fifo-old');
    const newer = await startImplement(p, 'newer', 'queue-replay-fifo-new');
    assert.equal(older.queued && newer.queued, true);
    releaseRunning(running);
    const replayNewer = await startImplement(p, 'newer', 'queue-replay-fifo-new');
    assert.equal(replayNewer.ok, true);
    assert.equal(replayNewer.replayed, true);
    assert.equal(replayNewer.queued, true);
    assert.equal(getDelegationById(newer.delegation.id).status, 'queued');
    assert.equal(getDelegationById(older.delegation.id).status, 'queued');
    const drain = await service.drainQueue({ parentChatId: p.id });
    assert.equal(drain.started.includes(older.delegation.id), true);
    assert.equal(drain.started.includes(newer.delegation.id), false);
    releaseRunning(getDelegationById(older.delegation.id));
    releaseRunning(newer.delegation);
  }

  // (9) A parked row alone does not count as workspace/global occupancy.
  {
    const parkedOnly = [{
      id: 'queued-only',
      parentChatId: 'parent-x',
      workspaceFolder: project,
      assignment: 'implement',
      status: 'queued',
    }];
    const ws = resolveDelegationWorkspaceWriteConflict({
      active: parkedOnly,
      workspaceFolder: project,
      parentChatId: 'parent-y',
      incomingAssignment: 'implement',
    });
    assert.equal(ws.ok, true);
    const global = resolveDelegationGlobalLimit({ active: parkedOnly, limit: 1 });
    assert.equal(global.ok, true);
  }

  // (10) Final report with an idle child frees the slot and drains in the same turn.
  {
    const p = parent('queue-final-drain');
    const head = await startImplement(p, 'head', 'queue-final-head');
    const parked = await startImplement(p, 'parked', 'queue-final-parked');
    assert.equal(parked.queued, true);
    const job = head.delegation;
    patchMockChatRun(job.childChatId, { busy: false, waitingForInput: false });
    const final = await acceptDelegationFinalReport({
      delegationId: job.id,
      attemptId: job.attemptId,
      runId: job.runId,
      report: 'done',
    });
    assert.equal(final.ok, true);
    const after = getDelegationById(job.id);
    assert.equal(inspectDelegationSlot(after).occupied, false);
    await service.drainQueue({ parentChatId: p.id });
    assert.equal(getDelegationById(parked.delegation.id).status !== 'queued', true);
    releaseRunning(getDelegationById(parked.delegation.id));
  }

  // The parked row of a terminal parent is genuinely 'queued' (not active).
  assert.equal(isTerminalDelegationStatus('queued'), false);
} finally {
  if (previousFanout == null) delete process.env.CRETLI_DELEGATION_REVIEW_FANOUT;
  else process.env.CRETLI_DELEGATION_REVIEW_FANOUT = previousFanout;
  if (previousQueueMax == null) delete process.env.CRETLI_DELEGATION_QUEUE_MAX;
  else process.env.CRETLI_DELEGATION_QUEUE_MAX = previousQueueMax;
}

console.log('delegation-queue.test.js OK');
