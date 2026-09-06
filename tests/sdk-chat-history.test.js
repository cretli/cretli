import assert from 'node:assert/strict';
import {
  extractSdkMessageText,
  formatSdkAgentMessagesToBuffer,
  splitSdkFormattedConversation,
} from '../lib/sdk/sdk-chat-history.js';
import {
  cloneSerializableSdkEvent,
  isValidSdkHistoryRecord,
  sdkHistoryRecordsFromAgentMessageRows,
} from '../app_front/lib/sdk-chat-history-store.js';
import {
  appendChatHistoryEvents,
  deleteChatHistory,
  getChatHistoryPage,
} from '../lib/persist/chat-history-persist.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

// --- extractSdkMessageText ---

runCase('extractSdkMessageText: null/empty', () => {
  assert.equal(extractSdkMessageText(null), '');
  assert.equal(extractSdkMessageText(undefined), '');
});

runCase('extractSdkMessageText: plain string', () => {
  assert.equal(extractSdkMessageText('hello'), 'hello');
});

runCase('extractSdkMessageText: { text }', () => {
  assert.equal(extractSdkMessageText({ text: 'x' }), 'x');
});

runCase('extractSdkMessageText: content[] parts', () => {
  assert.equal(
    extractSdkMessageText({ content: ['a', { text: 'b' }, { type: 'text', text: 'c' }] }),
    'a\nb\nc'
  );
});

runCase('extractSdkMessageText: parts[]', () => {
  assert.equal(extractSdkMessageText({ parts: [{ text: 'p' }] }), 'p');
});

// --- formatSdkAgentMessagesToBuffer ---

runCase('formatSdkAgentMessagesToBuffer: empty / non-array', () => {
  assert.equal(formatSdkAgentMessagesToBuffer([]), '');
  assert.equal(formatSdkAgentMessagesToBuffer(/** @type {any} */ (null)), '');
});

runCase('formatSdkAgentMessagesToBuffer: user and assistant', () => {
  const buf = formatSdkAgentMessagesToBuffer([
    { type: 'user', message: 'Hi' },
    { type: 'assistant', message: 'Hello' },
  ]);
  assert.ok(buf.includes('> Hi'));
  assert.ok(buf.includes('Hello'));
});

// --- splitSdkFormattedConversation (round-trip z formatSdkAgentMessagesToBuffer) ---

runCase('splitSdkFormattedConversation: round-trip', () => {
  const buf = formatSdkAgentMessagesToBuffer([
    { type: 'user', message: 'Q' },
    { type: 'assistant', message: 'A' },
  ]);
  const segs = splitSdkFormattedConversation(buf);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].role, 'user');
  assert.equal(segs[0].text, 'Q');
  assert.equal(segs[1].role, 'assistant');
  assert.equal(segs[1].text.trim(), 'A');
});

runCase('splitSdkFormattedConversation: empty / whitespace', () => {
  assert.deepEqual(splitSdkFormattedConversation(''), []);
  assert.deepEqual(splitSdkFormattedConversation('   \n'), []);
});

runCase('splitSdkFormattedConversation: [user] tag', () => {
  const segs = splitSdkFormattedConversation('[user] tagged\nassistant reply');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].role, 'user');
  assert.equal(segs[0].text, 'tagged');
  assert.equal(segs[1].role, 'assistant');
});

// --- isValidSdkHistoryRecord ---

runCase('isValidSdkHistoryRecord: sdk + event object', () => {
  assert.equal(isValidSdkHistoryRecord({ kind: 'sdk', event: { type: 'user' } }), true);
  assert.equal(
    isValidSdkHistoryRecord({
      kind: 'sdk',
      event: { type: 'user' },
      createdAt: '2026-07-11T09:51:00.000Z',
    }),
    true
  );
  assert.equal(
    isValidSdkHistoryRecord({ kind: 'sdk', event: { type: 'user' }, createdAt: 123 }),
    false
  );
});

runCase('isValidSdkHistoryRecord: localUser', () => {
  assert.equal(isValidSdkHistoryRecord({ kind: 'localUser', text: 'x' }), true);
  assert.equal(isValidSdkHistoryRecord({ kind: 'localUser', text: 1 }), false);
});

runCase('isValidSdkHistoryRecord: meta variants', () => {
  assert.equal(isValidSdkHistoryRecord({ kind: 'meta', variant: 'banner', payload: 'p' }), true);
  assert.equal(isValidSdkHistoryRecord({ kind: 'meta', variant: 'mode', payload: 'agent' }), true);
  assert.equal(
    isValidSdkHistoryRecord({ kind: 'meta', variant: 'queueRemoved', payload: 'prompt' }),
    true
  );
  assert.equal(
    isValidSdkHistoryRecord({ kind: 'meta', variant: 'contextSeed', payload: 'summary' }),
    true
  );
  assert.equal(
    isValidSdkHistoryRecord({ kind: 'meta', variant: 'delegation', payload: '{}' }),
    true
  );
  assert.equal(
    isValidSdkHistoryRecord({ kind: 'meta', variant: 'mailbox', payload: '{}' }),
    true
  );
  assert.equal(
    isValidSdkHistoryRecord({ kind: 'meta', variant: 'relatedChat', payload: '{}' }),
    true
  );
  assert.equal(isValidSdkHistoryRecord({ kind: 'meta', variant: 'bad' }), false);
});

