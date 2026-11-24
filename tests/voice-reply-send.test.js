/**
 * Send flow in the `agent` read mode: the voice-reply marker travels in `text`
 * (never in `displayText`), only on the SDK/harness WebSocket path, and the
 * live `voiceReply` socket frame reaches the speaker without making a card.
 */
import './helpers/isolated-data-dir.js';
import './helpers/stub-style-imports.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.WebSocket = { OPEN: 1 };
globalThis.window = Object.assign(globalThis.window || {}, { dispatchEvent() {}, addEventListener() {}, location: { search: '', href: 'http://localhost/' } });
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };

const { registerChatHost } = await import('../app_front/features/chat/services/chatHost.js');
registerChatHost({
  processAgentOutput() {},
  recordChatActivity() {},
  writeChatDraft() {},
  ensureChatConnection() {},
  SEND_ENTER_DELAY_MS: 0,
  ENTER_FOCUS_DELAY_MS: 0,
});
const { createChatSendHandlers } = await import('../app_front/features/chat/services/chatSendHandlers.js');
const { createChatSpeaker, getChatSpeaker, setChatSpeakerForTests } = await import('../app_front/features/voice/chatSpeaker.js');
const { buildVoiceReplyMarker } = await import('../app_front/features/voice/voiceReplyMarker.js');
const { applyLiveServerHistoryCards } = await import('../app_front/features/chat/chatHistoryViewApply.js');
const { createSocketMessageHandler } = await import('../app_front/features/chat/transport/socketMessages.js');
const { chatRuntime } = await import('../app_front/features/chat/state/chatRuntimeState.js');

// Defined after the imports: lit-html probes `document` at load time.
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };

function makeChat(transport = 'sdk') {
  const sent = [];
  const chat = {
    id: 'chat-send',
    agentTransport: transport,
    sdkMode: 'agent',
    _sdkSteerSupported: true,
    ws: { readyState: 1, send: (data) => sent.push(JSON.parse(data)) },
    focusDelayMs: 0,
  };
  return { chat, sent };
}
const setMode = (mode) => localStorage.setItem('cretli-voice-read-mode', mode);

// Agent mode on the SDK transport: marker in text, not in displayText.
{
  setMode('agent');
  const { chat, sent } = makeChat();
  createChatSendHandlers(chat).chatOnSend('Fix the bug', { rawText: 'Fix the bug' });
  const frame = sent.find((f) => f.type === 'send');
  assert.ok(frame, JSON.stringify(sent));
  const turn = /turn=([A-Za-z0-9_-]{1,64})/.exec(frame.text)?.[1];
  assert.ok(turn, frame.text);
  assert.equal(frame.text, `Fix the bug\n\n${buildVoiceReplyMarker(turn)}`);
  assert.equal(frame.displayText, 'Fix the bug');
  assert.ok(!frame.displayText.includes('voice-reply'));
  assert.equal(frame.skillMentions, undefined, 'skill mentions are not regressed');
}

// Steer frame carries both fields too. A busy chat queues by default; steering is the
// explicit send-menu choice (chatComposer.js), so the test asks for it.
{
  setMode('agent');
  const { chat, sent } = makeChat();
  chat._sdkServerBusy = true;
  createChatSendHandlers(chat).chatOnSend('Also this', { rawText: 'Also this', steer: true });
  const frame = sent.find((f) => f.type === 'steer');
  assert.ok(frame && frame.text.includes("[voice-reply mode, turn=") && frame.displayText === "Also this", JSON.stringify(sent));
}

// Page selection only: displayText is explicit (never empty), without the marker.
{
  setMode('agent');
  const { chat, sent } = makeChat();
  createChatSendHandlers(chat).chatOnSend('', {
    rawText: '',
    pageSelectionContext: { text: 'Selected text', url: 'https://example.com/x' },
  });
  const frame = sent.find((f) => f.type === 'send');
  assert.ok(frame, JSON.stringify(sent));
  assert.ok(frame.text.includes('[voice-reply mode, turn='));
  assert.ok(frame.displayText && !frame.displayText.includes('voice-reply'), frame.displayText);
  assert.strictEqual(frame.skillMentions, false, 'page selection sends skillMentions=false');
}

// Other modes: text identical to the user's, no marker.
for (const mode of ['off', 'final', 'stream']) {
  setMode(mode);
  const { chat, sent } = makeChat();
  createChatSendHandlers(chat).chatOnSend('Plain', { rawText: 'Plain' });
  const frame = sent.find((f) => f.type === 'send');
  assert.equal(frame.text, 'Plain');
}

// Title prompt and PTY transport: no marker.
{
  setMode('agent');
  const { chat, sent } = makeChat();
  createChatSendHandlers(chat).chatOnSend('Reply with a single line of JSON {"title":"x"}', {
    rawText: 'Reply with a single line of JSON {"title":"x"}',
  });
  assert.ok(!sent.some((f) => String(f.text || '').includes('voice-reply')));
  const pty = makeChat('');
  delete pty.chat.agentTransport;
  createChatSendHandlers(pty.chat).chatOnSend('Hi', { rawText: 'Hi' });
  assert.ok(pty.sent.length > 0 && !pty.sent.some((f) => String(f.data || f.text || '').includes('voice-reply')));
}

