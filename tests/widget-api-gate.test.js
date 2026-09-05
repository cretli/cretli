import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { installWidgetApiGate } from '../lib/widget/widget-http.js';
import { saveChats } from '../lib/persist/chats-persist.js';

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

removeIsolatedDataDir();
console.log('All widget-api-gate tests passed.');
