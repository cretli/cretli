import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { createMcpServer } from '../lib/mcp/mcp-service.js';
import { BUILTIN_CRETILI_SERVER_ID } from '../lib/mcp/mcp-config.js';
import {
  encodeMcpToolName,
  hasMcpServerIdentity,
  isCretliBuiltinServerIdentity,
  isCretliBuiltinToolName,
  mcpBuiltinToolBridgeEncodedName,
  resolveCretliBuiltinToolName,
} from '../lib/mcp/mcp-tool-names.js';
import {
  isMcpToolAllowedInPlan,
  isReadOnlyBuiltinMcpToolName,
} from '../lib/mcp/mcp-policy.js';
import { resolvePlanGuardMcpServerIdentity } from '../lib/mcp/mcp-session.js';
import { isScoutProtocolToolCall } from '../lib/workspace-scout-chat.js';
import {
  resolveScoutNativeToolDecision,
  resolveScoutReadOnlySdkEventDecision,
} from '../lib/workspace-scout-read-only.js';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

/**
 * GAP 1 + GAP 2 regression: ownership must be decided from the real server
 * identity carried by the call context, not from name text. The name text stays
 * as a legacy fallback but it can never widen a foreign server into the builtin
 * catalog when the caller knows the server kind.
 *
 * The external id below is the exact GAP 1 shape: `toMcpRuntimeName('mynotionserv')`
 * is `cretli_mynotionserv`, so the encoded name still carries the `cretli`
 * token that the old heuristic keyed on.
 */
const BUILTIN_IDENTITY = { id: 'builtin-cretli', kind: 'builtin-cretli' };
const FOREIGN_IDENTITY = { id: 'mynotionserv', kind: 'external' };

assert.equal(hasMcpServerIdentity(BUILTIN_IDENTITY), true);
assert.equal(hasMcpServerIdentity(FOREIGN_IDENTITY), true);
assert.equal(hasMcpServerIdentity(null), false);
assert.equal(hasMcpServerIdentity(''), false);
assert.equal(hasMcpServerIdentity('builtin-cretli'), true);
assert.equal(isCretliBuiltinServerIdentity(BUILTIN_IDENTITY), true);
assert.equal(isCretliBuiltinServerIdentity('builtin-cretli'), true);
assert.equal(isCretliBuiltinServerIdentity(FOREIGN_IDENTITY), false);
assert.equal(isCretliBuiltinServerIdentity({ id: 'mynotionserv' }), false);
assert.equal(
  isCretliBuiltinServerIdentity({ id: 'mynotionserv', kind: 'builtin-cretli' }),
  false,
  'config spoof kind must not count as builtin without the real server id',
);
assert.equal(isCretliBuiltinServerIdentity(null), false);

/** Own shapes: a bare name, a single runtime prefix, the bridge and a mangled middle. */
const OWNED_READ_NAMES = [
  'wmem_list',
  'workspace_memory_list',
  'mcp__cretli_builtincretl__todo_list',
  'mcp__cretli_bridge__mcp__cretli_builtincretl__workspace_memory_list',
  'mcp__cretli_bridge__mcp__cre___tincretl__workspace_watcher_show',
];
for (const name of OWNED_READ_NAMES) {
  assert.equal(isCretliBuiltinToolName(name), true, `${name} must stay catalog-owned by name`);
  assert.equal(
    isCretliBuiltinToolName(name, BUILTIN_IDENTITY),
    true,
    `${name} must stay owned for the builtin identity even when mangled`,
  );
  assert.equal(isReadOnlyBuiltinMcpToolName(name), true, `${name} must read as a builtin read`);
  assert.equal(
    isReadOnlyBuiltinMcpToolName(name, BUILTIN_IDENTITY),
    true,
    `${name} must read as a builtin read for the builtin identity`,
  );
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: name, args: {}, server: BUILTIN_IDENTITY }).deny,
    false,
    `Scout must allow the owned read ${name}`,
  );
}

/**
 * GAP 1: a foreign runtime slug that carries a `cretli` token. The GAP 1 example
 * `mcp__cretli_mynotionserv__todo_list` collides with the builtin `todo_list`
 * basename; the external identity must reject it even though the text does not.
 */
