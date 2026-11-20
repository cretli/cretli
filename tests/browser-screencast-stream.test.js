/**
 * Screencast stream tests: the `/ws-browser` channel driven end to end against a
 * fake CDP session. Covers the flag being off (the existing pull path must not
 * change), binary framing, one `Page.screencastFrameAck` per frame, the
 * unacked-frame window with collapse, every fallback trigger, listener cleanup,
 * rate adaptation and the metrics surface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserWsHandler } from '../lib/browser/ws-handler.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';

const SCOPE = { workspaceFile: '/ws/a' };
const JPEG = Buffer.from('fake-jpeg-bytes', 'utf8');
const EPOCH = 1_700_000_000_000;

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    /** Ordered wire log: JSON control messages and binary frames in one sequence. */
    this.out = [];
    this.closeCode = null;
    this.closedReason = null;
  }

  send(payload, options) {
    if (options && options.binary) {
      this.out.push({ kind: 'binary', bytes: Buffer.from(payload) });
      return;
    }
    this.out.push({ kind: 'json', message: JSON.parse(String(payload)) });
  }

  close(code, reason) {
    this.closeCode = code;
    this.closedReason = reason;
    this.readyState = 3;
  }

  get sent() {
    return this.out.filter((row) => row.kind === 'json').map((row) => row.message);
  }

  get binaries() {
    return this.out.filter((row) => row.kind === 'binary').map((row) => row.bytes);
  }
}

/**
 * A CDP session that records every method call and lets the test push frames as
 * Chromium would, so `Page.screencastFrame` handling is exercised for real.
 */
function createFakeCdp(options = {}) {
  const calls = [];
  const listeners = new Map();
  const cdp = {
    calls,
    methods: () => calls.map((row) => row.method),
    callFor(method) {
      return calls.find((row) => row.method === method) || null;
    },
    countOf(method) {
      return calls.filter((row) => row.method === method).length;
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    off(event, handler) {
      const rows = listeners.get(event) || [];
      const index = rows.indexOf(handler);
      if (index >= 0) rows.splice(index, 1);
      if (!rows.length) listeners.delete(event);
    },
    emitFrame(frame) {
      for (const handler of [...(listeners.get('Page.screencastFrame') || [])]) handler(frame);
    },
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Page.startScreencast' && options.failStart) {
        throw new Error('Target closed');
      }
      if (method === 'Runtime.getHeapUsage') {
        if (options.noHeap) throw new Error('not supported');
        return { usedSize: 4096, totalSize: 8192 };
      }
      return {};
    },
    async detach() {
      calls.push({ method: 'detach' });
    },
  };
  return cdp;
}

/**
 * @param {{ cdp?: any, allowCdp?: boolean, failStart?: boolean, noHeap?: boolean }} [shape]
 */
