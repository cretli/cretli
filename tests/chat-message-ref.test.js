import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatChatMessageRef,
  parseChatMessageRef,
  resolveChatMessageRefAction,
  writeChatMessageRef,
} from '../lib/chat-message-ref.js';
import { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { MCP_EVENT_TEXT_CHARS, extractAssistantText, readEventField } from '../lib/mcp/builtin/chat-history-format.js';
import { addChat } from '../lib/persist/chats-persist.js';
import {
  appendChatHistoryEvents,
  loadChatHistory,
} from '../lib/persist/chat-history-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const CHAT_ID = 'e5e3492e-2b3d-4d45-b247-ed359ed20afa';
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-chat-ref-'));

const assistantRec = {
  kind: 'sdk',
  event: {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'done from seq' }] },
  },
};
const userRec = { kind: 'localUser', text: 'hello from seq' };
const thinkingRec = { kind: 'sdk', event: { type: 'thinking', text: 'hidden thoughts' } };
const toolRec = {
  kind: 'sdk',
  event: {
    type: 'tool_call',
    name: 'bash',
    args: { command: 'ls' },
    result: 'ok',
  },
};
const sdkUserRec = {
  kind: 'sdk',
  event: {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'sdk user only' }] },
  },
};

assert.equal(formatChatMessageRef({ chatId: CHAT_ID, seq: 26 }), `cretli-ref chat=${CHAT_ID} seq=26`);
assert.equal(formatChatMessageRef({ chatId: CHAT_ID.toUpperCase(), seq: 26 }), `cretli-ref chat=${CHAT_ID} seq=26`);
assert.equal(formatChatMessageRef({ chatId: 'e5e3492e', seq: 26 }), '');
assert.equal(formatChatMessageRef({ chatId: CHAT_ID, seq: 0 }), '');
assert.equal(formatChatMessageRef({ chatId: 'Ask', seq: 26 }), '');

assert.deepEqual(parseChatMessageRef(`cretli-ref chat=${CHAT_ID} seq=26`), { chatId: CHAT_ID, seq: 26 });
assert.deepEqual(parseChatMessageRef(`  cretli-ref chat=${CHAT_ID.toUpperCase()} seq=26  `), {
  chatId: CHAT_ID,
  seq: 26,
});
assert.equal(parseChatMessageRef(`cretli-ref chat=e5e3492e seq=26`), null);
assert.equal(parseChatMessageRef(`cretli-ref chat=Ask seq=26`), null);
assert.equal(parseChatMessageRef(`cretli-ref chat=${CHAT_ID} seq=26 extra`), null);
assert.equal(parseChatMessageRef(`cretli-ref chat=${CHAT_ID} seq=0`), null);

const savedUser = resolveChatMessageRefAction({
  variant: 'user',
  historySeq: 26,
  chatId: CHAT_ID,
  forkable: true,
  passable: true,
});
assert.equal(savedUser.visible, true);
assert.equal(savedUser.enabled, true);
assert.equal(savedUser.ref, `cretli-ref chat=${CHAT_ID} seq=26`);

const unsavedUser = resolveChatMessageRefAction({ variant: 'user', historySeq: 0, chatId: CHAT_ID });
assert.equal(unsavedUser.visible, true);
assert.equal(unsavedUser.enabled, false);
assert.equal(unsavedUser.reason, 'needs_saved_history');

assert.equal(resolveChatMessageRefAction({ variant: 'thinking', historySeq: 26, chatId: CHAT_ID }).visible, false);
assert.equal(resolveChatMessageRefAction({ variant: 'plan', historySeq: 26, chatId: CHAT_ID }).visible, false);
assert.equal(resolveChatMessageRefAction({
  variant: 'user',
  historySeq: 26,
  chatId: CHAT_ID,
  queued: true,
}).visible, false);
assert.equal(resolveChatMessageRefAction({
  variant: 'assistant',
  historySeq: 26,
  chatId: CHAT_ID,
  running: true,
}).visible, false);
assert.equal(resolveChatMessageRefAction({ variant: 'user', historySeq: 26, chatId: 'not-a-uuid' }).visible, false);
assert.equal(resolveChatMessageRefAction({
  variant: 'assistant',
  historySeq: 26,
  chatId: CHAT_ID,
  canReadText: false,
}).visible, false);

