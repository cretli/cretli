import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserVoiceMode } from '../app_front/features/voice/browserVoiceMode.js';
import { IDLE_STATE } from '../app_front/features/voice/browserVoiceState.js';
import { VOICE_SPEAKING_EVENT } from '../app_front/features/voice/chatSpeaker.js';
import { createBrowserSpeechInput } from '../app_front/features/voice/browserSpeechInput.js';
import { createVoiceSendGate } from '../app_front/features/voice/voiceSendGate.js';
import { setVoiceSessionStatus } from '../app_front/features/voice/voiceSessionState.js';

function makeStore() {
  let value = IDLE_STATE;
  return { get: () => value, set: (next) => { value = next; } };
}

function makeTarget() {
  const listeners = new Map();
  return {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
    emit: (name, detail) => listeners.get(name)?.({ detail }),
    has: (name) => listeners.has(name),
  };
}

/** A recognizer double driven by the test, wrapped by the real controller. */
function makeRig() {
  const instances = [];
  class Fake {
    constructor() { this.starts = 0; this.stops = 0; instances.push(this); }
    start() { this.starts += 1; }
    stop() { this.stops += 1; this.onend?.(); }
    say(text) { this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
  }
  const timers = [];
  const clock = {
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (id) => { timers[id - 1] = null; },
    flush() { const due = timers.splice(0); due.forEach((fn) => fn?.()); },
  };
  const createInput = (options) => createBrowserSpeechInput({ ...options, win: { webkitSpeechRecognition: Fake }, ...clock });
  return { instances, clock, createInput };
}

test('a spoken prompt is sent once; a command runs instead of a prompt', async () => {
  const rig = makeRig();
  const sent = [];
  const stops = [];
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput,
    handlers: { sendPrompt: async (text) => { sent.push(text); return { ok: true }; } },
    executors: { stop_agent: async () => { stops.push(1); return { ok: true }; } },
    eventTarget: makeTarget(),
    getLang: () => 'en',
    state: makeStore(),
  });
  assert.equal(mode.start().ok, true);
  rig.instances[0].say('add a unit test');
  rig.clock.flush();
  rig.instances[0].say('stop');
  rig.clock.flush();
  await Promise.resolve();
  assert.deepEqual(sent, ['add a unit test']);
  assert.equal(stops.length, 1);
});

test('text read aloud by the app never returns as a prompt (echo guard)', async () => {
  const rig = makeRig();
  const target = makeTarget();
  const sent = [];
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput,
    handlers: { sendPrompt: async (text) => { sent.push(text); return { ok: true }; } },
    executors: {},
    eventTarget: target,
    getLang: () => 'en',
    state: makeStore(),
  });
  mode.start();
  const recognition = rig.instances[0];
  recognition.say('half heard');
  target.emit(VOICE_SPEAKING_EVENT, { active: true });
  recognition.say('the build passed and all tests are green');
  rig.clock.flush();
  await Promise.resolve();
  assert.deepEqual(sent, [], 'nothing heard while speaking is sent, and the buffered half is dropped');
  target.emit(VOICE_SPEAKING_EVENT, { active: false });
  rig.clock.flush();
  recognition.say('thanks');
  rig.clock.flush();
  await Promise.resolve();
  assert.deepEqual(sent, ['thanks']);
});

test('no API: the state shows the unsupported message and the listener is not attached', () => {
  const store = makeStore();
  const target = makeTarget();
  const mode = createBrowserVoiceMode({
    createInput: (options) => createBrowserSpeechInput({ ...options, win: {} }),
    handlers: {},
    executors: {},
    eventTarget: target,
    state: store,
  });
  assert.equal(mode.start().ok, false);
  assert.equal(store.get().error, 'unsupported');
  assert.equal(store.get().active, false);
  assert.equal(target.has(VOICE_SPEAKING_EVENT), false);
});

test('a denied microphone ends the session with a denied state', () => {
  const rig = makeRig();
  const store = makeStore();
  const target = makeTarget();
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput, handlers: {}, executors: {}, eventTarget: target, state: store,
  });
  mode.start();
  rig.instances[0].onerror({ error: 'not-allowed' });
  assert.equal(store.get().error, 'denied');
  assert.equal(store.get().active, false);
  assert.equal(target.has(VOICE_SPEAKING_EVENT), false);
});

test('stop clears the state and toggle starts again', () => {
  const rig = makeRig();
  const store = makeStore();
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput, handlers: {}, executors: {}, eventTarget: makeTarget(), state: store,
  });
  assert.equal(mode.toggle().active, true);
  assert.equal(store.get().active, true);
  assert.equal(mode.toggle().active, false);
  assert.equal(store.get().active, false);
});

test('CAR4: Web Speech does not start while a Realtime session is active', () => {
  const rig = makeRig();
  const store = makeStore();
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput, handlers: {}, executors: {}, eventTarget: makeTarget(), state: store,
    isRealtimeActive: () => true,
  });
  assert.deepEqual(mode.start(), { ok: false, code: 'realtime_active' });
  assert.equal(rig.instances.length, 0, 'no recognizer is created');
  assert.equal(store.get().active, false);
  assert.equal(mode.toggle().active, false);
});

