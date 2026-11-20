import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createTracingController, TRACE_CATEGORIES } from '../lib/browser/tracing.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import { buildBrowserAgentTools } from '../lib/browser/agent-tools.js';

const scope = { owner: 'owner', chat: 'chat', workspace: 'workspace' };
const tick = () => new Promise((r) => setImmediate(r));
class CDP extends EventEmitter {
  calls = []; detached = 0;
  constructor(options = {}) { super(); this.options = options; }
  async send(method, args) {
    this.calls.push({ method, args });
    if (method === 'Tracing.start' && this.options.startError) throw new Error(this.options.startError);
    if (method === 'Tracing.end' && !this.options.noComplete) this.emit('Tracing.tracingComplete', { stream: 'stream' });
    if (method === 'IO.read') return { data: this.options.payload || '{"traceEvents":[]}', eof: true, base64Encoded: this.options.base64 };
    return {};
  }
  async detach() { this.detached++; }
}
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'browser-tracing-'));
  const timers = [];
  const controller = createTracingController({ dataDir: dir, ...options,
    setTimer(fn, ms) { const timer = { fn, ms, cancelled: false }; timers.push(timer); return timer; },
    clearTimer(timer) { if (timer) timer.cancelled = true; },
  });
  t.after(async () => { await controller.closeTab('tab'); await fs.rm(dir, { recursive: true, force: true }); });
  const cdp = new CDP();
  const input = { ...scope, tabId: 'tab', durationMs: 1000,
    conditions: async () => ({ hidden: true, screencast: false, uiFreezeDiag: false }),
    mark: async () => {}, factories: [{ name: 'browser', create: async () => cdp }],
  };
  async function terminal(traceId) {
    for (let i = 0; i < 100; i++) {
      const r = controller.status(traceId, scope);
      if (r.state === 'ready' || r.state === 'failed') return r;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail('trace did not finish');
  }
  return { dir, controller, cdp, input, timers, terminal, fire(ms) { const timer = timers.find((x) => x.ms === ms && !x.cancelled); assert.ok(timer, `timer ${ms}`); timer.cancelled = true; timer.fn(); } };
}
test('start, marker, timer, stream and private file use one CDP session', async (t) => {
  const x = await setup(t); let marker;
  x.input.mark = async (name) => { marker = name; assert.equal(x.cdp.calls[0].method, 'Tracing.start'); };
  const start = await x.controller.start(x.input);
  assert.equal(start.state, 'recording'); assert.match(start.traceId, /^[0-9a-f-]{36}$/);
  assert.equal(marker, `cretli-trace-${start.traceId}`);
  assert.deepEqual(start.warnings, ['hidden']); assert.equal(start.cdpSession, 'browser');
  x.fire(1000); const done = await x.terminal(start.traceId);
  assert.equal(done.state, 'ready');
  assert.equal((await fs.stat(done.path)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(done.path, 'utf8'), '{"traceEvents":[]}');
  assert.deepEqual(x.cdp.calls.map((c) => c.method), ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close']);
  assert.equal(x.cdp.detached, 1); assert.equal(x.cdp.listenerCount('Tracing.tracingComplete'), 0);
  assert.equal(TRACE_CATEGORIES.some((c) => c.includes('screenshot')), false);
  const again = await x.controller.start(x.input); x.fire(1000); await x.terminal(again.traceId);
});
test('browser creation/start failures fall back to page; both failures release slot', async (t) => {
  const x = await setup(t);
  for (const factory of [async () => { throw Error('not supported'); }, async () => new CDP({ startError: 'unsupported domain' })]) {
    const r = await x.controller.start({ ...x.input, factories: [{ name: 'browser', create: factory }, { name: 'page', create: async () => x.cdp }] });
    assert.equal(r.cdpSession, 'page'); x.fire(1000); await x.terminal(r.traceId);
  }
  await assert.rejects(x.controller.start({ ...x.input, factories: [{ create: async () => { throw Error('offline'); } }] }), { code: 'trace-unavailable' });
  const r = await x.controller.start(x.input); x.fire(1000); await x.terminal(r.traceId);
});
test('process-wide concurrent reservation and invalid durations cannot leak a slot', async (t) => {
  const x = await setup(t), y = await setup(t);
  for (const durationMs of [999, 120001, NaN, 1.2]) await assert.rejects(x.controller.start({ ...x.input, durationMs }), { code: 'invalid-duration' });
  const validation = await Promise.allSettled([x.controller.start({ ...x.input, durationMs: 0 }), y.controller.start(y.input)]);
  assert.equal(validation[0].reason.code, 'invalid-duration');
  y.fire(1000); await y.terminal(validation[1].value.traceId);
  const results = await Promise.allSettled([x.controller.start(x.input), y.controller.start({ ...y.input, owner: 'other' })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'trace-busy');
  assert.equal(results[1].reason.message.includes('owner'), false);
  x.fire(1000); await x.terminal(results[0].value.traceId);
  const r = await y.controller.start(y.input); y.fire(1000); await y.terminal(r.traceId);
});
test('external Tracing already started maps to busy without stealing or ending it', async (t) => {
  const x = await setup(t), cdp = new CDP({ startError: 'Tracing is already started' });
  await assert.rejects(x.controller.start({ ...x.input, factories: [{ create: async () => cdp }] }), { code: 'trace-busy' });
  assert.equal(cdp.calls.some((c) => c.method === 'Tracing.end'), false);
  assert.equal(cdp.detached, 1);
});
test('marker retries context loss once and fails cleanly after second failure', async (t) => {
  const x = await setup(t); let tries = 0;
  const mark = async () => { if (++tries === 1) throw Error('Execution context destroyed'); };
  const r = await x.controller.start({ ...x.input, mark }); assert.equal(tries, 2);
  x.fire(1000); await x.terminal(r.traceId);
  tries = 0;
  const failed = await x.controller.start({ ...x.input, mark: async () => { tries++; throw Error('Execution context destroyed'); } });
  assert.equal(tries, 2); assert.equal(failed.code, 'trace-marker-failed');
  assert.equal(failed.state, 'failed');
});
for (const cause of ['close', 'disconnect', 'write', 'size']) test(`${cause} fails, ends once, removes partial file and detaches`, async (t) => {
  const x = await setup(t, cause === 'size' ? { limits: { ...BROWSER_LIMITS, TRACE_MAX_BYTES: 1 } } : cause === 'write' ? { io: { ...fs, open: async (...args) => { const output = await fs.open(...args); return { async writeFile(bytes) { await output.writeFile(bytes); throw Error('disk unavailable'); }, close: () => output.close() }; } } } : {});
  const r = await x.controller.start(x.input);
  if (cause === 'close') await x.controller.closeTab('tab');
  else if (cause === 'disconnect') x.cdp.emit('Inspector.detached');
  else x.fire(1000);
  const done = await x.terminal(r.traceId);
  assert.equal(done.state, 'failed');
  assert.equal(done.code, cause === 'size' ? 'trace-too-large' : cause === 'write' ? 'trace-write-failed' : 'trace-tab-closed');
  assert.equal(x.cdp.calls.filter((c) => c.method === 'Tracing.end').length, 1);
  assert.equal(x.cdp.detached, 1);
  assert.deepEqual(await fs.readdir(path.join(x.dir, 'browser-traces')), []);
  const next = await x.controller.start(x.input);
  await x.controller.closeTab('tab'); await x.terminal(next.traceId);
});
test('missing tracingComplete times out and releases recording', async (t) => {
  const x = await setup(t); x.cdp.options.noComplete = true;
  const r = await x.controller.start(x.input); x.fire(1000);
  await tick(); x.fire(30000);
  const done = await x.terminal(r.traceId);
  assert.equal(done.code, 'trace-end-timeout'); assert.equal(x.cdp.detached, 1);
});
test('retention removes expired/oldest orphan files and preserves active file', async (t) => {
  const x = await setup(t); const folder = path.join(x.dir, 'browser-traces'); await fs.mkdir(folder);
  for (let i = 0; i < 9; i++) {
    const file = path.join(folder, `${randomUUID()}.json`); await fs.writeFile(file, '{}');
    const at = new Date(Date.now() - (i ? i * 1000 : 8 * 86400000)); await fs.utimes(file, at, at);
  }
  const r = await x.controller.start(x.input);
  assert.equal((await fs.readdir(folder)).length, 6);
  x.fire(1000); const done = await x.terminal(r.traceId);
  assert.equal(await fs.readFile(done.path, 'utf8'), '{"traceEvents":[]}');
  assert.equal((await fs.readdir(folder)).length, 6);
});
test('trace UUID reads require exact original owner/chat/workspace; not-ready blocks summary', async (t) => {
  const x = await setup(t); const r = await x.controller.start(x.input);
  for (const wrong of [{ owner: 'foreign' }, { chat: 'foreign' }, { workspace: 'foreign' }]) {
    assert.throws(() => x.controller.status(r.traceId, { ...scope, ...wrong }), { code: 'trace-not-found' });
    await assert.rejects(x.controller.summary(r.traceId, { ...scope, ...wrong }), { code: 'trace-not-found' });
  }
  await assert.rejects(x.controller.summary(r.traceId, scope), { code: 'trace-not-ready' });
  await x.controller.closeTab('tab');
});
test('tool surface denies start in plan/ask/review and requires confirmation', async () => {
  const options = { manager: {}, ownerSessionId: 'owner', chatId: 'chat', scope: { cwd: '/workspace' } };
  for (const mode of ['plan', 'ask']) {
    const tools = buildBrowserAgentTools({ ...options, mode });
    assert.equal(tools.browser_trc_start, undefined); assert.ok(tools.browser_trc_status); assert.ok(tools.browser_trc_sum);
  }
  const review = buildBrowserAgentTools({ ...options, mode: 'agent', assignment: 'review' });
  const tools = buildBrowserAgentTools({ ...options, mode: 'agent' });
  await assert.rejects(tools.browser_trc_start.execute({ browserSessionId: 's', browserTabId: 't' }), { code: 'confirmation-required' });
  assert.ok(review.browser_trc_status); assert.equal(review.browser_trc_start, undefined);
});

test('session manager binds factories and fixed page expressions to the selected tab', async () => {
  const { BrowserSessionManager } = await import('../lib/browser/session-manager.js');
  const browser = {}, pageCdp = {}, evaluations = [];
  const tab = { id: 'target', page: { async evaluate(fn, arg) {
    evaluations.push({ code: String(fn), arg });
    return arg ? undefined : { hidden: false, uiFreezeDiag: false };
  } } };
  const session = { workspaceKey: 'workspace', browser: { newBrowserCDPSession: async () => browser }, context: { newCDPSession: async (page) => { assert.equal(page, tab.page); return pageCdp; } } };
  const manager = {
    requireTab(s, t, o, scope) { assert.deepEqual([s, t, o, scope], ['session', 'target', 'owner', { cwd: 'workspace' }]); return { session, tab }; },
    screencasts: new Map([['target', {}]]),
    tracing: { async start(input) {
      assert.equal(input.owner, 'owner'); assert.equal(input.chat, 'chat');
      assert.equal(await input.factories[0].create(), browser);
      assert.equal(await input.factories[1].create(), pageCdp);
      assert.deepEqual(await input.conditions(), { hidden: false, uiFreezeDiag: false, screencast: true });
      await input.mark('cretli-trace-server-generated');
      return { state: 'recording' };
    } },
  };
  await BrowserSessionManager.prototype.traceStart.call(manager, 'session', 'target', 'owner', { chatId: 'chat', durationMs: 1000 }, { cwd: 'workspace' });
  assert.equal(evaluations.length, 2);
  assert.match(evaluations[0].code, /visibilityState/); assert.equal(evaluations[0].arg, undefined);
  assert.match(evaluations[1].code, /performance.mark\(marker\)/);
  assert.equal(evaluations[1].arg, 'cretli-trace-server-generated');
  let closed;
  await BrowserSessionManager.prototype.detachCdpSession.call({ tracing: { async closeTab(id) { closed = id; } }, async detachDebuggerForTab() {}, async detachNavigationCdpSession() {} }, tab);
  assert.equal(closed, 'target');
});

test('default duration and base64 stream are handled without changing bytes', async (t) => {
  const x = await setup(t);
  x.cdp.options.payload = Buffer.from('{"traceEvents":[]}').toString('base64');
  x.cdp.options.base64 = true;
  const r = await x.controller.start({ ...x.input, durationMs: undefined });
  x.fire(60000); const done = await x.terminal(r.traceId);
  assert.equal(await fs.readFile(done.path, 'utf8'), '{"traceEvents":[]}');
});
test('fixed diagnostic probe matches query overrides and current/legacy storage values', async () => {
  const { BrowserSessionManager } = await import('../lib/browser/session-manager.js');
  const cases = [
    ['', null, null, false], ['', 'false', null, false], ['', '0', 'true', false],
    ['', '', 'true', false], ['', null, ' YES ', true], ['', 'true', null, true],
    ['?uiFreezeDiag=0', 'true', null, false], ['?uiFreezeDiag=off', 'yes', null, false],
    ['?uiFreezeDiag=ON', 'false', null, true], ['?uiFreezeDiag=unknown', 'yes', null, true],
  ];
  for (const [search, current, legacy, expected] of cases) {
    const tab = { id: 'target', page: { async evaluate(fn) {
      return runInNewContext(`(${fn})()`, {
        URLSearchParams, location: { search }, document: { visibilityState: 'visible' },
        localStorage: { getItem: (key) => key === 'cretli-ui-freeze-diag' ? current : legacy },
      });
    } } };
    const manager = {
      requireTab: () => ({ session: { workspaceKey: 'workspace' }, tab }),
      screencasts: new Map(),
      tracing: { async start(input) {
        const conditions = await input.conditions();
        assert.equal(conditions.uiFreezeDiag, expected, JSON.stringify([search, current, legacy]));
        assert.equal(conditions.hidden, false);
        assert.equal(conditions.screencast, false);
      } },
    };
    await BrowserSessionManager.prototype.traceStart.call(manager, 'session', 'target', 'owner', { chatId: 'chat' });
  }
});
test('closing during asynchronous start is remembered and prevents a recording leak', async (t) => {
  const x = await setup(t);
  let release, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const start = x.controller.start({ ...x.input, conditions: () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
  await waiting; await x.controller.closeTab('tab'); release({ hidden: false });
  await assert.rejects(start, { code: 'trace-tab-closed' });
  assert.equal(x.cdp.calls.length, 0);
  const r = await x.controller.start(x.input); x.fire(1000); await x.terminal(r.traceId);
});
