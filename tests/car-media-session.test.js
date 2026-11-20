import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCarMediaSession, mapMediaActions, silentWavDataUri, MEDIA_ACTIONS } from '../app_front/features/car/carMediaSession.js';
import { createWakeLock } from '../app_front/features/pwa/wakeLock.js';

function fakeSession() {
  const handlers = {};
  return {
    handlers,
    metadata: undefined,
    playbackState: 'none',
    setActionHandler(action, fn) { handlers[action] = fn; },
  };
}

function fakeAudio() {
  const audio = { plays: 0, paused: 0, src: 'x', loop: false, volume: 1, play() { audio.plays += 1; return Promise.resolve(); }, pause() { audio.paused += 1; } };
  return audio;
}

function setup(overrides = {}) {
  const mediaSession = fakeSession();
  const audio = fakeAudio();
  const calls = [];
  const session = createCarMediaSession({
    navigator: { mediaSession },
    createAudio: () => audio,
    MediaMetadata: class { constructor(init) { Object.assign(this, init); } },
    handlers: { toggleMic: () => calls.push('mic'), cycleAgent: (d) => calls.push(`cycle:${d}`) },
    ...overrides,
  });
  return { mediaSession, audio, calls, session };
}

test('mapMediaActions routes keys to handlers', () => {
  const calls = [];
  const map = mapMediaActions({ toggleMic: () => calls.push('mic'), cycleAgent: (d) => calls.push(d) });
  map.play(); map.pause(); map.stop(); map.nexttrack(); map.previoustrack();
  assert.deepEqual(calls, ['mic', 'mic', 'mic', 1, -1]);
});

test('start registers every action and runs the silent audio; keys call handlers', async () => {
  const { mediaSession, audio, calls, session } = setup();
  assert.equal(await session.start(), true);
  assert.deepEqual(Object.keys(mediaSession.handlers).sort(), [...MEDIA_ACTIONS].sort());
  assert.equal(audio.loop, true);
  mediaSession.handlers.nexttrack();
  mediaSession.handlers.previoustrack();
  mediaSession.handlers.pause();
  assert.deepEqual(calls, ['cycle:1', 'cycle:-1', 'mic']);
  assert.ok(audio.plays >= 4, 'audio restarted after each key');
});

test('metadata is set while running and cleared with handlers on stop', async () => {
  const { mediaSession, audio, session } = setup();
  await session.start();
  session.setMetadata({ title: 'Fix checkout' });
  assert.equal(mediaSession.metadata.title, 'Fix checkout');
  session.stop();
  assert.equal(mediaSession.metadata, null);
  for (const action of MEDIA_ACTIONS) assert.equal(mediaSession.handlers[action], null);
  assert.equal(audio.paused, 1);
  assert.equal(session.isRunning(), false);
});

test('rejected autoplay reports false and resume retries', async () => {
  let allow = false;
  const audio = fakeAudio();
  audio.play = () => (allow ? Promise.resolve() : Promise.reject(new Error('NotAllowed')));
  const { session } = setup({ createAudio: () => audio });
  assert.equal(await session.start(), false);
  allow = true;
  assert.equal(await session.resume(), true);
});

test('unsupported navigator is a no-op', async () => {
  const session = createCarMediaSession({ navigator: {}, handlers: {} });
  assert.equal(await session.start(), false);
  session.stop();
});

test('silent wav is a valid RIFF data URI', () => {
  assert.match(silentWavDataUri(), /^data:audio\/wav;base64,UklGR/);
});

function wakeEnv({ hidden = false } = {}) {
  const listeners = {};
  const sentinels = [];
  const doc = { hidden, addEventListener(type, fn) { listeners[type] = fn; } };
  const nav = {
    wakeLock: {
      async request() {
        const s = { released: false, async release() { s.released = true; if (s.onRelease) s.onRelease(); }, addEventListener(_t, fn) { s.onRelease = fn; } };
        sentinels.push(s);
        return s;
      },
    },
  };
  return { doc, nav, listeners, sentinels };
}

test('wake lock is held while the car reason is set, even without an agent', async () => {
  const env = wakeEnv();
  const lock = createWakeLock({ navigator: env.nav, document: env.doc });
  await lock.setReason('car', true);
  assert.equal(lock.isHeld(), true);
  await lock.setReason('car', false);
  assert.equal(lock.isHeld(), false);
  assert.equal(env.sentinels[0].released, true);
});

test('releasing car does not release the agent lock (and vice versa)', async () => {
  const env = wakeEnv();
  const lock = createWakeLock({ navigator: env.nav, document: env.doc });
  await lock.setReason('agent', true);
  await lock.setReason('car', true);
  assert.equal(env.sentinels.length, 1, 'one shared sentinel');
  await lock.setReason('car', false);
  assert.equal(lock.isHeld(), true);
  assert.equal(env.sentinels[0].released, false);
  await lock.setReason('agent', false);
  assert.equal(lock.isHeld(), false);
});

test('lock is requested again after visibilitychange to visible', async () => {
  const env = wakeEnv();
  const lock = createWakeLock({ navigator: env.nav, document: env.doc });
  await lock.setReason('car', true);
  env.doc.hidden = true;
  env.listeners.visibilitychange();
  await new Promise((r) => setImmediate(r));
  assert.equal(lock.isHeld(), false);
  env.doc.hidden = false;
  env.listeners.visibilitychange();
  await new Promise((r) => setImmediate(r));
  assert.equal(lock.isHeld(), true);
  assert.equal(env.sentinels.length, 2);
});

test('a play() of a closed session does not overwrite the state of a reopened one', async () => {
  const mediaSession = fakeSession();
  /** @type {Array<(value?: unknown) => void>} */
  const settlers = [];
  const rejecters = [];
  const createAudio = () => ({
    loop: false,
    volume: 1,
    src: 'x',
    play: () => new Promise((resolve, reject) => { settlers.push(resolve); rejecters.push(reject); }),
    pause() {},
  });
  const session = createCarMediaSession({
    navigator: { mediaSession },
    createAudio,
    MediaMetadata: class {},
    handlers: { toggleMic() {}, cycleAgent() {} },
  });
  const first = session.start();
  session.stop();
  const second = session.start();
  settlers[1]();
  assert.equal(await second, true);
  assert.equal(mediaSession.playbackState, 'playing');
  // The old autoplay is refused late; it must not reset the new session to 'none'.
  rejecters[0](new Error('NotAllowedError'));
  assert.equal(await first, false);
  assert.equal(mediaSession.playbackState, 'playing');
});