test('CAR4: when Realtime goes live mid-session the local matcher and prompts stop', async () => {
  const rig = makeRig();
  const store = makeStore();
  let realtime = false;
  const sent = [];
  const matched = [];
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput,
    handlers: { sendPrompt: async (text) => { sent.push(text); return { ok: true }; } },
    executors: {},
    match: (text) => { matched.push(text); return null; },
    eventTarget: makeTarget(),
    state: store,
    isRealtimeActive: () => realtime,
  });
  mode.start();
  rig.instances[0].say('first');
  rig.clock.flush();
  await Promise.resolve();
  assert.deepEqual(sent, ['first']);
  realtime = true;
  rig.instances[0].say('second');
  rig.clock.flush();
  await Promise.resolve();
  assert.deepEqual(sent, ['first'], 'nothing is sent while Realtime owns the microphone');
  assert.deepEqual(matched, ['first'], 'the local matcher never ran for the second utterance');
  assert.equal(store.get().active, false, 'browser voice shut itself down');
});

test('CAR1: an already-speaking app keeps the microphone off when listening starts', () => {
  const rig = makeRig();
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput, handlers: {}, executors: {}, eventTarget: makeTarget(), state: makeStore(),
    isSpeaking: () => true,
  });
  mode.start();
  assert.equal(rig.instances[0].starts, 0);
});

test('CAR4: Realtime activation immediately stops an already running browser recognizer', async () => {
  const rig = makeRig();
  const { voiceSessionStatus } = await import('../app_front/features/voice/voiceSessionState.js');
  const { subscribe } = await import('../app_front/state/sharedState.js');
  const updates = [];
  const unsubscribe = subscribe(voiceSessionStatus, (value) => updates.push(value));
  setVoiceSessionStatus('closing');
  await new Promise((resolve) => setTimeout(resolve, 0));
  setVoiceSessionStatus('idle');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const mode = createBrowserVoiceMode({ createInput: rig.createInput, handlers: {}, executors: {}, eventTarget: makeTarget(), state: makeStore() });
  mode.start();
  const rec = rig.instances[0];
  assert.equal(rec.starts, 1);
  setVoiceSessionStatus('connecting');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(updates.includes('connecting'));
  assert.ok(rec.stops > 0);
  assert.equal(mode.isActive(), false);
  setVoiceSessionStatus('idle');
  unsubscribe();
});

/** Car-mode rig: the undo window runs on a manual clock; `getActiveChat` can be delayed. */
function makeCarRig(extra = {}) {
  const rig = makeRig();
  const sent = [];
  const spoken = [];
  const stops = [];
  let now = 0;
  const timers = new Map();
  let id = 0;
  const clock = {
    now: () => now,
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (timerId) => timers.delete(timerId),
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms) => {
    now += ms;
    for (const [key, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(key); timer.fn(); }
    }
    await tick();
  };
  let activeChat = { id: 'c1', title: 'Shop' };
  let chatLookup = null;
  const handlers = {
    sendPrompt: async (text, options) => {
      await Promise.resolve(); // the real handler awaits the chat module here
      if (options?.isCurrent && !options.isCurrent()) return { ok: false, code: 'cancelled', error: 'cancelled' };
      if (options?.expectChatId && options.expectChatId !== activeChat.id) return { ok: false, error: 'chat changed' };
      sent.push({ text, chat: activeChat.id });
      return { ok: true };
    },
    getActiveChat: async () => {
      if (chatLookup) await chatLookup;
      return activeChat;
    },
  };
  const gate = createVoiceSendGate({ handlers, isCarMode: () => true, clock });
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput,
    handlers,
    executors: { stop_agent: async () => { stops.push(1); return { ok: true }; } },
    eventTarget: makeTarget(),
    getLang: () => 'en',
    state: makeStore(),
    isCarMode: () => true,
    readBack: (text) => spoken.push(text),
    gate,
    speakingClock: clock,
    ...extra,
  });
  mode.start();
  const say = async (text) => {
    rig.instances[0].say(text);
    rig.clock.flush();
    await tick();
  };
  return {
    mode, gate, say, sent, spoken, stops, advance, tick, rig,
    setChat: (chat) => { activeChat = chat; },
    delayLookup: () => {
      let release;
      chatLookup = new Promise((resolve) => { release = resolve; });
      return () => { chatLookup = null; release(); };
    },
  };
}

test('car mode: a prompt is read back and sent only after the undo window', async () => {
  const car = makeCarRig();
  await car.say('please add a unit test for the parser module now');
  assert.equal(car.sent.length, 0);
  assert.match(car.spoken[0], /^To Shop: please add a unit test for the parser…$/);
  await car.advance(4999);
  assert.equal(car.sent.length, 0);
  await car.advance(1);
  assert.deepEqual(car.sent, [{ text: 'please add a unit test for the parser module now', chat: 'c1' }]);
});

