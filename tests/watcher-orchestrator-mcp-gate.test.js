/**
 * Shared orchestrator MCP gate: live catalog, correct error codes and the
 * session/preflight strategies that match each harness transport lifecycle.
 */
import assert from 'node:assert/strict';
import { clearMcpBridgeToolsListed, markMcpBridgeToolsListed } from '../lib/mcp/mcp-bridge-ready.js';
import { ORCHESTRATOR_MCP_CONTRACT_TOOLS } from '../lib/mcp/mcp-orchestrator-contract.js';
import {
  MCP_BRIDGE_GATE_STRATEGY,
  enforceWatcherOrchestratorMcpGate,
  evaluateMcpBridgeReadySnapshot,
  evaluateOrchestratorMcpToolNames,
  normalizeMcpBridgeGateStrategy,
} from '../lib/mcp/watcher-orchestrator-mcp-gate.js';
import { probeMcpBridgeCatalog } from '../lib/mcp/mcp-bridge-preflight.js';
import { createCodeBuddyLiveSession } from '../lib/codebuddy/codebuddy-live-session.js';

const ORCHESTRATOR_CHAT = { pickPurpose: 'watcher-orchestrator' };
const ORCHESTRATOR_ROOM = (chatId) => ({ chatId, watcherOrchestrator: true });
const BRIDGE = Object.freeze({ command: 'node', args: ['x'], env: {} });

/** @param {object} input */
async function gate(input) {
  return enforceWatcherOrchestratorMcpGate(input);
}

// A catalog-less snapshot is a readiness failure, never a missing-tool failure.
assert.equal(evaluateOrchestratorMcpToolNames(['todo_show']).code, 'mcp_tools_missing');
assert.equal(evaluateMcpBridgeReadySnapshot(null, ORCHESTRATOR_MCP_CONTRACT_TOOLS)?.code, 'mcp_not_ready');
assert.equal(
  evaluateMcpBridgeReadySnapshot({ at: 1, toolNames: [] }, ORCHESTRATOR_MCP_CONTRACT_TOOLS)?.code,
  'mcp_tools_missing',
  'a listed but empty catalog is a catalog failure',
);
assert.equal(
  evaluateMcpBridgeReadySnapshot({ at: 1, toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS }, ORCHESTRATOR_MCP_CONTRACT_TOOLS),
  null,
);

assert.equal(normalizeMcpBridgeGateStrategy('preflight'), MCP_BRIDGE_GATE_STRATEGY.PREFLIGHT);
assert.equal(normalizeMcpBridgeGateStrategy('nonsense'), MCP_BRIDGE_GATE_STRATEGY.SESSION);
assert.equal(normalizeMcpBridgeGateStrategy(undefined), MCP_BRIDGE_GATE_STRATEGY.SESSION);

// A timeout (no mark, no catalog) is `mcp_not_ready`, not a missing catalog.
clearMcpBridgeToolsListed('gate-shared');
const blocked = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-shared'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: Date.now(),
  timeoutMs: 0,
});
assert.equal(blocked?.code, 'mcp_not_ready');

// A mark that arrives while the gate waits releases the prompt.
clearMcpBridgeToolsListed('gate-arrives');
const pendingMark = gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-arrives'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 0,
  timeoutMs: 500,
});
setTimeout(() => {
  markMcpBridgeToolsListed('gate-arrives', { now: Date.now(), toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS });
}, 10);
assert.equal(await pendingMark, null, 'a bridge that becomes ready during the wait is accepted');

// A stale mark (older than the run) does not release a fresh run, but a
// server-side preflight catalog does.
clearMcpBridgeToolsListed('gate-stale-preflight');
markMcpBridgeToolsListed('gate-stale-preflight', { now: 100, toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS });
const staleNoProbe = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-stale-preflight'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 101,
  timeoutMs: 0,
  bridgeCatalogProbe: async () => null,
});
assert.equal(staleNoProbe?.code, 'mcp_not_ready');
const staleWithProbe = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-stale-preflight'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 101,
  timeoutMs: 0,
  bridgeCatalogProbe: async () => ({ at: 102, toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS }),
});
assert.equal(staleWithProbe, null, 'a preflight catalog saves a transport whose own mark never arrives');

