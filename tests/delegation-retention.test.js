/**
 * Lossy retention guards: who gets archived and when, verdict and review badge
 * survive the report cut, mailbox replay still works on a trimmed body, and an
 * archived job cannot be retried with an empty assignment.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { addChat } from '../lib/persist/chats-persist.js';
import { applyDelegationRetention, MAILBOX_BODY_PREVIEW } from '../lib/delegation-retention.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  createMailboxMessage,
  getMailboxMessageById,
  hashMailboxBody,
} from '../lib/persist/delegation-mailbox-persist.js';
import { enqueueMailboxMessage } from '../lib/delegation-mailbox.js';
import { resolveDelegationRecordVerdict } from '../lib/delegation-verdict.js';
import { resolveTodoReviewReportLinkState } from '../lib/todo-review-read.js';
import { createDelegationService, finishDelegation } from '../lib/delegation-service.js';
import { registerMockChatRunAdapter, patchMockChatRun } from '../lib/chat-run/mock-adapter.ts';

test.after(() => removeIsolatedDataDir());

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const LONG_REPORT = `${'finding line\n'.repeat(400)}VERDICT: FAIL`;

/**
 * @param {string} id
 * @param {Record<string, unknown>} fields
 */
function finished(id, fields = {}) {
  createDelegationRecord({ id, parentChatId: `parent-${id}`, childChatId: `child-${id}`, harness: 'claude', model: 'm', task: 't' });
  return updateDelegationRecord(id, {
    status: 'completed',
    finishedAt: daysAgo(5),
    report: LONG_REPORT,
    sourceText: 'the original task',
    ...fields,
  });
}

const LEAF_DONE = '11111111-1111-4111-8111-111111111111';
const LEAF_OPEN = '22222222-2222-4222-8222-222222222222';
const leafOpen = (open) => (row) => open.has(String(row.leafId || ''));

test('closed or leafless jobs are archived after the trim age; open leaves wait for the ceiling', async () => {
  finished('r-closed', { leafId: LEAF_DONE });
  finished('r-open', { leafId: LEAF_OPEN });
  finished('r-open-old', { leafId: LEAF_OPEN, finishedAt: daysAgo(31) });
  finished('r-fresh', { finishedAt: daysAgo(1) });
  const before = resolveDelegationRecordVerdict(getDelegationById('r-closed'));
  await applyDelegationRetention({ now: NOW, isLeafOpen: leafOpen(new Set([LEAF_OPEN])) });
  const closed = getDelegationById('r-closed');
  assert.ok(closed.archivedAt);
  assert.equal(closed.sourceText, '');
  assert.equal(closed.report.length, 2000);
  // The verdict sat past the cut; it was persisted from the full report first.
  assert.equal(closed.reportVerdict, 'FAIL');
  assert.equal(resolveDelegationRecordVerdict(closed), before);
  assert.equal(resolveTodoReviewReportLinkState({ delegation: closed }), 'report_trimmed');
  assert.ok(!getDelegationById('r-open').archivedAt);
  assert.equal(getDelegationById('r-open').report, LONG_REPORT);
  assert.ok(getDelegationById('r-open-old').archivedAt);
  assert.ok(!getDelegationById('r-fresh').archivedAt);
});

test('undelivered outbox, queued parent reply and uncertain accept are never archived', async () => {
  finished('r-outbox', { outbox: [{ id: 'o1', type: 'mailbox', deliveredAt: '', snapshot: { report: 'x' } }] });
  finished('r-uncertain', { acceptState: 'uncertain' });
  // Two-stage case: the outbox item is delivered (the mailbox row exists),
  // but the parent has not received that row yet.
  finished('r-two-stage', { outbox: [{ id: 'o2', type: 'mailbox', deliveredAt: daysAgo(5) }] });
  createMailboxMessage({ kind: 'reply', replyKind: 'final_report', fromChatId: 'child-r-two-stage', toChatId: 'parent-r-two-stage', delegationId: 'r-two-stage', delegationAttemptId: 'a1', body: 'report', status: 'queued' });
  await applyDelegationRetention({ now: NOW, isLeafOpen: () => false });
  for (const id of ['r-outbox', 'r-uncertain', 'r-two-stage']) {
    assert.ok(!getDelegationById(id).archivedAt, id);
    assert.equal(getDelegationById(id).report, LONG_REPORT, id);
  }
});