const FOREIGN_COLLIDING_NAMES = [
  'mcp__cretli_mynotionserv__todo_list',
  'mcp__cretli_mynotionserv__chat_list',
  'mcp__cretli_mynotionserv__wmem_list',
  'mcp__cretli_mynotionserv__watcher_scout_findings',
  'mcp__github__todo_list',
  'mcp__other__todo_list',
];
for (const name of FOREIGN_COLLIDING_NAMES) {
  assert.equal(
    isCretliBuiltinToolName(name, FOREIGN_IDENTITY),
    false,
    `${name} must belong to the foreign identity`,
  );
  assert.equal(
    resolveCretliBuiltinToolName(name, FOREIGN_IDENTITY),
    null,
    `${name} must not resolve to a builtin tool for the foreign identity`,
  );
  assert.equal(
    isReadOnlyBuiltinMcpToolName(name, FOREIGN_IDENTITY),
    false,
    `${name} must not read as a builtin read for the foreign identity`,
  );
  assert.equal(
    resolveScoutNativeToolDecision({ toolName: name, args: {}, server: FOREIGN_IDENTITY }).deny,
    true,
    `Scout must deny the foreign server tool ${name}`,
  );
}

// A bare basename carries no ownership text, so only the identity can decide.
assert.equal(
  resolveScoutNativeToolDecision({ toolName: 'todo_list', args: {}, server: FOREIGN_IDENTITY }).deny,
  true,
  'a foreign server must not inherit the bare builtin read',
);
assert.equal(
  resolveScoutNativeToolDecision({ toolName: 'todo_list', args: {}, server: BUILTIN_IDENTITY }).deny,
  false,
  'the builtin server keeps its bare read',
);

// The builtin identity owns its (possibly mangled) names and only its own.
assert.equal(
  isReadOnlyBuiltinMcpToolName('mcp__cretli_bridge__mcp__cre___tincretl__todo_list', BUILTIN_IDENTITY),
  true,
);
// Identity is authoritative, so once the context says builtin the basename is
// only a catalog lookup (this is what keeps mangled harness names working).
assert.equal(
  isReadOnlyBuiltinMcpToolName('mcp__cretli_mynotionserv__todo_list', BUILTIN_IDENTITY),
  true,
);

/**
 * GAP 2: the Scout protocol name must be ownership-checked. A foreign server
 * exposing `watcher_scout_findings` is never the scan protocol, while every own
 * shape (bare, single prefix, bridge, mangled middle) still is.
 */
for (const action of ['list', 'submit']) {
  assert.equal(
    isScoutProtocolToolCall('mcp__github__watcher_scout_findings', { action }),
    false,
    `foreign watcher_scout_findings ${action} must not be the scout protocol`,
  );
  assert.equal(
    isScoutProtocolToolCall('mcp__other__watcher_scout_findings', { action }),
    false,
  );
  assert.equal(
    isScoutProtocolToolCall('mcp.acme.watcher_scout_findings', { action }),
    false,
  );
  assert.equal(
    resolveScoutNativeToolDecision({
      toolName: 'mcp__github__watcher_scout_findings',
      args: { action },
    }).deny,
    true,
    `Scout must deny foreign watcher_scout_findings ${action}`,
  );
  assert.equal(
    resolveScoutNativeToolDecision({
      toolName: 'mcp__cretli_mynotionserv__watcher_scout_findings',
      args: { action },
      server: FOREIGN_IDENTITY,
    }).deny,
    true,
    `Scout must deny the foreign slug watcher_scout_findings ${action}`,
  );
}

const OWNED_PROTOCOL_NAMES = [
  'scout_findings',
  'watcher_scout_findings',
  'mcp__cretli__watcher_scout_findings',
  'mcp__cretli_builtincretl__watcher_scout_findings',
  'mcp__cretli_bridge__mcp__cretli_builtincretl__watcher_scout_findings',
  'mcp__cretli_bridge__mcp__cre___tincretl__watcher_scout_findings',
];
for (const name of OWNED_PROTOCOL_NAMES) {
  for (const action of ['list', 'submit']) {
    assert.equal(
      isScoutProtocolToolCall(name, { action }),
      true,
      `${name} ${action} must stay the scout protocol`,
    );
    assert.equal(
      resolveScoutNativeToolDecision({ toolName: name, args: { action } }).deny,
      false,
      `Scout must allow the owned protocol ${name} ${action}`,
    );
    assert.equal(
      isScoutProtocolToolCall(name, { action }, BUILTIN_IDENTITY),
      true,
      `${name} ${action} must stay the scout protocol for the builtin identity`,
    );
  }
}
// `accept` is not a protocol action and stays denied for an owned name.
assert.equal(isScoutProtocolToolCall('watcher_scout_findings', { action: 'accept' }), false);
assert.equal(
  resolveScoutNativeToolDecision({ toolName: 'watcher_scout_findings', args: { action: 'accept' } }).deny,
  true,
);

