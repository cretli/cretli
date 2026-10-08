/**
 * CDP debugger helpers and lifecycle (fake CDP + injected clock).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceMapGenerator } from 'source-map-js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import {
  buildSetBreakpointByUrlParams,
  createDebuggerController,
  debuggerAutoResumeMs,
  mapGeneratedPositionFromSourceMap,
  normalizeBreakpointLocation,
  redactDebuggerPayload,
  truncateCallFrames,
  withCdpTimeout,
} from '../lib/browser/debugger.js';
import {
  assertBrowserActionAllowed,
  BROWSER_MUTATION_ACTIONS,
  BROWSER_READ_ACTIONS,
} from '../lib/browser/guards.js';
import { redactValue } from '../lib/browser/redaction.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

function clock(start = 1000) {
  const ref = { value: start };
  const timers = [];
  return {
    at: ref,
    now: () => ref.value,
    setTimeoutFn: (fn, ms) => {
      const id = { ms, fn, cancelled: false };
      timers.push(id);
      return id;
    },
    clearTimeoutFn: (id) => {
      if (id) id.cancelled = true;
    },
    fireDueTimers() {
      for (const t of timers) {
        if (!t.cancelled) t.fn();
      }
    },
  };
}

/**
 * @returns {{ cdp: any, sent: string[], handlers: Map<string, Function[]>, emit: (event: string, payload?: any) => void }}
 */
function sampleSourceMapJson() {
  const gen = new SourceMapGenerator({ file: 'app.js' });
  gen.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: 'src/app.ts',
  });
  return JSON.parse(gen.toString());
}

function fakeCdp() {
  const sent = [];
  const handlers = new Map();
  let detached = false;
  const cdp = {
    send: async (method, params = {}) => {
      sent.push(method);
      if (method === 'Debugger.setBreakpointByUrl') {
        return { breakpointId: `bp-${sent.length}`, locations: [{ lineNumber: params.lineNumber }] };
      }
      if (method === 'Debugger.getStackTrace') {
        return { stackTrace: { callFrames: [] } };
      }
      if (method === 'Runtime.getProperties') {
        return { result: [{ name: 'token', value: { type: 'string', value: 'secret-token-abc' } }] };
      }
      if (method === 'Debugger.evaluateOnCallFrame') {
        return { result: { type: 'string', value: 'ok' } };
      }
      if (method === 'Debugger.getScriptSource') {
        return { scriptSource: 'console.log("hi")' };
      }
      return {};
    },
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    off: (event, fn) => {
      const list = handlers.get(event) || [];
      handlers.set(event, list.filter((entry) => entry !== fn));
    },
    detach: async () => {
      detached = true;
    },
    get detached() {
      return detached;
    },
  };
  const emit = (event, payload = {}) => {
    for (const fn of handlers.get(event) || []) fn(payload);
  };
  return { cdp, sent, handlers, emit };
}

test('breakpoint params and limits normalize', () => {
  assert.deepEqual(normalizeBreakpointLocation('https://example.test/app.js', 4, 1), {
    url: 'https://example.test/app.js',
    lineNumber: 4,
    columnNumber: 1,
  });
  assert.equal(normalizeBreakpointLocation('', 1), null);
  assert.deepEqual(buildSetBreakpointByUrlParams({ url: 'https://x', lineNumber: 2 }), {
    url: 'https://x',
    lineNumber: 2,
    columnNumber: 0,
  });
  assert.equal(truncateCallFrames(new Array(50).fill({}), BROWSER_LIMITS).length, BROWSER_LIMITS.DEBUGGER_MAX_STACK_DEPTH);
  assert.equal(debuggerAutoResumeMs(BROWSER_LIMITS), BROWSER_LIMITS.DEBUGGER_AUTO_RESUME_MS);
});

