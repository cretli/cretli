import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createGeminiTurnTiming } from '../app_front/features/voice/geminiTurnTiming.js';
import { createVoiceResponseTimingTracker } from '../app_front/features/voice/voiceResponseTiming.js';

/**
 * Creates a tracker whose clock is advanced explicitly.
 *
 * @param {number} initialNow
 */
function createClock(initialNow) {
  const clock = { current: initialNow };
  const tracker = createVoiceResponseTimingTracker({ now: () => clock.current });
  return { clock, tracker };
}

/**
 * Mirrors the Gemini `serverContent` timing branch: the turn helper decides
 * what each frame means and the tracker records it. Returns the events the
 * session log would receive.
 *
 * @param {ReturnType<typeof createGeminiTurnTiming>} turn
 * @param {ReturnType<typeof createVoiceResponseTimingTracker>} tracker
 * @param {{ inputText?: boolean, hasModelContent?: boolean, hasAudio?: boolean, completed?: boolean }} frame
 * @returns {Array<{ phase: string, timing: object }>}
 */
function applyGeminiFrame(turn, tracker, frame) {
  const decision = turn.readFrame(frame);
  if (decision.start) {
    tracker.begin({ provider: 'gemini', userSpeechEndedAt: decision.userSpeechEndedAt });
  }
  const events = [];
  if (decision.firstAudio) {
    const timing = tracker.firstAudio();
    if (timing) events.push({ phase: 'first_audio', timing });
  }
  if (decision.end) {
    const timing = tracker.end();
    if (timing) events.push({ phase: 'end', timing });
  }
  return events;
}

test('first audio is logged once per response with latency from the response start', () => {
  const { clock, tracker } = createClock(1000);
  tracker.begin({ provider: 'openai', responseId: 'resp_1' });

  clock.current = 1120;
  const actual = tracker.firstAudio({ responseId: 'resp_1' });

  assert.deepEqual(actual, { provider: 'openai', responseId: 'resp_1', latencyMs: 120 });
  clock.current = 1300;
  assert.equal(tracker.firstAudio({ responseId: 'resp_1' }), null);
});

test('first audio latency is measured from the user speech end when known', () => {
  const { clock, tracker } = createClock(1000);
  tracker.begin({ provider: 'openai', responseId: 'resp_1', userSpeechEndedAt: 850 });

  clock.current = 1100;
  const actual = tracker.firstAudio({ responseId: 'resp_1' });

  assert.equal(actual.latencyMs, 250);
});

test('a speech end after the response start is not used as the reference', () => {
  const { clock, tracker } = createClock(1000);
  tracker.begin({ provider: 'openai', responseId: 'resp_1', userSpeechEndedAt: 1200 });

  clock.current = 1100;
  const actual = tracker.firstAudio({ responseId: 'resp_1' });

  assert.equal(actual.latencyMs, 100);
});

test('response end reports the total duration once and frees the id', () => {
  const { clock, tracker } = createClock(1000);
  tracker.begin({ provider: 'openai', responseId: 'resp_1' });

  clock.current = 2500;
  const actual = tracker.end({ responseId: 'resp_1' });

  assert.deepEqual(actual, { provider: 'openai', responseId: 'resp_1', durationMs: 1500 });
  clock.current = 3000;
  assert.equal(tracker.end({ responseId: 'resp_1' }), null);

  tracker.begin({ provider: 'openai', responseId: 'resp_1' });
  clock.current = 3050;
  assert.equal(tracker.firstAudio({ responseId: 'resp_1' }).latencyMs, 50);
});

test('an id-less provider keeps one open response per turn', () => {
  const { clock, tracker } = createClock(1000);

  assert.ok(tracker.begin({ provider: 'gemini' }));
  assert.equal(tracker.begin({ provider: 'gemini' }), null);

  clock.current = 1400;
  assert.equal(tracker.firstAudio().latencyMs, 400);
  assert.equal(tracker.firstAudio(), null);

  clock.current = 2100;
  assert.equal(tracker.end().durationMs, 1100);
  assert.equal(tracker.end(), null);

  // Next turn starts a fresh measurement.
  assert.ok(tracker.begin({ provider: 'gemini' }));
  clock.current = 2250;
  assert.equal(tracker.firstAudio().latencyMs, 150);
});

test('an unknown response id resolves to the open response', () => {
  const { clock, tracker } = createClock(1000);
  tracker.begin({ provider: 'gemini' });

  clock.current = 1200;
  const actual = tracker.firstAudio({ responseId: 'unknown' });

  assert.equal(actual.latencyMs, 200);
});

