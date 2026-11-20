/**
 * `voice_reply` over the REAL SQLite chat-history adapter (worker host + store):
 * the record is persisted and exactly one broadcast frame is sent per write.
 */
import './helpers/isolated-data-dir.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { bootParts, chatIdOf, makeRoot } from './fixtures/storage-history-adapter-harness.js';
import { VOICE_MCP_TOOLS, setVoiceToolsDeps } from '../lib/mcp/builtin/voice-tools.js';
import { subscribeChatHistoryUpdates } from '../lib/sdk/sdk-history-updates.ts';
import { isValidSdkHistoryRecord } from '../lib/persist/chat-history-validate.js';

let root;
let parts;
beforeEach(async () => {
  root = makeRoot('cretli-voice-reply-sqlite-');
  parts = await bootParts({ root });
});
afterEach(async () => {
  setVoiceToolsDeps(null);
  await parts?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('voice_reply on the SQLite history adapter', () => {
  it('persists a valid voiceReply record and broadcasts one frame per write', async () => {
    assert.equal(parts.adapter.backendKind, 'sqlite');
    setVoiceToolsDeps({ append: (chatId, cursor, items, options) => parts.adapter.appendChatHistoryEvents(chatId, cursor, items, options) });
    const chat = chatIdOf(7);
    const socket = Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(data) { this.sent.push(JSON.parse(data)); } });
    subscribeChatHistoryUpdates(chat, socket);

    for (const [index, turn] of ['t-one', 't-two'].entries()) {
      const res = await VOICE_MCP_TOOLS[0].handler({ text: `Reply ${index}.`, turn }, { session: { chatId: chat } });
      assert.equal(res.isError, false, JSON.stringify(res.content));
      assert.equal(socket.sent.length, index + 1, 'exactly one frame per write');
      assert.equal(socket.sent[index].type, 'sdkHistoryChanged');
      assert.equal(socket.sent[index].records.length, 1);
      assert.equal(socket.sent[index].records[0].variant, 'voiceReply');
    }
    const doc = await parts.adapter.loadChatHistory(chat);
    const stored = doc.events.filter((row) => row.rec.variant === 'voiceReply');
    assert.equal(stored.length, 2);
    assert.equal(isValidSdkHistoryRecord(stored[0].rec), true);
    assert.deepEqual(JSON.parse(stored[1].rec.payload), { text: 'Reply 1.', turn: 't-two' });
  });
});
