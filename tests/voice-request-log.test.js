import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendVoiceRequestLog, listVoiceRequestLogs } from '../lib/voice/voice-request-log.js';

test('stores recent voice HTTP timings newest first', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-voice-http-'));
  appendVoiceRequestLog(dataDir, {
    ts: 10,
    route: '/api/voice/realtime-token',
    status: 200,
    durationMs: 420,
    sessionId: '11111111-1111-4111-8111-111111111111',
    model: 'gpt-realtime-mini',
  });
  appendVoiceRequestLog(dataDir, {
    ts: 20,
    route: '/api/voice/gemini-live-token',
    status: 503,
    durationMs: 8,
    error: 'missing key',
  });
  const actual = listVoiceRequestLogs(dataDir, 10);
  assert.equal(actual.length, 2);
  assert.equal(actual[0].route, '/api/voice/gemini-live-token');
  assert.equal(actual[0].status, 503);
  assert.equal(actual[1].durationMs, 420);
});
