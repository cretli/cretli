/**
 * Browser panel live-view wiring (`/ws-browser`).
 *
 * The connection logic is exported as pure helpers plus a factory with an
 * injected socket and timers, so the protocol decisions and the socket
 * lifecycle are exercised here without a DOM. The panel source assertions at
 * the end guard the vertical slice (cursor consumption, i18n, workspace
 * refresh, REST fallback) in the same spirit as browser-panel-wiring.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_WS_CLOSE,
  BROWSER_WS_MUTATION_TYPES,
  browserWsReconnectDelayMs,
  buildBrowserWsFrameAck,
  buildBrowserWsUrl,
  classifyBrowserWsClose,
  createBrowserWsClient,
  resolveBrowserWsRoute,
  shouldAckBrowserWsFrame,
  withBrowserWsGuardContext,
} from '../app_front/features/browser/browserWsClient.js';
import { guardContext, setBrowserPanelGuardDeps } from '../app_front/features/browser/browserPanel.js';
import { BROWSER_WS_PATH } from '../lib/browser/constants.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/** @type {FakeSocket[]} */
const sockets = [];

class FakeSocket {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    /** @type {Array<Record<string, any>>} */
    this.sent = [];
    /** @type {{ code: number, reason: string } | null} */
    this.closed = null;
    this.readyState = 1;
    sockets.push(this);
  }

  /** @param {string} payload */
  send(payload) {
    this.sent.push(JSON.parse(String(payload)));
  }

  /**
   * @param {number} code
   * @param {string} reason
   */
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

/**
 * Deterministic timer queue: at most one timer per key is pending in the
 * client, so a map keyed by insertion id is enough to assert exact delays.
 * @returns {Record<string, any>}
 */
function createFakeScheduler() {
  let nextId = 0;
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const tasks = new Map();
  return {
    /**
     * @param {() => void} fn
     * @param {number} ms
     * @returns {number}
     */
    setTimeoutFn(fn, ms) {
      const id = ++nextId;
      tasks.set(id, { fn, ms });
      return id;
    },
    /** @param {number} id */
    clearTimeoutFn(id) {
      tasks.delete(id);
    },
    /** @returns {number} */
    count() {
      return tasks.size;
    },
    /** @returns {number} */
    onlyDelay() {
      assert.equal(tasks.size, 1, 'expected exactly one pending timer');
      return [...tasks.values()][0].ms;
    },
    /**
     * Runs the oldest pending timer once.
     * @returns {number}
     */
    runNext() {
      const entry = [...tasks.entries()].sort((a, b) => a[0] - b[0])[0];
      if (!entry) throw new Error('no timer pending');
      tasks.delete(entry[0]);
      entry[1].fn();
      return entry[1].ms;
    },
    /**
     * Runs every timer pending at call time once (timers scheduled by that run
     * stay queued), so the frame/pull/keepalive loops can be advanced together.
     */
    runAllCurrent() {
      const entries = [...tasks.entries()].sort((a, b) => a[0] - b[0]);
      for (const [id, task] of entries) {
        if (tasks.delete(id)) task.fn();
      }
    },
  };
}

/**
 * @param {Record<string, any>} [options]
 * @returns {{ client: ReturnType<typeof createBrowserWsClient>, scheduler: Record<string, any>, socket: () => FakeSocket }}
 */
function createHarness(options = {}) {
  sockets.length = 0;
  const scheduler = createFakeScheduler();
  const client = createBrowserWsClient({
    WebSocketImpl: FakeSocket,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
    isActive: () => true,
    ...options,
  });
  return {
    client,
    scheduler,
    socket: () => sockets[sockets.length - 1],
  };
}

/**
 * @param {FakeSocket} socket
 * @param {Record<string, any>} message
 */
function deliver(socket, message) {
  socket.onmessage({ data: JSON.stringify(message) });
}