function createFakeDriver(shape = {}) {
  const allowCdp = shape.allowCdp !== false;
  const state = { cdpSessions: 0, cdp: shape.cdp || createFakeCdp(shape) };
  class FakePage {
    /** @param {FakeContext} context */
    constructor(context) {
      this._context = context;
      this._url = 'about:blank';
      this._handlers = new Map();
      this._viewport = { width: 390, height: 844 };
      this.mouse = { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {}, wheel: async () => {} };
      this.keyboard = { type: async () => {}, down: async () => {}, up: async () => {}, press: async () => {} };
      this.touchscreen = { tap: async () => {} };
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    context() { return this._context; }
    async goto(url) { this._url = url; }
    async title() { return 'fake'; }
    url() { return this._url; }
    viewportSize() { return this._viewport; }
    async setViewportSize(v) { this._viewport = v; }
    async screenshot() { return JPEG; }
    async close() { for (const h of this._handlers.get('close') || []) h(); }
  }
  class FakeContext {
    constructor() {
      this._handlers = new Map();
      this.routes = [];
      this.context = this;
      this.browser = () => ({ process: () => ({ pid: 4242 }), close: async () => {} });
      if (allowCdp) this.newCDPSession = async () => { state.cdpSessions += 1; return state.cdp; };
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    async route(_pattern, handler) { this.routes.push(handler); }
    async newPage() {
      const page = new FakePage(this);
      for (const h of this._handlers.get('page') || []) h(page);
      return page;
    }
    async close() {}
  }
  class FakeBrowser {
    async newContext() { return new FakeContext(); }
    async close() {}
  }
  return {
    driver: { launch: async () => new FakeBrowser() },
    driverStatus: { status: 'available' },
    state,
  };
}

/**
 * @param {Record<string, any>} [overrides]
 */
async function setup(overrides = {}) {
  const fake = createFakeDriver(overrides.driverShape || {});
  const clock = { value: EPOCH };
  const manager = new BrowserSessionManager({
    driver: fake.driver,
    driverStatus: fake.driverStatus,
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    now: () => clock.value,
    screencastMetrics: { sampleResource: () => ({ cpuMicros: 1000, rssBytes: 424242, pid: 7 }) },
    ...overrides,
  });
  const session = await manager.createSession({ ownerSessionId: 'owner-a', ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, 'owner-a', SCOPE);
  const liveTab = manager.sessions.get(session.browserSessionId)?.tabs.get(tab.browserTabId) || null;
  return { manager, session, tab, liveTab, fake, clock, cdp: fake.state.cdp };
}

function connect(manager, session, tab, extra = {}) {
  const ws = new FakeWs();
  createBrowserWsHandler({
    browserManager: manager,
    ownerSessionId: 'owner-a',
    getScope: () => SCOPE,
    now: () => Date.now(),
    ...extra,
  })(ws, {
    url: `/ws-browser?session=${session.browserSessionId}&tab=${tab.browserTabId}`,
  });
  return ws;
}

function framePayload(frameIndex, atMs = EPOCH - 40) {
  return {
    data: JPEG.toString('base64'),
    frameIndex,
    metadata: { timestamp: atMs / 1000 },
  };
}

/** Streams one tab and returns the socket plus the parsed start answer. */
async function startStream(target, options = {}) {
  const { manager, session, tab } = target;
  const ws = connect(manager, session, tab, options.handlerOptions || {});
  ws.emit('message', JSON.stringify({
    type: 'screencast-start',
    browserTabId: tab.browserTabId,
    caps: { binary: options.binary !== false },
  }));
  await tick();
  return { ws, mode: ws.sent.find((row) => row.type === 'screencast-mode') };
}

test('the flag defaults to off and leaves the pull channel untouched', async () => {
  const target = await setup();
  const ws = connect(target.manager, target.session, target.tab);
  const ready = ws.sent[0];
  assert.equal(ready.type, 'ready');
  assert.equal(ready.screencast.mode, 'off');
  assert.equal(ready.screencast.available, false);
  assert.equal(ready.screencast.running, false);
  assert.equal(ready.limits.SCREENCAST_MODE, 'off');

  // Even a client that asks for pushed frames gets refused, with a reason.
  ws.emit('message', JSON.stringify({ type: 'screencast-start', caps: { binary: true } }));
  await tick();
  const mode = ws.sent.find((row) => row.type === 'screencast-mode');
  assert.equal(mode.mode, 'pull');
  assert.equal(mode.reason, 'mode-off');
  // Nothing CDP was ever opened, so nothing can leak.
  assert.equal(target.fake.state.cdpSessions, 0);
  assert.equal(target.manager.screencasts.size, 0);

  // And the existing pull cycle still answers a screenshot with a base64 frame.
  ws.emit('message', JSON.stringify({ type: 'screenshot', requestId: 'r1' }));
  await tick();
  const frame = ws.sent.find((row) => row.type === 'frame');
  assert.ok(frame, 'pull frame still delivered');
  assert.equal(frame.frame.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(frame.frame.data, 'base64').toString('utf8'), 'fake-jpeg-bytes');

  ws.emit('message', JSON.stringify({ type: 'frame-ack' }));
  target.clock.value += BROWSER_LIMITS.SCREENSHOT_MIN_INTERVAL_MS + 1;
  ws.emit('message', JSON.stringify({ type: 'screenshot', requestId: 'r2' }));
  await tick();
  assert.ok(ws.sent.some((row) => row.type === 'frame' && row.requestId === 'r2'));
});

test('an unconfigured manager does not read the env flag as streaming', async () => {
  const target = await setup();
  assert.equal(target.manager.screencastMode, 'off');
  const withEnv = await setup({ screencastMode: 'experimental' });
  assert.equal(withEnv.manager.screencastMode, 'experimental');
});

test('experimental mode opens CDP and answers Chromium for every frame', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const { ws, mode } = await startStream(target);
  assert.equal(mode.mode, 'screencast');
  assert.equal(mode.reason, 'started');
  assert.equal(target.fake.state.cdpSessions, 1);
  assert.equal(target.cdp.methods().includes('Page.startScreencast'), true);
  const params = target.cdp.callFor('Page.startScreencast').params;
  assert.equal(params.format, 'jpeg');
  assert.equal(params.quality, BROWSER_LIMITS.SCREENCAST_DEFAULT_QUALITY);
  assert.equal(params.maxWidth, 390);
  assert.equal(params.maxHeight, 844);
  assert.equal(params.everyNthFrame, 10, 'the default rate against a 30fps cadence');
  assert.equal(target.cdp.listenerCount('Page.screencastFrame'), 1);

  // One frame: a JSON header first, then the raw bytes as a binary WS frame.
  target.cdp.emitFrame(framePayload(11));
  await tick();
  const header = ws.sent.find((row) => row.type === 'screencast-frame');
  assert.ok(header, 'header control message');
  assert.equal(header.seq, 1);
  assert.equal(header.browserTabId, target.tab.browserTabId);
  assert.equal(header.frameIndex, 11);
  assert.equal(header.byteLength, JPEG.length);
  assert.equal(header.mimeType, 'image/jpeg');
  assert.equal(header.width, 390);
  assert.equal(ws.binaries.length, 1);
  assert.equal(ws.binaries[0].length, JPEG.length);
  // The pair has to stay adjacent: the client has no other way to match them.
  const headerIndex = ws.out.findIndex((row) => row.kind === 'json' && row.message.type === 'screencast-frame');
  assert.equal(ws.out[headerIndex + 1].kind, 'binary');
  assert.equal(target.cdp.countOf('Page.screencastFrameAck'), 0, 'no ack before the client answers');

  ws.emit('message', JSON.stringify({ type: 'screencast-ack', seq: 1, browserTabId: target.tab.browserTabId }));
  await tick();
  const ack = target.cdp.callFor('Page.screencastFrameAck');
  assert.deepEqual(ack.params, { frameIndex: 11 });

  // An unknown seq is refused instead of silently freeing the window.
  const before = target.cdp.countOf('Page.screencastFrameAck');
  ws.emit('message', JSON.stringify({ type: 'screencast-ack', seq: 99 }));
  await tick();
  assert.equal(target.cdp.countOf('Page.screencastFrameAck'), before);
  ws.emit('message', JSON.stringify({ type: 'screencast-ack', seq: 'nope' }));
  await tick();
  assert.ok(ws.sent.some((row) => row.type === 'error' && row.code === 'invalid-seq'));
});

test('a slow viewer collapses frames instead of growing the queue, and every frame is acked', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const { ws } = await startStream(target);
  const tabId = target.tab.browserTabId;

  target.cdp.emitFrame(framePayload(1));
  await tick();
  target.cdp.emitFrame(framePayload(2));
  await tick();

  // Window is one: the second frame collapsed the unacknowledged first one.
  const dropped = ws.sent.filter((row) => row.type === 'screencast-dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].seq, 1);
  assert.equal(target.cdp.countOf('Page.screencastFrameAck'), 1);
  assert.deepEqual(target.cdp.callFor('Page.screencastFrameAck').params, { frameIndex: 1 });
  assert.equal(ws.binaries.length, 2, 'both frames reached the wire');
  const headers = ws.sent.filter((row) => row.type === 'screencast-frame');
  assert.deepEqual(headers.map((row) => row.seq), [1, 2]);
  assert.equal(headers[headers.length - 1].frameIndex, 2);

  // Stopping drains what is still unacked, so Chromium is answered for frame 2 too.
  ws.emit('message', JSON.stringify({ type: 'screencast-stop', browserTabId: tabId }));
  await tick();
  assert.equal(target.cdp.countOf('Page.screencastFrameAck'), 2);
  assert.equal(target.cdp.methods().filter((m) => m === 'Page.stopScreencast').length, 1);
  assert.equal(target.cdp.listenerCount('Page.screencastFrame'), 0, 'no listener may survive a stop');
  assert.equal(target.manager.screencasts.size, 0);
  assert.equal(target.liveTab.screencast, null);
  const stopMode = ws.sent.filter((row) => row.type === 'screencast-mode').pop();
  assert.equal(stopMode.mode, 'pull');
  assert.equal(stopMode.reason, 'stopped');

  // A late event after teardown must not resurrect the stream.
  target.cdp.emitFrame(framePayload(3));
  await tick();
  assert.equal(ws.binaries.length, 2);
});

test('a dropped socket stops the producer instead of streaming into the void', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const { ws } = await startStream(target);
  assert.equal(target.cdp.listenerCount('Page.screencastFrame'), 1);

  ws.emit('close');
  await tick();
  assert.equal(target.manager.screencasts.size, 0);
  assert.equal(target.cdp.countOf('Page.stopScreencast'), 1);
  assert.equal(target.cdp.listenerCount('Page.screencastFrame'), 0);
  // An explicit client stop is not a fallback, so nothing is recorded as one.
  assert.equal(target.manager.screencastFallbacks.length, 0);
});

test('closing a tab detaches CDP and ends its stream', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  await startStream(target);
  await target.manager.closeTab(
    target.session.browserSessionId,
    target.tab.browserTabId,
    'owner-a',
    SCOPE,
  );
  assert.equal(target.manager.screencasts.size, 0);
  assert.equal(target.cdp.listenerCount('Page.screencastFrame'), 0);
  assert.equal(target.cdp.countOf('Page.stopScreencast'), 1);
  assert.equal(target.cdp.countOf('detach'), 1);
});

