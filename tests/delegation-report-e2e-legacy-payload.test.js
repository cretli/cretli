/**
 * Stage 3.3 — end-to-end delegation report capture, persist, mailbox, and UI
 * safety for legacy stored payloads with prefix repetitions (~800 KiB).
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { findMailboxReplyForDelegation, loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';
import { buildDelegationCardModel, projectDelegationCardsFromHistory } from '../lib/delegation-card-model.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { noteDelegationRoomEvent } from '../lib/delegation-run-bridge.js';
import {
  captureHarnessPlanFromSdkEvent,
  resetHarnessPlanCapture,
} from '../lib/sdk/harness-plan-sync.js';
import {
  createRunAssistantStreamCapture,
  noteRunAssistantStreamEvent,
  readRunAssistantStreamCombinedText,
  rebuildAssistantTextFromHistoryEvents,
} from '../lib/sdk/sdk-plan-text.js';
import {
  buildHistoryCardReportHostHtml,
  buildHistoryCardReportViewModel,
  estimateHtmlElementCount,
  getHistoryCardReportFullText,
  measureUtf8ByteLength,
  renderHistoryCardReportMarkdownCached,
  resetHistoryCardReportRuntimeForTests,
} from '../app_front/lib/delegationHistoryCardReport.js';
import {
  UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES,
} from '../app_front/lib/uiFreezeRenderBudgets.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('sdk');

const project = mkdtempSync(path.join(os.tmpdir(), 'cr-report-e2e-'));
const service = createDelegationService({
  workspaceDirForAgent: () => project,
  isModelAvailable: () => true,
});

const CANONICAL_VERDICT = 'TASK: implement\nVERDICT: PASS';

/**
 * Simulates pre-3.1 run-level accumulation that appended unrelated snapshots.
 *
 * @param {string} canonicalFinal
 * @returns {string}
 */
function buildLegacyPrefixBloatHead(seedText) {
  const progressive = ['Komentarz. ', 'R', 'Ra', 'Rap', 'Raport'];
  let buggy = '';
  for (const chunk of progressive) {
    buggy += chunk;
  }
  return `${buggy}\n\n${seedText}`;
}

/**
 * @param {string} seed
 * @param {number} minUtf8Bytes
 * @returns {{ stored: string, canonicalTail: string }}
 */
function buildLegacyStoredReport(seed, minUtf8Bytes) {
  const canonicalTail = `${seed}\n\n${CANONICAL_VERDICT}`;
  const head = buildLegacyPrefixBloatHead(seed);
  const padLine = `${'legacy-paragraph '.repeat(80)}\n\n`;
  let stored = head;
  while (measureUtf8ByteLength(stored) < minUtf8Bytes) {
    stored += padLine;
  }
  stored += `\n\n${canonicalTail}`;
  assert.ok(measureUtf8ByteLength(stored) >= minUtf8Bytes);
  assert.ok(stored.includes('RRa'), 'legacy shape must retain prefix repetition artifacts');
  return { stored, canonicalTail };
}

/**
 * @param {string} text
 * @param {string} [id]
 * @param {string} [streamTextMode]
 * @returns {object}
 */
function assistantEvent(text, id = '', streamTextMode = '') {
  const message = { role: 'assistant', content: [{ type: 'text', text }] };
  if (id) message.id = id;
  const event = { type: 'assistant', message };
  if (streamTextMode) event.streamTextMode = streamTextMode;
  return event;
}

/**
 * @param {string} title
 */
function createParent(title) {
  return addChat(`sess-${title}-${Math.random().toString(16).slice(2)}`, title, null, project, 'planner-model', {
    agentTransport: 'sdk',
    sdkMode: 'plan',
  });
}

test('capture (multi snapshot/delta) → finish → persist → history → mailbox — single final report', async () => {
  const parent = createParent('E2E capture');
  const started = await service.createAndStart({
    parentChatId: parent.id,
    executor: { transport: 'sdk', model: 'sdk/test' },
    sourceKind: 'text',
    taskText: 'Verify report pipeline',
    idempotencyKey: `e2e-capture-${Date.now()}`,
  });
  assert.equal(started.ok, true);
  const room = {
    chatId: started.delegation.childChatId,
    delegationId: started.delegation.id,
    delegationAttemptId: started.delegation.attemptId,
  };
  resetHarnessPlanCapture(room);
  captureHarnessPlanFromSdkEvent(room, assistantEvent('Komentarz. '));
  for (const part of ['R', 'Ra', 'Rap', 'Raport']) {
    captureHarnessPlanFromSdkEvent(room, assistantEvent(part));
  }
  captureHarnessPlanFromSdkEvent(room, assistantEvent('Progress note.', 'msg-progress', 'delta'));
  captureHarnessPlanFromSdkEvent(room, assistantEvent(' more progress.', 'msg-progress', 'delta'));
  captureHarnessPlanFromSdkEvent(room, {
    type: 'tool_call',
    name: 'Read',
    call_id: 'tool-1',
  });
  captureHarnessPlanFromSdkEvent(room, assistantEvent(
    `Final body line.\n\n${CANONICAL_VERDICT}`,
    'msg-final',
    'snapshot',
  ));
  const expected = String(room._currentRunAssistantText || '').trim();
  assert.equal(expected.includes('Komentarz.'), true);
  assert.equal(expected.includes('Raport'), true);
  assert.equal(expected.includes('Progress note. more progress.'), true);
  assert.equal((expected.match(/TASK: implement/g) || []).length, 1);
  assert.equal(expected.includes('RRa'), false, 'capture must not leave prefix-chain garbage');
  await noteDelegationRoomEvent(room, {
    type: 'sdkRunFinished',
    status: 'completed',
    runId: started.delegation.runId,
  });
  const persisted = getDelegationById(started.delegation.id);
  assert.ok(persisted);
  assert.equal(String(persisted.report || '').trim(), expected);
  assert.equal(persisted.status, 'completed');
  assert.ok(String(persisted.historyDeliveredAt || '').trim());
  const historyEvents = loadChatHistory(parent.id).events.filter(
    (row) => row.rec?.variant === 'delegation',
  );
  const finishedCard = historyEvents
    .map((row) => JSON.parse(String(row.rec.payload || '{}')))
    .find((row) => row.event === 'finished');
  assert.ok(finishedCard);
  assert.equal(String(finishedCard.report || '').trim(), expected);
  assert.equal(finishedCard.status, 'completed');
  const mailbox = loadMailboxMessages().find(
    (row) => row.kind === 'reply'
      && row.delegationId === started.delegation.id
      && String(row.replyKind || '') === 'final_report',
  );
  assert.ok(mailbox);
  assert.equal(String(mailbox.body || '').trim(), expected);
  assert.equal(findMailboxReplyForDelegation(started.delegation.id)?.status, 'delivered');
  assert.ok(String(persisted.reportDeliveredAt || '').trim());
  assert.ok(String(persisted.historyDeliveredAt || '').trim());
  const cardModel = buildDelegationCardModel({
    ...finishedCard,
    historyDeliveredAt: persisted.historyDeliveredAt,
    reportDeliveredAt: persisted.reportDeliveredAt,
  });
  assert.equal(cardModel.deliveryState, 'delivered');
});