test('buildBrowserWsUrl derives ws/wss from the page and carries session/tab', () => {
  assert.equal(
    buildBrowserWsUrl({ sessionId: 's1', tabId: 't1', protocol: 'https:', host: 'example.com:3011' }),
    `wss://example.com:3011${BROWSER_WS_PATH}?session=s1&tab=t1`,
  );
  assert.equal(
    buildBrowserWsUrl({ sessionId: 's1', protocol: 'http:', host: 'your-pc:3011' }),
    `ws://your-pc:3011${BROWSER_WS_PATH}?session=s1`,
  );
  assert.equal(
    buildBrowserWsUrl({ protocol: 'http:', host: 'your-pc:3011' }),
    `ws://your-pc:3011${BROWSER_WS_PATH}`,
  );
  // No widget subprotocol/token ever appears in the URL.
  assert.doesNotMatch(buildBrowserWsUrl({ sessionId: 's1', protocol: 'http:', host: 'x' }), /cretli-widget|token/);
});

test('browserWsReconnectDelayMs grows, caps and restarts from the base', () => {
  assert.equal(browserWsReconnectDelayMs(0, { baseMs: 500, maxMs: 4000 }), 500);
  assert.equal(browserWsReconnectDelayMs(1, { baseMs: 500, maxMs: 4000 }), 1000);
  assert.equal(browserWsReconnectDelayMs(2, { baseMs: 500, maxMs: 4000 }), 2000);
  assert.equal(browserWsReconnectDelayMs(3, { baseMs: 500, maxMs: 4000 }), 4000);
  assert.equal(browserWsReconnectDelayMs(25, { baseMs: 500, maxMs: 4000 }), 4000);
  // A `ready` frame resets the attempt counter, so index 0 is the base again.
  assert.equal(browserWsReconnectDelayMs(0, { baseMs: 500, maxMs: 4000 }), 500);
  assert.equal(browserWsReconnectDelayMs(0), 600);
});

test('classifyBrowserWsClose separates policy stops from session resyncs', () => {
  assert.equal(classifyBrowserWsClose(BROWSER_WS_CLOSE.LOGIN_REQUIRED), 'resync');
  assert.equal(classifyBrowserWsClose(BROWSER_WS_CLOSE.SESSION_GONE), 'resync');
  assert.equal(classifyBrowserWsClose(BROWSER_WS_CLOSE.MISSING_SESSION), 'stop');
  assert.equal(classifyBrowserWsClose(BROWSER_WS_CLOSE.FORBIDDEN), 'stop');
  assert.equal(classifyBrowserWsClose(1006), 'retry');
  assert.equal(classifyBrowserWsClose(undefined), 'retry');
  // The constants mirror the server contract.
  assert.equal(BROWSER_WS_CLOSE.MISSING_SESSION, 4400);
  assert.equal(BROWSER_WS_CLOSE.LOGIN_REQUIRED, 4401);
  assert.equal(BROWSER_WS_CLOSE.FORBIDDEN, 4403);
  assert.equal(BROWSER_WS_CLOSE.SESSION_GONE, 4404);
});

test('resolveBrowserWsRoute routes a pull by `channel`, not a `network` type', () => {
  const network = resolveBrowserWsRoute({ type: 'console', channel: 'network', payload: { entries: [1], nextSince: 4 } });
  assert.equal(network.kind, 'pull');
  assert.equal(network.channel, 'network');
  assert.deepEqual(network.payload, { entries: [1], nextSince: 4 });

  const consoleRoute = resolveBrowserWsRoute({ type: 'console', channel: 'console', payload: { entries: [], nextSince: 0 } });
  assert.equal(consoleRoute.channel, 'console');

  // An unknown/missing channel falls back to console, never to network.
  assert.equal(resolveBrowserWsRoute({ type: 'console', payload: {} }).channel, 'console');
  // The server never emits a `network` message type.
  assert.equal(resolveBrowserWsRoute({ type: 'network' }).kind, 'ignore');
});

