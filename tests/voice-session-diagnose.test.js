import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseVoiceSessionLog } from '../lib/voice/voice-session-diagnose.js';

test('measures the wait from user speech to the next tool, not the tool itself', () => {
  const inputSession = {
    sessionId: 'bcf9c90e-4681-4f90-a518-26bf27e4c393',
    startedAt: 1000,
    endedAt: 92000,
    entries: [
      { ts: 16000, event: 'transcript', role: 'user', text: 'Zmień model na Grok 4.6.' },
      { ts: 16800, event: 'transcript', role: 'assistant', text: 'Zweryfikuję dostępne modele.' },
      { ts: 37000, event: 'tool.start', name: 'list_models' },
      { ts: 37002, event: 'tool.call', name: 'list_models', ok: true, durationMs: 2, resultBytes: 12000, modelCount: 80 },
      { ts: 38000, event: 'transcript', role: 'user', text: 'Nic nie zrobiłeś.' },
      { ts: 67000, event: 'tool.start', name: 'set_model' },
      { ts: 67038, event: 'tool.call', name: 'set_model', ok: true, durationMs: 38, resultBytes: 60 },
    ],
  };
  const actual = diagnoseVoiceSessionLog(inputSession);
  assert.equal(actual.sessionId, inputSession.sessionId);
  assert.equal(actual.durationMs, 91000);
  assert.equal(actual.userTurns, 2);
  assert.equal(actual.toolCalls[0].durationMs, 2);
  assert.equal(actual.toolCalls[1].durationMs, 38);
  const listGap = actual.gaps.find((gap) => gap.to === 'tool.start:list_models' && gap.from.startsWith('user:'));
  assert.ok(listGap);
  assert.equal(listGap.gapMs, 21000);
  assert.ok(actual.largestGapMs >= 21000);
});

test('computes p95 latency from user turns to tool, first audio and response end', () => {
  const inputEntries = [];
  for (let i = 0; i < 20; i += 1) {
    const base = 1000 + i * 10000;
    inputEntries.push({ ts: base, event: 'transcript', role: 'user', text: `u${i}` });
    inputEntries.push({ ts: base + 100 + i, event: 'tool.start', name: 'get_cost' });
    inputEntries.push({ ts: base + 110 + i, event: 'tool.call', name: 'get_cost', ok: true, durationMs: 1 });
    inputEntries.push({ ts: base + 300 + i, event: 'response.first_audio' });
    inputEntries.push({ ts: base + 301 + i, event: 'response.first_audio' });
    inputEntries.push({ ts: base + 900 + i, event: 'response.end' });
  }
  const actual = diagnoseVoiceSessionLog({ sessionId: 's', entries: inputEntries });
  assert.equal(actual.latency.userToToolStart.count, 20);
  assert.equal(actual.latency.userToToolStart.p95, 118);
  assert.equal(actual.latency.userToToolResult.p95, 128);
  assert.equal(actual.latency.userToFirstAudio.count, 20);
  assert.equal(actual.latency.userToFirstAudio.p95, 318);
  assert.equal(actual.latency.userToResponseEnd.p50, 909);
});

test('latency summaries are empty when the log has no timing events', () => {
  const actual = diagnoseVoiceSessionLog({ sessionId: 's', entries: [] });
  assert.deepEqual(actual.latency.userToFirstAudio, { count: 0, p50: null, p95: null });
});