const passFlags = { variant: 'user', historySeq: 12, chatId: CHAT_ID, forkable: true, passable: true };
resolveChatMessageRefAction(passFlags);
assert.equal(passFlags.forkable, true);
assert.equal(passFlags.passable, true);

assert.equal(readEventField(userRec, 'text'), 'hello from seq');
assert.equal(readEventField(assistantRec, 'text'), 'done from seq');
assert.equal(extractAssistantText(assistantRec.event), 'done from seq');
assert.equal(readEventField(thinkingRec, 'text'), '');
assert.equal(readEventField(toolRec, 'text'), '');
assert.equal(readEventField(sdkUserRec, 'text'), '');
assert.ok(readEventField(userRec, 'text').length > 0);
assert.ok(readEventField(assistantRec, 'text').length > 0);
assert.equal(readEventField(thinkingRec, 'text').length, 0);
assert.equal(readEventField(toolRec, 'text').length, 0);
assert.equal(readEventField(sdkUserRec, 'text').length, 0);

const copied = [];
const clipboardOk = await writeChatMessageRef(
  { variant: 'assistant', historySeq: 26, chatId: CHAT_ID },
  async (text) => {
    copied.push(text);
    return true;
  },
);
assert.equal(clipboardOk.ok, true);
assert.deepEqual(copied, [`cretli-ref chat=${CHAT_ID} seq=26`]);

const clipboardFail = await writeChatMessageRef(
  { variant: 'assistant', historySeq: 26, chatId: CHAT_ID },
  async () => false,
);
assert.equal(clipboardFail.ok, false);
assert.equal(clipboardFail.reason, 'clipboard');

const clipboardThrow = await writeChatMessageRef(
  { variant: 'assistant', historySeq: 26, chatId: CHAT_ID },
  async () => {
    throw new Error('denied');
  },
);
assert.equal(clipboardThrow.ok, false);
assert.equal(clipboardThrow.reason, 'clipboard');

const skippedCopy = await writeChatMessageRef(
  { variant: 'thinking', historySeq: 26, chatId: CHAT_ID },
  async () => true,
);
assert.equal(skippedCopy.ok, false);
assert.equal(skippedCopy.reason, 'hidden');

assert.equal(typeof en.sdkBlock.copyRef, 'string');
assert.equal(typeof pl.sdkBlock.copyRef, 'string');
assert.equal(typeof en.sdkBlock.copyContent, 'string');
assert.equal(typeof en.sdkBlock.forkFromHere, 'string');
assert.equal(typeof en.sdkBlock.passToChild, 'string');
assert.match(en.sdkBlock.copyRef, /ref/i);
assert.match(pl.sdkBlock.copyRef, /ref/i);

const chatEventDef = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'chat_event');
const chatShowDef = CRETILI_MCP_TOOL_DEFS.find((tool) => tool.name === 'chat_show');
assert.match(chatEventDef.description, /cretli-ref chat=<uuid> seq=<n>/);
assert.match(chatEventDef.description, /field: "text"/);
assert.match(chatEventDef.description, /NOT_FOUND/);
assert.match(chatShowDef.description, /cretli-ref chat=<uuid> seq=<n>/);
assert.match(chatShowDef.description, /chat_event/);

const chat = addChat('sess-chat-ref', 'Copy ref source', null, workspace, 'model-a', {
  agentTransport: 'sdk',
  id: CHAT_ID,
});
assert.equal(chat.id, CHAT_ID);
appendChatHistoryEvents(chat.id, 'sess-chat-ref', [{ rec: userRec }]);
appendChatHistoryEvents(chat.id, 'sess-chat-ref', [{ rec: assistantRec }]);
appendChatHistoryEvents(chat.id, 'sess-chat-ref', [{ rec: thinkingRec }]);
appendChatHistoryEvents(chat.id, 'sess-chat-ref', [{ rec: toolRec }]);

