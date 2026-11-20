import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { commandHandlers } from '../app_front/features/voice/commandHandlers.js';
import { createConfirmGuard } from '../app_front/features/voice/voiceConfirmGuard.js';
import { GEMINI_LATE_TRANSCRIPT_GRACE_MS, createGeminiSignals, createOpenAiSignals } from '../app_front/features/voice/voiceSessionSignals.js';
import { executeRealtimeTool, noteRealtimeUserSpeech, setRealtimeConfirmGuard } from '../app_front/features/voice/realtimeTools.js';
import { createVoiceSendGate, getVoiceSendGate } from '../app_front/features/voice/voiceSendGate.js';
import { setCarViewProbe } from '../app_front/features/car/carViewProbe.js';

function patch(overrides) {
  const originals = {};
  for (const key of Object.keys(overrides)) originals[key] = commandHandlers[key];
  Object.assign(commandHandlers, overrides);
  return () => Object.assign(commandHandlers, originals);
}

test('S1: with the car view open Realtime send_prompt waits in the undo window, and undo_send drops it', async () => {
  const sent = [];
  const restore = patch({
    sendPrompt: async (text) => { sent.push(text); return { ok: true }; },
    getActiveChat: async () => ({ id: 'c1', title: 'Shop' }),
  });
  setCarViewProbe(() => true);
  try {
    const result = await executeRealtimeTool('send_prompt', { text: 'add tests' });
    assert.equal(result.ok, true);
    assert.equal(result.pending_undo, true);
    assert.equal(result.chat, 'Shop');
    assert.match(result.message, /Shop/);
    assert.equal(sent.length, 0, 'nothing sent yet');
    assert.equal((await executeRealtimeTool('undo_send', {})).ok, true);
    assert.equal((await executeRealtimeTool('undo_send', {})).ok, false, 'nothing left');
    assert.equal(sent.length, 0);
  } finally {
    getVoiceSendGate().reset();
    setCarViewProbe(() => false);
    restore();
  }
});

/** Guard on a manual clock, installed for the test's duration. */
function useClock() {
  const clock = { time: 1000, advance(ms) { this.time += ms; } };
  setRealtimeConfirmGuard(createConfirmGuard({ now: () => clock.time }));
  return clock;
}

test('S1: Realtime send_now sends the waiting prompt once, to the remembered chat', async () => {
  const sent = [];
  const clock = useClock();
  const restore = patch({
    sendPrompt: async (text, options) => { sent.push([text, options.expectChatId]); return { ok: true }; },
    getActiveChat: async () => ({ id: 'c1', title: 'Shop' }),
  });
  setCarViewProbe(() => true);
  try {
    await executeRealtimeTool('send_prompt', { text: 'run build' });
    noteRealtimeUserSpeech();
    clock.advance(2000);
    const result = await executeRealtimeTool('send_now', {});
    assert.equal(result.ok, true);
    assert.deepEqual(sent, [['run build', 'c1']]);
    assert.equal((await executeRealtimeTool('send_now', {})).ok, false);
  } finally {
    getVoiceSendGate().reset();
    setCarViewProbe(() => false);
    restore();
  }
});

test('S1: outside car mode Realtime send_prompt sends at once (unchanged)', async () => {
  const sent = [];
  const restore = patch({ sendPrompt: async (text) => { sent.push(text); return { ok: true }; } });
  try {
    assert.equal((await executeRealtimeTool('send_prompt', { text: 'hi' })).ok, true);
    assert.deepEqual(sent, ['hi']);
  } finally {
    restore();
  }
});

test('S1: Realtime stop_agent needs an explicit confirm in car mode only', async () => {
  let stops = 0;
  const clock = useClock();
  const restore = patch({ stopAgent: async () => { stops += 1; return { ok: true }; } });
  try {
    setCarViewProbe(() => true);
    const refused = await executeRealtimeTool('stop_agent', {});
    assert.equal(refused.ok, false);
    assert.equal(refused.needs_confirm, true);
    assert.equal(stops, 0);
    noteRealtimeUserSpeech();
    clock.advance(1000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).ok, true);
    assert.equal(stops, 1);
    setCarViewProbe(() => false);
    assert.equal((await executeRealtimeTool('stop_agent', {})).ok, true);
    assert.equal(stops, 2);
  } finally {
    setCarViewProbe(() => false);
    restore();
  }
});

