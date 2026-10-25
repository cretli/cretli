/**
 * Built-in provider descriptors (WR1 pilot, extended in B2) and the
 * registry-backed dispatch used by ws-router, register-app-routes and the MCP
 * adapter registry.
 *
 * No vendor SDK, no network, no API key. Every assertion runs against the
 * isolated test data dir so an operator's real settings can never leak in.
 */
import './helpers/default-optional-harnesses.js';

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import { AGENT_TRANSPORTS, isClaudeChat, isOpenRouterChat } from '../lib/agent-transport.js';
import { getHarnessMcpAdapter } from '../lib/mcp/adapters/index.js';
import { sdkMcpAdapter } from '../lib/mcp/adapters/sdk-adapter.js';
import { HARNESS_PLUGIN_CAPABILITY_KEYS } from '../lib/agent-harness/harness-plugin-contract.ts';
import {
  CLAUDE_HARNESS_PROVIDER,
  getBuiltinHarnessChatHandler,
  getBuiltinHarnessProvider,
  listBuiltinHarnessProviders,
  resolveBuiltinHarnessChatHandler,
} from '../lib/agent-harness/builtin-harness-providers.ts';
import { getHarnessMeta } from '../lib/agent-harness/registry.ts';
import { handleOpenRouterAgentWebSocket } from '../harnesses/openrouter/openrouter-agent-ws.js';
import { handleClaudeAgentWebSocket } from '../lib/claude/claude-agent-ws.ts';
import { hasChatRunAdapter } from '../lib/chat-run-service.js';
import { saveSettings } from '../lib/persist/settings.js';

// OpenRouter chat is a repo plugin (harnesses/openrouter), loaded by the helper above.
const OPENROUTER_HARNESS_PROVIDER = /** @type {any} */ (getBuiltinHarnessProvider('openrouter'));
assert.ok(OPENROUTER_HARNESS_PROVIDER, 'the openrouter plugin must be loaded');

const WS_ROUTER_SOURCE = readFileSync(new URL('../lib/ws/ws-router.ts', import.meta.url), 'utf8');
const APP_ROUTES_SOURCE = readFileSync(new URL('../lib/register-app-routes.js', import.meta.url), 'utf8');
const NON_SDK_TRANSPORTS = AGENT_TRANSPORTS.filter((id) => id !== 'sdk');

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

