import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { installWidgetApiGate } from '../lib/widget/widget-http.js';
import { saveChats } from '../lib/persist/chats-persist.js';
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

removeIsolatedDataDir();
console.log('All widget-api-gate tests passed.');
