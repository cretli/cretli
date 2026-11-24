import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { requireRequestScope } from '../lib/workspace-scope.js';

const workspaceId = 'cretli:ws:11111111-1111-4111-8111-111111111111';
const settings = (selected = workspaceId) => ({
  workspaceId: selected,
  workspaceFile: selected,
  workspaces: [
    { id: workspaceId, kind: 'folders' },
    { id: 'cretli:ws:22222222-2222-4222-8222-222222222222', kind: 'folders' },
  ],
  workspaceSidebarConfig: {
    [workspaceId]: { folders: { '/work/one': { enabled: true }, '/work/shared': { enabled: true } } },
    'cretli:ws:22222222-2222-4222-8222-222222222222': { folders: { '/work/two': { enabled: true }, '/work/shared': { enabled: true } } },
  },
});

const scopedRequest = (workspaceFolder) => ({ query: { workspaceFolder }, body: {} });

test('per-workspace route scope is required and explicit scope ignores global selection', async () => {
  const missing = await requireRequestScope({ query: {}, body: {} }, settings());
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 400);
  assert.equal(missing.code, 'workspace-scope-required');

  const first = await requireRequestScope(scopedRequest('/work/one'), settings(workspaceId));
  const second = await requireRequestScope(scopedRequest('/work/one'), settings('cretli:ws:22222222-2222-4222-8222-222222222222'));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.scope.folder, second.scope.folder);
  assert.equal(first.scope.workspaceId, second.scope.workspaceId);
});

