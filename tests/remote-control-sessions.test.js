import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { saveSettings } from '../lib/persist/settings.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { listExternalMcpClients } from '../lib/mcp/mcp-external-clients.js';
import {
  configureRemoteControl,
  createRemoteControlSession,
  deleteRemoteControlSession,
  listRemoteControlSessions,
  resetRemoteControlForTests,
  startRemoteControlAutostart,
  stopRemoteControlSession,
  updateRemoteControlSession,
} from '../lib/remote-control/rc-sessions.js';
import { registerRemoteControlRoutes } from '../lib/routes/remote-control-routes.js';

const auth = await import('../lib/auth.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-rc-'));
const folderA = path.join(root, 'shop');
const folderB = path.join(root, 'other', 'shop');
fs.mkdirSync(folderA, { recursive: true });
fs.mkdirSync(folderB, { recursive: true });

/** Fake PTY: records writes, lets the test emit output and exit. */
function fakePty() {
  /** @type {Array<(chunk: string) => void>} */
  const listeners = [];
  return {
    pid: 4242,
    writes: /** @type {string[]} */ ([]),
    killed: false,
    onData(/** @type {(chunk: string) => void} */ fn) { listeners.push(fn); },
    emit(/** @type {string} */ chunk) { for (const fn of listeners) fn(chunk); },
    write(/** @type {string} */ data) { this.writes.push(data); },
    kill() { this.killed = true; },
  };
}

/** @type {Map<string, any>} */
let taskRuns;
/** @type {any[]} */
let launches;
let cli = '/usr/local/bin/claude';
let configDir = '/claude-home';

function configure() {
  taskRuns = new Map();
  launches = [];
  let next = 0;
  configureRemoteControl({
    taskRuns,
    buildInteractivePtyEnv: (o = {}) => ({ ...o }),
    randomSessionId: () => 'unused',
    port: 3011,
    useHttps: false,
    resolveCli: () => cli,
    resolveConfigDir: () => configDir,
    launchTask: (spec, hooks) => {
      const runId = `run-${++next}`;
      const pty = fakePty();
      taskRuns.set(runId, { pty, clients: new Set() });
      launches.push({ spec, hooks, runId, pty });
      return { runId, pid: pty.pid };
    },
  });
}

/** @type {http.Server} */
let server;
let baseUrl = '';
let humanCookie = '';