test('trimmed mailbox bodies shrink and still replay by idempotency key', async () => {
  finished('r-mail', { finishedAt: daysAgo(10) });
  const body = 'B'.repeat(5000);
  const input = {
    kind: 'reply',
    replyKind: 'final_report',
    taskOutcome: 'success',
    fromChatId: 'child-r-mail',
    toChatId: 'parent-r-mail',
    delegationId: 'r-mail',
    delegationAttemptId: 'a1',
    body,
    idempotencyKey: 'mail-key',
  };
  const message = createMailboxMessage({ ...input, status: 'delivered', requestHash: `old-format\n${body}` });
  const { updateMailboxMessage } = await import('../lib/persist/delegation-mailbox-persist.js');
  updateMailboxMessage(message.id, { deliveredAt: daysAgo(5) });
  const queued = createMailboxMessage({ ...input, idempotencyKey: 'queued-key', delegationAttemptId: 'a2', status: 'queued' });
  const result = await applyDelegationRetention({ now: NOW, isLeafOpen: () => false });
  assert.equal(result.mailboxTrimmed, 1);
  const trimmed = getMailboxMessageById(message.id);
  assert.ok(trimmed.bodyTrimmedAt);
  assert.equal(trimmed.bodyHash, hashMailboxBody(body));
  assert.equal(trimmed.bodyLength, 5000);
  assert.ok(trimmed.body.length < MAILBOX_BODY_PREVIEW + 200);
  assert.ok(!trimmed.requestHash.includes(body), 'old full-body requestHash is rewritten');
  assert.equal(getMailboxMessageById(queued.id).body, body);
  const replay = await enqueueMailboxMessage(input);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, message.id);
  const changed = await enqueueMailboxMessage({ ...input, body: `${body}!` });
  assert.equal(changed.code, 'idempotency_conflict');
  const otherJob = await enqueueMailboxMessage({ ...input, delegationId: 'r-other' });
  assert.equal(otherJob.ok, false);
  // A second pass leaves the trimmed row alone.
  assert.equal((await applyDelegationRetention({ now: NOW, isLeafOpen: () => false })).mailboxTrimmed, 0);
});

test('an archived job with trimmed task text is not retried', async () => {
  registerMockChatRunAdapter('testfake');
  const service = createDelegationService({ workspaceDirForAgent: () => ISOLATED_DATA_DIR, isModelAvailable: () => true });
  const parent = addChat(crypto.randomUUID(), 'retention retry', null, ISOLATED_DATA_DIR, 'testfake/test', { agentTransport: 'testfake', sdkMode: 'agent' });
  const created = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'probe',
    executor: { transport: 'testfake', model: 'testfake/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  finishDelegation(created.delegation, { status: 'failed', error: 'first' });
  patchMockChatRun(created.delegation.childChatId, { busy: false, waitingForInput: false });
  updateDelegationRecord(created.delegation.id, { archivedAt: daysAgo(1), sourceText: '', planMarkdown: '' });
  const retried = await service.retry(created.delegation.id);
  assert.equal(retried.ok, false);
  assert.equal(retried.code, 'delegation_archived');
});

test('the default leaf probe reads todo status from the workspace', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { addTodo, updateTodo } = await import('../lib/persist/todos-persist.js');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-retention-ws-'));
  try {
    const todo = addTodo(ISOLATED_DATA_DIR, workspace, { title: 'leaf', status: 'doing' });
    const leafId = todo.id || todo.item?.id;
    finished('r-probe', { leafId, workspaceFolder: workspace });
    await applyDelegationRetention({ now: NOW });
    assert.ok(!getDelegationById('r-probe').archivedAt, 'open leaf keeps the full report');
    updateTodo(ISOLATED_DATA_DIR, workspace, leafId, { status: 'done' });
    await applyDelegationRetention({ now: NOW });
    assert.ok(getDelegationById('r-probe').archivedAt, 'closed leaf is archived');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a leaf missing from the todo store keeps the full text until the ceiling', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-retention-missing-'));
  try {
    finished('r-missing-leaf', { leafId: '33333333-3333-4333-8333-333333333333', workspaceFolder: workspace });
    await applyDelegationRetention({ now: NOW });
    assert.ok(!getDelegationById('r-missing-leaf').archivedAt);
    assert.equal(getDelegationById('r-missing-leaf').report, LONG_REPORT);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('old extra instructions are cleared with one mailbox write', async () => {
  const fs = await import('node:fs');
  const { updateMailboxMessage } = await import('../lib/persist/delegation-mailbox-persist.js');
  const ids = [1, 2, 3].map((n) => {
    const message = createMailboxMessage({ kind: 'task', fromChatId: 'p', toChatId: `c${n}`, body: 'short', extraInstructions: 'keep it brief', status: 'delivered' });
    updateMailboxMessage(message.id, { deliveredAt: daysAgo(40) });
    return message.id;
  });
  const realWrite = fs.default.writeFileSync;
  let mailboxWrites = 0;
  fs.default.writeFileSync = (file, ...rest) => {
    if (String(file).includes('delegation-mailbox.json')) mailboxWrites += 1;
    return realWrite(file, ...rest);
  };
  try {
    await applyDelegationRetention({ now: NOW, isLeafOpen: () => false });
  } finally {
    fs.default.writeFileSync = realWrite;
  }
  assert.equal(mailboxWrites, 1);
  for (const id of ids) assert.equal(getMailboxMessageById(id).extraInstructions, '');
});

test('compaction dry-run refuses an older sqlite schema instead of upgrading it', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-compact-v3-'));
  try {
    const file = path.join(dir, 'delegations.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('schemaVersion', '3'); PRAGMA user_version = 3;");
    legacy.close();
    const run = spawnSync(process.execPath, ['scripts/compact-delegation-store.js', '--data-dir', dir], {
      env: { ...process.env, CRETLI_DELEGATION_STORE: 'sqlite' },
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /schema 3/);
    const probe = new DatabaseSync(file, { readOnly: true });
    assert.equal(Number(probe.prepare('PRAGMA user_version').get().user_version), 3);
    probe.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
