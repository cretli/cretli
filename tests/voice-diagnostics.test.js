import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectVoiceDiagnostics,
  createDiagnosticsCoordinator,
  createDisposer,
  shouldCancelOnIntersection,
  mapMediaError,
  mapSpeechError,
  runMicTest,
  runRecognitionTest,
  voiceErrorKeys,
} from '../app_front/features/voice/voiceDiagnostics.js';
import { createBrowserSpeechInput } from '../app_front/features/voice/browserSpeechInput.js';
import { createBrowserVoiceMode } from '../app_front/features/voice/browserVoiceMode.js';
import { IDLE_STATE } from '../app_front/features/voice/browserVoiceState.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

test('web speech errors map to distinct codes', () => {
  assert.equal(mapSpeechError('not-allowed'), 'denied');
  assert.equal(mapSpeechError('not-allowed', { secure: false }), 'insecure');
  assert.equal(mapSpeechError('service-not-allowed'), 'service');
  assert.equal(mapSpeechError('service-not-allowed', { secure: false }), 'service');
  assert.equal(mapSpeechError('audio-capture'), 'nodevice');
  assert.equal(mapSpeechError('network'), 'error');
  assert.equal(mapSpeechError(''), 'error');
  assert.equal(mapSpeechError('no-speech'), '');
  assert.equal(mapSpeechError('aborted'), '');
});

test('getUserMedia rejections map to codes', () => {
  assert.equal(mapMediaError({ name: 'NotAllowedError' }), 'denied');
  assert.equal(mapMediaError({ name: 'NotAllowedError' }, { secure: false }), 'insecure');
  assert.equal(mapMediaError({ name: 'NotFoundError' }), 'nodevice');
  assert.equal(mapMediaError(new Error('x')), 'error');
});

test('every code has a message and advice in both languages', () => {
  for (const code of ['denied', 'insecure', 'service', 'unsupported', 'nodevice', 'error', 'whatever']) {
    const keys = voiceErrorKeys(code);
    for (const dict of [en, pl]) {
      for (const key of [keys.message, keys.advice]) {
        const value = key.split('.').reduce((node, part) => node?.[part], dict);
        assert.ok(typeof value === 'string' && value.length > 0, `${key} missing`);
      }
    }
  }
});

test('speech input reports insecure, service and denied separately', () => {
  /** @type {any[]} */
  const instances = [];
  class FakeRecognition {
    constructor() { instances.push(this); }
    start() {}
    stop() {}
  }
  const run = (win, error) => {
    instances.length = 0;
    const codes = [];
    const input = createBrowserSpeechInput({ win: { ...win, SpeechRecognition: FakeRecognition }, onError: (e) => codes.push(e.code) });
    input.start();
    instances[0].onerror({ error });
    return { codes, wanted: input.isWanted() };
  };
  assert.deepEqual(run({ isSecureContext: true }, 'not-allowed'), { codes: ['denied'], wanted: false });
  assert.deepEqual(run({ isSecureContext: false }, 'not-allowed'), { codes: ['insecure'], wanted: false });
  assert.deepEqual(run({ isSecureContext: true }, 'service-not-allowed'), { codes: ['service'], wanted: false });
  assert.deepEqual(run({}, 'network'), { codes: ['error'], wanted: true });
});

test('diagnostic report without permissions API, recognition or secure context', async () => {
  const report = await collectVoiceDiagnostics({
    win: { isSecureContext: false, location: { protocol: 'http:' } },
    nav: {},
  });
  assert.equal(report.secure, false);
  assert.equal(report.permission, 'unknown');
  assert.equal(report.permissionsApi, false);
  assert.equal(report.speechRecognition, false);
  assert.equal(report.getUserMedia, false);
  assert.equal(report.outputSelection, false);
  assert.equal(report.hint, 'insecure');
});

test('diagnostic report reads the permission and capabilities', async () => {
  class Audio {}
  const nav = {
    permissions: { query: async ({ name }) => ({ state: name === 'microphone' ? 'denied' : 'granted' }) },
    mediaDevices: { getUserMedia() {} },
  };
  const win = {
    isSecureContext: true,
    location: { protocol: 'https:' },
    webkitSpeechRecognition: class {},
    MediaRecorder: class {},
    speechSynthesis: {},
    SpeechSynthesisUtterance: class {},
    AudioContext: Audio,
    HTMLMediaElement: { prototype: { setSinkId() {} } },
  };
  const report = await collectVoiceDiagnostics({ win, nav });
  assert.equal(report.permission, 'denied');
  assert.equal(report.hint, 'denied');
  assert.equal(report.speechRecognition, true);
  assert.equal(report.mediaRecorder, true);
  assert.equal(report.speechSynthesis, true);
  assert.equal(report.outputSelection, true);
  // A rejecting permissions API (Firefox/Safari) degrades to unknown.
  const rejecting = await collectVoiceDiagnostics({ win, nav: { ...nav, permissions: { query: async () => { throw new TypeError('x'); } } } });
  assert.equal(rejecting.permission, 'unknown');
  assert.equal(rejecting.hint, '');
});