test('redactDebuggerPayload hides secrets in scope-like values', () => {
  const payload = redactDebuggerPayload({
    props: [{ name: 'authorization', value: 'Bearer abcdef123456' }],
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.match(text, /\[redacted\]|redacted/i);
  assert.doesNotMatch(text, /abcdef123456/);
});

test('redactDebuggerPayload preserves non-sensitive scope values at DEBUGGER_REDACT_MAX_DEPTH', () => {
  const payload = redactDebuggerPayload({
    scopes: [{
      type: 'local',
      name: 'local',
      properties: [{
        name: 'count',
        value: { type: 'number', value: 42, description: '42' },
        writable: true,
        configurable: true,
        enumerable: true,
      }],
    }],
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.match(text, /"value":42|"value": 42/);
  assert.doesNotMatch(text, /\[truncated\]/);
});

test('redactDebuggerPayload redacts sensitive scope property values', () => {
  const payload = redactDebuggerPayload({
    scopes: [{
      type: 'local',
      name: 'local',
      properties: [{
        name: 'pin',
        value: { type: 'number', value: 9999, description: '9999' },
        writable: true,
        configurable: true,
        enumerable: true,
      }],
    }],
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /9999/);
  assert.match(text, /\[redacted\]/);
});

test('redactDebuggerPayload redacts watch exceptionDetails sensitive fields', () => {
  const payload = redactDebuggerPayload({
    result: {
      type: 'object',
      value: { accessToken: 'LEAK_AT' },
    },
    exceptionDetails: {
      text: 'Error',
      exception: {
        type: 'object',
        description: 'Object',
        preview: {
          type: 'object',
          properties: [{ name: 'clientSecret', type: 'string', value: 'LEAK_CS' }],
        },
      },
    },
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /LEAK_AT/);
  assert.doesNotMatch(text, /LEAK_CS/);
  assert.match(text, /\[redacted\]/);
});

test('redactValue masks CDP Runtime.getProperties password remote object', () => {
  const cdpShape = {
    name: 'password',
    value: { type: 'string', value: 'hunter2' },
    writable: true,
    configurable: true,
    enumerable: true,
    isOwn: true,
  };
  const out = redactValue([cdpShape]);
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /\[redacted\]/);
});

test('source map mapping uses VLQ mappings and ignores sourcesContent-only maps', async () => {
  const withMappings = sampleSourceMapJson();
  const mapped = await mapGeneratedPositionFromSourceMap(withMappings, 0, 0);
  assert.ok(mapped);
  assert.equal(mapped.source, 'src/app.ts');
  assert.equal(mapped.line, 0);
  const withoutMappings = await mapGeneratedPositionFromSourceMap({
    sources: ['orig.ts'],
    sourcesContent: ['line0\nline1\nline2'],
  }, 1);
  assert.equal(withoutMappings, null);
});

test('debugger controller: pause, stack, watch, breakpoints', async () => {
  const { cdp, sent, emit } = fakeCdp();
  const ctl = createDebuggerController({
    limits: BROWSER_LIMITS,
    now: () => 42,
    send: (method, params) => cdp.send(method, params),
    on: (event, fn) => cdp.on(event, fn),
    off: (event, fn) => cdp.off(event, fn),
  });
  await ctl.attach();
  await ctl.pause();
  assert.ok(sent.includes('Debugger.pause'));
  emit('Debugger.paused', {
    reason: 'break',
    callFrames: [
      {
        callFrameId: 'cf-1',
        functionName: 'main',
        location: { scriptId: 's1', lineNumber: 0, columnNumber: 0 },
        scopeChain: [{ type: 'local', name: 'local', object: { objectId: 'obj-1' } }],
      },
      {
        callFrameId: 'cf-2',
        functionName: 'outer',
        location: { scriptId: 's1', lineNumber: 5, columnNumber: 0 },
        scopeChain: [],
      },
    ],
  });
  const stack = await ctl.getStack();
  assert.equal(stack.ok, true);
  assert.equal(stack.paused, true);
  assert.equal(stack.frames.length, 2);
  const scopes = await ctl.getScopes('cf-1');
  assert.equal(scopes.scopes.length, 1);
  const bp = await ctl.setBreakpoint({ url: 'https://example.test/x.js', lineNumber: 10 });
  assert.ok(bp.breakpointId);
  assert.ok(sent.includes('Debugger.setBreakpointByUrl'));
  await ctl.removeBreakpoint(bp.breakpointId);
  assert.ok(sent.includes('Debugger.removeBreakpoint'));
  const watch = await ctl.watch('1 + 1', 'cf-1');
  assert.equal(watch.ok, true);
  await ctl.resume();
  emit('Debugger.resumed');
  const idleStack = await ctl.getStack();
  assert.equal(idleStack.ok, false);
  assert.equal(idleStack.error, 'debugger-not-paused');
  assert.equal(idleStack.paused, false);
});

test('source map cache key is per script URL plus sourceMapURL (no collision)', async () => {
  const mapA = { ...sampleSourceMapJson(), file: 'a.js' };
  const mapB = { ...sampleSourceMapJson(), file: 'b.js' };
  const fetched = [];
  const { cdp } = fakeCdp();
  const ctl = createDebuggerController({
    limits: BROWSER_LIMITS,
    send: (method, params) => cdp.send(method, params),
    on: (event, fn) => cdp.on(event, fn),
    off: (event, fn) => cdp.off(event, fn),
    fetchSourceMap: async (sourceMapURL, scriptURL) => {
      fetched.push({ sourceMapURL, scriptURL });
      if (scriptURL === 'https://cdn.test/pkg/a/index.js') return mapA;
      if (scriptURL === 'https://cdn.test/pkg/b/index.js') return mapB;
      return null;
    },
  });
  await ctl.attach();
  await ctl._handleScriptParsed({
    scriptId: 's-a',
    url: 'https://cdn.test/pkg/a/index.js',
    sourceMapURL: 'index.js.map',
  });
  await ctl._handleScriptParsed({
    scriptId: 's-b',
    url: 'https://cdn.test/pkg/b/index.js',
    sourceMapURL: 'index.js.map',
  });
  assert.equal(fetched.length, 2);
  assert.equal(fetched[0].scriptURL, 'https://cdn.test/pkg/a/index.js');
  assert.equal(fetched[1].scriptURL, 'https://cdn.test/pkg/b/index.js');
});

test('debugger controller: source map fetch wired through scriptParsed and stack original', async () => {
  const sourceMap = sampleSourceMapJson();
  const { cdp, emit } = fakeCdp();
  const ctl = createDebuggerController({
    limits: BROWSER_LIMITS,
    send: (method, params) => cdp.send(method, params),
    on: (event, fn) => cdp.on(event, fn),
    off: (event, fn) => cdp.off(event, fn),
    fetchSourceMap: async (url) => (url === 'https://example.test/app.js.map' ? sourceMap : null),
  });
  await ctl.attach();
  await ctl._handleScriptParsed({
    scriptId: 'script-1',
    url: 'https://example.test/app.js',
    sourceMapURL: 'https://example.test/app.js.map',
  });
  emit('Debugger.paused', {
    reason: 'break',
    callFrames: [{
      callFrameId: 'cf-map',
      functionName: 'app',
      location: { scriptId: 'script-1', lineNumber: 0, columnNumber: 0 },
      scopeChain: [],
    }],
  });
  const stack = await ctl.getStack();
  assert.equal(stack.frames.length, 1);
  const frame = /** @type {{ original?: { source?: string } }} */ (stack.frames[0]);
  assert.equal(frame.original?.source, 'src/app.ts');
});

test('auto-resume fires after DEBUGGER_AUTO_RESUME_MS', async () => {
  const { cdp, emit } = fakeCdp();
  const { now, setTimeoutFn, clearTimeoutFn, fireDueTimers } = clock(5000);
  let resumed = false;
  const ctl = createDebuggerController({
    limits: { ...BROWSER_LIMITS, DEBUGGER_AUTO_RESUME_MS: 1000 },
    now,
    setTimeoutFn: (fn, ms) => {
      const id = setTimeoutFn(fn, ms);
      return id;
    },
    clearTimeoutFn,
    send: async (method) => {
      if (method === 'Debugger.resume') resumed = true;
      return cdp.send(method);
    },
    on: (event, fn) => cdp.on(event, fn),
    off: (event, fn) => cdp.off(event, fn),
  });
  await ctl.attach();
  emit('Debugger.paused', { reason: 'other', callFrames: [{ callFrameId: 'cf', scopeChain: [] }] });
  fireDueTimers();
  await Promise.resolve();
  assert.equal(resumed, true);
});

test('detach clears listeners and resumes when paused', async () => {
  const { cdp, handlers, emit } = fakeCdp();
  let resumeCount = 0;
  const ctl = createDebuggerController({
    limits: BROWSER_LIMITS,
    send: async (method, params) => {
      if (method === 'Debugger.resume') resumeCount += 1;
      return cdp.send(method, params);
    },
    on: (event, fn) => cdp.on(event, fn),
    off: (event, fn) => cdp.off(event, fn),
  });
  await ctl.attach();
  emit('Debugger.paused', { reason: 'break', callFrames: [{ callFrameId: 'cf', scopeChain: [] }] });
  await ctl.detach();
  assert.equal(resumeCount, 1);
  assert.equal((handlers.get('Debugger.paused') || []).length, 0);
});

test('CDP send timeout rejects slow commands', async () => {
  await assert.rejects(
    () => withCdpTimeout(new Promise(() => {}), 5, 'Slow.method'),
    /timed out/,
  );
});

test('debugger guard split: reads in plan, mutations blocked', () => {
  for (const action of ['debugger-state', 'debugger-stack', 'debugger-scopes', 'debugger-script-source']) {
    assert.equal(BROWSER_READ_ACTIONS.has(action), true, action);
    assert.doesNotThrow(() => assertBrowserActionAllowed({ action, mode: 'plan' }));
  }
  for (const action of [
    'debugger-pause',
    'debugger-resume',
    'debugger-set-breakpoint',
    'debugger-remove-breakpoint',
    'debugger-watch',
  ]) {
    assert.equal(BROWSER_MUTATION_ACTIONS.has(action), true, action);
    assert.throws(() => assertBrowserActionAllowed({ action, mode: 'plan' }));
  }
});

test('navigation CDP stale recovery does not detach debugger session', async () => {
  let debuggerDetachCount = 0;
  const navigationCdp = {
    send: async (method) => {
      if (method === 'Page.getNavigationHistory') throw new Error('stale navigation CDP');
      return {};
    },
    detach: async () => {},
    on: () => {},
    off: () => {},
  };
  const debuggerCdp = {
    send: async (method) => {
      if (method === 'Debugger.setBreakpointByUrl') {
        return { breakpointId: 'bp-nav', locations: [] };
      }
      return {};
    },
    on: () => {},
    off: () => {},
    detach: async () => {
      debuggerDetachCount += 1;
    },
  };
  let newSessionKind = 0;
  const page = {
    isClosed: () => false,
    viewportSize: () => ({ width: 390, height: 844 }),
    url: () => 'https://example.com/',
    title: async () => '',
    context: () => ({
      newCDPSession: async () => {
        newSessionKind += 1;
        return newSessionKind === 1 ? navigationCdp : debuggerCdp;
      },
    }),
    close: async () => {},
    on: () => {},
    route: async () => {},
  };
  const manager = new BrowserSessionManager({
    limits: BROWSER_LIMITS,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    driver: {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => page,
          route: async () => {},
          close: async () => {},
        }),
        isConnected: () => true,
        close: async () => {},
      }),
    },
  });
  const session = await manager.createSession({ ownerSessionId: 'owner-nav', workspaceFile: '/ws' });
  const sessionId = session.browserSessionId;
  const tabId = session.activeTabId;
  assert.ok(tabId);
  await manager.debuggerPause(sessionId, tabId, 'owner-nav', { workspaceFile: '/ws' });
  assert.ok(manager.debuggers.has(tabId));
  await manager.getState(sessionId, tabId, 'owner-nav', { workspaceFile: '/ws' });
  assert.ok(manager.debuggers.has(tabId));
  assert.equal(debuggerDetachCount, 0);
});

test('session manager teardown detaches debugger CDP without leaking handlers', async () => {
  let debuggerDetached = false;
  const debuggerCdp = {
    send: async (method) => {
      if (method === 'Debugger.setBreakpointByUrl') {
        return { breakpointId: 'bp-test', locations: [] };
      }
      return {};
    },
    on: () => {},
    off: () => {},
    detach: async () => {
      debuggerDetached = true;
    },
  };
  const page = {
    isClosed: () => false,
    viewportSize: () => ({ width: 390, height: 844 }),
    context: () => ({
      newCDPSession: async () => debuggerCdp,
    }),
    close: async () => {},
    on: () => {},
    route: async () => {},
  };
  const manager = new BrowserSessionManager({
    limits: BROWSER_LIMITS,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    driver: {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => page,
          route: async () => {},
          close: async () => {},
        }),
        isConnected: () => true,
        close: async () => {},
      }),
    },
  });
  const session = await manager.createSession({ ownerSessionId: 'owner-a', workspaceFile: '/ws' });
  const sessionId = session.browserSessionId;
  const tabId = session.activeTabId;
  assert.ok(tabId);
  await manager.debuggerPause(sessionId, tabId, 'owner-a', { workspaceFile: '/ws' });
  assert.ok(manager.debuggers.has(tabId));
  await manager.closeTab(sessionId, tabId, 'owner-a', { workspaceFile: '/ws' });
  assert.equal(manager.debuggers.has(tabId), false);
  assert.equal(debuggerDetached, true);
});

