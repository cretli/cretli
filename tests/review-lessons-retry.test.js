import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationService } from '../lib/delegation-service.js';
import {
  createDelegationRecord,
  getDelegationById,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { addReviewLesson } from '../lib/persist/review-lessons-persist.js';
import { registerMockChatRunAdapter, getMockChatRun } from '../lib/chat-run/mock-adapter.ts';

const folder = path.join(ISOLATED_DATA_DIR, 'retry-lessons-ws');
fs.mkdirSync(folder, { recursive: true });
registerMockChatRunAdapter('opencode');
const service = createDelegationService({ workspaceDirForAgent: () => folder, isModelAvailable: () => true });
const LESSON_TEXT = 'Add a regression test for every fix.';

function newParent(title) {
  return addChat(crypto.randomUUID(), title, null, folder, 'opencode/test', { agentTransport: 'opencode', sdkMode: 'agent' });
}

function interrupt(id) {
  updateDelegationRecord(id, {
    status: 'interrupted', interruptCode: 'server_restart', finishedAt: new Date().toISOString(), runStoppingAt: '',
  });
}

function lessonsBlock(prompt) {
  const start = prompt.indexOf('[KNOWN REVIEW LESSONS]');
  return start < 0 ? '' : prompt.slice(start, start + 600);
}

// Flag off: a started run still pins an (empty) exposure.
{
  const previousFlag = process.env.CRETLI_REVIEW_LESSONS;
  process.env.CRETLI_REVIEW_LESSONS = '0';
  const off = await service.createAndStart({
    parentChatId: newParent('lessons off').id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    sourceKind: 'text',
    taskText: 'flag off task',
    idempotencyKey: 'lessons-off-1',
  });
  assert.equal(off.ok, true, JSON.stringify(off));
  const offRow = getDelegationById(off.delegation.id);
  assert.deepEqual(offRow.injectedLessonIds, []);
  assert.ok(offRow.lessonsInjectedAt);
  updateDelegationRecord(offRow.id, { status: 'completed', finishedAt: new Date().toISOString(), slotHeldBy: '' });
  if (previousFlag === undefined) delete process.env.CRETLI_REVIEW_LESSONS;
  else process.env.CRETLI_REVIEW_LESSONS = previousFlag;
}

const previous = process.env.CRETLI_REVIEW_LESSONS;
process.env.CRETLI_REVIEW_LESSONS = '1';
try {
  const lesson = addReviewLesson(folder, { audience: 'implementer', kind: 'do', category: 'missing-test', text: LESSON_TEXT, status: 'active' });

  // A retried attempt shows the same block and keeps the first attempt's ids.
  const started = await service.createAndStart({
    parentChatId: newParent('lessons retry').id,
    executor: { transport: 'opencode', model: 'opencode/test' },
    sourceKind: 'text',
    taskText: 'fix the tests',
    idempotencyKey: 'lessons-retry-1',
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const firstPrompt = getMockChatRun(started.delegation.childChatId).prompt;
  assert.ok(firstPrompt.includes(LESSON_TEXT), 'first attempt shows the lesson');
  const firstRow = getDelegationById(started.delegation.id);
  assert.deepEqual(firstRow.injectedLessonIds, [lesson.id]);
  addReviewLesson(folder, { audience: 'implementer', kind: 'avoid', category: 'perf', text: 'Added after the first attempt.', status: 'active' });
  interrupt(firstRow.id);
  getMockChatRun(started.delegation.childChatId).busy = false;
  const retried = await service.retry(firstRow.id);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  const retryPrompt = getMockChatRun(started.delegation.childChatId).prompt;
  assert.equal(lessonsBlock(retryPrompt), lessonsBlock(firstPrompt), 'retry shows the same block');
  assert.ok(!retryPrompt.includes('Added after the first attempt.'));
  const afterRetry = getDelegationById(firstRow.id);
  assert.deepEqual(afterRetry.injectedLessonIds, firstRow.injectedLessonIds);
  assert.equal(afterRetry.lessonsInjectedAt, firstRow.lessonsInjectedAt);

  // Free the workspace slot held by the retried attempt.
  updateDelegationRecord(firstRow.id, { status: 'completed', finishedAt: new Date().toISOString(), slotHeldBy: '' });

  // A legacy record (no exposure fields) gets them set on its first retry.
  const child = addChat(crypto.randomUUID(), 'legacy child', null, folder, 'opencode/test', { agentTransport: 'opencode', sdkMode: 'agent' });
  const legacy = createDelegationRecord({
    parentChatId: newParent('legacy retry').id,
    childChatId: child.id,
    workspaceFolder: folder,
    executor: { transport: 'opencode', model: 'opencode/test' },
    assignment: 'implement',
    status: 'interrupted',
    sourceKind: 'text',
    sourceText: 'fix the tests',
  });
  interrupt(legacy.id);
  assert.equal(getDelegationById(legacy.id).lessonsInjectedAt, '');
  const legacyRetry = await service.retry(legacy.id);
  assert.equal(legacyRetry.ok, true, JSON.stringify(legacyRetry));
  assert.ok(getMockChatRun(child.id).prompt.includes(LESSON_TEXT));
  const legacyAfter = getDelegationById(legacy.id);
  assert.ok(legacyAfter.lessonsInjectedAt);
  assert.ok(legacyAfter.injectedLessonIds.includes(lesson.id));
} finally {
  if (previous === undefined) delete process.env.CRETLI_REVIEW_LESSONS;
  else process.env.CRETLI_REVIEW_LESSONS = previous;
}

console.log('review-lessons-retry tests passed');
