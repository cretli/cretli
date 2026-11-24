import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityConnection, runAntigravityPrompt, createAntigravityEventNormalizer, acpMcpServers, buildAntigravityUsageEvents, readAntigravityQuotaNotice } from '../antigravity-client.js';
import { resolveHarnessUsageTokens } from '../../../lib/usage/harness-usage.ts';
import { resolveUsageContract, resolveWindowSemantics } from '../../../lib/usage/usage-contract.js';
import { applyCodexMeasuredContextUsage, buildChatContextSnapshot } from '../../../app_front/features/chat/chatContextMeter.js';
import { listAntigravityModels, parseAntigravityModels, resolveAntigravityCli, isAntigravityCliFound } from '../antigravity-config.js';
import { loadOptionalHarnessPlugins } from '../../../lib/agent-harness/optional-harness-plugins.ts';
import { getBuiltinHarnessProvider } from '../../../lib/agent-harness/builtin-harness-providers.ts';
import { getBuiltinHarnessBackend } from '../../../lib/agent-harness/builtin-harness-backends.ts';
import { getChatRunAdapterCapabilities } from '../../../lib/chat-run-service.js';
import { getHarnessMcpAdapter } from '../../../lib/mcp/adapters/index.js';
import { readClientSettings, applySettingsPatch } from '../antigravity-settings.js';

function fakeConnection(responses = {}) {
  const requests = [];
  let handlers;
  return {
    requests,
    factory(options) {
      handlers = options;
      return {
        close() { requests.push(['close']); },
        async request(method, params) {
          requests.push([method, params]);
          if (method in responses) return typeof responses[method] === 'function' ? responses[method](params, handlers) : responses[method];
          if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
          if (method === 'session/new' || method === 'session/load') {
            // History replay must not duplicate prior assistant messages.
            handlers.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } } });
            return { sessionId: 'saved', modes: { currentModeId: 'agent', availableModes: [{ id: 'plan' }, { id: 'agent' }] } };
          }
          if (method === 'session/prompt') {
            handlers.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } });
            return { stopReason: 'end_turn' };
          }
          return {};
        },
      };
    },
  };
}

const base = () => ({ cwd: process.cwd(), model: 'default', mode: 'agent', prompt: 'hello', mcpServers: {}, onSession: async () => {}, onEvent: () => {}, checkPermission: async () => ({ outcome: 'proceed' }) });

test('configuration, model table and non-secret settings', () => {
  assert.equal(resolveAntigravityCli({ ANTIGRAVITY_BIN: 'custom' }, { antigravityBin: 'saved' }), 'custom');
  assert.equal(isAntigravityCliFound('/no/such/agy'), false);
  assert.deepEqual(parseAntigravityModels('Available models:\n gemini-3.1-pro-high   Gemini Pro\n\u001b[32mclaude-sonnet\u001b[0m   Claude Sonnet\n'), [{ id: 'gemini-3.1-pro-high', name: 'Gemini Pro' }, { id: 'claude-sonnet', name: 'Claude Sonnet' }]);
  const settings = {};
  assert.equal(applySettingsPatch({ antigravityBin: ' agy ', antigravityChatEnabledModels: ['default'] }, settings).changed, true);
  assert.deepEqual(readClientSettings(settings), { antigravityBin: 'agy', antigravityChatEnabledModels: ['default'] });
});

test('model discovery accepts CLI tab-separated rows and ignores progress messages', async () => {
  const models = [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ];
  const stdout = 'Fetching available models...\r\n' + models.map(({ id, name }) => `${id}\t${name}\r\n`).join('');
  const result = await listAntigravityModels({ run: async (_bin, args) => {
    assert.deepEqual(args, ['models']);
    return { stdout };
  } });
  assert.deepEqual(result.models, [{ id: 'default', name: 'Antigravity default' }, ...models]);
  assert.deepEqual(result.catalog.slice(1), models.map(({ id, name }) => ({ value: id, modelId: id, label: name, group: name.replace(/\s+\([^()]+\)$/, '') })));
  assert.equal(result.modelsSource, 'cli');
});