test('car mode: "cancel" inside the window drops the prompt and does not stop the agent', async () => {
  const car = makeCarRig();
  await car.say('delete everything');
  await car.say('cancel');
  await car.advance(10000);
  assert.equal(car.sent.length, 0);
  assert.equal(car.stops.length, 0);
  // With nothing waiting, "cancel" is just a prompt again and still never a stop.
  await car.say('cancel');
  assert.equal(car.stops.length, 0);
});

test('car mode: "send" inside the window sends at once', async () => {
  const car = makeCarRig();
  await car.say('run the build');
  await car.say('send');
  assert.deepEqual(car.sent.map((entry) => entry.text), ['run the build']);
  await car.advance(10000);
  assert.equal(car.sent.length, 1);
});

test('car mode: a chat switched during the window refuses the send instead of misdelivering', async () => {
  const car = makeCarRig();
  await car.say('deploy now');
  car.setChat({ id: 'c2', title: 'Blog' });
  await car.advance(5000);
  assert.equal(car.sent.length, 0);
  assert.ok(car.spoken.includes('chat changed'), 'the failure is spoken');
});

test('car mode: undo and stop() drop a waiting prompt', async () => {
  const car = makeCarRig();
  await car.say('first');
  assert.equal(car.gate.undo(), true);
  assert.equal(car.gate.undo(), false);
  await car.say('second');
  car.mode.stop();
  await car.advance(10000);
  assert.equal(car.sent.length, 0);
});

test('car mode: a bare "stop" is a waiting prompt, "stop agent" stops', async () => {
  const car = makeCarRig();
  await car.say('stop');
  assert.equal(car.stops.length, 0);
  await car.say('undo');
  await car.say('stop agent');
  assert.equal(car.stops.length, 1);
});

test('S2: stop() during a slow active-chat lookup sends nothing and opens no window', async () => {
  const car = makeCarRig();
  const release = car.delayLookup();
  await car.say('send this please');
  car.mode.stop();
  release();
  await car.tick();
  await car.advance(20000);
  assert.equal(car.sent.length, 0);
  assert.equal(car.gate.getPending(), null);
});

test('S2: a send already in flight when the session ends does not submit', async () => {
  const car = makeCarRig();
  await car.say('almost gone');
  const pending = car.gate.sendNow();
  car.gate.reset();
  await pending;
  assert.equal(car.sent.length, 0, 'cancelled before the send bar was used');
});

test('S3: a missing "speech ended" event does not freeze the window or the microphone', async () => {
  const car = makeCarRig();
  await car.say('hello there');
  // The read-back starts speaking; the end event never arrives.
  car.gate.hold();
  assert.equal(car.gate.getPending().held, true);
  await car.advance(14999);
  assert.equal(car.sent.length, 0);
  await car.advance(1);
  assert.equal(car.gate.getPending().held, false, 'the hold expired');
  await car.advance(5000);
  assert.deepEqual(car.sent.map((entry) => entry.text), ['hello there']);
});

test('S3: the microphone is released when the speech-end event is lost', async () => {
  const rig = makeRig();
  const target = makeTarget();
  let now = 0;
  const timers = new Map();
  let id = 0;
  const speakingClock = {
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (timerId) => timers.delete(timerId),
  };
  const mode = createBrowserVoiceMode({
    createInput: rig.createInput, handlers: {}, executors: {}, eventTarget: target,
    getLang: () => 'en', state: makeStore(), isCarMode: () => false, speakingClock,
    gate: createVoiceSendGate({ handlers: {}, isCarMode: () => false }),
    isSpeaking: () => false,
  });
  mode.start();
  const recognition = rig.instances[0];
  target.emit(VOICE_SPEAKING_EVENT, { active: true });
  const stopsAfterPause = recognition.stops;
  assert.ok(stopsAfterPause > 0, 'paused while speaking');
  now = 15000;
  for (const [key, timer] of [...timers]) { if (timer.at <= now) { timers.delete(key); timer.fn(); } }
  rig.clock.flush();
  assert.ok(recognition.starts >= 2, 'recognizer restarted without the end event');
});

test('S4: "Send now" returns the send result, including a refusal', async () => {
  const car = makeCarRig();
  await car.say('go');
  car.setChat({ id: 'c2', title: 'Blog' });
  const result = await car.gate.sendNow();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chat changed');
  assert.equal(await car.gate.sendNow(), null, 'nothing left to send');
});

test('S5: a prompt for another chat says out loud that the earlier one was not sent', async () => {
  const car = makeCarRig();
  await car.say('first message');
  car.setChat({ id: 'c2', title: 'Blog' });
  await car.say('second message');
  assert.ok(car.spoken.some((line) => /Shop/.test(line) && /not sent/.test(line)), car.spoken.join(' | '));
  await car.advance(5000);
  assert.deepEqual(car.sent, [{ text: 'second message', chat: 'c2' }]);
});
