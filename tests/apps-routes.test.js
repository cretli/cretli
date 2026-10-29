import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-apps-routes-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = path.join(temp, 'data');
const auth = await import('../lib/auth.js');
const { registerAppsRoutes } = await import('../lib/routes/apps-routes.js');
const { registerTasksAgentsRoutes } = await import('../lib/routes/tasks-agents-routes.js');
const { createAppsService } = await import('../lib/apps/service.js');
const { createAppsStateStore } = await import('../lib/apps/state-store.js');
const { createTaskLauncher } = await import('../lib/apps/task-launcher.js');
const { loadTasks } = await import('../lib/tasks.js');
const { isTaskRunInScope } = await import('../lib/workspace-context.js');

const dir = fs.mkdtempSync(path.join(temp, 'ws-'));
fs.mkdirSync(path.join(dir, '.cretli'));
fs.mkdirSync(path.join(dir, '.vscode'));
fs.writeFileSync(path.join(dir, '.vscode', 'tasks.json'), JSON.stringify({
  tasks: [{ label: 'Serve my-app', type: 'shell', command: 'sleep 30' }],
}));
const appDef = (id, extra = {}) => ({ id, name: id, start: { taskLabel: 'Serve my-app' }, ports: [], exposure: 'local', ...extra });
fs.writeFileSync(path.join(dir, '.cretli', 'apps.json'), JSON.stringify({ apps: [appDef('my-app'), appDef('other-app')] }));

async function withServer(fn) {
  assert.equal(auth.setPassword('test-password-for-apps').ok, true);
  const sessionToken = auth.createSession();
  const cookie = `cr_session=${encodeURIComponent(sessionToken)}`;
  const csrf = auth.getCsrfTokenForSessionToken(sessionToken);
  const taskRuns = new Map();
  const service = createAppsService({
    getWorkspaceDir: () => dir,
    taskRuns,
    launchTask: createTaskLauncher({
      taskRuns,
      buildInteractivePtyEnv: (o = {}) => ({ ...process.env, ...o }),
      randomSessionId: () => Math.random().toString(36).slice(2),
      buildTaskRunScopeSnapshot: () => ({ workspaceFile: '', cwd: dir }),
    }),
    loadTasksForWorkspace: ({ workspaceFolder }) => loadTasks(workspaceFolder),
    snapshot: async () => ({ ok: true, listeners: [] }),
    state: createAppsStateStore({ file: path.join(temp, 'state.json') }),
  });
  const app = express();
  app.use(express.json());
  registerAppsRoutes(app, { taskRuns, getCurrentCwd: () => dir, service });
  registerTasksAgentsRoutes(app, {
    taskRuns, devBuildRunId: 'dev-build', loadCurrentTasks: () => loadTasks(dir),
    buildTaskRunScopeSnapshot: () => ({ workspaceFile: '', cwd: dir }), isTaskRunInScope,
    randomSessionId: () => 'x', getCurrentCwd: () => dir,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, [auth.AUTH_CSRF_HEADER]: csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn({ call, taskRuns, base }); } finally {
    for (const run of taskRuns.values()) { try { run.pty.kill(); } catch { /* gone */ } }
    await new Promise((resolve) => server.close(resolve));
  }
}

test('routes require a session', async () => {
  await withServer(async ({ base }) => {
    for (const [method, url] of [['GET', '/api/apps'], ['PUT', '/api/apps'], ['GET', '/api/apps/status'], ['POST', '/api/apps/my-app/stop']]) {
      assert.equal((await fetch(base + url, { method })).status, 401, `${method} ${url}`);
    }
  });
});

test('integration: start from a task shows up in /api/task-runs and stop ends it', async () => {
  await withServer(async ({ call, taskRuns }) => {
    const started = await call('POST', '/api/apps/my-app/start');
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const listed = await call('GET', '/api/task-runs');
    assert.deepEqual(listed.body.runs.map((r) => r.runId), [started.body.runId]);
    assert.equal(listed.body.runs[0].taskLabel, 'Serve my-app');
    assert.equal((await call('POST', '/api/apps/my-app/start')).body.error, 'app-already-running');
    const status = await call('GET', '/api/apps/status?refresh=1');
    assert.equal(status.body.apps.find((a) => a.id === 'my-app').status, 'running');
    const stopped = await call('POST', '/api/apps/my-app/stop');
    assert.equal(stopped.status, 200);
    assert.equal(taskRuns.size, 0);
    assert.deepEqual((await call('GET', '/api/task-runs')).body.runs, []);
  });
});

test('isolation: stop never touches a run started outside the registry; no own run is app-not-running', async () => {
  await withServer(async ({ call, taskRuns }) => {
    // A run started the normal way (as /ws-task would): present in taskRuns, absent from any appId mapping.
    const foreign = { pty: { pid: 1, kill() { foreign.killed = true; } }, clients: new Set(), taskLabel: 'Serve my-app', cwd: dir, workspaceFile: '' };
    taskRuns.set('foreign-run', foreign);
    for (const id of ['my-app', 'other-app']) {
      const res = await call('POST', `/api/apps/${id}/stop`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'app-not-running');
    }
    assert.equal(foreign.killed, undefined);
    assert.equal(taskRuns.has('foreign-run'), true);
    // Starting and stopping an app leaves the foreign run alone too.
    assert.equal((await call('POST', '/api/apps/my-app/start')).status, 200);
    assert.equal((await call('POST', '/api/apps/my-app/stop')).status, 200);
    assert.equal((await call('POST', '/api/apps/other-app/stop')).body.error, 'app-not-running');
    assert.equal(foreign.killed, undefined);
    assert.equal(taskRuns.has('foreign-run'), true);
  });
});

test('a broken apps.json yields a readable 400 and the server keeps answering', async () => {
  await withServer(async ({ call }) => {
    const file = path.join(dir, '.cretli', 'apps.json');
    const good = fs.readFileSync(file, 'utf8');
    try {
      fs.writeFileSync(file, '{ broken');
      const res = await call('GET', '/api/apps');
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'apps-file-invalid');
      assert.match(res.body.errors[0], /not valid JSON/);
      assert.equal((await call('GET', '/api/apps/status?refresh=1')).body.ok, true);
      assert.equal((await call('POST', '/api/apps/my-app/start')).status, 400);
      const bad = await call('PUT', '/api/apps', { apps: [{ id: 'x' }] });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'invalid-apps');
    } finally { fs.writeFileSync(file, good); }
  });
});

test('adding a suggestion or orphan writes only a definition', async () => {
  await withServer(async ({ call, taskRuns }) => {
    const file = path.join(dir, '.cretli', 'apps.json');
    const good = fs.readFileSync(file, 'utf8');
    try {
      const added = await call('POST', '/api/apps', { app: appDef('orphan-9000', { ports: [{ port: 9000, bind: '0.0.0.0', role: 'http' }] }) });
      assert.equal(added.status, 200);
      assert.equal(taskRuns.size, 0);
      assert.equal((await call('GET', '/api/apps')).body.apps.length, 3);
      assert.equal((await call('POST', '/api/apps', { app: appDef('orphan-9000') })).status, 400);
      assert.ok((await call('GET', '/api/apps/suggestions')).body.suggestions.length >= 1);
    } finally { fs.writeFileSync(file, good); }
  });
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