function makeAudioEnv({ levels, rejectWith } = {}) {
  const stopped = [];
  let closed = false;
  let index = 0;
  const stream = { getTracks: () => [{ stop: () => stopped.push(1) }, { stop: () => stopped.push(1) }] };
  class AudioContext {
    createAnalyser() {
      return {
        fftSize: 0,
        getByteTimeDomainData(buffer) {
          const level = levels[Math.min(index++, levels.length - 1)];
          buffer.fill(128 + level);
        },
      };
    }
    createMediaStreamSource() { return { connect() {} }; }
    async close() { closed = true; }
  }
  const nav = {
    mediaDevices: { getUserMedia: async () => { if (rejectWith) throw rejectWith; return stream; } },
  };
  return { win: { isSecureContext: true, AudioContext }, nav, stopped, isClosed: () => closed };
}

/** Timers that fire in order when `run()` is called, so the test never waits. */
function manualTimers() {
  const queue = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; queue.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    // Fires ticks (80ms) a few times, then the overall timeout.
    async drain() {
      for (let i = 0; i < 200; i += 1) {
        await Promise.resolve();
        const next = queue.find((t) => t.live && t.ms === 80) || queue.find((t) => t.live);
        if (!next) return;
        next.live = false;
        next.fn();
        if (next.ms !== 80 && !queue.some((t) => t.live && t.ms === 80)) return;
        if (i > 3) { const overall = queue.find((t) => t.live && t.ms !== 80); if (overall) { overall.live = false; overall.fn(); return; } }
      }
    },
  };
}