test('a workspace file and a folder outside it conflict', async () => {
  const result = await requireRequestScope({ query: { workspaceFile: '/work/project.code-workspace', workspaceFolder: '/work/one' }, body: {} }, {
    workspaces: [{ id: '/work/project.code-workspace', kind: 'file', workspaceFile: '/work/project.code-workspace' }],
    workspaceSidebarConfig: { '/work/project.code-workspace': { folders: { '/work/project': { enabled: true } } } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'workspace-scope-conflict');
});

test('widget and chat scope work without a folder, while an unrelated chat is forbidden', async () => {
  const widget = await requireRequestScope({ query: {}, body: {}, widgetAccess: { workspaceId } }, settings());
  assert.equal(widget.ok, true);
  assert.equal(widget.scope.source, 'widget');

  const chat = { id: 'chat-one', workspaceId, workspaceFolder: '/work/one' };
  const chatResult = await requireRequestScope({ query: { chatId: chat.id }, body: {} }, settings(), { getChat: () => chat });
  assert.equal(chatResult.ok, true);
  assert.equal(chatResult.scope.chatId, chat.id);

  const outside = await requireRequestScope({ query: { chatId: chat.id, workspaceFolder: '/work/two' }, body: {} }, settings(), {
    getChat: () => chat,
    isChatInWorkspace: () => false,
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.status, 403);
  assert.equal(outside.code, 'OUT_OF_SCOPE');
});

test('registered per-workspace HTTP routes enforce scope without consulting global selection', async (t) => {
  const [{ default: express }, { mkdtempSync, rmSync }, os, path, http] = await Promise.all([
    import('express'),
    import('node:fs'),
    import('node:os'),
    import('node:path'),
    import('node:http'),
  ]);
  const [{ registerAppsRoutes }, { registerBrowserRoutes }, { registerGitRoutes }, { registerReviewLessonsRoutes },
    { registerTasksAgentsRoutes }, { registerWakeupsRoutes }, { registerWorkspaceWatcherRoutes }, authModule,
    _settingsModule, chatsBackend] = await Promise.all([
    import('../lib/routes/apps-routes.js'),
    import('../lib/browser/routes.js'),
    import('../lib/routes/git-routes.js'),
    import('../lib/routes/review-lessons-routes.js'),
    import('../lib/routes/tasks-agents-routes.js'),
    import('../lib/routes/wakeups-routes.js'),
    import('../lib/routes/workspace-watcher-routes.js'),
    import('../lib/auth.js'),
    import('../lib/persist/settings.js'),
    import('./helpers/chats-backends.js'),
  ]);

  await chatsBackend.useChatsBackendFromEnv();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-scope-http-'));
  const folderA = mkdtempSync(path.join(os.tmpdir(), 'cretli-scope-a-'));
  const folderB = mkdtempSync(path.join(os.tmpdir(), 'cretli-scope-b-'));
  const workspaceId = 'cretli:ws:11111111-1111-4111-8111-111111111111';
  const fileWorkspace = path.join(dataDir, 'file-workspace.code-workspace');
  const otherGlobal = path.join(dataDir, 'other-global.code-workspace');
  let globalSelection = fileWorkspace;
  const loadSettings = () => ({
    workspaceFile: globalSelection,
    workspaces: [
      { id: workspaceId, kind: 'folders' },
      { id: fileWorkspace, kind: 'file', workspaceFile: fileWorkspace },
    ],
    workspaceSidebarConfig: {
      [workspaceId]: { folders: { [folderA]: { enabled: true } } },
      [fileWorkspace]: { folders: { [folderB]: { enabled: true } } },
    },
  });
  await chatsBackend.seedChatRows([
    { id: 'scope-chat-a', workspaceId, workspaceFolder: folderA },
    { id: 'widget-chat-a', workspaceId, workspaceFolder: folderA, widgetInstallationId: 'widget-a' },
  ]);

  const browserScopes = [];
  const browserKeys = [];
  const browserManager = {
    listSessions(_owner, scope) { browserScopes.push(scope); return []; },
    describeExternalHolder() { return null; },
    getStorageStateStatus(key) { browserKeys.push(key); return { workspaceKey: key }; },
    async createSession(input) { browserScopes.push(input); return { browserSessionId: 'session-a', workspaceKey: input.workspaceFile || input.cwd }; },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers['x-test-widget'] === '1') req.widgetAccess = { installationId: 'widget-a', workspaceFolder: folderA };
    next();
  });

  assert.equal(authModule.setPassword('scope-matrix-password').ok, true);
  const authToken = authModule.createSession();
  const authCookie = `cr_session=${encodeURIComponent(authToken)}`;
  registerAppsRoutes(app, {
    taskRuns: new Map(),
    getCurrentCwd: () => folderB,
    service: { list: ({ dir }) => ({ ok: true, apps: [], dir }) },
    isKnownFolder: (folder) => folder === folderA,
    loadSettings,
  });
  registerBrowserRoutes(app, {
    browserManager,
    dataDir,
    loadSettings,
    getOwnerSessionId: () => 'owner-a',
  });
  registerGitRoutes(app, { dataDir, loadSettings });
  registerReviewLessonsRoutes(app, {
    dataDir,
    loadSettings,
    isKnownFolder: (folder) => folder === folderA,
  });
  registerTasksAgentsRoutes(app, {
    loadCurrentTasks: () => ({ tasks: [] }),
    loadTasksForWorkspace: ({ workspaceFolder }) => ({ tasks: [], workspaceFolder }),
    taskRuns: new Map(),
    devBuildRunId: '',
    buildTaskRunScopeSnapshot: () => ({ workspaceFile: '', cwd: folderB }),
    isTaskRunInScope: () => false,
    randomSessionId: () => 'session',
    loadSettings,
  });
  registerWakeupsRoutes(app, {
    dataDir,
    loadSettings,
    conditionCheck: { create: async (input) => ({ ok: true, item: { workspaceFolder: input.workspaceFolder } }) },
  });
  registerWorkspaceWatcherRoutes(app, { dataDir, getCurrentCwd: () => folderB, loadSettings });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const routes = [
    { name: 'apps', path: '/api/apps', okStatus: 200, project: (body) => body.dir, headers: { cookie: authCookie } },
    { name: 'browser policy', path: '/api/browser/policy', okStatus: 200, project: (body) => body.workspaceKey, headers: { 'x-test-owner': 'owner-a' } },
    { name: 'browser sessions', path: '/api/browser/sessions', okStatus: 200, project: (body) => body.sessions.length },
    { name: 'browser storage', path: '/api/browser/storage-state', okStatus: 200, project: (body) => body.workspaceKey },
    { name: 'git', path: '/api/git/info', okStatus: 200, project: (body) => body.cwd },
    { name: 'review lessons', path: '/api/review-lessons', okStatus: 200, project: (body) => body.lessons.length },
    { name: 'tasks', path: '/api/tasks', okStatus: 200, project: (body) => body.tasks.length },
    { name: 'task runs', path: '/api/task-runs', okStatus: 200, project: (body) => body.runs.length },
    { name: 'agents', path: '/api/agents', okStatus: 200, project: (body) => body.agents.length },
    { name: 'workspace watcher', path: '/api/workspace-watcher', okStatus: 200, project: (body) => body.cwd },
    { name: 'execution settings', path: '/api/execution-settings', okStatus: 200, project: (body) => body.cwd },
    { name: 'delegation settings', path: '/api/delegation-settings', okStatus: 200, project: (body) => body.cwd },
    { name: 'wake-up condition check', path: '/api/wakeups/condition-check', method: 'POST', okStatus: 201,
      project: (body) => body.item.workspaceFolder, body: {}, },
  ];

  const call = async (route, query = {}, options = {}) => {
    const url = new URL(route.path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const headers = { ...(route.headers || {}), ...(options.headers || {}) };
    const method = route.method || 'GET';
    if (method !== 'GET') headers['content-type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      ...(method !== 'GET' ? { body: JSON.stringify(options.body ?? route.body ?? {}) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    for (const route of routes) {
      await t.test(`${route.name}: missing scope is rejected and explicit folder scope works`, async () => {
        const missing = await call(route);
        assert.equal(missing.status, 400, JSON.stringify(missing.body));
        assert.equal(missing.body.code, 'workspace-scope-required');
        const explicit = await call(route, { workspaceFolder: folderA });
        assert.equal(explicit.status, route.okStatus, JSON.stringify(explicit.body));
        assert.equal(route.project(explicit.body) !== undefined, true);
      });

      await t.test(`${route.name}: contradictory file and folder selectors are rejected`, async () => {
        const conflict = await call(route, { workspaceFile: fileWorkspace, workspaceFolder: folderA });
        assert.equal(conflict.status, 400, JSON.stringify(conflict.body));
        assert.equal(conflict.body.code, 'workspace-scope-conflict');
      });

      await t.test(`${route.name}: changing global selection leaves explicit scope unchanged`, async () => {
        globalSelection = fileWorkspace;
        const first = await call(route, { workspaceFolder: folderA });
        globalSelection = otherGlobal;
        const second = await call(route, { workspaceFolder: folderA });
        assert.equal(first.status, route.okStatus);
        assert.equal(second.status, route.okStatus);
        assert.deepEqual(route.project(second.body), route.project(first.body));
      });
    }

    const widget = await call(routes.find((route) => route.name === 'review lessons'), {}, { headers: { 'x-test-widget': '1' } });
    assert.equal(widget.status, 200, JSON.stringify(widget.body));
    const lessonsRoute = routes.find((route) => route.name === 'review lessons');
    const workspaceLessons = await call(lessonsRoute, { workspaceId });
    assert.equal(workspaceLessons.status, 200, JSON.stringify(workspaceLessons.body));
    const widgetChat = await call(lessonsRoute, { chatId: 'widget-chat-a' }, { headers: { 'x-test-widget': '1' } });
    assert.equal(widgetChat.status, 200, JSON.stringify(widgetChat.body));
    const foreignWidgetChat = await call(lessonsRoute, { chatId: 'scope-chat-a' }, { headers: { 'x-test-widget': '1' } });
    assert.equal(foreignWidgetChat.status, 404);
    assert.equal(foreignWidgetChat.body.code, 'NOT_FOUND');
    for (const name of ['git', 'workspace watcher']) {
      const widgetOverride = await call(routes.find((route) => route.name === name), { workspaceFolder: folderB }, {
        headers: { 'x-test-widget': '1' },
      });
      assert.equal(widgetOverride.status, 200, JSON.stringify(widgetOverride.body));
      assert.equal(widgetOverride.body.cwd, folderA, `${name} must use the widget workspace`);
    }
    const chat = await call(routes.find((route) => route.name === 'git'), { chatId: 'scope-chat-a' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    assert.equal(chat.body.cwd, folderA);
    const foreignChat = await call(routes.find((route) => route.name === 'git'), { chatId: 'scope-chat-a', workspaceFolder: folderB });
    assert.equal(foreignChat.status, 403, JSON.stringify(foreignChat.body));
    assert.equal(foreignChat.body.code, 'OUT_OF_SCOPE');
    const conflictingChat = await call(routes.find((route) => route.name === 'git'), {
      chatId: 'scope-chat-a', workspaceFile: fileWorkspace, workspaceFolder: folderA,
    });
    assert.equal(conflictingChat.status, 400, JSON.stringify(conflictingChat.body));
    assert.equal(conflictingChat.body.code, 'workspace-scope-conflict');
    const conflictingTodo = await call(routes.find((route) => route.name === 'git'), {
      todoId: 'todo-a', workspaceFile: fileWorkspace, workspaceFolder: folderA,
    });
    assert.equal(conflictingTodo.status, 400, JSON.stringify(conflictingTodo.body));
    assert.equal(conflictingTodo.body.code, 'workspace-scope-conflict');

    const folderWorkspace = await call(routes.find((route) => route.name === 'browser policy'), { workspaceId });
    assert.equal(folderWorkspace.status, 200);
    assert.equal(folderWorkspace.body.workspaceKey, workspaceId);
    await call({ name: 'browser sessions', path: '/api/browser/sessions', okStatus: 200, headers: { 'x-test-owner': 'owner-a' } }, { workspaceId });
    assert.equal(browserScopes.at(-1).workspaceFile, workspaceId);
    const fileWorkspacePolicy = await call(routes.find((route) => route.name === 'browser policy'), { workspaceFile: fileWorkspace });
    assert.equal(fileWorkspacePolicy.status, 200);
    assert.equal(fileWorkspacePolicy.body.workspaceKey, fileWorkspace);
    await call({ name: 'browser sessions', path: '/api/browser/sessions', okStatus: 200, headers: { 'x-test-owner': 'owner-a' } }, { workspaceFile: fileWorkspace });
    assert.equal(browserScopes.at(-1).workspaceFile, fileWorkspace);
    const storage = await call({ name: 'browser storage', path: '/api/browser/storage-state', okStatus: 200, headers: { 'x-test-owner': 'owner-a' } }, { workspaceId });
    assert.equal(storage.status, 200);
    assert.equal(browserKeys.at(-1), workspaceId);
    const fileStorage = await call({ name: 'browser storage', path: '/api/browser/storage-state', okStatus: 200, headers: { 'x-test-owner': 'owner-a' } }, { workspaceFile: fileWorkspace });
    assert.equal(fileStorage.status, 200);
    assert.equal(browserKeys.at(-1), fileWorkspace);

    // A folder-only request keeps its override even when membership identifies a file workspace.
    const { setWorkspacePolicy } = await import('../lib/browser/policy-store.js');
    setWorkspacePolicy(dataDir, fileWorkspace, { allowedOrigins: ['https://workspace.example.com'] });
    setWorkspacePolicy(dataDir, folderB, { allowedOrigins: ['https://folder.example.com'] });
    const folderPolicy = await call(routes.find((route) => route.name === 'browser policy'), { workspaceFolder: folderB });
    assert.equal(folderPolicy.status, 200);
    assert.equal(folderPolicy.body.workspaceKey, folderB);
    assert.deepEqual(folderPolicy.body.policy.allowedOrigins, ['https://folder.example.com']);
    const parentPolicy = await call(routes.find((route) => route.name === 'browser policy'), { workspaceFile: fileWorkspace });
    assert.deepEqual(parentPolicy.body.policy.allowedOrigins, ['https://workspace.example.com']);
    const folderStorage = await call({ path: '/api/browser/storage-state' }, { workspaceFolder: folderB });
    assert.equal(folderStorage.status, 200);
    assert.equal(folderStorage.body.workspaceKey, folderB);
    assert.equal(browserKeys.at(-1), folderB);
    const folderSession = await call({ path: '/api/browser/sessions', method: 'POST' }, {}, {
      body: { workspaceFolder: folderB, mode: 'agent' },
    });
    assert.equal(folderSession.status, 201, JSON.stringify(folderSession.body));
    assert.equal(folderSession.body.session.workspaceKey, folderB);
    assert.equal(browserScopes.at(-1).workspaceFile, '');
    assert.equal(browserScopes.at(-1).cwd, folderB);
    const unknownLessons = await call(routes.find((route) => route.name === 'review lessons'), { workspaceFolder: path.join(dataDir, 'unregistered') });
    assert.equal(unknownLessons.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await chatsBackend.registerChatsBackendTeardown();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folderA, { recursive: true, force: true });
    rmSync(folderB, { recursive: true, force: true });
  }
});

test('folder-only task-run listing filters by the folder even when it belongs to a file workspace', async () => {
  const [{ default: express }, http, { registerTasksAgentsRoutes }] = await Promise.all([
    import('express'),
    import('node:http'),
    import('../lib/routes/tasks-agents-routes.js'),
  ]);
  const file = '/ws/project.code-workspace';
  const folder = '/ws/project/app';
  const loadSettings = () => ({
    workspaces: [{ id: file, kind: 'file', workspaceFile: file }],
    workspaceSidebarConfig: { [file]: { folders: { [folder]: { enabled: true } } } },
  });
  // A run created from a folder alone stores an empty workspaceFile.
  const taskRuns = new Map([
    ['run-folder', { taskLabel: 'dev', cwd: folder, workspaceFile: '' }],
    ['run-file', { taskLabel: 'file-run', cwd: folder, workspaceFile: file }],
    ['run-other', { taskLabel: 'other', cwd: '/ws/other', workspaceFile: '' }],
  ]);
  const app = express();
  app.use(express.json());
  registerTasksAgentsRoutes(app, {
    loadCurrentTasks: () => ({ tasks: [] }),
    loadTasksForWorkspace: (scope) => ({ tasks: [scope] }),
    taskRuns,
    devBuildRunId: '',
    buildTaskRunScopeSnapshot: () => ({ workspaceFile: '', cwd: '' }),
    isTaskRunInScope: () => false,
    randomSessionId: () => 'session',
    loadSettings,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async (query) => (await fetch(`${base}/api/task-runs?${new URLSearchParams(query)}`)).json();
    const folderOnly = await get({ workspaceFolder: folder });
    assert.deepEqual(folderOnly.runs.map((r) => r.taskLabel).sort(), ['dev', 'file-run']);
    const both = await get({ workspaceFile: file, workspaceFolder: folder });
    assert.deepEqual(both.runs.map((r) => r.taskLabel), ['file-run']);
    // /api/tasks keeps the folder-only selector too (no inferred file).
    const tasks = await (await fetch(`${base}/api/tasks?${new URLSearchParams({ workspaceFolder: folder })}`)).json();
    assert.equal(tasks.tasks[0].workspaceFile, '');
    assert.equal(tasks.tasks[0].workspaceFolder, folder);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