test('ACP new session, model selection, MCP and streaming', async () => {
  const fake = fakeConnection();
  const events = [];
  const sessions = [];
  await runAntigravityPrompt({ ...base(), model: 'custom-model', mcpServers: { bridge: { command: 'node', args: ['bridge.js'], env: { KEY: 'value' } } }, connectionFactory: fake.factory, onEvent: (event) => events.push(event), onSession: async (id) => sessions.push(id) });
  assert.deepEqual(sessions, ['saved']);
  assert.equal(events.length, 1);
  assert.equal(events[0].message.content[0].text, 'hello');
  assert.deepEqual(fake.requests.find(([method]) => method === 'session/new')[1].mcpServers, [{ name: 'bridge', command: 'node', args: ['bridge.js'], env: [{ name: 'KEY', value: 'value' }] }]);
  assert.equal(fake.requests.find(([method]) => method === 'session/set_model')[1].modelId, 'custom-model');
  assert.equal(fake.requests.at(-1)[0], 'close');
  assert.throws(() => acpMcpServers({ invalid: { url: 'http://localhost' } }), /stdio bridge/);
});

test('turn usage becomes a measured context reading and a ledger delta', async () => {
  // Shape captured from agy 1.5.13: input excludes cached tokens, thoughts are part of output.
  const usage = { inputTokens: 2148, outputTokens: 15, cachedReadTokens: 6758, cachedWriteTokens: 0, thoughtTokens: 14, totalTokens: 8921 };
  const [context, ledger] = buildAntigravityUsageEvents({ result: { usage }, usageUpdate: { used: 8921, size: 1048576 }, model: 'gemini-3.8-flash-medium', observedAt: '2026-11-21T00:00:00.000Z', turnId: 'run-1' });
  assert.deepEqual(context, {
    type: 'context_usage', source: 'antigravity-acp', model: 'gemini-3.8-flash-medium',
    usage: { inputTokens: 8906, outputTokens: 15, totalTokens: 8921, cacheReadTokens: 6758, cacheWriteTokens: 0, reasoningTokens: 14 },
    contextWindowTokens: 1048576, observedAt: '2026-11-21T00:00:00.000Z', turnId: 'run-1',
  });
  assert.equal(ledger.type, 'usage');
  assert.equal(ledger.final, true);
  const tokens = resolveHarnessUsageTokens('antigravity', ledger);
  assert.equal(tokens.textInput, 2148);
  assert.equal(tokens.cachedInput, 6758);
  assert.equal(tokens.textOutput, 15);
  assert.equal(resolveWindowSemantics(resolveUsageContract('antigravity')), 'disjoint');
  // Without a usage_update the turn total still sizes the context; the window stays unknown.
  const [fallback] = buildAntigravityUsageEvents({ result: { usage }, model: 'm' });
  assert.equal(fallback.usage.totalTokens, 8921);
  assert.equal(fallback.contextWindowTokens, null);
  assert.deepEqual(buildAntigravityUsageEvents({ result: { stopReason: 'end_turn' } }), []);

  const fake = fakeConnection({ 'session/prompt': (_params, handlers) => {
    handlers.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'usage_update', used: 8921, size: 1048576 } });
    return { stopReason: 'end_turn', usage };
  } });
  const events = [];
  await runAntigravityPrompt({ ...base(), model: 'gemini-3.8-flash-medium', turnId: 'run-2', connectionFactory: fake.factory, onEvent: (event) => events.push(event) });
  assert.deepEqual(events.map((event) => event.type), ['context_usage', 'usage']);
  assert.equal(events[0].contextWindowTokens, 1048576);
  assert.equal(events[0].model, 'gemini-3.8-flash-medium');
  assert.equal(events[1].turnId, 'run-2');
});