test('every fallback trigger switches the viewer back to the pull cycle', async () => {
  // 1. No CDP at all.
  const noCdp = await setup({ screencastMode: 'experimental', driverShape: { allowCdp: false } });
  const refused = await startStream(noCdp);
  assert.equal(refused.mode.mode, 'pull');
  assert.equal(refused.mode.reason, 'cdp-unavailable');
  assert.equal(noCdp.manager.screencasts.size, 0);
  assert.deepEqual(lastFallback(noCdp.manager).reason, 'cdp-unavailable');
  // The pull path keeps working right after the refusal.
  refused.ws.emit('message', JSON.stringify({ type: 'screenshot', requestId: 'p1' }));
  await tick();
  assert.ok(refused.ws.sent.some((row) => row.type === 'frame' && row.requestId === 'p1'));

  // 2. The viewer cannot read binary frames.
  const noBinary = await setup({ screencastMode: 'experimental' });
  const binary = await startStream(noBinary, { binary: false });
  assert.equal(binary.mode.mode, 'pull');
  assert.equal(binary.mode.reason, 'client-no-binary');
  assert.equal(noBinary.fake.state.cdpSessions, 0, 'no CDP session for a socket that cannot read frames');

  // 3. `Page.startScreencast` throws.
  const startFails = await setup({
    screencastMode: 'experimental',
    driverShape: { failStart: true },
  });
  const failed = await startStream(startFails);
  assert.equal(failed.mode.mode, 'pull');
  assert.equal(failed.mode.reason, 'start-failed');
  assert.equal(startFails.cdp.listenerCount('Page.screencastFrame'), 0, 'a failed start cleans its listener up');
  assert.equal(startFails.manager.screencasts.size, 0);
  assert.equal(startFails.cdp.countOf('Page.stopScreencast'), 1);

  // 4. The stream stalls: no frame within the bound.
  const stalled = await setup({ screencastMode: 'experimental' });
  const live = await startStream(stalled);
  assert.equal(live.mode.mode, 'screencast');
  stalled.cdp.emitFrame(framePayload(1));
  await tick();
  stalled.clock.value += BROWSER_LIMITS.SCREENCAST_STALL_TIMEOUT_MS + 1;
  live.ws.emit('message', JSON.stringify({ type: 'state' }));
  await tick();
  const stallMode = live.ws.sent.filter((row) => row.type === 'screencast-mode').pop();
  assert.equal(stallMode.mode, 'pull');
  assert.equal(stallMode.reason, 'stall');
  assert.deepEqual(lastFallback(stalled.manager).reason, 'stall');
  assert.equal(stalled.manager.screencasts.size, 0);
  // The refused start answer for a dead stream is stable, not a crash.
  live.ws.emit('message', JSON.stringify({ type: 'screencast-ack', seq: 1 }));
  await tick();
  assert.equal(stalled.cdp.countOf('Page.screencastFrameAck'), 1, 'the drain answered the stalled frame');
});

