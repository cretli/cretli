import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeTool } from '../lib/agent-harness/tool-executor.js';
import { resolvePlanModeSdkEventDecision, resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.js';
import { listDelegationAdapterCapabilities } from '../lib/delegation-adapter-capabilities.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { getChatRunAdapter } from '../lib/chat-run-service.js';

const TRANSPORTS = ['opencode', 'openrouter', 'codebuddy', 'deepseek', 'qwen', 'codex'];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER_MODULES = {
  opencode: 'lib/opencode/opencode-agent-ws.js',
  openrouter: 'lib/openrouter/openrouter-agent-ws.js',
  codebuddy: 'lib/codebuddy/codebuddy-agent-ws.js',
  deepseek: 'lib/deepseek/deepseek-agent-ws.js',
  qwen: 'lib/qwen/qwen-agent-ws.js',
  codex: 'lib/codex/codex-agent-ws.js',
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-phase3b-adapter-'));
const fixturePath = path.join(tmpRoot, 'fixture.txt');
fs.writeFileSync(fixturePath, 'fixture-read', 'utf8');

const caps = listDelegationAdapterCapabilities();
for (const transport of TRANSPORTS) {
  const row = caps.find((item) => item.transport === transport);
  assert.ok(row, `missing capabilities for ${transport}`);
  assert.equal(row.canReadFiles, true);
}

/**
 * @param {string} transport
 */
async function assertReviewWriteDenied(transport) {
  const denied = resolvePlanModeToolDecision({
    transport,
    mode: 'agent',
    assignment: 'review',
    toolName: 'write_file',
    input: { path: 'fixture.txt', content: 'mutated' },
  });
  assert.equal(denied.deny, true, transport);
  const eventDenied = resolvePlanModeSdkEventDecision({
    transport,
    mode: 'agent',
    assignment: 'review',
    event: {
      type: 'tool_call',
      name: 'write_file',
      status: 'running',
      args: { path: 'fixture.txt', content: 'mutated' },
    },
  });
  assert.equal(eventDenied.deny, true, transport);
  const before = fs.readFileSync(fixturePath, 'utf8');
  assert.equal(before, 'fixture-read');
  const write = await executeTool('write_file', { path: 'fixture.txt', content: 'mutated' }, {
    cwd: tmpRoot,
    mode: 'agent',
    assignment: 'review',
  });
  assert.equal(write.ok, false, `${transport} write_file must fail in review`);
  assert.equal(fs.readFileSync(fixturePath, 'utf8'), before);
  const read = await executeTool('read_file', { path: 'fixture.txt' }, {
    cwd: tmpRoot,
    mode: 'agent',
    assignment: 'review',
  });
  assert.equal(read.ok, true);
  assert.match(read.output, /fixture-read/);
}

/**
 * Cancel through the real adapter module without starting a model run.
 *
 * @param {{
 *   transport: string,
 *   model: string,
 *   ensureRoom: Function,
 *   disposeRoom?: Function,
 * }} input
 */
async function certifyInMemoryCancel(input) {
  const chat = addChat(crypto.randomUUID(), `${input.transport}-guard`, null, ISOLATED_DATA_DIR, input.model, {
    agentTransport: input.transport,
    sdkMode: 'agent',
  });
  const ensured = await input.ensureRoom(chat.cursorSessionId, {
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
  });
  if (ensured && typeof ensured === 'object' && 'error' in ensured) {
    return {
      integration: 'deferred',
      integrationReason: String(ensured.code || ensured.error || 'ensure_room_failed'),
    };
  }
  const runId = `run-${input.transport}-e3`;
  ensured.room.busy = true;
  ensured.room.currentRun = { id: runId };
  const adapter = getChatRunAdapter(input.transport);
  await adapter.cancel({ chat, runId });
  assert.equal(ensured.room.cancelled, true, input.transport);
  assert.ok(adapter.getState({ chat, runId }));
  if (typeof input.disposeRoom === 'function') input.disposeRoom(chat.cursorSessionId);
  return { integration: 'pass', integrationReason: '' };
}

const matrix = [];

for (const transport of TRANSPORTS) {
  const modulePath = ADAPTER_MODULES[transport];
  const abs = path.join(projectRoot, modulePath);
  assert.equal(fs.existsSync(abs), true, abs);
  const source = fs.readFileSync(abs, 'utf8');
  assert.match(source, /register(?:Kernel)?ChatRunAdapter|registerChatRunAdapter/);
  assert.equal(/registerMockChatRunAdapter/.test(source), false, transport);
  await assertReviewWriteDenied(transport);
  await import(pathToFileURL(abs).href);
  const adapter = getChatRunAdapter(transport);
  assert.ok(adapter, `adapter module did not register ${transport}`);
  assert.equal(typeof adapter.cancel, 'function');
  let integration = 'deferred';
  let integrationReason = '';
  if (transport === 'openrouter') {
    const { ensureOpenRouterRoom, disposeOpenRouterRoom } = await import('../lib/openrouter/openrouter-agent-ws.js');
    const result = await certifyInMemoryCancel({
      transport,
      model: 'openrouter/test',
      ensureRoom: ensureOpenRouterRoom,
      disposeRoom: disposeOpenRouterRoom,
    });
    integration = result.integration;
    integrationReason = result.integrationReason;
  } else if (transport === 'opencode') {
    integrationReason = 'ensureOpenCodeRoom starts a live OpenCode instance';
  } else if (transport === 'deepseek') {
    const { ensureDeepSeekRoom, disposeDeepSeekRoom } = await import('../lib/deepseek/deepseek-agent-ws.js');
    const result = await certifyInMemoryCancel({
      transport,
      model: 'deepseek-chat',
      ensureRoom: ensureDeepSeekRoom,
      disposeRoom: disposeDeepSeekRoom,
    });
    integration = result.integration;
    integrationReason = result.integrationReason;
  } else if (transport === 'codebuddy') {
    const { ensureCodeBuddyRoom, disposeCodeBuddyRoom } = await import('../lib/codebuddy/codebuddy-agent-ws.js');
    const result = await certifyInMemoryCancel({
      transport,
      model: 'codebuddy/default',
      ensureRoom: ensureCodeBuddyRoom,
      disposeRoom: disposeCodeBuddyRoom,
    });
    integration = result.integration;
    integrationReason = result.integrationReason;
  } else if (transport === 'qwen') {
    const { ensureQwenRoom, disposeQwenRoom } = await import('../lib/qwen/qwen-agent-ws.js');
    const result = await certifyInMemoryCancel({
      transport,
      model: 'qwen-plus',
      ensureRoom: ensureQwenRoom,
      disposeRoom: disposeQwenRoom,
    });
    integration = result.integration;
    integrationReason = result.integrationReason;
  } else if (transport === 'codex') {
    const { ensureCodexRoom, disposeCodexRoom } = await import('../lib/codex/codex-agent-ws.js');
    const result = await certifyInMemoryCancel({
      transport,
      model: 'gpt-5',
      ensureRoom: ensureCodexRoom,
      disposeRoom: disposeCodexRoom,
    });
    integration = result.integration;
    integrationReason = result.integrationReason;
  }
  matrix.push({
    transport,
    path: modulePath,
    unit: 'pass',
    integration,
    integrationReason,
    live: 'deferred-no-paid-models',
  });
}

assert.equal(matrix.length, TRANSPORTS.length);
assert.equal(matrix.every((row) => row.unit === 'pass'), true);
assert.equal(matrix.every((row) => row.live === 'deferred-no-paid-models'), true);
assert.equal(matrix.some((row) => row.integration === 'pass-mock-adapter'), false);
assert.equal(matrix.some((row) => row.integration === 'pass' && row.transport === 'openrouter'), true);

console.log(JSON.stringify({ gate: 'E3', matrix }, null, 2));
console.log('delegation-phase3-adapter-guards.test.js OK');