test('resolveBrowserWsRoute maps frame, state, error, ready, ack and pong', () => {
  assert.equal(resolveBrowserWsRoute({ type: 'frame', frame: { data: 'x' } }).kind, 'frame');
  assert.equal(resolveBrowserWsRoute({ type: 'frame-skipped', reason: 'backpressure' }).kind, 'frame-skipped');
  const stateRoute = resolveBrowserWsRoute({ type: 'state', state: { url: 'https://example.com' } });
  assert.equal(stateRoute.kind, 'state');
  assert.equal(stateRoute.state.url, 'https://example.com');
  const errorRoute = resolveBrowserWsRoute({ type: 'error', code: 'rate-limited', error: 'slow down' });
  assert.equal(errorRoute.kind, 'error');
  assert.equal(errorRoute.code, 'rate-limited');
  const ready = resolveBrowserWsRoute({ type: 'ready', limits: { MAX_SCREENSHOT_FPS: 2 }, browserTabId: 't1' });
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.tabId, 't1');
  assert.equal(resolveBrowserWsRoute({ type: 'ack', op: 'subscribe' }).kind, 'ack');
  assert.equal(resolveBrowserWsRoute({ type: 'pong', at: 5 }).kind, 'pong');
  assert.equal(resolveBrowserWsRoute({ type: 'ping' }).kind, 'ping');
});

test('only a delivered frame is acknowledged', () => {
  assert.equal(shouldAckBrowserWsFrame({ type: 'frame', frame: {} }), true);
  assert.equal(shouldAckBrowserWsFrame({ type: 'frame-skipped', reason: 'backpressure' }), false);
  assert.equal(shouldAckBrowserWsFrame({ type: 'state' }), false);
  assert.deepEqual(buildBrowserWsFrameAck('t1'), { type: 'frame-ack', browserTabId: 't1' });
});

/**
 * Mirrors POST/DELETE query stamping in browserPanel.api().
 * @param {{ mode: string, chatId: string }} ctx
 * @returns {string}
 */
function buildRestMutationQuery(ctx) {
  const context = new URLSearchParams();
  if (ctx.mode) context.set('mode', ctx.mode);
  if (ctx.chatId) context.set('chatId', ctx.chatId);
  return context.toString();
}

test('guardContext omits mode when there is no explicit chat mode (REST + WS)', () => {
  setBrowserPanelGuardDeps({
    getActiveChatId: () => '',
    getChats: () => [],
  });
  const emptyChat = guardContext();
  assert.equal(emptyChat.mode, '');
  assert.equal(emptyChat.chatId, '');
  const emptyQuery = new URLSearchParams(buildRestMutationQuery(emptyChat));
  assert.equal(emptyQuery.has('mode'), false);
  assert.equal(emptyQuery.has('chatId'), false);

  const { client, socket } = createHarness({ getGuardContext: guardContext });
  client.open({ sessionId: 's1', tabId: 't1' });
  socket().onopen();
  client.send({ type: 'navigate', browserTabId: 't1', url: 'https://example.com' });
  const navigateMsg = socket().sent.find((m) => m.type === 'navigate');
  assert.ok(navigateMsg);
  assert.equal('mode' in navigateMsg, false);
  assert.equal('chatId' in navigateMsg, false);
  client.close('done');

  setBrowserPanelGuardDeps({
    getActiveChatId: () => 'chat-x',
    getChats: () => [{ id: 'chat-x', sdkMode: 'not-a-mode' }],
  });
  const unknownMode = guardContext();
  assert.equal(unknownMode.mode, '');
  assert.equal(unknownMode.chatId, 'chat-x');
  assert.equal(new URLSearchParams(buildRestMutationQuery(unknownMode)).has('mode'), false);
  assert.equal(new URLSearchParams(buildRestMutationQuery(unknownMode)).get('chatId'), 'chat-x');

  setBrowserPanelGuardDeps({
    getActiveChatId: () => 'chat-plan',
    getChats: () => [{ id: 'chat-plan', sdkMode: 'plan' }],
  });
  const planCtx = guardContext();
  assert.equal(planCtx.mode, 'plan');
  assert.equal(new URLSearchParams(buildRestMutationQuery(planCtx)).get('mode'), 'plan');

  setBrowserPanelGuardDeps({
    getActiveChatId: () => 'chat-agent',
    getChats: () => [{ id: 'chat-agent', sdkMode: 'agent' }],
  });
  const agentCtx = guardContext();
  assert.equal(agentCtx.mode, 'agent');
  assert.equal(new URLSearchParams(buildRestMutationQuery(agentCtx)).get('mode'), 'agent');

  const { client: agentClient, socket: agentSocket } = createHarness({ getGuardContext: guardContext });
  agentClient.open({ sessionId: 's1', tabId: 't1' });
  agentSocket().onopen();
  agentClient.send({ type: 'input', browserTabId: 't1', event: { kind: 'key' } });
  const inputMsg = agentSocket().sent.find((m) => m.type === 'input');
  assert.equal(inputMsg.mode, 'agent');
  assert.equal(inputMsg.chatId, 'chat-agent');
  agentClient.close('done');
});