function lastFallback(manager) {
  return manager.screencastFallbacks[manager.screencastFallbacks.length - 1];
}

test('inbound messages stay JSON-only on a channel that now emits binary frames', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const { ws } = await startStream(target);
  ws.emit('message', Buffer.from('not json at all'));
  await tick();
  assert.ok(ws.sent.some((row) => row.type === 'error' && row.code === 'invalid-json'));
  ws.emit('message', 'x'.repeat(300 * 1024));
  await tick();
  assert.ok(ws.sent.some((row) => row.type === 'error' && row.code === 'message-too-large'));
  // The stream itself is still alive after both refusals.
  target.cdp.emitFrame(framePayload(5));
  await tick();
  assert.equal(ws.binaries.length, 1);
});

test('screencast is a read-only action, so plan mode may watch but not touch', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const { mode } = await startStream(target, { handlerOptions: {} });
  assert.equal(mode.mode, 'screencast');
  const ws = connect(target.manager, target.session, target.tab);
  ws.emit('message', JSON.stringify({
    type: 'screencast-start',
    mode: 'plan',
    chatId: 'chat-1',
    caps: { binary: true },
  }));
  await tick();
  assert.equal(
    ws.sent.filter((row) => row.type === 'screencast-mode').pop().mode,
    'screencast',
    'watching frames is allowed in plan mode',
  );
  ws.emit('message', JSON.stringify({ type: 'input', mode: 'plan', event: { kind: 'key', action: 'press', key: 'Enter' } }));
  await tick();
  assert.ok(ws.sent.some((row) => row.type === 'error' && row.code === 'plan-mode-readonly'));
});

