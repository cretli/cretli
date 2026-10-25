import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createMailboxMessage } from '../lib/persist/delegation-mailbox-persist.js';
import { closeDelegationSqlite } from '../lib/persist/delegation-sqlite.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';

process.env.CRETLI_DELEGATION_STATS_TTL_MS = '0';
const workspace = ISOLATED_DATA_DIR;
const foreignWorkspace = `${workspace}-foreign`;
const chatsPath = path.join(workspace, 'chats.json');
const chats = [
  { id: 'local', workspaceFolder: workspace, widgetInstallationId: 'widget-a' },
  { id: 'foreign', workspaceFolder: foreignWorkspace, widgetInstallationId: 'widget-b' },
  { id: 'other-widget', workspaceFolder: workspace, widgetInstallationId: 'widget-b' },
];
fs.writeFileSync(chatsPath, JSON.stringify({ chats }));
const jobs = [
  { parentChatId: 'local' },
  { parentChatId: 'foreign' },
  { parentChatId: 'foreign', controllerChatId: 'local' },
  { parentChatId: 'local', controllerChatId: 'deleted' },
  { parentChatId: 'other-widget' },
  { parentChatId: 'missing' },
].map((fields) => createDelegationRecord({
  ...fields,
  workspaceFolder: workspace,
  assignment: 'implement',
  status: 'completed',
  executor: { transport: 'testfake', model: 'testfake/test' },
}));
for (const [fromChatId, toChatId] of [
  ['local', 'foreign'], ['foreign', 'foreign'], ['other-widget', 'other-widget'],
]) createMailboxMessage({ fromChatId, toChatId, body: 'Scope fixture' });

const routes = new Map();
registerDelegationsRoutes({
  get: (route, handler) => routes.set(route, handler),
  post: () => {},
}, { workspaceDirForAgent: () => workspace, listHarnessCatalog: async () => [] });

/** Count chat snapshots rather than timing the test, which varies by machine. */
async function invokeRoute(route, options = {}) {
  const originalRead = fs.readFileSync;
  let chatLoads = 0;
  let status = 200;
  let body;
  fs.readFileSync = function (file, ...args) {
    if (String(file) === chatsPath) chatLoads += 1;
    return originalRead.call(this, file, ...args);
  };
  try {
    await routes.get(route)({ params: {}, query: {}, body: {}, ...options }, {
      status(code) { status = code; return this; },
      json(value) { body = value; return this; },
    });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(chatLoads, 1, `${route} must load chats once for all scope checks`);
  return body;
}

test.after(() => {
  closeDelegationSqlite();
  removeIsolatedDataDir();
});

test('bulk delegation reads share a chat snapshot and preserve scope boundaries', async () => {
  const all = await invokeRoute('/api/delegations');
  assert.deepEqual(all.delegations.map((row) => row.id).sort(), jobs.slice(0, 5).map((row) => row.id).sort());
  const options = { query: { workspaceFolder: workspace } };
  const scoped = await invokeRoute('/api/delegations', options);
  assert.deepEqual(scoped.delegations.map((row) => row.id).sort(), [0, 2, 3, 4].map((i) => jobs[i].id).sort());
  const widget = await invokeRoute('/api/delegations', {
    ...options, widgetAccess: { installationId: 'widget-a' },
  });
  assert.deepEqual(widget.delegations.map((row) => row.id).sort(), [0, 2, 3].map((i) => jobs[i].id).sort());
  const runtime = await invokeRoute('/api/delegations/runtime', options);
  assert.equal(runtime.runtime.counts.terminal, 4);
  assert.equal(runtime.runtime.counts.pendingMailbox, 2);
  const widgetRuntime = await invokeRoute('/api/delegations/runtime', {
    ...options, widgetAccess: { installationId: 'widget-a' },
  });
  assert.equal(widgetRuntime.runtime.counts.terminal, 3);
  assert.equal(widgetRuntime.runtime.counts.pendingMailbox, 1);
  await invokeRoute('/api/delegations/stats', options);
  await invokeRoute('/api/review-loop-stats', options);
});

test('a new request observes changed chat ownership', async () => {
  const options = { widgetAccess: { installationId: 'widget-a' } };
  const before = await invokeRoute('/api/delegations', options);
  assert.equal(before.delegations.length, 3);
  chats[0].widgetInstallationId = 'widget-reassigned';
  fs.writeFileSync(chatsPath, JSON.stringify({ chats }));
  const after = await invokeRoute('/api/delegations', options);
  assert.deepEqual(after.delegations, []);
  const runtime = await invokeRoute('/api/delegations/runtime', options);
  assert.equal(runtime.runtime.counts.terminal, 0);
  assert.equal(runtime.runtime.counts.pendingMailbox, 0);
});