// Preflight strategy (harnesses that spawn with the first prompt) uses the
// injected catalog probe directly.
clearMcpBridgeToolsListed('gate-preflight');
const preflightOk = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-preflight'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 0,
  bridgeStrategy: 'preflight',
  bridgeCatalogProbe: async () => ({ at: Date.now(), toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS }),
});
assert.equal(preflightOk, null);
const preflightShort = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-preflight'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 0,
  bridgeStrategy: 'preflight',
  bridgeCatalogProbe: async () => ({ at: Date.now(), toolNames: ['todo_show'] }),
});
assert.equal(preflightShort?.code, 'mcp_tools_missing', 'a preflight catalog without the contract is a tools failure');
const preflightNone = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-preflight'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 0,
  bridgeStrategy: 'preflight',
  bridgeCatalogProbe: async () => null,
});
assert.equal(preflightNone?.code, 'mcp_not_ready', 'a preflight that never listed is not_ready');
const preflightThrows = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-preflight'),
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 0,
  bridgeStrategy: 'preflight',
  bridgeCatalogProbe: async () => { throw new Error('bridge down'); },
});
assert.equal(preflightThrows?.code, 'mcp_not_ready', 'a preflight that rejects is not_ready');

// Managed (non-bridge) harnesses still verify the in-process catalog.
const managedMissing = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-managed'),
  mcpPrep: { bridge: null },
  mcpContext: {},
  liveToolNames: ['todo_show'],
});
assert.equal(managedMissing?.code, 'mcp_tools_missing');
const managedOk = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-managed'),
  mcpPrep: { bridge: null },
  liveToolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS,
});
assert.equal(managedOk, null);

// No bridge and no managed context: still a readiness failure, never a pass.
const noBridge = await gate({
  chat: ORCHESTRATOR_CHAT,
  room: ORCHESTRATOR_ROOM('gate-nobridge'),
  mcpPrep: { bridge: null },
});
assert.equal(noBridge?.code, 'mcp_not_ready');

// An ordinary chat is never routed through the orchestrator gate.
const ordinary = await gate({
  chat: { pickPurpose: '' },
  room: { chatId: 'ordinary' },
  mcpPrep: { bridge: BRIDGE },
  sessionStartedAt: 0,
});
assert.equal(ordinary, null);

// The standalone probe reports no catalog when the bridge has no token/url.
assert.equal(await probeMcpBridgeCatalog(BRIDGE, { timeoutMs: 0 }), null);
assert.equal(await probeMcpBridgeCatalog(null), null);

// The probe maps the bridge endpoint payload to the snapshot the gate reads.
const probedCatalog = await probeMcpBridgeCatalog(
  { command: 'node', args: [], env: { CRETLI_URL: 'https://127.0.0.1:3011', CRETLI_MCP_TOKEN: 'tok' } },
  {
    timeoutMs: 100,
    createClient: () => ({
      getMcpBridgeTools: async () => ({
        ok: true,
        tools: [
          { name: 'mcp__cretli_builtincretl__todo_show' },
          { name: 'mcp__cretli_builtincretl__watcher_update' },
          { name: '' },
        ],
      }),
    }),
  },
);
assert.deepEqual(probedCatalog?.toolNames, [
  'mcp__cretli_builtincretl__todo_show',
  'mcp__cretli_builtincretl__watcher_update',
]);
const failedCatalog = await probeMcpBridgeCatalog(
  { command: 'node', args: [], env: { CRETLI_URL: 'https://127.0.0.1:3011', CRETLI_MCP_TOKEN: 'tok' } },
  {
    timeoutMs: 100,
    createClient: () => ({
      getMcpBridgeTools: async () => { throw new Error('bridge endpoint down'); },
    }),
  },
);
assert.equal(failedCatalog, null, 'a failed probe is a readiness gap, not a catalog');

const brokenSession = {
  transport: {
    options: {},
    sendControlRequest: async () => ({}),
  },
};
assert.throws(
  () => createCodeBuddyLiveSession({
    sdk: { unstable_v2_createSession: () => brokenSession },
    model: 'default-model',
    pathToCodebuddyCode: '/opt/codebuddy-launcher.sh',
    env: {},
    cwd: '/tmp/workspace',
    permissionMode: 'bypassPermissions',
    mcpServers: { cretli_bridge: { type: 'stdio', command: 'node', args: [] } },
    mcpContractTools: ORCHESTRATOR_MCP_CONTRACT_TOOLS,
    waitForMcpReady: async () => null,
  }),
  (err) => err?.code === 'mcp_not_ready',
  'orchestrator session without hook support is refused',
);

console.log('watcher-orchestrator-mcp-gate.test.js OK');