test('rate pressure lowers fps and quality by restarting the stream, not by queueing', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const { ws } = await startStream(target);
  const started = target.cdp.countOf('Page.startScreencast');

  for (let i = 0; i < BROWSER_LIMITS.SCREENCAST_ADAPT_WINDOW; i += 1) {
    target.clock.value += 50;
    target.cdp.emitFrame(framePayload(100 + i));
    await tick();
  }

  assert.equal(target.cdp.countOf('Page.startScreencast'), started + 1, 'one restart for the new target');
  const starts = target.cdp.calls.filter((row) => row.method === 'Page.startScreencast');
  const latest = starts[starts.length - 1].params;
  assert.ok(latest.quality < BROWSER_LIMITS.SCREENCAST_DEFAULT_QUALITY, `quality lowered to ${latest.quality}`);
  assert.ok(latest.everyNthFrame > starts[0].params.everyNthFrame, `cadence slowed to every ${latest.everyNthFrame}`);
  assert.equal(target.cdp.methods().filter((m) => m === 'Page.stopScreencast').length, 1);
  const announced = ws.sent.filter((row) => row.type === 'screencast-target').pop();
  assert.equal(announced.target.quality, latest.quality);
  assert.equal(target.manager.screencasts.size, 1, 'the stream stayed alive');
  // The window never grew: one frame per admission, collapses answer Chromium.
  assert.ok(target.cdp.countOf('Page.screencastFrameAck') >= BROWSER_LIMITS.SCREENCAST_ADAPT_WINDOW - 1);
});