test('context meter shows the measured Antigravity window, cache reads and source', () => {
  const usage = { inputTokens: 2148, outputTokens: 15, cachedReadTokens: 6758, cachedWriteTokens: 0, thoughtTokens: 14 };
  const [event] = buildAntigravityUsageEvents({ result: { usage }, usageUpdate: { used: 8921, size: 1048576 }, model: 'gemini-3.8-flash-medium', observedAt: new Date().toISOString() });
  const chat = { agentTransport: 'antigravity', model: 'gemini-3.8-flash-medium' };
  assert.equal(applyCodexMeasuredContextUsage(chat, event), true);
  const snapshot = buildChatContextSnapshot(chat);
  assert.equal(snapshot.source, 'antigravity-measured');
  assert.equal(snapshot.isEstimated, false);
  assert.equal(snapshot.contextWindowTokens, 1048576);
  assert.equal(snapshot.limitSource, 'provider');
  assert.equal(snapshot.inputTokens, 8906);
  assert.equal(snapshot.outputTokens, 15);
  assert.equal(snapshot.cacheReadTokens, 6758);
  assert.equal(snapshot.fillPercent, 0.9);
  assert.equal(applyCodexMeasuredContextUsage({ agentTransport: 'opencode' }, event), false);
});

test('resumes exact id, suppresses replay and requires load capability', async () => {
  const fake = fakeConnection();
  await runAntigravityPrompt({ ...base(), sessionId: 'saved', connectionFactory: fake.factory });
  assert.equal(fake.requests.find(([method]) => method === 'session/load')[1].sessionId, 'saved');
  const unavailable = fakeConnection({ initialize: { protocolVersion: 1, agentCapabilities: {} } });
  await assert.rejects(runAntigravityPrompt({ ...base(), sessionId: 'saved', connectionFactory: unavailable.factory }), /cannot resume/);
  assert.ok(!unavailable.requests.some(([method]) => method === 'session/new'));
});

test('permission uses only allow_once and propagates deny', async () => {
  for (const decision of ['proceed', 'deny']) {
    let outcome;
    const fake = fakeConnection({ 'session/prompt': async (_params, handlers) => {
      outcome = await handlers.onPermission({ sessionId: 'saved', toolCall: { kind: 'execute', rawInput: { command: 'pwd' } }, options: [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }] });
      return { stopReason: 'end_turn' };
    } });
    await runAntigravityPrompt({ ...base(), connectionFactory: fake.factory, checkPermission: async () => ({ outcome: decision }) });
    assert.deepEqual(outcome, { outcome: decision === 'proceed' ? { outcome: 'selected', optionId: 'once' } : { outcome: 'cancelled' } });
  }
});

test('Plan requires native mode, denies execute and review is forced into Plan', async () => {
  let permission;
  const fake = fakeConnection({ 'session/prompt': async (_params, handlers) => {
    permission = await handlers.onPermission({ sessionId: 'saved', toolCall: { kind: 'execute' }, options: [{ kind: 'allow_once', optionId: 'once' }] });
    return { stopReason: 'end_turn' };
  } });
  await runAntigravityPrompt({ ...base(), mode: 'plan', connectionFactory: fake.factory });
  assert.ok(fake.requests.some(([method]) => method === 'session/set_mode'));
  assert.deepEqual(permission, { outcome: { outcome: 'cancelled' } });
  const review = fakeConnection({ 'session/prompt': async (_params, handlers) => {
    permission = await handlers.onPermission({ sessionId: 'saved', toolCall: { kind: 'edit' }, options: [{ kind: 'allow_once', optionId: 'once' }] });
    return { stopReason: 'end_turn' };
  } });
  await runAntigravityPrompt({ ...base(), mode: 'agent', assignment: 'review', connectionFactory: review.factory });
  assert.ok(review.requests.some(([method]) => method === 'session/set_mode'));
  assert.deepEqual(permission, { outcome: { outcome: 'cancelled' } });
  const noPlan = fakeConnection({ 'session/new': { sessionId: 'saved' } });
  await assert.rejects(runAntigravityPrompt({ ...base(), mode: 'ask', connectionFactory: noPlan.factory }), /native Plan/);
});