test('OpenRouter descriptor is a plugin-built provider with the stock handler', () => {
  const meta = getHarnessMeta('openrouter');
  assert.ok(meta, 'the harness registry must still know openrouter');

  assert.equal(OPENROUTER_HARNESS_PROVIDER.id, 'openrouter');
  assert.equal(OPENROUTER_HARNESS_PROVIDER.origin, 'builtin-optional');
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

  // Core built-ins first, then the repo plugins in boot-load (alphabetical) order.
  const list = listBuiltinHarnessProviders();
  assert.deepEqual(
    list.map((provider) => provider.id),
    ['codex', 'claude', 'codebuddy', 'deepseek', 'opencode', 'mimo', 'mistral', 'openrouter', 'qwen', 'zai'],
  );
  assert.equal(list[7], OPENROUTER_HARNESS_PROVIDER);
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

test('every built-in transport except sdk has a complete descriptor', () => {
  for (const id of NON_SDK_TRANSPORTS) {
    const provider = getBuiltinHarnessProvider(id);
    assert.ok(provider, `${id} must have a descriptor`);
    // Repo plugins keep a complete descriptor but carry their own origin; only codex and claude stay core.
    assert.equal(provider.origin, ['codex', 'claude'].includes(id) ? 'builtin' : 'builtin-optional');
    assert.equal(provider.label, getHarnessMeta(id).label, id);
    assert.equal(typeof provider.handler, 'function', id);
    assert.match(provider.handlerLabel, / agent handler$/, id);
    assert.equal(typeof provider.registerRoutes, 'function', id);
    assert.equal(Object.isFrozen(provider), true, id);
  }
  // sdk (Cursor) stays the router's catch-all, without a descriptor.
  assert.equal(getBuiltinHarnessProvider('sdk'), null);
  assert.equal(listBuiltinHarnessProviders().length, NON_SDK_TRANSPORTS.length);
});

test('chats-routes fields keep the pre-registry per-harness behavior', async () => {
  const providers = listBuiltinHarnessProviders();
  for (const provider of providers) {
    assert.equal(typeof provider.room.getDiag, 'function', provider.id);
    assert.equal(typeof provider.room.dispose, 'function', provider.id);
    assert.equal(typeof provider.checkCreateReady, 'function', provider.id);
    assert.ok(provider.chatTitlePrefix, provider.id);
  }
  // OpenRouter rooms never had a model to sync; opencode/openrouter keep their
  // own status tail instead of reading chat history.
  assert.deepEqual(providers.filter((p) => !p.room.syncModel).map((p) => p.id), ['openrouter']);
  assert.deepEqual(
    providers.filter((p) => !p.historyStatusTail).map((p) => p.id).sort(),
    ['opencode', 'openrouter'],
  );
  assert.equal(getBuiltinHarnessProvider('zai').chatTitlePrefix, 'Z.AI SDK');
  // No key in env or settings (beforeEach): the gate returns the old 503 text.
  assert.equal(
    await OPENROUTER_HARNESS_PROVIDER.checkCreateReady({ resolveWorkspaceFolder: () => '/tmp' }),
    'OpenRouter chat requires an API key: set OPENROUTER_API_KEY or save it in Settings.',
  );
});

test('MCP adapter registry covers every transport and stays a leaf-only module', () => {
  assert.equal(getHarnessMcpAdapter('sdk'), sdkMcpAdapter);
  for (const id of AGENT_TRANSPORTS) {
    assert.equal(getHarnessMcpAdapter(id)?.harness, id, id);
  }
  // Importing the provider module from the MCP graph creates an init cycle
  // through the harness WebSocket modules (room-kernel TDZ).
  const adaptersSource = readFileSync(new URL('../lib/mcp/adapters/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(adaptersSource, /from\s+['"][^'"]*builtin-harness-providers/);
  for (const value of ['', null, undefined, 'cursor', 'not-a-harness', 'toString', 'constructor']) {
    assert.equal(getHarnessMcpAdapter(value), null, String(value));
  }
});

test('registerBuiltinHarnessRoutes is the only per-harness route registration', () => {
  const appRoutes = APP_ROUTES_SOURCE.slice(
    APP_ROUTES_SOURCE.indexOf('export function registerAppRoutes'),
    APP_ROUTES_SOURCE.indexOf('export function registerDevAndUpdateRoutes'),
  );
  assert.ok(
    appRoutes.includes('registerBuiltinHarnessRoutes(app, { workspaceDirForAgent: ctx.workspaceDirForAgent });'),
    'register-app-routes must register built-in harness routes through the registry',
  );
  for (const name of ['OpenRouter', 'OpenCode', 'CodeBuddy', 'DeepSeek', 'Mistral', 'Zai', 'Mimo', 'Codex', 'Qwen', 'Claude']) {
    assert.doesNotMatch(APP_ROUTES_SOURCE, new RegExp(`register${name}Routes\\b`), name);
  }
});

test('ws-router dispatches built-ins through one registry branch before local and SDK', () => {
  const branchStart = WS_ROUTER_SOURCE.indexOf('getBuiltinHarnessProvider(getChatAgentTransport(routedChat))');
  assert.ok(branchStart > 0, 'the registry dispatch must exist');
  const localIndex = WS_ROUTER_SOURCE.indexOf(
    "rawHarnessTransportKind(routedChat.agentTransport) === 'local'",
    branchStart,
  );
  const sdkIndex = WS_ROUTER_SOURCE.indexOf('handleAgentSdkWebSocket(ws, sessionKey', branchStart);
  assert.ok(localIndex > branchStart && sdkIndex > localIndex, 'registry, then local, then the SDK catch-all');

  const branch = WS_ROUTER_SOURCE.slice(branchStart, localIndex);
  assert.ok(branch.includes('builtinProvider.handler(ws, sessionKey, harnessWsDeps)'));
  assert.ok(branch.includes('builtinProvider.handlerLabel'));
  assert.ok(branch.indexOf('return;') > 0, 'the registry branch must return');

  // No per-harness handler is imported by the router any more.
  assert.doesNotMatch(WS_ROUTER_SOURCE, /handle(OpenRouter|Mistral|OpenCode|CodeBuddy|DeepSeek|Codex|Qwen|Claude|Zai|Mimo)AgentWebSocket/);
});

console.log('builtin-harness-providers.test.js OK');