test('metrics ride on the state the panel already polls', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const { ws } = await startStream(target);

  ws.emit('message', JSON.stringify({ type: 'state' }));
  await tick();
  const early = ws.sent.filter((row) => row.type === 'state').pop().state;
  assert.equal(early.screencast.running, true);
  // Nothing measured yet: null, never a zero that reads like an idle stream.
  assert.equal(early.screencast.metrics.fps, null);
  assert.equal(early.screencast.metrics.avgLatencyMs, null);
  assert.equal(early.screencast.metrics.lastFrameAgeMs, null);

  target.clock.value += 200;
  target.cdp.emitFrame(framePayload(21));
  await tick();
  ws.emit('message', JSON.stringify({ type: 'screencast-ack', seq: 1 }));
  await tick();
  target.clock.value += 200;
  target.cdp.emitFrame(framePayload(22, target.clock.value - 40));
  await tick();
  ws.emit('message', JSON.stringify({ type: 'screencast-ack', seq: 2 }));
  await tick();

  // The heap sample is taken by the same poll that expires a stalled stream.
  await target.manager.expireScreencasts();
  await tick();

  ws.emit('message', JSON.stringify({ type: 'state' }));
  await tick();
  const metrics = ws.sent.filter((row) => row.type === 'state').pop().state.screencast.metrics;
  assert.equal(metrics.framesSent, 2);
  assert.equal(metrics.framesAcked, 2);
  assert.equal(metrics.framesDropped, 0);
  // Latency is capture -> client ack. Frame 21 was captured 40ms before the poll
  // advanced 200ms and the ack landed (240ms); frame 21's successor was acked in
  // the same tick it was captured 40ms earlier (40ms).
  assert.equal(metrics.lastLatencyMs, 40);
  assert.equal(metrics.avgLatencyMs, 140);
  assert.equal(metrics.fps, 5, 'two frames 200ms apart inside the window');
  assert.equal(metrics.browserPid, 4242);
  assert.equal(metrics.hostProcess.rssBytes, 424242);
  assert.equal(metrics.tabHeap.usedBytes, 4096);
  assert.equal(metrics.tabHeap.totalBytes, 8192);
});

test('a second viewer without binary caps is refused while a binary stream runs', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  const first = await startStream(target);
  assert.equal(first.mode.mode, 'screencast');
  target.cdp.emitFrame(framePayload(1));
  await tick();
  const binariesBefore = first.ws.binaries.length;

  const secondWs = connect(target.manager, target.session, target.tab);
  secondWs.emit('message', JSON.stringify({ type: 'screencast-start' }));
  await tick();
  const refused = secondWs.sent.filter((row) => row.type === 'screencast-mode').pop();
  assert.equal(refused.mode, 'pull');
  assert.equal(refused.reason, 'client-no-binary');
  const state = target.manager.screencasts.get(target.tab.browserTabId);
  assert.equal(state.sinks.size, 1);

  target.cdp.emitFrame(framePayload(2));
  await tick();
  assert.equal(first.ws.binaries.length, binariesBefore + 1);
  assert.equal(lastFallback(target.manager), undefined, 'refusing a second viewer is not a producer fallback');
});