test('withBrowserWsGuardContext stamps only mutating messages', () => {
  assert.deepEqual([...BROWSER_WS_MUTATION_TYPES].sort(), ['close-tab', 'input', 'navigate']);
  for (const type of ['input', 'navigate', 'close-tab']) {
    assert.deepEqual(
      withBrowserWsGuardContext({ type, browserTabId: 't1' }, { mode: 'agent', chatId: 'c1' }),
      { type, browserTabId: 't1', mode: 'agent', chatId: 'c1' },
    );
  }
  // Read actions must not gain a mode/chatId they do not need.
  for (const type of ['screenshot', 'state', 'pull', 'ping', 'frame-ack']) {
    assert.deepEqual(
      withBrowserWsGuardContext({ type, browserTabId: 't1' }, { mode: 'agent', chatId: 'c1' }),
      { type, browserTabId: 't1' },
    );
  }
  // A blank context never overwrites the message.
  assert.deepEqual(withBrowserWsGuardContext({ type: 'input' }, { mode: '', chatId: '' }), { type: 'input' });
});

test('client opens the channel, polls a frame and acknowledges it', () => {
  const frames = [];
  const { client, scheduler, socket } = createHarness({ handlers: { onFrame: (frame) => frames.push(frame) } });
  client.open({ sessionId: 's1', tabId: 't1' });
  assert.ok(socket().url.endsWith(`${BROWSER_WS_PATH}?session=s1&tab=t1`), socket().url);
  socket().onopen();
  assert.equal(client.isLive(), true);
  // frame + pull + keepalive loops are pending.
  assert.equal(scheduler.count(), 3);

  scheduler.runNext();
  const firstFrame = socket().sent.find((m) => m.type === 'screenshot');
  assert.deepEqual(firstFrame, { type: 'screenshot', browserTabId: 't1', requestId: 'frame-1' });

  // A delivered frame is rendered and then acked.
  deliver(socket(), { type: 'frame', frame: { browserTabId: 't1', data: 'abc' } });
  assert.equal(frames.length, 1);
  assert.deepEqual(socket().sent.at(-1), { type: 'frame-ack', browserTabId: 't1' });
  client.close('done');
});

test('frame backpressure keeps one screenshot in flight until acked', () => {
  const { client, scheduler, socket } = createHarness();
  client.open({ sessionId: 's1', tabId: 't1' });
  socket().onopen();

  scheduler.runAllCurrent();
  const screenshots = () => socket().sent.filter((m) => m.type === 'screenshot').length;
  assert.equal(screenshots(), 1);

  // While the frame is unacknowledged the next tick must not send another one.
  scheduler.runAllCurrent();
  assert.equal(screenshots(), 1);

  deliver(socket(), { type: 'frame', frame: { browserTabId: 't1', data: 'abc' } });
  scheduler.runAllCurrent();
  assert.equal(screenshots(), 2);

  // A frame-skipped answer frees the slot too.
  deliver(socket(), { type: 'frame-skipped', reason: 'backpressure' });
  scheduler.runAllCurrent();
  assert.equal(screenshots(), 3);
  client.close('done');
});

