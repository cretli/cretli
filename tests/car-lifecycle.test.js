import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setSharedWakeLockEnv, syncAgentWakeLock } from '../app_front/features/pwa/wakeLock.js';
import { MEDIA_ACTIONS } from '../app_front/features/car/carMediaSession.js';
import { closeCarView, openCarView, restoreCarView, setCarLifecycleDeps } from '../app_front/features/car/carService.js';

const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
});

function setup() {
  store.clear();
  const sentinels = [];
  const handlers = {};
  const mediaSession = { metadata: undefined, playbackState: 'none', setActionHandler: (a, fn) => { handlers[a] = fn; } };
  const audios = [];
  const listeners = {};
  const doc = { hidden: false, addEventListener: (t, fn) => { listeners[t] = fn; } };
  const wakeNav = {
    wakeLock: {
      async request() {
        const s = { released: false, async release() { s.released = true; }, addEventListener() {} };
        sentinels.push(s);
        return s;
      },
    },
  };
  setSharedWakeLockEnv({ navigator: wakeNav, document: doc });
  setCarLifecycleDeps({
    loadView: async () => {},
    navigator: { mediaSession },
    MediaMetadata: class { constructor(init) { Object.assign(this, init); } },
    createAudio: () => {
      const a = { plays: 0, paused: 0, src: 'x', play() { a.plays += 1; return Promise.resolve(); }, pause() { a.paused += 1; } };
      audios.push(a);
      return a;
    },
  });
  return { sentinels, handlers, mediaSession, audios, listeners, doc };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const live = (sentinels) => sentinels.filter((s) => !s.released).length;

test('openCarView takes the car wake lock and starts Media Session; closeCarView releases both', async (t) => {
  const env = setup();
  t.after(() => { closeCarView(); setCarLifecycleDeps({}); });
  await openCarView();
  await tick();
  assert.equal(live(env.sentinels), 1, 'wake lock held with no agent running');
  assert.deepEqual(Object.keys(env.handlers).sort(), [...MEDIA_ACTIONS].sort());
  assert.ok(env.handlers.play);
  assert.equal(env.audios.length, 1);
  assert.ok(env.audios[0].plays >= 1);
  assert.equal(env.mediaSession.metadata?.artist, 'Cretli');

  closeCarView();
  await tick();
  assert.equal(live(env.sentinels), 0);
  for (const action of MEDIA_ACTIONS) assert.equal(env.handlers[action], null);
  assert.equal(env.mediaSession.metadata, null);
  assert.equal(env.audios[0].paused, 1);
});

test('closing the car view keeps the lock while an agent run still needs it', async (t) => {
  const env = setup();
  t.after(() => { syncAgentWakeLock(false); closeCarView(); setCarLifecycleDeps({}); });
  syncAgentWakeLock(true);
  await openCarView();
  await tick();
  assert.equal(env.sentinels.length, 1, 'one shared sentinel');
  closeCarView();
  await tick();
  assert.equal(live(env.sentinels), 1);
});

test('visibilitychange re-requests the lock while the view is open', async (t) => {
  const env = setup();
  t.after(() => { closeCarView(); setCarLifecycleDeps({}); });
  await openCarView();
  await tick();
  env.doc.hidden = true;
  env.listeners.visibilitychange();
  await tick();
  assert.equal(live(env.sentinels), 0);
  env.doc.hidden = false;
  env.listeners.visibilitychange();
  await tick();
  assert.equal(live(env.sentinels), 1);
});

test('restoreCarView after a reload re-establishes lock and Media Session; it is a no-op when car mode is off', async (t) => {
  const env = setup();
  t.after(() => { closeCarView(); setCarLifecycleDeps({}); });
  restoreCarView();
  await tick();
  assert.equal(live(env.sentinels), 0);
  assert.equal(env.audios.length, 0);

  store.set('cretli-car-mode', 'on');
  restoreCarView();
  await tick();
  assert.equal(live(env.sentinels), 1);
  assert.ok(env.handlers.nexttrack);
  assert.equal(env.audios.length, 1);
});

function fakeDocument() {
  const reg = new Map();
  const doc = {
    hidden: false,
    body: { appendChild() {} },
    querySelector: () => ({ remove() {} }),
    createElement: () => ({}),
    addEventListener: (type, fn) => { if (!reg.has(type)) reg.set(type, new Set()); reg.get(type).add(fn); },
    removeEventListener: (type, fn) => { reg.get(type)?.delete(fn); },
    // Only the retry gestures; other modules register unrelated listeners (e.g. visibilitychange).
    count: () => ['pointerup', 'click', 'keydown'].reduce((n, type) => n + (reg.get(type)?.size || 0), 0),
    fire: (type) => { for (const fn of [...(reg.get(type) || [])]) fn(); },
  };
  return doc;
}

function installDocument(t) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = fakeDocument();
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: doc });
  t.after(() => {
    if (prev) Object.defineProperty(globalThis, 'document', prev);
    else delete globalThis.document;
  });
  return doc;
}