before(async () => {
  assert.ok(ISOLATED_DATA_DIR);
  assert.equal(auth.setPassword('test-password-for-rc').ok, true);
  humanCookie = `cr_session=${encodeURIComponent(auth.createSession())}`;
  const app = express();
  app.use(express.json());
  registerRemoteControlRoutes(app, {
    taskRuns: new Map(),
    buildInteractivePtyEnv: (o = {}) => ({ ...o }),
    randomSessionId: () => 'x',
    port: 3011,
    useHttps: false,
    autostart: false,
    resolveCli: () => '',
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  saveSettings({ externalMcpEnabled: true });
  for (const file of ['remote-control-sessions.json', 'mcp-external-clients.json']) fs.rmSync(resolveDataPath(file), { force: true });
  for (const folder of [folderA, folderB]) fs.rmSync(path.join(folder, '.mcp.json'), { force: true });
  cli = '/usr/local/bin/claude';
  configDir = '/claude-home';
  resetRemoteControlForTests();
  configure();
});

test('creating an operator chat connects the MCP and starts claude remote-control in the folder', () => {
  const session = createRemoteControlSession({ folder: folderA });
  assert.equal(session.mode, 'operator');
  assert.equal(session.autoStart, true);
  assert.equal(session.name, 'shop');
  assert.equal(session.mcpConnected, true);
  assert.equal(session.mcpMode, 'operator');
  const entry = JSON.parse(fs.readFileSync(path.join(folderA, '.mcp.json'), 'utf8')).mcpServers.cretli;
  assert.equal(entry.env.CRETLI_MCP_URL, 'http://127.0.0.1:3011/mcp');

  assert.equal(launches.length, 1);
  const { spec, pty } = launches[0];
  assert.equal(spec.command, cli);
  assert.deepEqual(spec.args, ['remote-control', '--name', 'shop', '--spawn=same-dir']);
  assert.equal(spec.cwd, folderA);
  assert.equal(spec.env.CLAUDE_CONFIG_DIR, '/claude-home', 'the claude.ai login of the Claude harness');
  assert.equal(listRemoteControlSessions()[0].status, 'starting');

  // First-run question is answered once; a split chunk still matches.
  pty.emit('Enable Remote Control? ');
  pty.emit('\x1b[1m(y/n)\x1b[0m ');
  pty.emit('Enable Remote Control? (y/n) ');
  assert.deepEqual(pty.writes, ['y\r']);
  pty.emit('Quick safety check: is this a project you trust?\r\nTrust /srv/shop? [y/N] ');
  assert.deepEqual(pty.writes, ['y\r', 'y\r']);

  pty.emit('\x1b]8;;https://claude.ai/code/session_01AbC?from=cli\x1b\\link\x1b]8;;\x1b\\ ·✔︎· Connected · shop');
  const [view] = listRemoteControlSessions();
  assert.equal(view.status, 'connected');
  assert.equal(view.url, 'https://claude.ai/code/session_01AbC');

  pty.emit('Reconnecting…');
  assert.equal(listRemoteControlSessions()[0].status, 'starting');
});

test('stop, start again, exit and delete', () => {
  const created = createRemoteControlSession({ folder: folderA, mode: 'agent', autoStart: false });
  assert.equal(created.mcpMode, 'agent');
  assert.equal(stopRemoteControlSession(created.id).status, 'stopped');
  assert.equal(taskRuns.size, 0, 'the task run was killed');
  assert.equal(launches[0].pty.killed, true);

  // Creating again for the same folder reuses the entry and restarts the process.
  const again = createRemoteControlSession({ folder: folderA, mode: 'plan' });
  assert.equal(again.id, created.id);
  assert.equal(again.mode, 'plan');
  assert.equal(again.autoStart, false, 'autoStart is kept when not given');
  assert.equal(launches.length, 2);

  // The process exits by itself: its last output explains why.
  launches[1].pty.emit('Error: not logged in\r\n');
  taskRuns.delete(launches[1].runId);
  launches[1].hooks.onExit({ runId: launches[1].runId });
  const exited = listRemoteControlSessions()[0];
  assert.equal(exited.status, 'stopped');
  assert.match(exited.lastOutput, /not logged in/);

  assert.equal(updateRemoteControlSession(created.id, { autoStart: true }).autoStart, true);
  deleteRemoteControlSession(created.id);
  assert.deepEqual(listRemoteControlSessions(), []);
  // The MCP connection of the folder stays.
  assert.ok(listExternalMcpClients().some((client) => client.managed && !client.revokedAt));
});

test('names are unique per folder and autostart starts only marked entries', () => {
  const a = createRemoteControlSession({ folder: folderA });
  const b = createRemoteControlSession({ folder: folderB, autoStart: false });
  assert.equal(a.name, 'shop');
  assert.equal(b.name, 'shop-2');
  stopRemoteControlSession(a.id);
  stopRemoteControlSession(b.id);

  resetRemoteControlForTests();
  configure();
  startRemoteControlAutostart();
  assert.deepEqual(launches.map((row) => row.spec.args[2]), ['shop']);
});

test('a missing CLI or claude.ai login is reported and the session stays stopped', () => {
  cli = '';
  assert.throws(() => createRemoteControlSession({ folder: folderA }), /CLI not found/);
  assert.equal(listRemoteControlSessions()[0].status, 'stopped');
  cli = '/usr/local/bin/claude';
  configDir = '';
  assert.throws(() => createRemoteControlSession({ folder: folderA }), /claude\.ai login/);
  assert.throws(() => createRemoteControlSession({ folder: 'relative' }), /absolute/);
  assert.throws(() => createRemoteControlSession({ folder: folderA, mode: 'root' }), /mode must be/);
});

test('routes need a human login session and enabled external MCP', async () => {
  const list = await fetch(`${baseUrl}/api/remote-control/sessions`);
  assert.equal(list.status, 403);
  const ok = await fetch(`${baseUrl}/api/remote-control/sessions`, { headers: { cookie: humanCookie } });
  assert.equal(ok.status, 200);
  saveSettings({ externalMcpEnabled: false });
  const create = await fetch(`${baseUrl}/api/remote-control/sessions`, {
    method: 'POST',
    headers: { cookie: humanCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ folder: folderA }),
  });
  assert.equal(create.status, 409);
});

test('an operator chat can allow the Cretli tools; removing it takes back only that rule', () => {
  const settings = path.join(folderA, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: '1' } }));
  try {
    const session = createRemoteControlSession({ folder: folderA, allowTools: true });
    assert.equal(session.toolsAllowed, true);
    assert.equal(session.toolPermission.added, true);
    const { hooks, ...written } = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.deepEqual(written, { env: { KEEP: '1' }, permissions: { allow: ['mcp__cretli'] }, enabledMcpjsonServers: ['cretli'] });
    assert.match(hooks.SessionStart[0].hooks[0].command, /cretli-mcp-heal\.mjs" --hint$/, 'the self-heal hint hook');
    deleteRemoteControlSession(session.id);
    // The folder keeps its MCP connection, so the server approval stays with it.
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { env: { KEEP: '1' }, permissions: { allow: [] }, enabledMcpjsonServers: ['cretli'] });
  } finally {
    fs.rmSync(path.join(folderA, '.claude'), { recursive: true, force: true });
  }
});