test('main-frame navigation resets debugger pause state', async () => {
  const debuggerCdp = {
    send: async (method) => {
      if (method === 'Debugger.resume') return {};
      return {};
    },
    on: () => {},
    off: () => {},
    detach: async () => {},
  };
  const page = {
    isClosed: () => false,
    viewportSize: () => ({ width: 390, height: 844 }),
    url: () => 'https://example.com/',
    title: async () => '',
    context: () => ({ newCDPSession: async () => debuggerCdp }),
    close: async () => {},
    on: () => {},
    route: async () => {},
  };
  const manager = new BrowserSessionManager({
    limits: BROWSER_LIMITS,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    driver: {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => page,
          route: async () => {},
          close: async () => {},
        }),
        isConnected: () => true,
        close: async () => {},
      }),
    },
  });
  const created = await manager.createSession({ ownerSessionId: 'owner-nav-reset', workspaceFile: '/ws' });
  const sessionId = created.browserSessionId;
  const tabId = created.activeTabId;
  assert.ok(tabId);
  await manager.debuggerPause(sessionId, tabId, 'owner-nav-reset', { workspaceFile: '/ws' });
  const session = manager.sessions.get(sessionId);
  const tab = session?.tabs.get(tabId);
  assert.ok(tab);
  const controller = manager.debuggers.get(tabId)?.controller;
  assert.ok(controller);
  await controller._handlePaused({
    reason: 'break',
    callFrames: [{ callFrameId: 'cf-nav', scopeChain: [] }],
  });
  assert.equal((await manager.debuggerState(sessionId, tabId, 'owner-nav-reset', { workspaceFile: '/ws' })).paused, true);
  await manager.resetDebuggerForMainFrameNavigation(tab);
  assert.equal((await manager.debuggerState(sessionId, tabId, 'owner-nav-reset', { workspaceFile: '/ws' })).paused, false);
  assert.ok(manager.debuggers.has(tabId));
});

