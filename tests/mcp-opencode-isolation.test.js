import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  opencodeInstanceKey,
  chooseOpenCodeListenPort,
  pickAndReserveOpenCodeListenPort,
} from '../lib/opencode/opencode-server-manager.js';
import { syncOpenCodeManagedMcp, isCretliManagedOpenCodeMcpName } from '../lib/mcp/mcp-opencode-sync.js';
import { rememberMcpExecutionContext, resetMcpExecutionRegistryForTests } from '../lib/mcp/mcp-execution-registry.js';
import { createMcpServer } from '../lib/mcp/mcp-service.js';

assert.notEqual(
  opencodeInstanceKey({ workspaceFolder: '/tmp/ws', sessionKey: 'chat-a' }),
  opencodeInstanceKey({ workspaceFolder: '/tmp/ws', sessionKey: 'chat-b' }),
);

const collisionA = await chooseOpenCodeListenPort({
  instanceKey: 'session-a',
  portBase: 4096,
  span: 2000,
  preferredOffset: 10,
  occupied: new Map(),
  ownerOf: () => null,
  isHealthy: () => false,
});
const collisionB = await chooseOpenCodeListenPort({
  instanceKey: 'session-b',
  portBase: 4096,
  span: 2000,
  preferredOffset: 10,
  occupied: new Map([[collisionA.port, 'session-a']]),
  ownerOf: (port) => (port === collisionA.port ? 'session-a' : null),
  isHealthy: (port) => port === collisionA.port,
});
assert.equal(collisionA.port, 4106);
assert.equal(collisionA.attach, false);
assert.equal(collisionB.port, 4107);
assert.equal(collisionB.attach, false);
const reattachA = await chooseOpenCodeListenPort({
  instanceKey: 'session-a',
  portBase: 4096,
  span: 2000,
  preferredOffset: 10,
  occupied: new Map([[collisionA.port, 'session-a']]),
  ownerOf: (port) => (port === collisionA.port ? 'session-a' : null),
  isHealthy: (port) => port === collisionA.port,
});
assert.equal(reattachA.port, collisionA.port);
assert.equal(reattachA.attach, true);

const raceOccupied = new Map();
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [raceA, raceB] = await Promise.all([
  pickAndReserveOpenCodeListenPort({
    instanceKey: 'race-a',
    portBase: 4096,
    span: 2000,
    preferredOffset: 10,
    occupied: raceOccupied,
    reserve: false,
    ownerOf: () => null,
    isHealthy: async () => {
      await waitMs(40);
      return false;
    },
  }),
  pickAndReserveOpenCodeListenPort({
    instanceKey: 'race-b',
    portBase: 4096,
    span: 2000,
    preferredOffset: 10,
    occupied: raceOccupied,
    reserve: false,
    ownerOf: () => null,
    isHealthy: async () => {
      await waitMs(40);
      return false;
    },
  }),
]);
assert.notEqual(raceA.port, raceB.port);
assert.equal(new Set([raceA.port, raceB.port]).size, 2);

assert.equal(isCretliManagedOpenCodeMcpName('cretli_bridge'), true);
assert.equal(isCretliManagedOpenCodeMcpName('cretli_filesystem'), false);

await createMcpServer({
  name: 'Ext',
  enabled: true,
  harnesses: ['opencode'],
  connection: { command: 'node' },
}, 0);

resetMcpExecutionRegistryForTests();

function mockClient(store) {
  return {
    mcp: {
      async status() {
        return { data: Object.fromEntries([...store.keys()].map((name) => [name, { status: 'connected' }])) };
      },
      async add({ body }) {
        store.set(body.name, body.config);
        return { data: { ok: true } };
      },
      async connect() {
        return { data: { ok: true } };
      },
      async disconnect({ path }) {
        store.delete(path.name);
        return { data: { ok: true } };
      },
    },
  };
}

const planStore = new Map();
const agentStore = new Map();
const planContext = {
  sessionId: 'opencode-plan',
  chatId: 'chat-plan',
  workspaceFolder: '/tmp/ws',
  harness: 'opencode',
  mode: 'plan',
};
const agentContext = {
  sessionId: 'opencode-agent',
  chatId: 'chat-agent',
  workspaceFolder: '/tmp/ws',
  harness: 'opencode',
  mode: 'agent',
};
rememberMcpExecutionContext(planContext, { getMode: () => planContext.mode });
rememberMcpExecutionContext(agentContext, { getMode: () => agentContext.mode });

const planSync = await syncOpenCodeManagedMcp({
  client: mockClient(planStore),
  workspaceFolder: '/tmp/ws',
  context: planContext,
});
const agentSync = await syncOpenCodeManagedMcp({
  client: mockClient(agentStore),
  workspaceFolder: '/tmp/ws',
  context: agentContext,
});
assert.equal(planSync.ok, true);
assert.equal(agentSync.ok, true);
assert.notEqual(
  planStore.get('cretli_bridge')?.environment?.CRETLI_MCP_TOKEN,
  agentStore.get('cretli_bridge')?.environment?.CRETLI_MCP_TOKEN,
);

const failing = await syncOpenCodeManagedMcp({
  client: {
    mcp: {
      async add() {
        return { error: 'connect failed' };
      },
    },
  },
  workspaceFolder: '/tmp/ws',
  context: agentContext,
});
assert.equal(failing.ok, false);

resetMcpExecutionRegistryForTests();
removeIsolatedDataDir();
console.log('mcp-opencode-isolation.test.js OK');
