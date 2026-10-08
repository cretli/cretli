/**
 * Browser WebSocket handler tests: session auth, plan-mode guard, backpressure,
 * per-socket queue and input rate limiting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserWsHandler } from '../lib/browser/ws-handler.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import { evaluateWidgetHandshake } from '../lib/ws/ws-auth-boundary.js';

const SCOPE = { workspaceFile: '/ws/a' };

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCode = null;
    this.closedReason = null;
  }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close(code, reason) { this.closeCode = code; this.closedReason = reason; this.readyState = 3; }
}

function createFakeDriver() {
  class FakePage {
    constructor() {
      this._url = 'about:blank';
      this._handlers = new Map();
      this._viewport = { width: 390, height: 844 };
      this.mouse = { move: async () => {}, down: async () => {}, up: async () => {}, click: async () => {}, wheel: async () => {} };
      this.keyboard = { type: async () => {}, down: async () => {}, up: async () => {}, press: async () => {} };
      this.touchscreen = { tap: async () => {} };
    }
    on(event, handler) { if (!this._handlers.has(event)) this._handlers.set(event, []); this._handlers.get(event).push(handler); }
    async goto(url) { this._url = url; }
    async title() { return 'fake'; }
    url() { return this._url; }
    viewportSize() { return this._viewport; }
    async setViewportSize(v) { this._viewport = v; }
    async screenshot() { return Buffer.from('fake-jpeg'); }
    async close() { for (const h of this._handlers.get('close') || []) h(); }
  }
  class FakeContext {
    constructor() { this._handlers = new Map(); this.routes = []; }
    on(event, handler) { if (!this._handlers.has(event)) this._handlers.set(event, []); this._handlers.get(event).push(handler); }
    async route(_p, handler) { this.routes.push(handler); }
    async newPage() { const p = new FakePage(); for (const h of this._handlers.get('page') || []) h(p); return p; }
    async close() {}
  }
  class FakeBrowser { async newContext() { return new FakeContext(); } async close() {} }
  return { async launch() { return new FakeBrowser(); } };
}

async function setup(overrides = {}) {
  const manager = new BrowserSessionManager({
    driver: createFakeDriver(),
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    ...overrides,
  });
  const session = await manager.createSession({ ownerSessionId: 'owner-a', ...SCOPE });
  const [tab] = manager.listTabs(session.browserSessionId, 'owner-a', SCOPE);
  return { manager, session, tab };
}

function connect(manager, session, tab, extra = {}) {
  const ws = new FakeWs();
  createBrowserWsHandler({
    browserManager: manager,
    ownerSessionId: 'owner-a',
    getScope: () => SCOPE,
    ...extra,
  })(ws, { url: `/ws-browser?session=${session.browserSessionId}${tab ? `&tab=${tab.browserTabId}` : ''}` });
  return ws;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('widget access protocol is rejected on the Browser WS path', () => {
  const req = { headers: { 'sec-websocket-protocol': 'cretli-widget, widget-token-abc' } };
  const decision = evaluateWidgetHandshake(req, '/ws-browser', {});
  assert.equal(decision.action, 'reject');
  assert.equal(decision.closeCode, 4403);
});

test('missing session id closes with 4400', async () => {
  const { manager } = await setup();
  const ws = new FakeWs();
  createBrowserWsHandler({ browserManager: manager, ownerSessionId: 'owner-a', getScope: () => SCOPE })(
    ws,
    { url: '/ws-browser' },
  );
  assert.equal(ws.closeCode, 4400);
  assert.equal(ws.sent[0].code, 'missing-session');
});

test('foreign owner is rejected with 4403', async () => {
  const { manager, session } = await setup();
  const ws = new FakeWs();
  createBrowserWsHandler({ browserManager: manager, ownerSessionId: 'owner-b', getScope: () => SCOPE })(
    ws,
    { url: `/ws-browser?session=${session.browserSessionId}` },
  );
  assert.equal(ws.closeCode, 4403);
  assert.equal(ws.sent[0].code, 'forbidden-owner');
});

test('foreign workspace is rejected with 4403', async () => {
  const { manager, session } = await setup();
  const ws = new FakeWs();
  createBrowserWsHandler({
    browserManager: manager,
    ownerSessionId: 'owner-a',
    getScope: () => ({ workspaceFile: '/ws/other' }),
  })(ws, { url: `/ws-browser?session=${session.browserSessionId}` });
  assert.equal(ws.closeCode, 4403);
  assert.equal(ws.sent[0].code, 'forbidden-workspace');
});

test('plan mode blocks input but allows screenshot', async () => {
  const { manager, session, tab } = await setup();
  const ws = connect(manager, session, tab);
  assert.equal(ws.sent[0].type, 'ready');

  ws.emit('message', JSON.stringify({ type: 'input', event: { kind: 'key', action: 'press', key: 'Enter' }, mode: 'plan' }));
  await tick();
  assert.ok(ws.sent.some((m) => m.type === 'error' && m.code === 'plan-mode-readonly'));

  ws.emit('message', JSON.stringify({ type: 'screenshot', requestId: 'r1', mode: 'plan' }));
  await tick();
  const frame = ws.sent.find((m) => m.type === 'frame');
  assert.ok(frame);
  assert.equal(frame.frame.mimeType, 'image/jpeg');
});

test('enforces one unacknowledged screenshot frame per tab', async () => {
  // Allow forced frames immediately so this test isolates WS backpressure from
  // the manager's force interval (covered in the session-manager tests).
  const { manager, session, tab } = await setup({
    limits: { ...BROWSER_LIMITS, SCREENSHOT_MIN_INTERVAL_MS: 0, SCREENSHOT_FORCE_MIN_INTERVAL_MS: 0 },
  });
  const ws = connect(manager, session, tab);
  ws.emit('message', JSON.stringify({ type: 'screenshot', requestId: 'r1', force: true }));
  await tick();
  ws.emit('message', JSON.stringify({ type: 'screenshot', requestId: 'r2', force: true }));
  await tick();
  const skipped = ws.sent.find((m) => m.type === 'frame-skipped');
  assert.ok(skipped);
  assert.equal(skipped.reason, 'backpressure');

  ws.emit('message', JSON.stringify({ type: 'frame-ack' }));
  await tick();
  // Acknowledge clears backpressure; the next frame is delivered.
  ws.emit('message', JSON.stringify({ type: 'screenshot', requestId: 'r3', force: true }));
  await tick();
  assert.ok(ws.sent.some((m) => m.type === 'frame' && m.requestId === 'r3'));
});

test('rate limits rapid input events', async () => {
  const { manager, session, tab } = await setup();
  const ws = connect(manager, session, tab, { inputMinIntervalMs: 10_000 });
  ws.emit('message', JSON.stringify({ type: 'input', mode: 'agent', event: { kind: 'key', action: 'press', key: 'Enter' } }));
  ws.emit('message', JSON.stringify({ type: 'input', mode: 'agent', event: { kind: 'key', action: 'press', key: 'Enter' } }));
  await tick();
  assert.ok(ws.sent.some((m) => m.type === 'ack' && m.op === 'input'));
  assert.ok(ws.sent.some((m) => m.type === 'error' && m.code === 'input-rate-limited'));
});

test('rejects messages beyond the bounded queue', async () => {
  const { manager, session, tab } = await setup();
  const ws = connect(manager, session, tab, { maxQueue: 1 });
  for (let i = 0; i < 4; i += 1) {
    ws.emit('message', JSON.stringify({ type: 'ping' }));
  }
  await tick();
  assert.ok(ws.sent.some((m) => m.type === 'error' && m.code === 'queue-full'));
});

test('rejects oversized and invalid messages', async () => {
  const { manager, session } = await setup();
  const ws = connect(manager, session, null);
  ws.emit('message', 'not-json');
  await tick();
  assert.ok(ws.sent.some((m) => m.code === 'invalid-json'));

  ws.emit('message', 'x'.repeat(300 * 1024));
  await tick();
  assert.ok(ws.sent.some((m) => m.code === 'message-too-large'));
});

test('registers a live WS subscriber after ready and releases it on close', async () => {
  const { manager, session, tab } = await setup();
  const ws = connect(manager, session, tab);
  assert.equal(ws.sent[0].type, 'ready');
  // The handler must hold one live subscriber so sweepIdle() keeps the session
  // the panel/agent is watching. Before this wiring the count was always 0.
  assert.equal(manager.hasLiveWsSubscriber(session.browserSessionId), true);

  // close releases the subscriber (the idempotent release fn, not a manual
  // removeWsSubscriber call) so an abandoned tab can be swept again.
  ws.emit('close');
  assert.equal(manager.hasLiveWsSubscriber(session.browserSessionId), false);
});

test('ping touches the session and replies with an unchanged pong frame', async () => {
  const { manager, session, tab } = await setup();
  const ws = connect(manager, session, tab);
  const sessionId = session.browserSessionId;
  // Push the activity stamp into the past so only a real touch can move it.
  manager.sessions.get(sessionId).lastActivityAt = 0;

  ws.emit('message', JSON.stringify({ type: 'ping' }));
  await tick();

  const pong = ws.sent.find((m) => m.type === 'pong');
  assert.ok(pong, 'ping must still be answered with a pong');
  // The reply frame keeps its exact shape: no new fields ride along with the touch.
  assert.deepEqual(Object.keys(pong).sort(), ['at', 'type']);
  assert.equal(typeof pong.at, 'number');

  // The keepalive refreshes lastActivityAt through touchSessionById; pre-fix it stayed 0.
  assert.ok(manager.sessions.get(sessionId).lastActivityAt > 0, 'ping must touch the session');
});
