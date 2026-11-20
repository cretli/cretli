import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseVoiceSessionLog } from '../lib/voice/voice-session-diagnose.ts';

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

test('reports p95 first-audio latency and response duration', () => {
  const inputSession = {
    sessionId: 'diag-response-timing',
    startedAt: 1000,
    endedAt: 13000,
    entries: [
      { ts: 1000, event: 'session.start' },
      { ts: 1500, event: 'response.first_audio', provider: 'openai', responseId: 'resp_1', latencyMs: 300 },
      { ts: 3000, event: 'response.end', provider: 'openai', responseId: 'resp_1', durationMs: 1500 },
      { ts: 4500, event: 'response.first_audio', provider: 'openai', responseId: 'resp_2', latencyMs: 700 },
      { ts: 6000, event: 'response.end', provider: 'openai', responseId: 'resp_2', durationMs: 1500 },
      { ts: 8000, event: 'response.first_audio', provider: 'gemini', latencyMs: 900 },
      { ts: 9500, event: 'response.end', provider: 'gemini', durationMs: 1500 },
      { ts: 10000, event: 'response.first_audio', provider: 'openai', responseId: 'resp_3', latencyMs: 2000 },
      { ts: 12000, event: 'response.end', provider: 'openai', responseId: 'resp_3', durationMs: 2000 },
    ],
  };
  const actual = diagnoseVoiceSessionLog(inputSession);

  assert.equal(actual.responseTiming.responses, 4);
  assert.deepEqual(actual.responseTiming.firstAudio, { count: 4, p50Ms: 700, p95Ms: 2000 });
  assert.deepEqual(actual.responseTiming.end, { count: 4, p50Ms: 1500, p95Ms: 2000 });
  // Existing fields are still reported.
  assert.equal(actual.durationMs, 12000);
  assert.equal(actual.userTurns, 0);
  assert.equal(actual.largestGapMs, 0);
});

test('ignores malformed response timing samples', () => {
  const actual = diagnoseVoiceSessionLog({
    sessionId: 'diag-malformed',
    startedAt: 1000,
    endedAt: 5000,
    entries: [
      { ts: 1100, event: 'response.first_audio', provider: 'openai', responseId: 'resp_1', latencyMs: 'slow' },
      { ts: 1200, event: 'response.first_audio', provider: 'openai', responseId: 'resp_2', latencyMs: -5 },
      { ts: 1300, event: 'response.first_audio', provider: 'gemini', latencyMs: 250 },
      { ts: 1400, event: 'response.end', provider: 'openai', responseId: 'resp_1', durationMs: undefined },
      { ts: 1500, event: 'response.end', provider: 'gemini', durationMs: 800 },
    ],
  });

  assert.deepEqual(actual.responseTiming.firstAudio, { count: 1, p50Ms: 250, p95Ms: 250 });
  assert.deepEqual(actual.responseTiming.end, { count: 1, p50Ms: 800, p95Ms: 800 });
  assert.equal(actual.responseTiming.responses, 1);
});

test('reports empty response timing for a session without responses', () => {
  const actual = diagnoseVoiceSessionLog({
    sessionId: 'diag-empty',
    startedAt: 100,
    endedAt: 200,
    entries: [],
  });

  assert.deepEqual(actual.responseTiming, {
    responses: 0,
    firstAudio: { count: 0, p50Ms: null, p95Ms: null },
    end: { count: 0, p50Ms: null, p95Ms: null },
  });
  assert.equal(actual.durationMs, 100);
  assert.deepEqual(actual.toolCalls, []);
  assert.deepEqual(actual.gaps, []);
  assert.equal(actual.largestGapMs, 0);
  assert.equal(actual.userTurns, 0);
});