test('FU2: stop_agent confirm=true in the first call is refused and only arms the confirmation', async () => {
  let stops = 0;
  const clock = useClock();
  const restore = patch({ stopAgent: async () => { stops += 1; return { ok: true }; } });
  try {
    setCarViewProbe(() => true);
    const first = await executeRealtimeTool('stop_agent', { confirm: true });
    assert.equal(first.needs_confirm, true);
    assert.equal(stops, 0);
    noteRealtimeUserSpeech();
    clock.advance(1000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).ok, true);
    assert.equal(stops, 1);
    // One-shot: the next confirm=true needs a fresh needs_confirm.
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    assert.equal(stops, 1);
  } finally {
    setCarViewProbe(() => false);
    restore();
  }
});

test('FU2: a stale needs_confirm does not authorise stop_agent', async () => {
  let stops = 0;
  const clock = useClock();
  const restore = patch({ stopAgent: async () => { stops += 1; return { ok: true }; } });
  try {
    setCarViewProbe(() => true);
    assert.equal((await executeRealtimeTool('stop_agent', {})).needs_confirm, true);
    noteRealtimeUserSpeech();
    clock.advance(31000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    assert.equal(stops, 0);
  } finally {
    setCarViewProbe(() => false);
    restore();
  }
});

test('F3: send_now needs driver speech after the submit; time alone never passes', async () => {
  const sent = [];
  const clock = useClock();
  const restore = patch({
    sendPrompt: async (text) => { sent.push(text); return { ok: true }; },
    getActiveChat: async () => ({ id: 'c1', title: 'Shop' }),
  });
  setCarViewProbe(() => true);
  try {
    await executeRealtimeTool('send_prompt', { text: 'deploy' });
    clock.advance(500);
    assert.equal((await executeRealtimeTool('send_now', {})).ok, false, 'too early');
    clock.advance(60000);
    assert.equal((await executeRealtimeTool('send_now', {})).ok, false, 'a long wait without the driver is not enough');
    assert.equal(sent.length, 0);
    assert.ok(getVoiceSendGate().getPending(), 'the prompt still waits');
    noteRealtimeUserSpeech();
    assert.equal((await executeRealtimeTool('send_now', {})).ok, true);
    assert.deepEqual(sent, ['deploy']);
  } finally {
    getVoiceSendGate().reset();
    setCarViewProbe(() => false);
    restore();
  }
});

test('F3: driver speech right after the submit still waits out the 1.5 s minimum', async () => {
  const clock = useClock();
  const restore = patch({
    sendPrompt: async () => ({ ok: true }),
    getActiveChat: async () => ({ id: 'c1', title: 'Shop' }),
  });
  setCarViewProbe(() => true);
  try {
    await executeRealtimeTool('send_prompt', { text: 'deploy' });
    noteRealtimeUserSpeech();
    clock.advance(400);
    assert.equal((await executeRealtimeTool('send_now', {})).ok, false);
    clock.advance(1200);
    assert.equal((await executeRealtimeTool('send_now', {})).ok, true);
  } finally {
    getVoiceSendGate().reset();
    setCarViewProbe(() => false);
    restore();
  }
});

test('F1: stop_agent confirm without driver speech between the two calls is refused (same response or next response)', async () => {
  let stops = 0;
  const clock = useClock();
  const restore = patch({ stopAgent: async () => { stops += 1; return { ok: true }; } });
  try {
    setCarViewProbe(() => true);
    // Two calls in one response / one Gemini batch: no time, no speech.
    assert.equal((await executeRealtimeTool('stop_agent', {})).needs_confirm, true);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    // Follow-up response much later but still no driver speech.
    clock.advance(5000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    clock.advance(5000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    assert.equal(stops, 0);
  } finally {
    setCarViewProbe(() => false);
    restore();
  }
});

test('F1: driver speech that came before the needs_confirm does not count, and the minimum gap applies', async () => {
  let stops = 0;
  const clock = useClock();
  const restore = patch({ stopAgent: async () => { stops += 1; return { ok: true }; } });
  try {
    setCarViewProbe(() => true);
    noteRealtimeUserSpeech(); // the utterance that triggered the first call
    assert.equal((await executeRealtimeTool('stop_agent', {})).needs_confirm, true);
    clock.advance(2000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    assert.equal(stops, 0);
    // New ask, speech, but too fast.
    await executeRealtimeTool('stop_agent', {});
    noteRealtimeUserSpeech();
    clock.advance(300);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    assert.equal(stops, 0);
  } finally {
    setCarViewProbe(() => false);
    restore();
  }
});

/** A gate on a manual clock whose window already holds a realtime prompt. */
function makeGate() {
  let time = 0;
  const timers = new Map();
  let id = 0;
  const sent = [];
  const gate = createVoiceSendGate({
    isCarMode: () => true,
    handlers: { getActiveChat: async () => ({ id: 'c1', title: 'Shop' }), sendPrompt: async (text) => { sent.push(text); return { ok: true }; } },
    clock: {
      now: () => time,
      setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, at: time + ms }); return id; },
      clearTimer: (timerId) => { timers.delete(timerId); },
    },
  });
  const advance = (ms) => {
    time += ms;
    for (const [timerId, timer] of [...timers]) if (timer.at <= time) { timers.delete(timerId); timer.fn(); }
  };
  return { gate, sent, advance };
}

test('FU1: a Realtime prompt waits while the model speaks, then the driver gets a full window', async () => {
  const { gate, sent, advance } = makeGate();
  await gate.submit('add tests', { source: 'realtime' });
  advance(6000);
  assert.equal(sent.length, 0, 'held from the submit: the model has not read it back yet');
  // The response that issued the tool call ends before the read-back begins: ignored.
  gate.noteModelSpeech(false);
  advance(6000);
  assert.equal(sent.length, 0);
  gate.noteModelSpeech(true); // the read-back starts
  advance(10000);
  assert.equal(sent.length, 0, 'still held while the model talks');
  gate.noteModelSpeech(false);
  advance(4999);
  assert.equal(sent.length, 0, 'the spoken "cancel" still fits');
  assert.equal(gate.undo(), true);
  advance(10000);
  assert.equal(sent.length, 0);
});

test('FU1: with no model audio the failsafe still lets the prompt go', async () => {
  const { gate, sent, advance } = makeGate();
  await gate.submit('x', { source: 'realtime' });
  advance(15000); // failsafe release
  advance(5000);
  await Promise.resolve();
  assert.deepEqual(sent, ['x']);
});

test('FU3: resetting the gate (session end) drops the waiting Realtime prompt', async () => {
  const { gate, sent, advance } = makeGate();
  await gate.submit('late', { source: 'realtime' });
  gate.noteModelSpeech(true);
  gate.noteModelSpeech(false);
  gate.reset();
  assert.equal(gate.getPending(), null);
  advance(60000);
  assert.equal(sent.length, 0);
});

/** Records what the signal mappers do to the gate and the guard. */
function makeSignalDeps() {
  const log = [];
  const clock = { time: 1000, advance(ms) { this.time += ms; } };
  return {
    log,
    clock,
    deps: {
      now: () => clock.time,
      gate: () => ({ noteModelSpeech: (active) => log.push(`model:${active}`), reset: () => log.push('gate.reset') }),
      noteUserSpeech: () => log.push('speech'),
      resetGuards: () => log.push('guards.reset'),
    },
  };
}

test('F6: OpenAI events map to model speech edges and driver speech', () => {
  const { log, deps } = makeSignalDeps();
  const signals = createOpenAiSignals(deps);
  for (const type of ['input_audio_buffer.speech_started', 'response.created', 'response.done', 'conversation.item.created']) signals.handleEvent(type);
  assert.deepEqual(log, ['speech', 'model:true', 'model:false'], 'without playback edges response.done releases');
  log.length = 0;
  for (const type of ['output_audio_buffer.started', 'response.done', 'output_audio_buffer.stopped']) signals.handleEvent(type);
  assert.deepEqual(log, ['model:true', 'model:false'], 'with playback edges response.done is ignored; stopped releases');
  log.length = 0;
  signals.handleEvent('output_audio_buffer.cleared');
  assert.deepEqual(log, ['model:false']);
});

test('FU3: ending an OpenAI session resets the gate and the guards, and a waiting prompt is gone', async () => {
  const { log, deps } = makeSignalDeps();
  createOpenAiSignals(deps).end();
  assert.deepEqual(log, ['gate.reset', 'guards.reset']);
  const { gate, sent, advance } = makeGate();
  await gate.submit('late', { source: 'realtime' });
  createOpenAiSignals({ ...deps, gate: () => gate }).end();
  advance(60000);
  assert.equal(sent.length, 0);
  assert.equal(gate.getPending(), null);
});

test('FU3: ending a Gemini session resets the gate and the guards', async () => {
  const { gate, sent, advance } = makeGate();
  const { deps } = makeSignalDeps();
  await gate.submit('late', { source: 'realtime' });
  createGeminiSignals({ ...deps, gate: () => gate }).end();
  advance(60000);
  assert.equal(sent.length, 0);
  assert.equal(gate.getPending(), null);
});

test('F2: Gemini transcription of the utterance that issued the tool call is not new driver speech', () => {
  const { log, deps, clock } = makeSignalDeps();
  const signals = createGeminiSignals(deps);
  signals.handleServerContent({ inputText: true }); // the driver's utterance
  assert.deepEqual(log, ['speech']);
  log.length = 0;
  signals.handleToolCall();
  signals.handleServerContent({ inputText: true }); // late transcript of the same utterance
  signals.handleServerContent({ hasAudio: true });
  signals.handleServerContent({ inputText: true });
  assert.deepEqual(log, ['model:true'], 'no speech counted while the tool turn is open');
  signals.handleServerContent({ turnComplete: true });
  clock.advance(GEMINI_LATE_TRANSCRIPT_GRACE_MS);
  signals.handleServerContent({ inputText: true }); // genuinely new utterance
  assert.deepEqual(log, ['model:true', 'model:false', 'speech']);
});

test('F2: a late transcript in the frame that closes the tool turn, or just after it, is not new speech', () => {
  const { log, deps, clock } = makeSignalDeps();
  const signals = createGeminiSignals(deps);
  signals.handleToolCall();
  signals.handleServerContent({ inputText: true, turnComplete: true });
  clock.advance(GEMINI_LATE_TRANSCRIPT_GRACE_MS - 1);
  signals.handleServerContent({ inputText: true });
  assert.deepEqual(log, ['model:false'], 'the trailing transcript belongs to the old utterance');
  clock.advance(1);
  signals.handleServerContent({ inputText: true });
  assert.deepEqual(log, ['model:false', 'speech']);
});

test('F2: a barge-in (interrupted) closes the tool turn so the next transcript counts', () => {
  const { log, deps, clock } = makeSignalDeps();
  const signals = createGeminiSignals(deps);
  signals.handleToolCall();
  signals.handleServerContent({ interrupted: true });
  clock.advance(GEMINI_LATE_TRANSCRIPT_GRACE_MS);
  signals.handleServerContent({ inputText: true });
  assert.deepEqual(log, ['model:false', 'speech']);
});

test('F4: Gemini generationComplete is not a release edge (only turnComplete / interrupted)', async () => {
  const { gate, sent, advance } = makeGate();
  const { deps } = makeSignalDeps();
  const signals = createGeminiSignals({ ...deps, gate: () => gate });
  await gate.submit('x', { source: 'realtime' });
  signals.handleServerContent({ hasAudio: true });
  signals.handleServerContent({}); // generationComplete carries no usable flag: ignored
  advance(10000);
  assert.equal(sent.length, 0, 'still held while the audio plays');
  signals.handleServerContent({ turnComplete: true });
  advance(4999);
  assert.equal(sent.length, 0);
  assert.equal(gate.undo(), true);
});

test('F1+F2 end to end (Gemini): toolCall batch cannot confirm a stop, a new turn after the question can', async () => {
  let stops = 0;
  const clock = useClock();
  const restore = patch({ stopAgent: async () => { stops += 1; return { ok: true }; } });
  const signals = createGeminiSignals({
    gate: getVoiceSendGate,
    noteUserSpeech: noteRealtimeUserSpeech,
    resetGuards: () => {},
    now: () => clock.time,
  });
  try {
    setCarViewProbe(() => true);
    signals.handleToolCall();
    assert.equal((await executeRealtimeTool('stop_agent', {})).needs_confirm, true);
    signals.handleServerContent({ inputText: true }); // late transcript of the old utterance
    clock.advance(2000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).needs_confirm, true);
    await executeRealtimeTool('stop_agent', {});
    signals.handleServerContent({ turnComplete: true }); // model asked the driver and finished
    clock.advance(1500); // the question plays; the driver answers after it
    signals.handleServerContent({ inputText: true }); // "yes"
    clock.advance(2000);
    assert.equal((await executeRealtimeTool('stop_agent', { confirm: true })).ok, true);
    assert.equal(stops, 1);
  } finally {
    setCarViewProbe(() => false);
    restore();
  }
});
