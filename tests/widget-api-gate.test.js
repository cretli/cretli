import { ISOLATED_DATA_DIR as dataDir, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import express from 'express';
import { registerDocsRoutes } from '../lib/routes/docs-routes.js';
import assert from 'node:assert/strict';
import { installWidgetApiGate } from '../lib/widget/widget-http.ts';
import { saveChats } from '../lib/persist/chats-legacy-store.js';
import { filterPresenceForScope } from '../lib/agent-presence-activity.js';

const ownChat = {
  id: 'chat-own',
  title: 'Own',
  widgetInstallationId: 'inst-1',
  widgetPageSessionId: 'page-1',
  workspaceFile: '/work/project.code-workspace',
  workspaceFolder: '/work/project',
  agentTransport: 'sdk',
};
const foreignChat = {
  id: 'chat-foreign',
  title: 'Foreign',
  widgetInstallationId: 'inst-2',
  widgetPageSessionId: 'page-2',
  workspaceFile: '/work/other.code-workspace',
  workspaceFolder: '/work/other',
  agentTransport: 'sdk',
};
saveChats([ownChat, foreignChat]);

const access = {
  installationId: 'inst-1',
  pageSessionId: 'page-1',
  workspaceFile: '/work/project.code-workspace',
  workspaceFolder: '/work/project',
};

function runGate(req) {
  const app = {
    handler: null,
    use(fn) {
      this.handler = fn;
    },
  };
  installWidgetApiGate(app);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ next: false, statusCode: this.statusCode, body });
        return this;
      },
    };
    app.handler(req, res, () => resolve({ next: true, statusCode: 200 }));
  });
}

const cookieOnly = await runGate({
  method: 'GET',
  path: '/api/chats/chat-foreign',
  widgetAccess: null,
});
assert.equal(cookieOnly.next, true);

const widgetOwn = await runGate({
  method: 'GET',
  path: '/api/chats/chat-own',
  widgetAccess: access,
});
assert.equal(widgetOwn.next, true);

const widgetForeign = await runGate({
  method: 'GET',
  path: '/api/chats/chat-foreign',
  widgetAccess: access,
});
assert.equal(widgetForeign.next, false);
assert.equal(widgetForeign.statusCode, 403);
assert.equal(widgetForeign.body?.ok, false);

const widgetRevisions = await runGate({
  method: 'GET',
  path: '/api/chats/history-revisions',
  widgetAccess: access,
});
assert.equal(widgetRevisions.next, true);

const widgetAgentStates = await runGate({
  method: 'GET',
  path: '/api/chats/agent-states',
  widgetAccess: access,
});
assert.equal(widgetAgentStates.next, true);

const widgetHistoryBatch = await runGate({
  method: 'POST',
  path: '/api/chats/history-batch',
  widgetAccess: access,
});
assert.equal(widgetHistoryBatch.next, true);

const widgetRevisionsBatch = await runGate({
  method: 'POST',
  path: '/api/chats/history-revisions-batch',
  widgetAccess: access,
});
assert.equal(widgetRevisionsBatch.next, true);

// Global delegation statistics are host-only; `/:id` stays available.
const widgetDelegationStats = await runGate({
  method: 'GET',
  path: '/api/delegations/stats',
  widgetAccess: access,
});
assert.equal(widgetDelegationStats.next, false);
assert.equal(widgetDelegationStats.statusCode, 403);

const widgetDelegationById = await runGate({
  method: 'GET',
  path: '/api/delegations/delegation-123',
  widgetAccess: access,
});
assert.equal(widgetDelegationById.next, true);

const widgetDelegationExecutors = await runGate({
  method: 'GET',
  path: '/api/delegations/executors',
  widgetAccess: access,
});
assert.equal(widgetDelegationExecutors.next, true);

// The card rating is one of the per-delegation widget actions (with
// cancel/retry/ack): a widget session may rate the job it can already see.
const widgetDelegationRate = await runGate({
  method: 'POST',
  path: '/api/delegations/delegation-123/rate',
  widgetAccess: access,
});
assert.equal(widgetDelegationRate.next, true, 'POST /api/delegations/:id/rate must pass the widget gate');

const widgetDelegationAck = await runGate({
  method: 'POST',
  path: '/api/delegations/delegation-123/ack',
  widgetAccess: access,
});
assert.equal(widgetDelegationAck.next, true);

const widgetPresence = filterPresenceForScope(
  { 'chat-own': { state: 'busy' }, 'chat-foreign': { state: 'waiting' } },
  ['chat-own', 'chat-foreign'],
  { kind: 'widget', chatIds: [ownChat.id] }
);
assert.equal(widgetPresence.states['chat-foreign'], undefined);
assert.deepEqual(widgetPresence.cleared, [ownChat.id]);

// MCP reaches only the bridge and Docs; Docs routes still own authorization.
for (const [method, path] of [
  ['GET', '/api/docs/tree'], ['GET', '/api/docs/note'], ['GET', '/api/docs/search'],
  ['GET', '/api/docs/backlinks'], ['POST', '/api/docs/proposals/write'],
  ['POST', '/api/docs/proposals/append'], ['POST', '/api/docs/proposals/link'],
]) {
  assert.equal((await runGate({ method, path, mcpIntegration: { workspaceId: 'ws', chatId: 'agent' } })).next, true, path);
  assert.equal((await runGate({ method, path, widgetAccess: access })).statusCode, 403, `Widget: ${path}`);
}
for (const path of ['/api/settings', '/api/todos', '/api/decisions/example', '/api/docs-other/tree', '/api/docs']) {
  const result = await runGate({ method: 'GET', path, mcpIntegration: { workspaceId: 'ws' } });
  assert.equal(result.next, false, path); assert.equal(result.statusCode, 403, path);
}
assert.equal((await runGate({ method: 'POST', path: '/api/mcp/bridge/call', mcpIntegration: {} })).next, true);
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.mcpIntegration = { workspaceId: 'ws', chatId: 'agent' }; next(); });
installWidgetApiGate(app);
registerDocsRoutes(app, { dataDir });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
try {
  for (const [method, endpoint] of [['PUT', 'config'], ['POST', 'note'], ['POST', 'links'], ['POST', 'consent']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/docs/${endpoint}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: 'docs', path: 'one.md', text: 'Denied' }),
    });
    assert.equal(response.status, 403, `${method} ${endpoint}`);
    assert.equal((await response.json()).code, 'docs-human-required', 'The route guard, not a blanket gate denial, enforces the human channel');
  }
} finally { await new Promise((resolve) => server.close(resolve)); }

removeIsolatedDataDir();
console.log('All widget-api-gate tests passed.');