const loaded = loadChatHistory(chat.id);
assert.equal(loaded.events[0].seq, 1);
assert.equal(readEventField(loaded.events[0].rec, 'text'), 'hello from seq');
assert.equal(readEventField(loaded.events[1].rec, 'text'), 'done from seq');
assert.equal(readEventField(loaded.events[2].rec, 'text'), '');
assert.equal(readEventField(loaded.events[3].rec, 'text'), '');

const reloaded = loadChatHistory(chat.id);
assert.equal(readEventField(reloaded.events[0].rec, 'text'), 'hello from seq');
assert.equal(readEventField(reloaded.events[1].rec, 'text'), 'done from seq');

const handlers = createCretliMcpToolHandlers(
  createInProcessMcpClient({
    harness: 'sdk',
    chatId: chat.id,
    workspaceFolder: workspace,
  }),
  { chatId: chat.id, workspaceFolder: workspace, mode: 'agent' },
);

const userEvent = await handlers.chat_event({ chat: chat.id, seq: 1, field: 'text' });
assert.equal(userEvent.isError, false);
assert.match(userEvent.content[0].text, /hello from seq/);
assert.equal(parseChatMessageRef(formatChatMessageRef({ chatId: chat.id, seq: 1 })).seq, 1);

const assistantEvent = await handlers.chat_event({ chat: chat.id, seq: 2, field: 'text' });
assert.equal(assistantEvent.isError, false);
assert.match(assistantEvent.content[0].text, /done from seq/);

const missing = await handlers.chat_event({ chat: chat.id, seq: 99, field: 'text' });
assert.equal(missing.isError, true);
assert.match(missing.content[0].text, /NOT_FOUND/);

const gapChat = addChat('sess-chat-ref-gap', 'Copy ref gap', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
const historyDir = path.join(resolveDataPath('chat-history'));
fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(path.join(historyDir, `${gapChat.id}.json`), JSON.stringify({
  v: 1,
  chatId: gapChat.id,
  cursorSessionId: 'sess-chat-ref-gap',
  headSeq: 9,
  updatedAt: new Date().toISOString(),
  events: [
    { seq: 1, rec: { kind: 'localUser', text: 'g1' } },
    { seq: 5, rec: { kind: 'localUser', text: 'g5' } },
    { seq: 9, rec: { kind: 'localUser', text: 'g9' } },
  ],
}));
const gapMiss = await handlers.chat_event({ chat: gapChat.id, seq: 3, field: 'text' });
assert.equal(gapMiss.isError, true);
assert.match(gapMiss.content[0].text, /NOT_FOUND/);
assert.doesNotMatch(gapMiss.content[0].text, /g1|g5|g9/);

const longChat = addChat('sess-chat-ref-long', 'Copy ref long', null, workspace, 'model-a', {
  agentTransport: 'sdk',
});
const unicode = 'żółć 😀\nlinia';
const longText = `${'α'.repeat(1800)}${unicode}UNIQUE_REF_TAIL`;
appendChatHistoryEvents(longChat.id, 'sess-chat-ref-long', [
  { rec: { kind: 'localUser', text: longText } },
]);
let offset = 0;
let recovered = '';
for (let i = 0; i < 8; i += 1) {
  const slice = await handlers.chat_event({
    chat: longChat.id,
    seq: 1,
    field: 'text',
    offset,
    length: MCP_EVENT_TEXT_CHARS,
  });
  assert.equal(slice.isError, false);
  const fragment = String(slice.content[0].text).split('--- fragment ---\n')[1] ?? '';
  recovered += fragment;
  if (slice.structuredContent.next_offset == null) break;
  assert.ok(slice.structuredContent.next_offset > offset);
  offset = slice.structuredContent.next_offset;
}
assert.equal(recovered, longText);
assert.match(recovered, /UNIQUE_REF_TAIL/);

console.log('chat-message-ref.test.js OK');