test('legacy ~800 KiB stored report: bounded UI render, full payload unchanged', () => {
  resetHistoryCardReportRuntimeForTests();
  const { stored, canonicalTail } = buildLegacyStoredReport('Stored legacy report body.', 800 * 1024);
  const model = buildHistoryCardReportViewModel({ fullText: stored });
  assert.equal(model.isTruncated, true);
  assert.ok(model.previewUtf8Bytes <= UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES);
  assert.ok(model.fullUtf8Bytes >= 800 * 1024);
  assert.equal(getHistoryCardReportFullText(model.contentKey), stored);
  const previewHtml = renderHistoryCardReportMarkdownCached(
    `${model.contentKey}:legacy:0`,
    model.previewText,
    (source) => `<div class="sdk-md"><pre>${source.length}</pre></div>`,
  );
  const previewNodes = estimateHtmlElementCount(previewHtml);
  assert.ok(previewNodes < 32);
  assert.ok(model.fullUtf8Bytes > model.previewUtf8Bytes * 10);
  assert.ok(stored.endsWith(canonicalTail));
  assert.equal((stored.match(/VERDICT: PASS/g) || []).length, 1);
});

test('history projection + host HTML for legacy payload preserves delivery and expand/copy paths', () => {
  resetHistoryCardReportRuntimeForTests();
  const { stored } = buildLegacyStoredReport('History card legacy.', 800 * 1024);
  const delegationId = `legacy-${Math.random().toString(16).slice(2)}`;
  const historyRow = {
    seq: 42,
    rec: {
      kind: 'meta',
      variant: 'delegation',
      payload: JSON.stringify({
        id: delegationId,
        status: 'completed',
        event: 'finished',
        report: stored,
        historyDeliveredAt: '2026-10-06T12:00:00.000Z',
        reportDeliveredAt: '2026-10-06T12:00:01.000Z',
        attempts: [],
        attemptId: 'a1',
      }),
    },
  };
  const projected = projectDelegationCardsFromHistory([historyRow]);
  const card = projected.get(delegationId);
  assert.ok(card);
  assert.equal(String(card.payload?.report || ''), stored);
  assert.equal(buildDelegationCardModel(card.payload).deliveryState, 'delivered');
  const deps = {
    escapeHtml: (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;'),
    t: (key) => key,
    renderMarkdown: (source) => `<div class="sdk-md"><pre>${source.length}</pre></div>`,
  };
  const hostHtml = buildHistoryCardReportHostHtml(stored, deps);
  assert.match(hostHtml, /data-report-action="expand"/);
  assert.match(hostHtml, /data-report-action="copy"/);
  assert.match(hostHtml, /sdk-rich-delegation-report-note/);
  assert.doesNotMatch(hostHtml, /legacy-paragraph legacy-paragraph legacy-paragraph/);
});

test('rebuildAssistantTextFromHistoryEvents matches live capture for multi-message run', () => {
  const capture = createRunAssistantStreamCapture();
  const events = [
    { seq: 1, rec: { kind: 'sdk', event: assistantEvent('First reply', 'm1') } },
    { seq: 2, rec: { kind: 'sdk', event: { type: 'tool_call', name: 'Grep' } } },
    { seq: 3, rec: { kind: 'sdk', event: assistantEvent('Delta chunk', 'm2', 'delta') } },
    { seq: 4, rec: { kind: 'sdk', event: assistantEvent(' tail', 'm2', 'delta') } },
    { seq: 5, rec: { kind: 'sdk', event: assistantEvent(`Done.\n\n${CANONICAL_VERDICT}`, 'm3', 'snapshot') } },
  ];
  for (const entry of events) {
    const rec = entry.rec;
    if (rec?.kind === 'sdk' && rec.event) {
      noteRunAssistantStreamEvent(capture, rec.event);
    }
  }
  const live = readRunAssistantStreamCombinedText(capture);
  const rebuilt = rebuildAssistantTextFromHistoryEvents(createRunAssistantStreamCapture(), events);
  assert.equal(rebuilt, live);
  assert.equal((rebuilt.match(/VERDICT: PASS/g) || []).length, 1);
});

console.log('delegation-report-e2e-legacy-payload.test.js OK');