test('review permits read-only ACP commands through the host gate and denies mutations', async () => {
  const cases = [
    [{ CommandLine: 'ls -la lib' }, true],
    [{ CommandLine: 'git diff --stat' }, true],
    [{ command: 'rg -n review lib' }, true],
    [{ commandLine: 'pwd' }, true],
    [{ cmd: 'cat package.json' }, true],
    [{ CommandLine: 'git status --porcelain', command: 'rm -rf lib' }, true],
    [{ CommandLine: 'rm -rf lib' }, false],
    [{ CommandLine: 'cat package.json > copy.json' }, false],
    [{ CommandLine: 'find . -exec rm {} +' }, false],
    [{ CommandLine: 'node scripts/task.js' }, false],
    [{ CommandLine: 'curl https://example.com' }, false],
    [{}, false],
  ];
  for (const [rawInput, allowed] of cases) {
    let outcome;
    const checked = [];
    const fake = fakeConnection({ 'session/prompt': async (_params, handlers) => {
      outcome = await handlers.onPermission({ sessionId: 'saved', toolCall: { kind: 'execute', rawInput }, options: [{ kind: 'allow_once', optionId: 'once' }] });
      return { stopReason: 'end_turn' };
    } });
    await runAntigravityPrompt({ ...base(), assignment: 'review', connectionFactory: fake.factory, checkPermission: async (name, input) => {
      checked.push({ name, input });
      return { outcome: 'proceed' };
    } });
    assert.deepEqual(outcome, { outcome: allowed ? { outcome: 'selected', optionId: 'once' } : { outcome: 'cancelled' } }, JSON.stringify(rawInput));
    assert.equal(checked.length, allowed ? 1 : 0);
    if (allowed) {
      assert.equal(checked[0].name, 'run_terminal_command');
      assert.equal(checked[0].input.command, rawInput.CommandLine ?? rawInput.command ?? rawInput.commandLine ?? rawInput.cmd);
    }
  }
});

test('review preserves host denial, requires native Plan and keeps Scout blocked', async () => {
  let outcome;
  const fake = fakeConnection({ 'session/prompt': async (_params, handlers) => {
    outcome = await handlers.onPermission({ sessionId: 'saved', toolCall: { kind: 'execute', rawInput: { CommandLine: 'pwd' } }, options: [{ kind: 'allow_once', optionId: 'once' }] });
    return { stopReason: 'end_turn' };
  } });
  await runAntigravityPrompt({ ...base(), assignment: 'review', connectionFactory: fake.factory, checkPermission: async () => ({ outcome: 'deny' }) });
  assert.deepEqual(outcome, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(fake.requests.find(([method]) => method === 'session/set_mode')[1], { sessionId: 'saved', modeId: 'plan' });
  const noPlan = fakeConnection({ 'session/new': { sessionId: 'saved' } });
  await assert.rejects(runAntigravityPrompt({ ...base(), assignment: 'review', connectionFactory: noPlan.factory }), /native Plan/);
  assert.ok(!noPlan.requests.some(([method]) => method === 'session/prompt'));
  const scout = fakeConnection();
  await assert.rejects(runAntigravityPrompt({ ...base(), scoutReadOnly: true, connectionFactory: scout.factory }), /not certified.*scout/);
  assert.equal(scout.requests.length, 0);
});

test('errors and cancelled stop reasons close the process', async () => {
  const fake = fakeConnection({ 'session/prompt': { stopReason: 'cancelled' } });
  await assert.rejects(runAntigravityPrompt({ ...base(), connectionFactory: fake.factory }), /cancelled/);
  assert.equal(fake.requests.at(-1)[0], 'close');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runAntigravityPrompt({ ...base(), signal: controller.signal }), /cancelled/);
});

