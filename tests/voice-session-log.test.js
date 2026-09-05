import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  listVoiceSessionLogs,
  readVoiceSessionLog,
  upsertVoiceSessionLog,
} from '../lib/voice/voice-session-log.js';

test('stores and reads voice session debug entries', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-voice-log-'));
  const sessionId = '11111111-1111-4111-8111-111111111111';
  upsertVoiceSessionLog(dataDir, sessionId, {
    startedAt: 1000,
    provider: 'gemini',
    model: 'gemini-live',
    chatId: 'chat-1',
    entries: [{ ts: 1001, event: 'session.start' }],
  });
  upsertVoiceSessionLog(dataDir, sessionId, {
    entries: [{
      ts: 1002,
      event: 'tool.call',
      name: 'set_model',
      ok: false,
      error: 'busy',
      durationMs: 12,
      resultBytes: 80,
      args: { model: 'grok 4.6' },
    }],
  });
  const doc = readVoiceSessionLog(dataDir, sessionId);
  assert.equal(doc.sessionId, sessionId);
  assert.equal(doc.provider, 'gemini');
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.entries[1].event, 'tool.call');
  assert.equal(doc.entries[1].durationMs, 12);
  assert.equal(doc.entries[1].resultBytes, 80);
  assert.equal(doc.entries[1].args.model, 'grok 4.6');
  const listed = listVoiceSessionLogs(dataDir, 5);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].entryCount, 2);
});

test('rejects invalid session ids', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-voice-log-'));
  assert.throws(() => upsertVoiceSessionLog(dataDir, '../evil', { entries: [] }));
});