test('send() applies the guard context only to mutations', () => {
  const { client, socket } = createHarness({ getGuardContext: () => ({ mode: 'agent', chatId: 'chat-1' }) });
  client.open({ sessionId: 's1', tabId: 't1' });
  socket().onopen();
  client.send({ type: 'input', browserTabId: 't1', event: { kind: 'key' } });
  client.send({ type: 'navigate', browserTabId: 't1', url: 'https://example.com' });
  client.send({ type: 'close-tab', browserTabId: 't1' });
  client.send({ type: 'screenshot', browserTabId: 't1' });

  for (const type of ['input', 'navigate', 'close-tab']) {
    const message = socket().sent.find((m) => m.type === type);
    assert.equal(message.mode, 'agent');
    assert.equal(message.chatId, 'chat-1');
  }
  const shot = socket().sent.find((m) => m.type === 'screenshot');
  assert.equal('mode' in shot, false);
  assert.equal('chatId' in shot, false);
  client.close('done');
});

test('a tab switch subscribes on the open socket instead of stacking a second one', () => {
  const { client, socket } = createHarness();
  client.open({ sessionId: 's1', tabId: 't1' });
  const first = socket();
  first.onopen();
  assert.equal(sockets.length, 1);

  client.open({ sessionId: 's1', tabId: 't2' });
  assert.equal(sockets.length, 1, 'same session must reuse the socket');
  assert.ok(first.sent.some((m) => m.type === 'subscribe' && m.browserTabId === 't2'));

  // A different session tears the old socket down and opens exactly one new one.
  client.open({ sessionId: 's2', tabId: 't9' });
  assert.equal(sockets.length, 2);
  assert.equal(first.closed.code, 1000);
  client.close('done');
});

test('a close on 4401/4404 resyncs and a 4400/4403 stop never redials', () => {
  for (const code of [4401, 4404]) {
    const resync = [];
    const { client, scheduler, socket } = createHarness({ handlers: { onResync: (info) => resync.push(info) } });
    client.open({ sessionId: 's1', tabId: 't1' });
    socket().onopen();
    socket().onclose({ code, reason: 'gone' });
    assert.equal(resync.length, 1, `code ${code} must resync`);
    assert.equal(scheduler.count(), 0, `code ${code} must not schedule a redial`);
    client.close('done');
  }
  for (const code of [4400, 4403]) {
    const stops = [];
    const { client, scheduler, socket } = createHarness({ handlers: { onStop: (info) => stops.push(info) } });
    client.open({ sessionId: 's1', tabId: 't1' });
    socket().onopen();
    socket().onclose({ code, reason: 'refused' });
    assert.equal(stops.length, 1, `code ${code} must stop`);
    assert.equal(scheduler.count(), 0, `code ${code} must not schedule a redial`);
    client.close('done');
  }
});

test('the reconnect backoff grows and a ready frame resets it', () => {
  const { client, scheduler, socket } = createHarness();
  client.open({ sessionId: 's1', tabId: 't1' });
  socket().onopen();
  socket().onclose({ code: 1006 });
  assert.equal(scheduler.onlyDelay(), 600);

  scheduler.runNext();
  socket().onopen();
  socket().onclose({ code: 1006 });
  assert.equal(scheduler.onlyDelay(), 1200);

  scheduler.runNext();
  socket().onopen();
  deliver(socket(), { type: 'ready', limits: { MAX_SCREENSHOT_FPS: 2 }, browserTabId: 't1' });
  socket().onclose({ code: 1006 });
  assert.equal(scheduler.onlyDelay(), 600, 'ready must reset the backoff to the base');
  client.close('done');
});

test('a pending loop closes the socket when the panel is no longer active', () => {
  let active = true;
  const { client, scheduler, socket } = createHarness({ isActive: () => active });
  client.open({ sessionId: 's1', tabId: 't1' });
  const live = socket();
  live.onopen();
  assert.equal(client.isLive(), true);

  active = false;
  scheduler.runNext();
  assert.deepEqual(live.closed, { code: 1000, reason: 'panel-inactive' });
  assert.equal(client.isLive(), false);
  assert.equal(scheduler.count(), 0, 'no timer may survive the teardown');
});

test('open() with no session never creates a socket', () => {
  const { client } = createHarness();
  client.open({ sessionId: '', tabId: 't1' });
  assert.equal(sockets.length, 0);
  assert.equal(client.isLive(), false);
});