test('partial tool updates retain their identity and arguments', () => {
  const events = [];
  const normalize = createAntigravityEventNormalizer((event) => events.push(event));
  normalize({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'Read', kind: 'read', rawInput: { path: 'file' } });
  normalize({ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed', rawOutput: 'text' });
  assert.equal(events[1].name, 'Read');
  assert.equal(events[1].status, 'completed');
  assert.deepEqual(events[1].args, { path: 'file' });
});

test('JSON-RPC transport handles split frames, reverse requests, process exit', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {};
  let sent = '';
  child.stdin.on('data', (chunk) => { sent += chunk; });
  const conn = new AntigravityConnection({ cwd: process.cwd(), spawnProcess: () => child });
  const pending = conn.request('initialize', {});
  child.stdout.write('{"jsonrpc":"2.0","id":1,"res');
  child.stdout.write('ult":{"protocolVersion":1}}\n');
  assert.deepEqual(await pending, { protocolVersion: 1 });
  child.stdout.write('{"jsonrpc":"2.0","id":2,"method":"unsupported","params":{}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sent, /Client capability not supported/);
  const interrupted = conn.request('session/new', {});
  child.emit('exit', 1);
  await assert.rejects(interrupted, /exited/);
  assert.equal(conn.pending.size, 0);
});

test('production optional plugin registers backend, WebSocket and server-run adapters', async () => {
  const result = await loadOptionalHarnessPlugins({ env: { CRETLI_OPTIONAL_HARNESSES: 'antigravity' } });
  assert.deepEqual(result.errors, []);
  assert.ok(getBuiltinHarnessProvider('antigravity'));
  assert.ok(getBuiltinHarnessBackend('antigravity'));
  assert.ok(getChatRunAdapterCapabilities('antigravity'));
  assert.equal(getHarnessMcpAdapter('antigravity').callControl, 'bridge');
});

test('server-run turn persists ACP identity, finishes and resumes through a real subprocess', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { addChatAsync, getChatByIdAsync } = await import('../../../lib/persist/chats-persist.js');
  const { handleAntigravityAgentWebSocket, startAntigravityChatRun, getAntigravityRoomDiag, disposeAntigravityRoom } = await import('../antigravity-agent-ws.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'cretli-acp-'));
  const cli = path.join(dir, 'agy');
  const previousBin = process.env.ANTIGRAVITY_BIN;
  const key = randomUUID();
  try {
    await writeFile(cli, `#!${process.execPath}
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const msg = JSON.parse(line);
  let result = {};
  if (msg.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  if (msg.method === 'session/new') result = { sessionId: 'durable-acp' };
  if (msg.method === 'session/load' && msg.params.sessionId !== 'durable-acp') process.exit(3);
  if (msg.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'durable-acp', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } } }) + '\\n');
    result = { stopReason: 'end_turn' };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
});
`, { mode: 0o700 });
    process.env.ANTIGRAVITY_BIN = cli;
    const chat = await addChatAsync(key, 'ACP test', '', dir, 'default', { agentTransport: 'antigravity', sdkMode: 'agent' });
    const payloads = [];
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.send = (text) => payloads.push(JSON.parse(text));
    ws.close = () => {};
    await handleAntigravityAgentWebSocket(ws, key, { workspaceDirForAgent: () => dir });
    for (let turn = 0; turn < 2; turn++) {
      const accepted = await startAntigravityChatRun({ chat, prompt: 'Reply briefly', deps: { workspaceDirForAgent: () => dir } });
      assert.equal(accepted.accepted, true);
      assert.ok(accepted.runId);
      const started = payloads.filter((item) => item.type === 'sdkPromptStarted').at(-1);
      assert.equal(started.text, 'Reply briefly');
      assert.equal(started.fromQueue, false);
      assert.equal(started.remaining, 0);
      const deadline = Date.now() + 5000;
      while (getAntigravityRoomDiag(key)?.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(getAntigravityRoomDiag(key)?.busy, false);
      assert.equal(payloads.filter((item) => item.type === 'sdkRunFinished').at(-1)?.status, 'completed');
      const saved = await getChatByIdAsync(chat.id);
      assert.equal(saved.antigravitySessionId, 'durable-acp');
      chat.antigravitySessionId = saved.antigravitySessionId;
    }
    payloads.length = 0;
    await startAntigravityChatRun({ chat, prompt: 'First', deps: { workspaceDirForAgent: () => dir } });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'send', text: 'Queued' })));
    const deadline = Date.now() + 5000;
    while (payloads.filter((item) => item.type === 'sdkRunFinished').length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const started = payloads.filter((item) => item.type === 'sdkPromptStarted');
    assert.deepEqual(started.map((item) => [item.text, item.fromQueue]), [['First', false], ['Queued', true]]);
    assert.equal(payloads.filter((item) => item.type === 'sdkRunFinished').length, 2);
  } finally {
    disposeAntigravityRoom(key);
    if (previousBin === undefined) delete process.env.ANTIGRAVITY_BIN;
    else process.env.ANTIGRAVITY_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  }
});