assert.equal(
  isMcpToolAllowedInPlan(BUILTIN_IDENTITY, 'mcp__cretli_bridge__mcp__cre___tincretl__todo_list'),
  true,
  'the builtin server owns a mangled todo_list',
);
assert.equal(
  isMcpToolAllowedInPlan(
    { id: 'mynotionserv', kind: 'external', toolPolicy: { allowInPlan: ['todo_list'] } },
    'todo_list',
  ),
  true,
  'an explicit allowInPlan still opts an external tool in',
);

const fixtureRoom = {
  sessionKey: 'sess-ownership-gate',
  cwd: '/tmp/project',
  sdkMode: 'agent',
  chatId: 'chat-ownership-gate',
};
const fixtureChat = {
  id: 'chat-ownership-gate',
  cursorSessionId: 'sess-ownership-gate',
  workspaceFolder: '/tmp/project',
  agentTransport: 'sdk',
};
await createMcpServer({
  id: 'mynotionserv',
  name: 'Notion fixture',
  enabled: true,
  harnesses: ['sdk'],
  scope: 'all',
  transport: 'stdio',
  connection: { command: 'node', args: ['tests/helpers/mcp-fixture-server.js'] },
}, 0);
const foreignEncodedTodo = encodeMcpToolName('mynotionserv', 'todo_list');
const foreignServerFromConfig = resolvePlanGuardMcpServerIdentity({
  room: fixtureRoom,
  chat: fixtureChat,
  harness: 'sdk',
  event: { type: 'tool_call', name: foreignEncodedTodo, args: {} },
});
assert.ok(foreignServerFromConfig, 'foreign runtime must resolve from MCP config');
assert.equal(foreignServerFromConfig.kind, 'external');
assert.equal(foreignServerFromConfig.id, 'mynotionserv');
assert.equal(
  isReadOnlyBuiltinMcpToolName(foreignEncodedTodo, foreignServerFromConfig),
  false,
  'resolved external identity must not classify as a builtin read',
);
const foreignReviewRead = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'mcp',
  input: { toolName: foreignEncodedTodo },
  mcpServer: foreignServerFromConfig,
});
assert.equal(foreignReviewRead.deny, true, 'review must deny a config-resolved foreign colliding read');

const builtinEncodedWait = mcpBuiltinToolBridgeEncodedName('delegation_wait');
const builtinServerFromConfig = resolvePlanGuardMcpServerIdentity({
  room: fixtureRoom,
  chat: fixtureChat,
  harness: 'sdk',
  event: { type: 'tool_call', name: builtinEncodedWait, args: {} },
});
assert.ok(builtinServerFromConfig);
assert.equal(builtinServerFromConfig.id, BUILTIN_CRETILI_SERVER_ID);
assert.equal(builtinServerFromConfig.kind, 'builtin-cretli');
const builtinReviewRead = resolvePlanModeToolDecision({
  transport: 'sdk',
  mode: 'agent',
  assignment: 'review',
  toolName: 'mcp',
  input: { toolName: builtinEncodedWait },
  mcpServer: builtinServerFromConfig,
});
assert.equal(builtinReviewRead.deny, false, 'review must keep a bridge builtin read for the resolved builtin row');

const scoutEvent = {
  type: 'tool_call',
  status: 'running',
  name: 'mcp__cretli_bridge__mcp__cre___tincretl__workspace_watcher_show',
  args: {},
};
assert.equal(
  resolveScoutReadOnlySdkEventDecision(scoutEvent, builtinServerFromConfig).deny,
  false,
  'the SDK event path must allow a mangled read for the resolved builtin server object',
);
assert.equal(
  resolveScoutReadOnlySdkEventDecision(
    { ...scoutEvent, name: encodeMcpToolName('mynotionserv', 'workspace_watcher_show') },
    foreignServerFromConfig,
  ).deny,
  true,
  'the SDK event path must deny a config-resolved foreign colliding read',
);

/**
 * Backward compatibility: without an identity the legacy name text decides, so
 * the bridge-encoded ownership guard keeps working. `mcp__github__*` was and
 * stays foreign; only the context can disambiguate a `cretli_<slug>` runtime.
 */
assert.equal(isCretliBuiltinToolName('mcp__github__todo_list'), false);
assert.equal(isReadOnlyBuiltinMcpToolName('mcp__github__todo_list'), false);
assert.equal(
  isReadOnlyBuiltinMcpToolName('mcp__cretli_bridge__mcp__cretli_builtincretl__delegation_wait'),
  true,
);

removeIsolatedDataDir();
console.log('mcp-tool-ownership-identity.test.js: ok');