test('panel pull path advances the nextSince cursor on both transports', () => {
  const panel = read('app_front/features/browser/browserPanel.js');
  assert.match(panel, /const nextSince = Number\(payload\.nextSince\)/);
  assert.match(panel, /state\.consoleSince = cursor/);
  assert.match(panel, /state\.networkSince = cursor/);
  // REST spreads the page at the top level; /ws-browser nests it under `payload`.
  assert.match(panel, /applyPullPayload\(channel, data\?\.payload \|\| data \|\| \{\}, since\)/);
  assert.match(panel, /applyPullPayload\(channel, payload \|\| \{\}, since\)/);
  assert.doesNotMatch(panel, /payload\?\.cursor|payload\.cursor/);
});

test('panel wires the live channel handlers to render + status', () => {
  const panel = read('app_front/features/browser/browserPanel.js');
  assert.match(panel, /import \{ createBrowserWsClient \} from '\.\/browserWsClient\.js'/);
  assert.match(panel, /isActive: isBrowserPanelActive/);
  assert.match(panel, /getGuardContext: guardContext/);
  assert.match(panel, /onFrame: \(frame\) => \{[\s\S]*?renderFrame\(state\.frame\)/);
  assert.match(panel, /onState: \(tabState\) => \{[\s\S]*?setUrlBar\(String\(tabState\?\.url \|\| ''\)\)[\s\S]*?applyHistoryState\(tabState\)/);
  assert.match(panel, /if \(route\.code === 'rate-limited'\) return;/);
  assert.match(panel, /onReconnecting:/);
  assert.match(panel, /onResync: \(\) => \{[\s\S]*?resetLiveViewSelection\(\)[\s\S]*?void reloadSessions\(\)/);
  assert.match(panel, /onStop: \(info\) => \{[\s\S]*?browser\.liveStopped/);
  // Workspace change tears the socket down; the workspace refresh reopens it.
  assert.match(panel, /'cretli-active-workspace-changed'[\s\S]*?liveView\.close\(\)/);
  // The panel never dials its own socket or bypasses the client helper.
  assert.doesNotMatch(panel, /new WebSocket/);
});

test('REST stays the source of truth; the socket only adds live updates', () => {
  const panel = read('app_front/features/browser/browserPanel.js');
  for (const call of [
    "api('/status')",
    "api('/sessions')",
    'screenshot?force=1',
    '/navigate',
    '/input',
    '/select',
    'method: \'DELETE\'',
  ]) {
    assert.ok(panel.includes(call), `panel must still issue ${call}`);
  }
  // Refresh has no new BS path: it calls the exported panel refresh.
  assert.match(panel, /export async function refreshBrowserPanel/);
});

test('browser.liveReconnecting and browser.liveStopped exist in en and pl', () => {
  for (const key of ['liveReconnecting', 'liveStopped']) {
    assert.equal(typeof en.browser[key], 'string', `en.js missing browser.${key}`);
    assert.equal(typeof pl.browser[key], 'string', `pl.js missing browser.${key}`);
    assert.notEqual(en.browser[key], pl.browser[key], `pl browser.${key} must differ from en`);
  }
  const panel = read('app_front/features/browser/browserPanel.js');
  assert.match(panel, /t\('browser\.liveReconnecting'/);
  assert.match(panel, /t\('browser\.liveStopped'/);
});

test('workspace switch refreshes the Browser panel only while it is visible', () => {
  const workspaceContext = read('app_front/app/appShell/workspaceContext.js');
  assert.match(workspaceContext, /refreshBrowserPanel = \(\) => \{\}/);
  assert.match(workspaceContext, /const browserPanel = document\.getElementById\('browser-panel'\)/);
  assert.match(workspaceContext, /if \(browserPanel\?\.classList\.contains\('active'\)\) \{\s*refreshBrowserPanel\(\);/);

  const app = read('app_front/App.js');
  const wired = app.match(/refreshBrowserPanel: \(\) => callLoadedPanel\('browser', 'refreshBrowserPanel'\)/g) || [];
  assert.ok(wired.length >= 2, 'App.js must pass refreshBrowserPanel to both panelRouter and workspaceContext');
  // The lazy panel chunk must stay lazy in the shell.
  assert.doesNotMatch(app, /^import .*features\/browser\/browserPanel/m);
});
