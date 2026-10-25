import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { CodexAppServer, isCodexAppServerCompaction, isCodexAppServerEnabled, runCodexAppServerTurn } from '../lib/codex/codex-app-server.ts';
import { handleThreadEvent } from '../lib/codex/codex-agent-ws.ts';
import { createCodexSteering, resolveCodexPromptKind } from '../lib/codex/codex-steer.ts';
import { buildCodexCompactionEvent, parseCodexContextUsage } from '../lib/codex/codex-context-usage.ts';
import { beginHarnessRun, recordHarnessUsageDelta } from '../lib/usage/harness-usage.ts';
import { normalizeCodexThreadEvent } from '../lib/agent-harness/codex-event-normalizer.ts';

function fakeClient({ stale = false, respond = true, requestTimeoutMs } = {}) {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => child.emit('close');
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const message = JSON.parse(chunk.toString());
    requests.push(message);
    if (respond && message.id && message.method) queueMicrotask(() => {
      const result = message.method.startsWith('thread/') ? { thread: { id: 'thread' } }
        : message.method === 'turn/start' ? { turn: { id: 'turn' } }
          : message.method === 'turn/steer' ? { turnId: message.params.expectedTurnId } : {};
      child.stdout.write(JSON.stringify(stale && message.method === 'turn/steer'
        ? { id: message.id, error: { message: 'stale turn' } } : { id: message.id, result }) + '\n');
    });
    callback();
  } });
  const client = new CodexAppServer({ spawnFn: () => child, requestTimeoutMs });
  return { client, child, requests, notify: (method, params) => child.stdout.write(JSON.stringify({ method, params }) + '\n') };
}

for (const stale of [false, true]) test(`fake RPC steer ${stale ? 'stale queues once' : 'delivered'}`, async () => {
  const fake = fakeClient({ stale });
  const queued = [], history = [], acks = [];
  await fake.client.initialize({ workingDirectory: '/workspace', approvalPolicy: 'never', sandboxMode: 'read-only' }, 'existing', { mcp_servers: { example: { url: 'https://example.com' } } });
  const room = { busy: true, currentRun: { id: 'run' }, _appServer: fake.client };
  const steering = createCodexSteering({ room, enqueue: (...args) => queued.push(args), delivered: (text) => history.push(text), broadcast: (ack) => acks.push(ack) });
  const run = fake.client.run('initial', (event) => steering.observe(event));
  await new Promise(setImmediate);
  await steering.steer('change');
  assert.equal(queued.length, stale ? 1 : 0);
  assert.deepEqual(history, stale ? [] : ['change']);
  assert.equal(acks[0].outcome, stale ? 'revert_to_followup' : 'complete_delivered');
  const resume = fake.requests.find((item) => item.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'existing');
  assert.equal(resume.params.sandbox, 'read-only');
  assert.equal(resume.params.approvalPolicy, 'never');
  assert.ok(resume.params.config.mcp_servers.example);
  fake.notify('turn/completed', { turn: { id: 'turn' } });
  await run;
  fake.client.close();
});

test('cancel preserves seen steer and queues unseen exactly once', async () => {
  const fake = fakeClient();
  await fake.client.initialize({}, '');
  const queued = [];
  const room = { busy: true, _appServer: fake.client, pendingPrompts: [] };
  const steering = createCodexSteering({ room, enqueue: (text, mode, displayText) => {
    queued.push(text);
    room.pendingPrompts.push({ text, mode, displayText });
  }, delivered() {}, broadcast() {} });
  const run = fake.client.run('initial', steering.observe);
  await new Promise(setImmediate);
  await steering.steer('seen');
  fake.notify('item/started', { turnId: 'turn', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'seen' }] } });
  fake.notify('item/completed', { turnId: 'turn', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'seen' }] } });
  await steering.steer('unseen');
  room.cancelled = true;
  steering.cancel();
  steering.cancel();
  assert.deepEqual(queued, ['unseen']);
  assert.deepEqual(room.pendingPrompts.map((item) => item.text), ['unseen']);
  const rejected = assert.rejects(run, /interrupted/);
  await fake.client.interrupt();
  await rejected;
  assert.ok(fake.requests.some((item) => item.method === 'turn/interrupt'));
  fake.client.close();
});

test('flag defaults off and app-server items normalize', () => {
  assert.equal(isCodexAppServerEnabled({}), false);
  assert.equal(isCodexAppServerEnabled({ CRETLI_CODEX_APP_SERVER: '1' }), true);
  assert.ok(normalizeCodexThreadEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'done' } } }).length);
});

test('ack arriving after cancel requeues once', async () => {
  let acknowledge;
  const queued = [];
  const room = { busy: true, _appServer: { turnId: 'turn', steer: () => new Promise((resolve) => { acknowledge = resolve; }) } };
  const steering = createCodexSteering({ room, enqueue: (text) => queued.push(text), delivered() {}, broadcast() {} });
  const request = steering.steer('late');
  room.cancelled = true;
  steering.cancel();
  acknowledge({ turnId: 'turn' });
  await request;
  steering.cancel();
  assert.deepEqual(queued, ['late']);
});


