import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AntigravityConnection, runAntigravityPrompt, createAntigravityEventNormalizer, acpMcpServers } from '../antigravity-client.js';
import { parseAntigravityModels, resolveAntigravityCli, isAntigravityCliFound } from '../antigravity-config.js';
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

test('Plan requires native mode, denies execute and review remains uncertified', async () => {
  let permission;
  const fake = fakeConnection({ 'session/prompt': async (_params, handlers) => {
    permission = await handlers.onPermission({ sessionId: 'saved', toolCall: { kind: 'execute' }, options: [{ kind: 'allow_once', optionId: 'once' }] });
    return { stopReason: 'end_turn' };
  } });
  await runAntigravityPrompt({ ...base(), mode: 'plan', connectionFactory: fake.factory });
  assert.ok(fake.requests.some(([method]) => method === 'session/set_mode'));
  assert.deepEqual(permission, { outcome: { outcome: 'cancelled' } });
  await assert.rejects(runAntigravityPrompt({ ...base(), assignment: 'review', connectionFactory: fake.factory }), /not certified/);
  const noPlan = fakeConnection({ 'session/new': { sessionId: 'saved' } });
  await assert.rejects(runAntigravityPrompt({ ...base(), mode: 'ask', connectionFactory: noPlan.factory }), /native Plan/);
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
      const deadline = Date.now() + 5000;
      while (getAntigravityRoomDiag(key)?.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(getAntigravityRoomDiag(key)?.busy, false);
      assert.equal(payloads.filter((item) => item.type === 'sdkRunFinished').at(-1)?.status, 'completed');
      const saved = await getChatByIdAsync(chat.id);
      assert.equal(saved.antigravitySessionId, 'durable-acp');
      chat.antigravitySessionId = saved.antigravitySessionId;
    }
  } finally {
    disposeAntigravityRoom(key);
    if (previousBin === undefined) delete process.env.ANTIGRAVITY_BIN;
    else process.env.ANTIGRAVITY_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  }
});