test('reset drops open responses and never throws for a missing response', () => {
  const { clock, tracker } = createClock(1000);
  tracker.begin({ provider: 'openai', responseId: 'resp_1' });
  tracker.reset();

  clock.current = 1500;
  assert.equal(tracker.firstAudio({ responseId: 'resp_1' }), null);
  assert.equal(tracker.end({ responseId: 'resp_1' }), null);
  assert.equal(tracker.firstAudio(), null);
  assert.equal(tracker.end(), null);
});

test('Gemini input transcription alone never opens a response', () => {
  const { clock, tracker } = createClock(1000);
  const turn = createGeminiTurnTiming({ now: () => clock.current });

  assert.deepEqual(turn.readFrame({ inputText: true }), {
    start: false,
    userSpeechEndedAt: 0,
    firstAudio: false,
    end: false,
  });

  // Nothing was opened, so the response starts from scratch on model content
  // and still uses the user speech as the first-audio reference.
  clock.current = 1400;
  const decision = turn.readFrame({ hasModelContent: true });
  assert.deepEqual(decision, {
    start: true,
    userSpeechEndedAt: 1000,
    firstAudio: false,
    end: false,
  });

  tracker.begin({ provider: 'gemini', userSpeechEndedAt: decision.userSpeechEndedAt });
  clock.current = 1600;
  assert.equal(tracker.firstAudio().latencyMs, 600);
});

test('a late input transcription after a completed turn does not swallow the next turn', () => {
  const { clock, tracker } = createClock(1000);
  const turn = createGeminiTurnTiming({ now: () => clock.current });

  // Turn 1: user speech -> model content -> first audio -> completed.
  clock.current = 1000;
  assert.deepEqual(applyGeminiFrame(turn, tracker, { inputText: true }), []);
  clock.current = 1200;
  assert.deepEqual(applyGeminiFrame(turn, tracker, { hasModelContent: true }), []);
  clock.current = 1350;
  const turn1FirstAudio = applyGeminiFrame(turn, tracker, { hasAudio: true });
  assert.equal(turn1FirstAudio[0].timing.latencyMs, 350);
  clock.current = 1600;
  assert.deepEqual(applyGeminiFrame(turn, tracker, { completed: true }), [
    { phase: 'end', timing: { provider: 'gemini', responseId: '', durationMs: 400 } },
  ]);

  // ASR lag: a user transcription frame lands after the turn already completed.
  // It must not open a response that would absorb turn 2's timings.
  clock.current = 1700;
  assert.deepEqual(applyGeminiFrame(turn, tracker, { inputText: true }), []);

  // Turn 2 must start clean and measure from turn 2's own speech.
  clock.current = 2000;
  applyGeminiFrame(turn, tracker, { inputText: true });
  clock.current = 2400;
  applyGeminiFrame(turn, tracker, { hasModelContent: true });
  clock.current = 2500;
  assert.deepEqual(applyGeminiFrame(turn, tracker, { hasAudio: true }), [
    { phase: 'first_audio', timing: { provider: 'gemini', responseId: '', latencyMs: 500 } },
  ]);
  clock.current = 2700;
  assert.deepEqual(applyGeminiFrame(turn, tracker, { completed: true }), [
    { phase: 'end', timing: { provider: 'gemini', responseId: '', durationMs: 300 } },
  ]);
});

test('appendVoiceResponseTiming is a no-op without an active session log', async () => {
  const {
    appendVoiceResponseTiming,
    exportActiveVoiceSessionLogText,
  } = await import('../app_front/features/voice/voiceSessionLog.js');

  assert.equal(exportActiveVoiceSessionLogText(), '');
  assert.doesNotThrow(() => {
    appendVoiceResponseTiming('start', { provider: 'openai', responseId: 'resp_missing' });
    appendVoiceResponseTiming('first_audio', { provider: 'openai', responseId: 'resp_missing' });
    appendVoiceResponseTiming('end', { provider: 'openai', responseId: 'resp_missing' });
    appendVoiceResponseTiming('unknown-phase');
  });
  assert.equal(exportActiveVoiceSessionLogText(), '');
});