test('RPC timeout rejects and removes its pending entry', async (t) => {
  const fake = fakeClient({ respond: false, requestTimeoutMs: 5 });
  t.after(() => fake.client.close());
  const request = fake.client.request('thread/start', {});
  assert.equal(fake.client.pending.size, 1);
  await assert.rejects(request, /Codex RPC timeout: thread\/start/);
  assert.equal(fake.client.pending.size, 0);
});

for (const event of ['close', 'error']) test(`child ${event} rejects all pending requests and later calls fail fast`, async (t) => {
  const fake = fakeClient({ respond: false });
  t.after(() => fake.client.close());
  const first = assert.rejects(fake.client.request('thread/start', {}), /closed|process failed/);
  const second = assert.rejects(fake.client.request('turn/start', {}), /closed|process failed/);
  assert.equal(fake.client.pending.size, 2);
  fake.child.emit(event, new Error('process failed'));
  await Promise.all([first, second]);
  assert.equal(fake.client.pending.size, 0);
  const sentBefore = fake.requests.length;
  let settled = false;
  const later = fake.client.request('turn/steer', {}).then(
    () => assert.fail('Disconnected client accepted a request'),
    (error) => { assert.match(error.message, /closed|process failed/); settled = true; },
  );
  await new Promise(setImmediate);
  assert.equal(settled, true, 'Later calls must reject before another event-loop iteration');
  await later;
  assert.equal(fake.client.pending.size, 0);
  assert.equal(fake.requests.length, sentBefore);
});

test('interactive server request receives an error without approving or disturbing pending RPC', async (t) => {
  const fake = fakeClient({ respond: false });
  t.after(() => fake.client.close());
  const request = fake.client.request('thread/start', {});
  const id = fake.requests[0].id;
  // Server and client request id spaces can overlap.
  fake.child.stdout.write(JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: {} }) + '\n');
  await new Promise(setImmediate);
  assert.deepEqual(fake.requests[1], { id, error: { code: -32601, message: 'Interactive requests are disabled' } });
  assert.equal(fake.client.pending.size, 1);
  fake.child.stdout.write(JSON.stringify({ id, result: { thread: { id: 'thread' } } }) + '\n');
  assert.deepEqual(await request, { thread: { id: 'thread' } });
  assert.equal(fake.client.pending.size, 0);
});

test('close() rejects pending requests as disposed even when process close fires later', async () => {
  const fake = fakeClient({ respond: false });
  const pending = fake.client.request('thread/start', {});
  fake.client.close();
  fake.child.emit('close');
  await assert.rejects(pending, /disposed/);
  await assert.rejects(fake.client.request('x', {}), /disposed/);
});

test('steer message without CRETLI_CODEX_APP_SERVER degrades to send', () => {
  assert.equal(resolveCodexPromptKind('steer', false), 'send');
  assert.equal(resolveCodexPromptKind('steer', true), 'steer');
  assert.equal(resolveCodexPromptKind('send', false), 'send');
  assert.equal(resolveCodexPromptKind('other', true), null);
});

const breakdown = (input, cached, output, reasoning) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning });

/** Runs a fake app-server turn and returns the SDK-shaped events the room would handle. */
async function runFakeTurn(notifications) {
  const fake = fakeClient();
  await fake.client.initialize({ workingDirectory: '/workspace', approvalPolicy: 'never', sandboxMode: 'read-only' }, '');
  const seen = [];
  const run = runCodexAppServerTurn(fake.client, 'go', { onEvent: (event) => seen.push(event) });
  await new Promise(setImmediate);
  for (const [method, params] of notifications) fake.notify(method, params);
  await run;
  fake.client.close();
  return seen;
}

function usageRecord(events) {
  const room = { chatId: 'c1', sessionKey: 's1', transport: 'codex', modelId: 'codex-test' };
  beginHarnessRun(room, { runId: 'r1' }, {});
  const records = [];
  for (const item of events.flatMap((event) => normalizeCodexThreadEvent(event)).filter((item) => item.kind === 'usage')) {
    recordHarnessUsageDelta(room, 'codex', { type: 'usage', usage: item.usage, final: true }, (partial) => { records.push(partial); return partial; });
  }
  return records;
}

test('app-server token usage yields the same ledger record as the SDK turn.completed path', async () => {
  const events = await runFakeTurn([
    ['turn/started', { threadId: 'thread', turn: { id: 'turn' } }],
    // Thread-wide totals carry earlier turns; only growth since this turn began counts.
    ['thread/tokenUsage/updated', { threadId: 'thread', turnId: 'turn', tokenUsage: { total: breakdown(5000, 4000, 300, 50), last: breakdown(1000, 800, 100, 20) } }],
    ['thread/tokenUsage/updated', { threadId: 'thread', turnId: 'turn', tokenUsage: { total: breakdown(7000, 5800, 450, 90), last: breakdown(2000, 1800, 150, 40) } }],
    ['turn/completed', { threadId: 'thread', turn: { id: 'turn' } }],
  ]);
  const native = usageRecord(events);
  const sdk = usageRecord([{ type: 'turn.completed', usage: { input_tokens: 3000, cached_input_tokens: 2600, output_tokens: 250, reasoning_output_tokens: 60 } }]);
  assert.equal(native.length, 1);
  assert.deepEqual(native, sdk);
  assert.deepEqual(native[0].tokens, { ...native[0].tokens, textInput: 400, cachedInput: 2600, textOutput: 250, reasoning: 60 });
});

