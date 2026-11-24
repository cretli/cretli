import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { createMcpServer, listMcpServers, updateMcpServer, resolveContextServers, callContextTool } from '../lib/mcp/mcp-service.js';
import { McpRevisionConflictError, loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { getMcpSecrets } from '../lib/mcp/mcp-secrets.js';
import { MCP_KINDS, normalizeMcpServer, resolveMcpServersForContext, resolveExternalMcpPolicy } from '../lib/mcp/mcp-config.js';
import { isMcpPlanCallDenied } from '../lib/mcp/mcp-policy.js';
import { callTool } from '../lib/mcp/mcp-runtime.js';
import { encodeMcpToolName, decodeMcpToolName, MCP_BUILTIN_SERVER_KIND } from '../lib/mcp/mcp-tool-names.js';
import { installWidgetApiGate } from '../lib/widget/widget-http.ts';
import { addChatAsync, getChatByIdAsync, updateChatAsync } from '../lib/persist/chats-persist.js';
import { buildMcpRuntimeContext } from '../lib/mcp/mcp-session.js';

const created = await createMcpServer({
  name: 'Docs',
  enabled: true,
  harnesses: ['codex', 'opencode'],
  scope: 'all',
  transport: 'stdio',
  connection: {
    command: 'node',
    args: ['tests/helpers/mcp-fixture-server.js'],
    env: { TOKEN: { secret: 'TOKEN', value: 'secret-value' } },
  },
  toolPolicy: { allowInPlan: ['ping_read'] },
}, 0);
assert.equal(created.revision, 1);
assert.ok(!JSON.stringify(created.server).includes('secret-value'));
assert.deepEqual(created.server.secretKeys, ['TOKEN']);
assert.equal(getMcpSecrets(created.server.id).TOKEN, 'secret-value');

const listed = listMcpServers();
assert.equal(listed.revision, 1);
assert.equal(listed.servers.length, 1);

let conflicted = false;
try {
  await createMcpServer({ name: 'Other', harnesses: ['sdk'], connection: { command: 'node' } }, 0);
} catch (err) {
  conflicted = err instanceof McpRevisionConflictError;
}
assert.equal(conflicted, true);

const updated = await updateMcpServer(created.server.id, {
  connection: { env: { TOKEN: { secret: 'TOKEN' } } },
}, listed.revision);
assert.equal(getMcpSecrets(created.server.id).TOKEN, 'secret-value');

const cleared = await updateMcpServer(created.server.id, {
  connection: { env: { TOKEN: { secret: 'TOKEN', clear: true } } },
}, updated.revision);
assert.equal(getMcpSecrets(created.server.id).TOKEN, undefined);
assert.equal(cleared.server.secretKeys.includes('TOKEN'), false);

const document = loadMcpDocument();
const forCodex = resolveMcpServersForContext({
  harness: 'codex',
  workspaceFolder: '/tmp/project',
}, document.servers);
assert.equal(forCodex.length, 2);
assert.equal(forCodex.filter((row) => row.kind === 'builtin-cretli').length, 1);
const forSdk = resolveMcpServersForContext({
  harness: 'sdk',
  workspaceFolder: '/tmp/project',
}, document.servers);
assert.equal(forSdk.length, 1);
assert.equal(forSdk[0].kind, 'builtin-cretli');

const external = document.servers.find((row) => row.kind === 'external');
assert.equal(external.availableToAutomaticAgents, false);
assert.equal(resolveExternalMcpPolicy({ id: 'ordinary-chat' }), 'all');
assert.equal(resolveExternalMcpPolicy({ id: 'delegation-chat', delegationId: 'delegation' }), 'allowlist');
assert.equal(resolveExternalMcpPolicy({ id: 'review-chat', delegationAssignment: 'review' }), 'allowlist');
assert.equal(resolveExternalMcpPolicy({ id: 'watcher-chat', pickPurpose: 'watcher-orchestrator' }), 'allowlist');
assert.equal(resolveExternalMcpPolicy({ id: 'scout-chat', pickPurpose: 'scout' }), 'allowlist');
assert.equal(resolveExternalMcpPolicy({ id: 'plan-chat', todoPlanCoordinator: true, title: 'Renamed plan chat' }), 'allowlist');
assert.equal(resolveExternalMcpPolicy({ id: 'plan-chat', title: '[Todo plan] Review' }), 'all', 'title alone is not a trusted role marker');
const scoutChat = await addChatAsync('mcp-scout-role-test', 'Scout', '', '/tmp/project', '', { agentTransport: 'codex', pickPurpose: 'scout', readOnlyScout: true });
const scoutContext = buildMcpRuntimeContext({ chat: scoutChat, room: { sessionKey: scoutChat.cursorSessionId, chatId: scoutChat.id }, harness: 'codex' });
assert.equal(scoutContext.automaticMcpPolicy, 'allowlist');
assert.equal(resolveContextServers(scoutContext).some((row) => row.kind === 'external'), false);
const scoutCall = await callContextTool(scoutContext, external.id, 'ping_read', {});
assert.equal(scoutCall.denied, true);
assert.match(scoutCall.error, /not available to automatic agents/i);
assert.equal(resolveContextServers({ ...scoutContext, automaticMcpPolicy: 'all' }).some((row) => row.kind === 'external'), false, 'trusted scout fields keep restriction if a stale/missing policy field is encountered');
const watcherChat = await addChatAsync('mcp-watcher-role-test', 'Watcher', '', '/tmp/project', '', { agentTransport: 'codex', pickPurpose: 'watcher-orchestrator' });
const watcherContext = buildMcpRuntimeContext({ chat: watcherChat, room: { sessionKey: watcherChat.cursorSessionId, chatId: watcherChat.id }, harness: 'codex' });
assert.equal(resolveContextServers(watcherContext).some((row) => row.kind === 'external'), false);
const durablePlanChat = await addChatAsync('mcp-plan-marker-test', '[Todo plan] Draft', '', '/tmp/project', '', { todoId: 'todo-marker-test', todoPlanCoordinator: true });
await updateChatAsync(durablePlanChat.id, { title: 'Renamed by user' });
assert.equal(resolveExternalMcpPolicy(await getChatByIdAsync(durablePlanChat.id)), 'allowlist');
assert.deepEqual(resolveMcpServersForContext({ harness: 'codex', chatId: 'delegation-chat', delegationId: 'd' }, document.servers).map((row) => row.kind), ['builtin-cretli']);
const allowedExternal = normalizeMcpServer({ ...external, availableToAutomaticAgents: true });
assert.equal(resolveMcpServersForContext({ harness: 'codex', chatId: 'delegation-chat', delegationId: 'd' }, [allowedExternal]).some((row) => row.id === external.id), true);
assert.deepEqual(resolveMcpServersForContext({ harness: 'codex', chatId: 'operator-unknown' }, [allowedExternal]).map((row) => row.kind), ['builtin-cretli']);

assert.equal(isMcpPlanCallDenied({
  mode: 'plan',
  toolName: 'write_note',
  server: { kind: 'external', toolPolicy: { allowInPlan: ['ping_read'] } },
}), true);
assert.equal(isMcpPlanCallDenied({
  mode: 'plan',
  toolName: 'ping_read',
  server: { kind: 'external', toolPolicy: { allowInPlan: ['ping_read'] } },
}), false);
assert.equal(isMcpPlanCallDenied({
  mode: 'plan',
  toolName: 'chat_list',
  server: { id: 'builtin-cretli', kind: 'builtin-cretli' },
}), false);
assert.equal(isMcpPlanCallDenied({
  mode: 'plan',
  toolName: 'chat_delete',
  server: { id: 'builtin-cretli', kind: 'builtin-cretli' },
}), true);
assert.equal(isMcpPlanCallDenied({
  mode: 'ask',
  toolName: 'chat_delete',
  server: { id: 'builtin-cretli', kind: 'builtin-cretli' },
}), true);
assert.equal(isMcpPlanCallDenied({
  mode: 'ask',
  toolName: 'chat_list',
  server: { id: 'builtin-cretli', kind: 'builtin-cretli' },
}), false);

let deleteCalled = false;
const denied = await callTool(
  {
    mode: 'plan',
    builtinClient: {
      async deleteChat() {
        deleteCalled = true;
      },
      async listChats() {
        return [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'X' }];
      },
    },
  },
  { id: 'builtin-cretli', kind: 'builtin-cretli', enabled: true, name: 'Cretli' },
  'chat_delete',
  { chat: 'aaaaaaaa', confirm: true },
);
assert.equal(denied.denied, true);
assert.equal(deleteCalled, false);

const encoded = encodeMcpToolName(created.server.id, 'ping_read');
assert.equal(decodeMcpToolName(encoded)?.toolName, 'ping_read');

function runGate(req) {
  const app = { handler: null, use(fn) { this.handler = fn; } };
  installWidgetApiGate(app);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ next: false, statusCode: this.statusCode, body }); return this; },
    };
    app.handler(req, res, () => resolve({ next: true, statusCode: 200 }));
  });
}

const widgetMcp = await runGate({
  method: 'GET',
  path: '/api/mcp/servers',
  widgetAccess: { installationId: 'inst-1' },
});
assert.equal(widgetMcp.next, false);
assert.equal(widgetMcp.statusCode, 403);

assert.equal(MCP_BUILTIN_SERVER_KIND, MCP_KINDS.find((kind) => kind === 'builtin-cretli'));
const spoofed = normalizeMcpServer({ id: 'mynotionserv', kind: 'builtin-cretli', transport: 'stdio', connection: { command: 'node' } });
assert.ok(spoofed);
assert.equal(spoofed.kind, 'external');
assert.equal(spoofed.id, 'mynotionserv');

removeIsolatedDataDir();
console.log('mcp-config.test.js OK');