test('uploaded screenshots become ACP image blocks and unsupported images fail explicitly', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const dir = await mkdtemp(path.join(tmpdir(), 'cretli-acp-images-'));
  const file = path.join(dir, randomUUID() + '.jpg');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  try {
    await writeFile(file, jpeg);
    const supported = fakeConnection({ initialize: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
    await runAntigravityPrompt({ ...base(), prompt: `Inspect this\n[Screenshot: ${file}]`, promptImageOptions: { uploadsDir: dir }, connectionFactory: supported.factory });
    const blocks = supported.requests.find(([method]) => method === 'session/prompt')[1].prompt;
    assert.deepEqual(blocks, [{ type: 'text', text: 'Inspect this' }, { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }]);
    const unsupported = fakeConnection();
    await assert.rejects(runAntigravityPrompt({ ...base(), prompt: `[Screenshot: ${file}]`, promptImageOptions: { uploadsDir: dir }, connectionFactory: unsupported.factory }), /does not support image/);
    assert.ok(!unsupported.requests.some(([method]) => method === 'session/prompt'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation notifies the ACP session before terminating the process', async () => {
  const controller = new AbortController();
  let finishPrompt;
  const fake = fakeConnection({ 'session/prompt': () => new Promise((resolve) => {
    finishPrompt = resolve;
    setImmediate(() => controller.abort());
  }) });
  const factory = (options) => ({
    ...fake.factory(options),
    write(message) {
      fake.requests.push(['notification', message]);
      finishPrompt({ stopReason: 'cancelled' });
    },
  });
  await assert.rejects(runAntigravityPrompt({ ...base(), signal: controller.signal, connectionFactory: factory }), /cancelled/);
  assert.deepEqual(fake.requests.find(([method]) => method === 'notification')[1], { method: 'session/cancel', params: { sessionId: 'saved' } });
  assert.equal(fake.requests.at(-1)[0], 'close');
});

test('an exhausted quota answered as assistant text fails the run as a usage limit', async () => {
  const notice = '\u26a0 Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 166h45m41s.';
  assert.equal(readAntigravityQuotaNotice(`\n${notice}\n`), notice.slice(2));
  assert.equal(readAntigravityQuotaNotice('The quota reached its peak in Q3, so I refactored the report.'.repeat(20)), '');
  assert.equal(readAntigravityQuotaNotice('hello'), '');
  const quota = fakeConnection({ 'session/prompt': (_params, handlers) => {
    handlers.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n${notice}\n` } } });
    return { stopReason: 'end_turn' };
  } });
  const events = [];
  await assert.rejects(
    runAntigravityPrompt({ ...base(), connectionFactory: quota.factory, onEvent: (event) => events.push(event) }),
    /^Error: Antigravity usage limit: Individual quota reached\..*Resets in 166h45m41s\.$/,
  );
  assert.equal(events.length, 1, 'the notice is still shown in the chat');
  assert.equal(quota.requests.at(-1)[0], 'close');
  // The same words inside a turn that used tools are an answer, not a refusal.
  const worked = fakeConnection({ 'session/prompt': (_params, handlers) => {
    handlers.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', kind: 'read', status: 'completed' } });
    handlers.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Individual quota reached is the error text in the logs.' } } });
    return { stopReason: 'end_turn' };
  } });
  await runAntigravityPrompt({ ...base(), connectionFactory: worked.factory });
});