runCase('isValidSdkHistoryRecord: rejects invalid', () => {
  assert.equal(isValidSdkHistoryRecord(null), false);
  assert.equal(isValidSdkHistoryRecord({ kind: 'sdk' }), false);
});

// --- cloneSerializableSdkEvent ---

runCase('cloneSerializableSdkEvent: deep clone', () => {
  const ev = { type: 'assistant', nested: { a: 1 } };
  const c = cloneSerializableSdkEvent(ev);
  assert.notStrictEqual(c, ev);
  assert.deepEqual(c, ev);
  if (!c) throw new Error('expected clone');
  c.nested.a = 2;
  assert.equal(ev.nested.a, 1);
});

runCase('cloneSerializableSdkEvent: non-object', () => {
  assert.equal(cloneSerializableSdkEvent(null), null);
});

// --- sdkHistoryRecordsFromAgentMessageRows ---

runCase('sdkHistoryRecordsFromAgentMessageRows: filters types', () => {
  const rows = [
    { type: 'user', id: '1' },
    { type: 'unknown_skip', foo: 'bar' },
    { type: 'assistant', id: '2' },
  ];
  const out = sdkHistoryRecordsFromAgentMessageRows(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'sdk');
  assert.equal(out[0].event.type, 'user');
  assert.equal(out[1].event.type, 'assistant');
});

runCase('sdkHistoryRecordsFromAgentMessageRows: empty', () => {
  assert.deepEqual(sdkHistoryRecordsFromAgentMessageRows([]), []);
  assert.deepEqual(sdkHistoryRecordsFromAgentMessageRows(/** @type {any} */ (undefined)), []);
});

runCase('sdkHistoryRecordsFromAgentMessageRows: tool call_id from toolCallId', () => {
  const inputRows = [
    {
      message: {
        agentConversationTurn: {
          steps: [
            {
              toolCall: {
                readToolCall: {
                  toolCallId: 'call-abc',
                  args: { path: '/tmp/a.js' },
                  result: { content: 'ok' },
                },
              },
            },
          ],
        },
      },
    },
  ];
  const actualRecords = sdkHistoryRecordsFromAgentMessageRows(inputRows);
  assert.equal(actualRecords.length, 1);
  assert.equal(actualRecords[0].event.type, 'tool_call');
  assert.equal(actualRecords[0].event.call_id, 'call-abc');
  assert.equal(actualRecords[0].event.status, 'completed');
});

// --- getChatHistoryPage (backwards window pagination) ---

const pageChatId = 'chat-history-page-test';

function seedPageHistory(count) {
  deleteChatHistory(pageChatId);
  appendChatHistoryEvents(
    pageChatId,
    'session-page',
    Array.from({ length: count }, (_, index) => ({
      rec: { kind: 'localUser', text: `msg-${index + 1}` },
    })),
  );
}

runCase('getChatHistoryPage: missing chat', () => {
  deleteChatHistory(pageChatId);
  const actual = getChatHistoryPage(pageChatId, { limit: 10 });
  assert.equal(actual.ok, true);
  assert.deepEqual(actual.events, []);
  assert.equal(actual.headSeq, 0);
  assert.equal(actual.oldestSeq, 0);
  assert.equal(actual.hasOlder, false);
});

runCase('getChatHistoryPage: returns the newest window', () => {
  seedPageHistory(10);
  const actual = getChatHistoryPage(pageChatId, { limit: 4 });
  assert.equal(actual.events.length, 4);
  assert.equal(actual.events[0].seq, 7);
  assert.equal(actual.events[3].seq, 10);
  assert.equal(actual.headSeq, 10);
  assert.equal(actual.oldestSeq, 1);
  assert.equal(actual.hasOlder, true);
});

runCase('getChatHistoryPage: pages backwards from before', () => {
  seedPageHistory(10);
  const actual = getChatHistoryPage(pageChatId, { limit: 4, beforeSeq: 7 });
  assert.equal(actual.events.length, 4);
  assert.equal(actual.events[0].seq, 3);
  assert.equal(actual.events[3].seq, 6);
  assert.equal(actual.hasOlder, true);
});

runCase('getChatHistoryPage: hasOlder false on the last page', () => {
  seedPageHistory(10);
  const actual = getChatHistoryPage(pageChatId, { limit: 4, beforeSeq: 3 });
  assert.equal(actual.events.length, 2);
  assert.equal(actual.events[0].seq, 1);
  assert.equal(actual.hasOlder, false);
});

runCase('getChatHistoryPage: window larger than the log', () => {
  seedPageHistory(3);
  const actual = getChatHistoryPage(pageChatId, { limit: 80 });
  assert.equal(actual.events.length, 3);
  assert.equal(actual.hasOlder, false);
  deleteChatHistory(pageChatId);
});

if (failed > 0) {
  console.error(`\nSDK chat history tests failed: ${failed}`);
  process.exit(1);
}

console.log('\nAll SDK chat history tests passed.');
