/**
 * WR1 pilot tests: the static OpenRouter built-in provider descriptor and the
 * registry-backed resolution used by the ws-router OpenRouter branch.
 *
 * No vendor SDK, no network, no API key. Every assertion runs against the
 * isolated test data dir so an operator's real settings can never leak in.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { AGENT_TRANSPORTS, isClaudeChat, isOpenRouterChat } from '../lib/agent-transport.js';
import { HARNESS_PLUGIN_CAPABILITY_KEYS } from '../lib/agent-harness/harness-plugin-contract.js';
import {
  OPENROUTER_HARNESS_PROVIDER,
  CLAUDE_HARNESS_PROVIDER,
  getBuiltinHarnessChatHandler,
  getBuiltinHarnessProvider,
  listBuiltinHarnessProviders,
  resolveBuiltinHarnessChatHandler,
} from '../lib/agent-harness/builtin-harness-providers.js';
import { getHarnessMeta } from '../lib/agent-harness/registry.js';
import { handleOpenRouterAgentWebSocket } from '../lib/openrouter/openrouter-agent-ws.js';
import { handleClaudeAgentWebSocket } from '../lib/claude/claude-agent-ws.js';
import { hasChatRunAdapter } from '../lib/chat-run-service.js';
import { saveSettings } from '../lib/persist/settings.js';

const WS_ROUTER_SOURCE = readFileSync(new URL('../lib/ws/ws-router.js', import.meta.url), 'utf8');

beforeEach(() => {
  // The executable forwarding assertion drives the real handler's missing-key
  // path; make sure neither env nor settings can supply a key.
  delete process.env.OPENROUTER_API_KEY;
  saveSettings({});
});

after(() => {
  delete process.env.OPENROUTER_API_KEY;
  removeIsolatedDataDir();
});

test('OpenRouter descriptor is a thin static builtin provider', () => {
  const meta = getHarnessMeta('openrouter');
  assert.ok(meta, 'the harness registry must still know openrouter');

  assert.equal(OPENROUTER_HARNESS_PROVIDER.id, 'openrouter');
  assert.equal(OPENROUTER_HARNESS_PROVIDER.origin, 'builtin');
  assert.equal(OPENROUTER_HARNESS_PROVIDER.label, meta.label);
  assert.equal(OPENROUTER_HARNESS_PROVIDER.description, meta.description);
  assert.equal(Object.isFrozen(OPENROUTER_HARNESS_PROVIDER), true);

  // Declarative closed capability set: chat on, every other shared key false.
  assert.deepEqual(
    Object.keys(OPENROUTER_HARNESS_PROVIDER.capabilities).sort(),
    [...HARNESS_PLUGIN_CAPABILITY_KEYS].sort(),
  );
  assert.equal(OPENROUTER_HARNESS_PROVIDER.capabilities.chat, true);
  for (const key of HARNESS_PLUGIN_CAPABILITY_KEYS) {
    if (key === 'chat') continue;
    assert.equal(OPENROUTER_HARNESS_PROVIDER.capabilities[key], false, `${key} must be false`);
  }

  assert.equal(OPENROUTER_HARNESS_PROVIDER.handler, handleOpenRouterAgentWebSocket);
});

test('descriptor registry exposes the existing openrouter transport id', () => {
  assert.equal(AGENT_TRANSPORTS.includes('openrouter'), true);
  assert.equal(isOpenRouterChat({ agentTransport: 'openrouter' }), true);

  assert.equal(getBuiltinHarnessProvider('openrouter'), OPENROUTER_HARNESS_PROVIDER);
  assert.equal(getBuiltinHarnessProvider('  OPENROUTER '), OPENROUTER_HARNESS_PROVIDER);
  assert.equal(getBuiltinHarnessProvider('not-a-harness'), null);
  assert.equal(getBuiltinHarnessProvider(''), null);
  assert.equal(getBuiltinHarnessProvider(null), null);

  const list = listBuiltinHarnessProviders();
  assert.equal(list.length, 2);
  assert.equal(list[0], OPENROUTER_HARNESS_PROVIDER);
  assert.equal(list[1], CLAUDE_HARNESS_PROVIDER);

  // The static import of the handler must keep registering the chat-run
  // adapter exactly as before (no dynamic import).
  assert.equal(hasChatRunAdapter('openrouter'), true);
});

test('Claude provider descriptor preserves the built-in SDK handler and id', () => {
  const meta = getHarnessMeta('claude');
  assert.ok(meta);
  assert.equal(AGENT_TRANSPORTS.includes('claude'), true);
  assert.equal(isClaudeChat({ agentTransport: 'claude' }), true);
  assert.equal(CLAUDE_HARNESS_PROVIDER.id, 'claude');
  assert.equal(CLAUDE_HARNESS_PROVIDER.origin, 'builtin');
  assert.equal(CLAUDE_HARNESS_PROVIDER.label, meta.label);
  assert.equal(CLAUDE_HARNESS_PROVIDER.description, meta.description);
  assert.equal(CLAUDE_HARNESS_PROVIDER.handler, handleClaudeAgentWebSocket);
  assert.equal(CLAUDE_HARNESS_PROVIDER.capabilities.chat, true);
  assert.equal(CLAUDE_HARNESS_PROVIDER.capabilities.models, true);
  assert.equal(getBuiltinHarnessProvider('claude'), CLAUDE_HARNESS_PROVIDER);
});

test('resolving the descriptor forwards to the existing OpenRouter handler', async () => {
  const fallback = () => 'fallback';
  const resolved = resolveBuiltinHarnessChatHandler('openrouter', fallback);
  assert.equal(resolved, handleOpenRouterAgentWebSocket);

  // Executable forwarding: the resolved handler runs the real code and reports
  // the missing-api-key path, which is emitted by the existing handler.
  const ws = {
    readyState: 1,
    sent: [],
    closed: false,
    send(data) {
      this.sent.push(data);
    },
    close() {
      this.closed = true;
    },
  };
  await resolved(ws, 'session-key', { workspaceDirForAgent: () => '/tmp' });

  assert.equal(ws.closed, true);
  const payloads = ws.sent.map((row) => JSON.parse(row));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].type, 'sdkError');
  assert.equal(payloads[0].code, 'missing_api_key');
});

test('missing descriptor falls back to the exact previous handler', () => {
  const fallback = () => 'previous-handler';

  assert.equal(getBuiltinHarnessChatHandler('openrouter'), handleOpenRouterAgentWebSocket);
  assert.equal(getBuiltinHarnessChatHandler('not-a-harness'), null);
  assert.equal(resolveBuiltinHarnessChatHandler('not-a-harness', fallback), fallback);
  assert.equal(resolveBuiltinHarnessChatHandler('not-a-harness', null), null);
  assert.equal(resolveBuiltinHarnessChatHandler('', fallback), fallback);
});

test('ws-router OpenRouter branch resolves from the registry and always returns', () => {
  const branchStart = WS_ROUTER_SOURCE.indexOf('isOpenRouterChat(routedChat)');
  assert.ok(branchStart > 0, 'the OpenRouter branch must exist');
  const sdkIndex = WS_ROUTER_SOURCE.indexOf('handleAgentSdkWebSocket(ws, sessionKey', branchStart);
  assert.ok(sdkIndex > branchStart, 'the SDK catch-all must stay after the OpenRouter branch');
  const branch = WS_ROUTER_SOURCE.slice(branchStart, sdkIndex);

  // It must resolve the handler through the new descriptor registry, keep the
  // exact previous handler as fallback, forward the exact call, and always
  // return before the SDK catch-all.
  assert.match(branch, /resolveBuiltinHarnessChatHandler\(/);
  assert.match(branch, /'openrouter'/);
  assert.match(branch, /handleOpenRouterAgentWebSocket/);
  assert.match(branch, /openRouterHandler\(ws, sessionKey, harnessWsDeps\)/);
  assert.ok(branch.indexOf('return;') > 0, 'the OpenRouter branch must return');

  // Ordering invariant: the local harness branch stays after OpenRouter and
  // before the SDK fallback.
  const localIndex = WS_ROUTER_SOURCE.indexOf(
    "rawHarnessTransportKind(routedChat.agentTransport) === 'local'",
    branchStart,
  );
  assert.ok(localIndex > branchStart && localIndex < sdkIndex);
});

test('ws-router Claude branch uses the descriptor with the old handler as fallback', () => {
  const branchStart = WS_ROUTER_SOURCE.indexOf('isClaudeChat(routedChat)');
  const nextBranch = WS_ROUTER_SOURCE.indexOf('isOpenRouterChat(routedChat)', branchStart);
  assert.ok(branchStart > 0 && nextBranch > branchStart);
  const branch = WS_ROUTER_SOURCE.slice(branchStart, nextBranch);
  assert.match(branch, /resolveBuiltinHarnessChatHandler\(/);
  assert.match(branch, /'claude'/);
  assert.match(branch, /handleClaudeAgentWebSocket/);
  assert.match(branch, /claudeHandler\(ws, sessionKey, harnessWsDeps\)/);
  assert.match(branch, /return;/);
});

console.log('builtin-harness-providers.test.js OK');