test('page close handler detaches debugger CDP session', async () => {
  let debuggerDetached = false;
  const closeHandlers = [];
  const debuggerCdp = {
    send: async (method) => {
      if (method === 'Debugger.setBreakpointByUrl') {
        return { breakpointId: 'bp-close', locations: [] };
      }
      if (method === 'Debugger.resume') return {};
      return {};
    },
    on: () => {},
    off: () => {},
    detach: async () => {
      debuggerDetached = true;
    },
  };
  const page = {
    isClosed: () => false,
    viewportSize: () => ({ width: 390, height: 844 }),
    url: () => 'https://example.com/',
    title: async () => '',
    context: () => ({
      newCDPSession: async () => debuggerCdp,
    }),
    close: async () => {},
    on: (event, fn) => {
      if (event === 'close') closeHandlers.push(fn);
    },
    route: async () => {},
  };
  const manager = new BrowserSessionManager({
    limits: BROWSER_LIMITS,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    driver: {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => page,
          route: async () => {},
          close: async () => {},
        }),
        isConnected: () => true,
        close: async () => {},
      }),
    },
  });
  const created = await manager.createSession({ ownerSessionId: 'owner-close', workspaceFile: '/ws' });
  const sessionId = created.browserSessionId;
  const tabId = created.activeTabId;
  assert.ok(tabId);
  await manager.debuggerPause(sessionId, tabId, 'owner-close', { workspaceFile: '/ws' });
  assert.ok(manager.debuggers.has(tabId));
  for (const fn of closeHandlers) fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.debuggers.has(tabId), false);
  assert.equal(debuggerDetached, true);
});
