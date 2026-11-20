/**
 * `voice_reply` MCP tool: validation, cleaning, history record, one broadcast
 * frame per write, Plan/Ask/Scout access, and the live-delivery path to the speaker.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import {
  VOICE_MCP_TOOLS,
  VOICE_REPLY_MAX_CHARS,
  cleanVoiceReplyText,
  setVoiceToolsDeps,
} from '../lib/mcp/builtin/voice-tools.js';
import { MCP_PLAN_MODE_OPEN_TOOLS } from '../lib/mcp/mcp-tool-names.js';
import { isValidSdkHistoryRecord } from '../lib/persist/chat-history-validate.js';
import { subscribeChatHistoryUpdates } from '../lib/sdk/sdk-history-updates.ts';
import { toSpeakableText } from '../lib/voice/speakable-text.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-service.js';
import { isServerAuthoredHistoryMeta } from '../app_front/features/chat/sdkEventReplayGuard.js';
import { toSpeakableText as frontToSpeakableText } from '../app_front/features/voice/speakableText.js';
import { parseVoiceReplyPayload } from '../app_front/features/voice/voiceReplyMarker.js';

const tool = VOICE_MCP_TOOLS[0];
const call = (args, chatId = 'chat-v') => tool.handler(args, { session: { chatId } });
const code = (promise) => promise.then(() => '', (err) => err.code);

// Registered, strict schema, open by name in every mode.
assert.ok(CRETILI_MCP_TOOL_DEFS.some((def) => def.name === 'voice_reply'));
assert.equal(tool.inputSchema.additionalProperties, false);
assert.deepEqual(tool.inputSchema.required, ['text']);
assert.ok(MCP_PLAN_MODE_OPEN_TOOLS.includes('voice_reply'));

// Cleaning: markdown, code, URLs gone; shared with the browser.
const noisy = '## Done\n\nFixed **the bug** in `a.js`. See [docs](https://example.com/x) and https://example.com.\n\n```js\nconst x = 1;\n```\n\nShould I merge it?';
const cleaned = cleanVoiceReplyText(noisy);
assert.ok(!/[*#`]|https?:|const x/.test(cleaned), cleaned);
assert.ok(cleaned.includes('Fixed the bug') && cleaned.includes('See docs') && cleaned.endsWith('Should I merge it?'), cleaned);
// Parity: the server cleaning is the browser's toSpeakableText (one shared module).
for (const sample of [noisy, '- a\n- b\n> quote', 'Plain sentence.', '| t | b |\n| - | - |\ntext']) {
  assert.equal(frontToSpeakableText(sample), toSpeakableText(sample));
}

// Limit: cut at a sentence boundary.
const longText = `${'Short one. '.repeat(80)}`;
const clipped = cleanVoiceReplyText(longText);
assert.ok(clipped.length <= VOICE_REPLY_MAX_CHARS);
assert.ok(clipped.endsWith('.'), clipped.slice(-20));
assert.ok(cleanVoiceReplyText(`${'word '.repeat(200)}`).length <= VOICE_REPLY_MAX_CHARS);

// Validation.
assert.equal(await code(call({ text: '' })), 'VALIDATION_ERROR');
assert.equal(await code(call({ text: '   ' })), 'VALIDATION_ERROR');
assert.equal(await code(call({ text: '```code```' })), 'VALIDATION_ERROR');
assert.equal(await code(call({ text: 'Hi.', turn: 'bad turn!' })), 'VALIDATION_ERROR');
assert.equal(await code(call({ text: 'Hi.', turn: 'x'.repeat(65) })), 'VALIDATION_ERROR');
// F6: a provided but empty turn is invalid; an absent one is fine.
assert.equal(await code(call({ text: 'Hi.', turn: '' })), 'VALIDATION_ERROR');
assert.equal(await code(call({ text: 'Hi.', turn: '   ' })), 'VALIDATION_ERROR');
assert.equal(tool.inputSchema.properties.turn.minLength, 1);
assert.equal(tool.inputSchema.properties.turn.maxLength, 64);
assert.equal(new RegExp(tool.inputSchema.properties.turn.pattern).test(''), false);
assert.equal(new RegExp(tool.inputSchema.properties.turn.pattern).test('ok_turn-1'), true);
assert.equal(await code(tool.handler({ text: 'Hi.' }, { session: {} })), 'VALIDATION_ERROR');

// Write + exactly one frame per write (stub backend shaped like the SQLite adapter).
{
  const frames = [];
  const appends = [];
  setVoiceToolsDeps({
    append: async (chatId, cursor, items) => {
      appends.push({ chatId, items });
      return { ok: true, appended: items.map((item, i) => ({ seq: 7 + i, rec: item.rec })), identity: { chatEpoch: 'e1' } };
    },
    broadcast: (chatId, appended, identity) => frames.push({ chatId, appended, identity }),
  });
  const res = await call({ text: 'All done. Merge?', turn: 'v1_a-B' });
  assert.equal(res.isError, false);
  assert.equal(appends.length, 1);
  assert.equal(frames.length, 1);
  const rec = appends[0].items[0].rec;
  assert.equal(rec.kind, 'meta');
  assert.equal(rec.variant, 'voiceReply');
  assert.deepEqual(JSON.parse(rec.payload), { text: 'All done. Merge?', turn: 'v1_a-B' });
  assert.equal(isValidSdkHistoryRecord(rec), true);
  assert.equal(isServerAuthoredHistoryMeta(rec), true);
  assert.deepEqual(parseVoiceReplyPayload(rec.payload), { text: 'All done. Merge?', turn: 'v1_a-B' });

  // A failed write broadcasts nothing and reports an error.
  setVoiceToolsDeps({ append: async () => ({ ok: false }), broadcast: () => frames.push('bad') });
  assert.equal(await code(call({ text: 'Hi.' })), 'HARNESS_UNAVAILABLE');
  assert.equal(frames.length, 1);
}

// Real (default) history backend: one persisted record and one frame.
{
  setVoiceToolsDeps(null);
  const chat = addChat({ title: 'voice' });
  const socket = Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } });
  subscribeChatHistoryUpdates(chat.id, socket);
  const res = await call({ text: 'Spoken summary.', turn: 'abc123' }, chat.id);
  assert.equal(res.isError, false, JSON.stringify(res.content));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, 'sdkHistoryChanged');
  assert.equal(socket.sent[0].records.length, 1);
  assert.equal(socket.sent[0].records[0].variant, 'voiceReply');
  const stored = (await loadChatHistory(chat.id)).events.filter((row) => row.rec.variant === 'voiceReply');
  assert.equal(stored.length, 1);
}

// Plan / Ask / Scout: callable through the gate by name.
for (const mode of ['plan', 'ask', 'agent']) {
  setVoiceToolsDeps({
    append: async (chatId, c, items) => ({ ok: true, appended: items.map((item) => ({ seq: 1, rec: item.rec })) }),
    broadcast: () => {},
  });
  const handlers = createCretliMcpToolHandlers(null, { chatId: 'chat-v', mode });
  const res = await handlers.voice_reply({ text: 'Hi there.' });
  assert.notEqual(res.isError, true, `${mode}: ${JSON.stringify(res.content)}`);
}
{
  const scoutClient = { isWorkspaceScoutChat: async () => true };
  const handlers = createCretliMcpToolHandlers(scoutClient, { chatId: 'chat-v', mode: 'plan' });
  const res = await handlers.voice_reply({ text: 'Hi there.' });
  assert.notEqual(res.isError, true, `scout: ${JSON.stringify(res.content)}`);
}
setVoiceToolsDeps(null);

import { getChatHistoryBackendKind } from '../lib/persist/chat-history-service.js';
console.log('voice-reply-tool: ok', getChatHistoryBackendKind());