test('rejected autoplay retries on click until play() succeeds, then drops the listeners', async (t) => {
  const doc = installDocument(t);
  const env = setup();
  let reject = 2;
  setCarLifecycleDeps({
    loadView: async () => {},
    navigator: { mediaSession: env.mediaSession },
    MediaMetadata: class { constructor(init) { Object.assign(this, init); } },
    createAudio: () => ({ play() { return reject-- > 0 ? Promise.reject(new Error('NotAllowed')) : Promise.resolve(); }, pause() {} }),
  });
  t.after(() => { closeCarView(); setCarLifecycleDeps({}); });
  await openCarView();
  await tick();
  assert.equal(env.mediaSession.playbackState, 'none');
  assert.ok(doc.count() > 0, 'gesture listeners armed after the rejection');

  doc.fire('pointerdown');
  await tick();
  assert.equal(env.mediaSession.playbackState, 'none', 'pointerdown is not a retry trigger');

  doc.fire('click'); // second rejection: stay armed
  await tick();
  assert.equal(env.mediaSession.playbackState, 'none');
  assert.ok(doc.count() > 0, 'still armed after a rejected retry');

  doc.fire('click'); // succeeds
  await tick();
  assert.equal(env.mediaSession.playbackState, 'playing');
  assert.equal(doc.count(), 0, 'listeners removed after success');
});

test('closing car mode removes pending gesture listeners', async (t) => {
  const doc = installDocument(t);
  const env = setup();
  setCarLifecycleDeps({
    loadView: async () => {},
    navigator: { mediaSession: env.mediaSession },
    createAudio: () => ({ play: () => Promise.reject(new Error('NotAllowed')), pause() {} }),
  });
  t.after(() => { closeCarView(); setCarLifecycleDeps({}); });
  await openCarView();
  await tick();
  assert.ok(doc.count() > 0);
  closeCarView();
  assert.equal(doc.count(), 0);
});

test('closeCarView before start() settles attaches nothing and leaves playbackState untouched', async (t) => {
  const doc = installDocument(t);
  const env = setup();
  let settle;
  setCarLifecycleDeps({
    loadView: async () => {},
    navigator: { mediaSession: env.mediaSession },
    MediaMetadata: class { constructor(init) { Object.assign(this, init); } },
    createAudio: () => ({ play: () => new Promise((_, rej) => { settle = rej; }), pause() {} }),
  });
  t.after(() => { closeCarView(); setCarLifecycleDeps({}); });
  await openCarView();
  await tick();
  assert.ok(settle, 'play() is pending');
  closeCarView();
  assert.equal(env.mediaSession.playbackState, 'none');
  settle(new Error('NotAllowed'));
  await tick();
  assert.equal(doc.count(), 0, 'no listeners attached after close');
  assert.equal(env.mediaSession.playbackState, 'none');
  assert.equal(env.mediaSession.metadata, null, 'metadata not re-set after close');
});