test('an operator chat takes a permission profile; the list view shows it; removing it releases only Cretli\'s rules', async () => {
  const settings = path.join(folderA, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ env: { KEEP: '1' }, permissions: { allow: ['Bash(npm test)'] } }));
  try {
    const bad = await fetch(`${baseUrl}/api/remote-control/sessions`, {
      method: 'POST',
      headers: { cookie: humanCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ folder: folderA, permissionProfile: 'everything' }),
    });
    assert.equal(bad.status, 400);

    const res = await fetch(`${baseUrl}/api/remote-control/sessions`, {
      method: 'POST',
      headers: { cookie: humanCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ folder: folderA, permissionProfile: 'edits_bash_guarded' }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()).session;
    assert.equal(created.permissionProfile, 'edits_bash_guarded');
    assert.equal(created.toolsAllowed, true);
    assert.equal(created.permissionGrant.profile, 'edits_bash_guarded');
    const listed = (await (await fetch(`${baseUrl}/api/remote-control/sessions`, { headers: { cookie: humanCookie } })).json()).sessions;
    assert.equal(listed.find((row) => row.id === created.id).permissionProfile, 'edits_bash_guarded');
    const written = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(written.permissions.defaultMode, 'acceptEdits');
    assert.ok(written.permissions.deny.includes('Read(./.env)'));

    const del = await fetch(`${baseUrl}/api/remote-control/sessions/${created.id}`, { method: 'DELETE', headers: { cookie: humanCookie } });
    assert.equal(del.status, 200);
    // Remove keeps the folder's MCP connection and with it the server approval.
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { env: { KEEP: '1' }, permissions: { allow: ['Bash(npm test)'], ask: [], deny: [] }, enabledMcpjsonServers: ['cretli'] });
  } finally {
    fs.rmSync(path.join(folderA, '.claude'), { recursive: true, force: true });
  }
});

test('allowTools maps to a profile and permissionProfile wins', () => {
  try {
    const session = createRemoteControlSession({ folder: folderA, allowTools: true, permissionProfile: 'prompt' });
    assert.equal(session.permissionProfile, 'prompt');
    assert.equal(session.toolsAllowed, false);
    const legacy = createRemoteControlSession({ folder: folderA, allowTools: true });
    assert.equal(legacy.permissionProfile, 'cretli_tools');
    deleteRemoteControlSession(legacy.id);
  } finally {
    fs.rmSync(path.join(folderA, '.claude'), { recursive: true, force: true });
  }
});

test('deleting an operator chat clears its connection\'s profile even when it owns no rules', () => {
  const settings = path.join(folderA, '.claude', 'settings.local.json');
  try {
    const session = createRemoteControlSession({ folder: folderA, permissionProfile: 'edits_bash_guarded' });
    // Reconnect without a profile: the new connection inherits the grant and owns the rules.
    deleteRemoteControlSession(session.id);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow, []);
    const mcp = listExternalMcpClients().find((client) => client.installFolder === folderA && !client.revokedAt);
    assert.equal(mcp?.claudePermissionGrant, undefined, 'grant cleared on the surviving connection');
    // A second delete of nothing owned still leaves the connection without a declared profile.
    const again = createRemoteControlSession({ folder: folderA, permissionProfile: 'prompt' });
    deleteRemoteControlSession(again.id);
    assert.equal(listExternalMcpClients().find((client) => client.installFolder === folderA && !client.revokedAt)?.claudePermissionGrant, undefined);
  } finally {
    fs.rmSync(path.join(folderA, '.claude'), { recursive: true, force: true });
  }
});