test('mic test measures the level and releases the stream', async () => {
  const env = makeAudioEnv({ levels: [0, 32, 10] });
  const timers = manualTimers();
  const seen = [];
  const pending = runMicTest({ ...env, durationMs: 5000, onLevel: (l) => seen.push(l), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await Promise.resolve();
  await timers.drain();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.ok(result.peak > 0.4, `peak ${result.peak}`);
  assert.ok(seen.length >= 1);
  assert.equal(env.stopped.length, 2, 'every track is stopped');
  assert.equal(env.isClosed(), true);
});

test('mic test maps rejection, insecure origin and missing API', async () => {
  const denied = makeAudioEnv({ levels: [0], rejectWith: { name: 'NotAllowedError' } });
  assert.deepEqual(await runMicTest(denied), { ok: false, code: 'denied' });
  const insecure = makeAudioEnv({ levels: [0] });
  insecure.win.isSecureContext = false;
  assert.deepEqual(await runMicTest(insecure), { ok: false, code: 'insecure' });
  assert.deepEqual(await runMicTest({ win: { isSecureContext: true }, nav: {} }), { ok: false, code: 'unsupported' });
});

test('recognition test returns one utterance or a mapped error', async () => {
  const instances = [];
  class Fake {
    constructor() { instances.push(this); }
    start() {}
    stop() {}
  }
  const win = { isSecureContext: true, SpeechRecognition: Fake };
  const pending = runRecognitionTest({ win, lang: 'pl-PL', setTimer: () => 1, clearTimer: () => {} });
  assert.equal(instances[0].lang, 'pl-PL');
  instances[0].onresult({ resultIndex: 0, results: [[{ transcript: 'cześć' }]] });
  assert.deepEqual(await pending, { ok: true, text: 'cześć' });

  const failing = runRecognitionTest({ win, setTimer: () => 1, clearTimer: () => {} });
  instances[1].onerror({ error: 'service-not-allowed' });
  assert.deepEqual(await failing, { ok: false, code: 'service' });

  const silent = runRecognitionTest({ win, setTimer: () => 1, clearTimer: () => {} });
  instances[2].onend();
  assert.deepEqual(await silent, { ok: false, code: 'no-speech' });

  assert.deepEqual(await runRecognitionTest({ win: {} }), { ok: false, code: 'unsupported' });
});

test('coordinator allows one diagnostic at a time', () => {
  const c = createDiagnosticsCoordinator();
  const first = c.start('mic');
  assert.equal(first.ok, true);
  assert.deepEqual(c.start('recognition'), { ok: false, code: 'busy' });
  assert.deepEqual(c.start('speaker'), { ok: false, code: 'busy' });
  first.finish();
  assert.equal(c.start('speaker').ok, true);
});

test('coordinator refuses mic tests during Realtime and stops voice mode first', () => {
  let realtime = true;
  let wanted = true;
  const stops = [];
  const c = createDiagnosticsCoordinator({
    isRealtimeActive: () => realtime,
    getVoiceMode: () => ({ isActive: () => wanted, stop: () => { wanted = false; stops.push(1); } }),
  });
  assert.deepEqual(c.start('mic'), { ok: false, code: 'realtime' });
  assert.deepEqual(c.start('recognition'), { ok: false, code: 'realtime' });
  assert.equal(stops.length, 0, 'a refused test leaves voice mode alone');
  // The speaker sample does not use the microphone.
  assert.equal(c.start('speaker').ok, true);
  c.cancel();
  realtime = false;
  const run = c.start('mic');
  assert.equal(run.ok, true);
  assert.equal(run.stoppedVoiceMode, true);
  assert.equal(stops.length, 1);
  run.finish();
  assert.equal(c.start('recognition').stoppedVoiceMode, false, 'nothing left to stop');
});

test('coordinator works with the real browser voice mode API (contract)', () => {
  let value = { ...IDLE_STATE };
  const state = { get: () => value, set: (next) => { value = next; } };
  const fakeInput = { start: () => ({ ok: true }), stop() {}, pause() {}, resume() {} };
  const mode = createBrowserVoiceMode({
    createInput: () => fakeInput,
    handlers: {},
    executors: {},
    eventTarget: null,
    isRealtimeActive: () => false,
    state,
  });
  const c = createDiagnosticsCoordinator({ getVoiceMode: () => mode });
  const idle = c.start('mic');
  assert.equal(idle.ok, true);
  assert.equal(idle.stoppedVoiceMode, false, 'an idle voice mode is left alone');
  idle.finish();
  assert.equal(mode.start().ok, true);
  assert.equal(mode.isActive(), true);
  const run = c.start('recognition');
  assert.equal(run.ok, true);
  assert.equal(run.stoppedVoiceMode, true);
  assert.equal(mode.isActive(), false, 'the live listener is stopped before the test');
  run.finish();
});

test('coordinator refuses recognition while the app speaks and drops it when speech starts', () => {
  let speaking = true;
  const c = createDiagnosticsCoordinator({ isSpeaking: () => speaking });
  assert.deepEqual(c.start('recognition'), { ok: false, code: 'speaking' });
  speaking = false;
  const run = c.start('recognition');
  assert.equal(run.ok, true);
  c.noteSpeaking(true);
  assert.equal(run.signal.aborted, true);
  assert.equal(c.active(), '');
  // A speaker sample is not interrupted by its own speaking event.
  const sample = c.start('speaker');
  c.noteSpeaking(true);
  assert.equal(sample.signal.aborted, false);
});

test('cancel aborts the running diagnostic', () => {
  const c = createDiagnosticsCoordinator();
  const run = c.start('mic');
  c.cancel();
  assert.equal(run.signal.aborted, true);
  assert.equal(c.start('mic').ok, true);
});

test('mic test cancelled before getUserMedia resolves stops the tracks and reports nothing', async () => {
  const stopped = [];
  let resolveStream;
  const nav = {
    mediaDevices: {
      getUserMedia: () => new Promise((resolve) => { resolveStream = resolve; }),
    },
  };
  const controller = new AbortController();
  const levels = [];
  const pending = runMicTest({
    win: { isSecureContext: true, AudioContext: class { constructor() { throw new Error('must not start'); } } },
    nav,
    signal: controller.signal,
    onLevel: (l) => levels.push(l),
  });
  controller.abort();
  resolveStream({ getTracks: () => [{ stop: () => stopped.push(1) }] });
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.equal(stopped.length, 1);
  assert.equal(levels.length, 0);
});

test('mic test aborted mid-run releases the stream', async () => {
  const env = makeAudioEnv({ levels: [10] });
  const controller = new AbortController();
  const pending = runMicTest({ ...env, signal: controller.signal, durationMs: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.equal(env.stopped.length, 2);
  assert.equal(env.isClosed(), true);
});

test('recognition test aborts through the signal and stops the recognizer', async () => {
  const instances = [];
  let stops = 0;
  class Fake {
    constructor() { instances.push(this); }
    start() {}
    stop() { stops += 1; }
  }
  const controller = new AbortController();
  const pending = runRecognitionTest({ win: { isSecureContext: true, SpeechRecognition: Fake }, signal: controller.signal, setTimer: () => 1, clearTimer: () => {} });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
  assert.ok(stops >= 1);
  // A late result after the abort changes nothing.
  instances[0].onresult({ resultIndex: 0, results: [[{ transcript: 'late' }]] });
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await runRecognitionTest({ win: { SpeechRecognition: Fake }, signal: already.signal }), { ok: false, code: 'cancelled' });
  assert.equal(instances.length, 1, 'an already aborted signal never starts a recognizer');
});

test('scrolling the section out of view does not cancel; a hidden panel does', () => {
  const out = [{ isIntersecting: false }];
  assert.equal(shouldCancelOnIntersection(out, () => true), false);
  assert.equal(shouldCancelOnIntersection(out, () => false), true);
  assert.equal(shouldCancelOnIntersection([{ isIntersecting: true }], () => false), false);
});

test('disposer removes listeners once and a re-mount does not double-register', () => {
  const listeners = new Set();
  const target = {
    addEventListener: (type, fn) => listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  let disconnected = 0;
  const d = createDisposer();
  d.listen(target, 'x', () => {});
  d.add(() => { disconnected += 1; });
  assert.equal(listeners.size, 1);
  d.dispose();
  d.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(disconnected, 1);
  assert.equal(d.size, 0);
  d.listen(target, 'x', () => {});
  assert.equal(listeners.size, 1);
});