test('an oversized frame is acked before the stream falls back', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  await startStream(target);
  const big = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  target.cdp.emitFrame({ data: big, frameIndex: 77, metadata: { timestamp: EPOCH / 1000 } });
  await tick();
  const acks = target.cdp.calls.filter((row) => row.method === 'Page.screencastFrameAck');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].params.frameIndex, 77);
  assert.deepEqual(lastFallback(target.manager).reason, 'frame-too-large');
  assert.equal(target.cdp.listenerCount('Page.screencastFrame'), 0);
  assert.equal(target.cdp.countOf('Page.stopScreencast'), 1);
  assert.equal(target.manager.screencasts.size, 0);
});

test('duplicate stopScreencastState calls tear down the producer once', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  await startStream(target);
  const state = target.manager.screencasts.get(target.tab.browserTabId);
  assert.ok(state);
  await Promise.all([
    target.manager.stopScreencastState(state),
    target.manager.stopScreencastState(state),
  ]);
  assert.equal(target.cdp.countOf('Page.stopScreencast'), 1);
  assert.equal(target.manager.screencasts.size, 0);
});

test('restartScreencastIfAdapted is a no-op when the stream is already torn down', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  await startStream(target);
  const state = target.manager.screencasts.get(target.tab.browserTabId);
  state.running = false;
  const startedBefore = target.cdp.countOf('Page.startScreencast');
  const ok = await target.manager.restartScreencastIfAdapted(state);
  assert.equal(ok, false);
  assert.equal(target.cdp.countOf('Page.startScreencast'), startedBefore);
});

test('a restart interrupted by teardown does not start screencast again', async () => {
  const target = await setup({ screencastMode: 'experimental' });
  await startStream(target);
  const state = target.manager.screencasts.get(target.tab.browserTabId);
  let releaseRestartStop;
  const restartStopBlocked = new Promise((resolve) => { releaseRestartStop = resolve; });
  const baseSend = target.cdp.send.bind(target.cdp);
  let deferRestartStop = false;
  target.cdp.send = async (method, params) => {
    if (method === 'Page.stopScreencast' && deferRestartStop) {
      deferRestartStop = false;
      await restartStopBlocked;
    }
    return baseSend(method, params);
  };
  deferRestartStop = true;
  for (let i = 0; i < BROWSER_LIMITS.SCREENCAST_ADAPT_WINDOW; i += 1) {
    target.clock.value += 50;
    target.cdp.emitFrame(framePayload(200 + i));
    await tick();
  }
  assert.equal(state.restarting, true);
  await target.manager.stopScreencastState(state, { reason: 'no-viewers', recordFallback: false });
  releaseRestartStop();
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(target.cdp.listenerCount('Page.screencastFrame'), 0);
  const startsAfterInterrupt = target.cdp.calls.filter((row) => row.method === 'Page.startScreencast');
  assert.equal(startsAfterInterrupt.length, 1, 'only the initial start, no restart after teardown');
  assert.equal(state.restarting, false);
});

test('a tab that cannot answer the heap probe keeps the dimension null', async () => {
  const target = await setup({
    screencastMode: 'experimental',
    driverShape: { noHeap: true },
  });
  await startStream(target);
  target.cdp.emitFrame(framePayload(1));
  await tick();
  await target.manager.expireScreencasts();
  await tick();
  const status = target.manager.screencastStatus({ browserTabId: target.tab.browserTabId });
  assert.equal(status.running, true);
  assert.equal(status.metrics.tabHeap.usedBytes, null);
});