test('app-server turn without token usage or with an error reports no usage', async () => {
  const events = await runFakeTurn([['turn/completed', { threadId: 'thread', turn: { id: 'turn' } }]]);
  assert.deepEqual(usageRecord(events), []);
});

test('app-server compaction yields the same context event as the rollout compaction record', () => {
  const rollout = parseCodexContextUsage(JSON.stringify({ type: 'compacted', timestamp: '2026-10-14T12:01:00Z' }) + '\n');
  assert.deepEqual(buildCodexCompactionEvent('2026-10-14T12:01:00Z'), rollout);
  assert.equal(isCodexAppServerCompaction({ method: 'thread/compacted', params: {} }), true);
  assert.equal(isCodexAppServerCompaction({ method: 'item/completed', params: { item: { type: 'contextCompaction' } } }), true);
  assert.equal(isCodexAppServerCompaction({ method: 'item/completed', params: { item: { type: 'agentMessage' } } }), false);
});

const mcpArgs = { query: 'status' };
const sdkItem = (extra) => ({ id: 'm1', type: 'mcp_tool_call', server: 'cretli', tool: 'todo_list', arguments: mcpArgs, ...extra });
const nativeItem = (extra) => ({ id: 'm1', type: 'mcpToolCall', server: 'cretli', tool: 'todo_list', arguments: mcpArgs, ...extra });
const managedMcpConfig = { mcp_servers: { cretli: { url: 'http://127.0.0.1:3011/mcp' } } };

/** A room whose broadcasts are captured as the sdkEvent payloads clients would receive. */
function capturingRoom(tag) {
  const sent = [];
  const room = {
    sessionKey: `codex-mcp-parity-${tag}`, transport: 'codex', cwd: '/workspace', sdkMode: 'agent',
    clients: new Set([{ readyState: 1, send: (data) => sent.push(JSON.parse(data)) }]),
    eventLog: [], pendingPrompts: [], _persistBuf: [],
  };
  return { room, toolEvents: () => sent.filter((p) => p.type === 'sdkEvent' && p.event?.type === 'tool_call').map((p) => p.event) };
}

/** Drives a fake app-server turn through the production runner and the agent-ws event handler. */
async function runThroughAgentWs(items) {
  const fake = fakeClient();
  await fake.client.initialize({ workingDirectory: '/workspace', approvalPolicy: 'never', sandboxMode: 'read-only' }, '', managedMcpConfig);
  const start = fake.requests.find((item) => item.method === 'thread/start');
  assert.deepEqual(start.params.config.mcp_servers, managedMcpConfig.mcp_servers);
  const { room, toolEvents } = capturingRoom('native');
  const run = runCodexAppServerTurn(fake.client, 'go', { onEvent: (event) => handleThreadEvent(room, event) });
  await new Promise(setImmediate);
  for (const [method, item] of items) fake.notify(method, { threadId: 'thread', turnId: 'turn', item });
  fake.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn' } });
  await run;
  fake.client.close();
  return toolEvents();
}

function sdkToolEvents(events) {
  const { room, toolEvents } = capturingRoom('sdk');
  for (const event of events) handleThreadEvent(room, event);
  return toolEvents();
}

test('managed MCP tool result via the app-server turn runner matches the SDK path', async () => {
  const content = [{ type: 'text', text: 'ok' }];
  const native = await runThroughAgentWs([
    ['item/started', nativeItem({ status: 'inProgress' })],
    ['item/completed', nativeItem({ status: 'completed', result: { content, structuredContent: { items: [] } } })],
  ]);
  const sdk = sdkToolEvents([
    { type: 'item.started', item: sdkItem({ status: 'in_progress' }) },
    { type: 'item.completed', item: sdkItem({ status: 'completed', result: { content, structured_content: { items: [] } } }) },
  ]);
  assert.equal(native.length, 2);
  assert.equal(native[1].status, 'completed');
  assert.deepEqual(native[1].result.content, content);
  assert.deepEqual(native, sdk);
});

test('managed MCP tool error via the app-server turn runner matches the SDK path', async () => {
  const error = { message: 'tool exploded' };
  const native = await runThroughAgentWs([
    ['item/started', nativeItem({ status: 'inProgress' })],
    ['item/completed', nativeItem({ status: 'failed', error })],
  ]);
  const sdk = sdkToolEvents([
    { type: 'item.started', item: sdkItem({ status: 'in_progress' }) },
    { type: 'item.completed', item: sdkItem({ status: 'failed', error }) },
  ]);
  assert.equal(native.length, 2);
  assert.equal(native[1].status, 'error');
  assert.deepEqual(native, sdk);
});