test('appendVoiceResponseTiming writes first-audio and end entries to the active log', async () => {
  const {
    appendVoiceResponseTiming,
    exportActiveVoiceSessionLogText,
    startVoiceSessionLog,
  } = await import('../app_front/features/voice/voiceSessionLog.js');

  startVoiceSessionLog('chat-timing', { provider: 'gemini', model: 'gemini-live' });
  const userSpeechEndedAt = Date.now() - 250;
  appendVoiceResponseTiming('start', { provider: 'gemini', userSpeechEndedAt });
  appendVoiceResponseTiming('first_audio', { provider: 'gemini' });
  appendVoiceResponseTiming('end', { provider: 'gemini' });

  const session = JSON.parse(exportActiveVoiceSessionLogText());
  const firstAudio = session.entries.filter((entry) => entry.event === 'response.first_audio');
  const ended = session.entries.filter((entry) => entry.event === 'response.end');
  assert.equal(firstAudio.length, 1);
  assert.equal(ended.length, 1);
  assert.equal(firstAudio[0].provider, 'gemini');
  assert.ok(firstAudio[0].latencyMs >= 250, 'latency is measured from the user speech end');
  assert.ok(ended[0].durationMs >= 0);
});

test('repeated timing calls log one first audio and one end per response', async () => {
  const {
    appendVoiceResponseTiming,
    exportActiveVoiceSessionLogText,
    startVoiceSessionLog,
  } = await import('../app_front/features/voice/voiceSessionLog.js');

  startVoiceSessionLog('chat-repeat', { provider: 'openai', model: 'gpt-realtime' });
  const baseline = JSON.parse(exportActiveVoiceSessionLogText()).entries.length;

  appendVoiceResponseTiming('start', { provider: 'openai', responseId: 'resp_repeat' });
  appendVoiceResponseTiming('first_audio', { provider: 'openai', responseId: 'resp_repeat' });
  appendVoiceResponseTiming('first_audio', { provider: 'openai', responseId: 'resp_repeat' });
  appendVoiceResponseTiming('end', { provider: 'openai', responseId: 'resp_repeat' });
  appendVoiceResponseTiming('end', { provider: 'openai', responseId: 'resp_repeat' });

  const logged = JSON.parse(exportActiveVoiceSessionLogText()).entries.slice(baseline);
  assert.deepEqual(logged.map((entry) => entry.event), ['response.first_audio', 'response.end']);
  assert.equal(logged[0].responseId, 'resp_repeat');
  assert.equal(logged[1].responseId, 'resp_repeat');
});

/**
 * @param {string} relativePath
 * @returns {string}
 */
function readSource(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/**
 * @param {string} source
 * @param {string} phase
 * @returns {number}
 */
function countCallSites(source, phase) {
  return source.split(`appendVoiceResponseTiming('${phase}'`).length - 1;
}

test('both live providers wire exactly one call site per timing phase', () => {
  for (const file of [
    'app_front/features/voice/realtimeSession.js',
    'app_front/features/voice/geminiLiveSession.js',
  ]) {
    const source = readSource(file);
    assert.ok(source.includes('appendVoiceResponseTiming'), `${file} imports the helper`);
    assert.equal(countCallSites(source, 'start'), 1, `${file} has one start call site`);
    assert.equal(countCallSites(source, 'first_audio'), 1, `${file} has one first-audio call site`);
    assert.equal(countCallSites(source, 'end'), 1, `${file} has one end call site`);
  }
});

test('the OpenAI handler reads the realtime lifecycle events', () => {
  const source = readSource('app_front/features/voice/realtimeSession.js');

  assert.ok(source.includes("type === 'response.created'"));
  assert.ok(source.includes("type === 'output_audio_buffer.started'"));
  assert.ok(source.includes("type === 'response.done'"));
});

test('the Gemini handler reads turn content and both completion flags', () => {
  const source = readSource('app_front/features/voice/geminiLiveSession.js');

  assert.ok(source.includes('serverContent?.modelTurn?.parts'));
  assert.ok(source.includes('serverContent?.turnComplete'));
  assert.ok(source.includes('serverContent?.generationComplete'));
});

test('the Gemini handler opens a response on model content only', () => {
  const source = readSource('app_front/features/voice/geminiLiveSession.js');

  // F1 regression guard: input transcription feeds the speech reference but
  // never opens the response; the start call carries that reference.
  assert.match(source, /hasModelContent:\s*parts\.length\s*>\s*0\s*\|\|\s*Boolean\(outputText\)/);
  assert.doesNotMatch(source, /hasModelContent:[^\n,]*inputText/);
  assert.ok(source.includes('userSpeechEndedAt: turn.userSpeechEndedAt'));
});