// Integration: marker -> issued turn -> live socket frame -> speaker, no manual handleVoiceReply.
{
  setMode('agent');
  chatRuntime.chatModelSelectApi = { refreshModelSelectLabels() {} };
  const speaker = getChatSpeaker();
  const { chat, sent } = makeChat();
  const appended = [];
  chat._sdkRichView = { appendHistoryRecords: async (records) => { appended.push(...records); }, appendUserPrompt() {}, queuedCount: 0 };
  chatRuntime.activeChatId = chat.id;
  createChatSendHandlers(chat).chatOnSend('Do it', { rawText: 'Do it' });
  const turn = /turn=([A-Za-z0-9_-]+)/.exec(sent.find((f) => f.type === 'send').text)[1];

  const received = [];
  const original = speaker.handleVoiceReply;
  speaker.handleVoiceReply = (chatId, reply) => { received.push({ chatId, reply }); return original.call(speaker, chatId, reply); };
  const logged = [];
  const handler = createSocketMessageHandler(chat, {}, { appLogger: { log: (...args) => logged.push(args) } });
  const frame = (record) => ({ data: JSON.stringify({ type: 'sdkHistoryChanged', records: [record] }) });
  const voiceRecord = (payload) => ({ kind: 'meta', variant: 'voiceReply', payload: JSON.stringify(payload), historySeq: 5 });

  // During hydration the frame is buffered, not spoken.
  chat._sdkHistoryHydrating = true;
  handler(frame(voiceRecord({ text: 'Buffered.', turn })));
  assert.equal(received.length, 0);
  assert.deepEqual(logged, [], JSON.stringify(logged));
  assert.equal(chat._sdkPendingRoomEvents.length, 1);
  // The buffered frame re-enters the same path after hydration.
  chat._sdkHistoryHydrating = false;
  const buffered = chat._sdkPendingRoomEvents.splice(0);
  for (const message of buffered) handler({ parsed: message });
  assert.deepEqual(logged, [], JSON.stringify(logged));
  assert.deepEqual(received, [{ chatId: chat.id, reply: { text: 'Buffered.', turn } }]);

  // A live frame also reaches the speaker; it never becomes a card.
  handler(frame(voiceRecord({ text: 'Live.', turn: 'unknown-turn' })));
  assert.equal(received.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(appended, [], 'a voiceReply record renders no card');

  // Positive control: other server-authored records still go to the view.
  handler(frame({ kind: 'meta', variant: 'relatedChat', payload: '{}', historySeq: 6 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(appended.length, 1);

  // Inactive chat: nothing is handed over.
  chatRuntime.activeChatId = 'someone-else';
  handler(frame(voiceRecord({ text: 'Background.', turn })));
  assert.equal(received.length, 2);
  speaker.handleVoiceReply = original;
}

// End to end: the MCP tool writes the record, the history broadcast frame feeds the
// socket handler, and the speaker reads it (no manual handleVoiceReply call).
{
  setMode('agent');
  const { addChat } = await import('../lib/persist/chats-legacy-store.js');
  const { subscribeChatHistoryUpdates } = await import('../lib/sdk/sdk-history-updates.ts');
  const { VOICE_MCP_TOOLS } = await import('../lib/mcp/builtin/voice-tools.js');
  const record = addChat({ title: 'voice e2e' });
  const { chat, sent } = makeChat();
  chat.id = record.id;
  chat._sdkRichView = { appendHistoryRecords: async () => {}, appendUserPrompt() {}, queuedCount: 0 };
  chatRuntime.activeChatId = chat.id;
  const logged = [];
  const handler = createSocketMessageHandler(chat, {}, { appLogger: { log: (...args) => logged.push(args) } });
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: (data) => handler({ data }) });
  subscribeChatHistoryUpdates(chat.id, socket);

  const spoken = [];
  setChatSpeakerForTests(createChatSpeaker({
    queue: { enqueue: (text) => spoken.push(text), cancel() {}, isBusy: () => false },
  }));
  const speaker = getChatSpeaker();
  createChatSendHandlers(chat).chatOnSend('Ship it', { rawText: 'Ship it' });
  const turn = /turn=([A-Za-z0-9_-]+)/.exec(sent.find((f) => f.type === 'send').text)[1];
  const result = await VOICE_MCP_TOOLS[0].handler({ text: 'Shipped. Anything else?', turn }, { session: { chatId: chat.id } });
  assert.equal(result.isError, false);
  assert.deepEqual(logged, []);
  assert.deepEqual(spoken, [], 'the reply waits for the end of the run');
  speaker.endAnswer(chat.id);
  assert.deepEqual(spoken, ['Shipped. Anything else?']);
  setChatSpeakerForTests(null);
}

console.log('voice-reply-send: ok');
