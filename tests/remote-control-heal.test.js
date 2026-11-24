import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, beforeEach, mock, test } from 'node:test';
import express from 'express';
import { saveSettings } from '../lib/persist/settings.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { createExternalMcpClient } from '../lib/mcp/mcp-external-clients.js';
import { connectExternalMcpClient } from '../lib/mcp/mcp-external-connect.js';
import { addClaudeHealHook, CLAUDE_HEAL_SCRIPT, removeClaudeHealHook } from '../lib/mcp/mcp-external-install.js';
import {
  configureRemoteControl,
  createRemoteControlSession,
  deleteRemoteControlSession,
  healRemoteControlSession,
  resetRemoteControlForTests,
} from '../lib/remote-control/rc-sessions.js';
import { registerRemoteControlRoutes } from '../lib/routes/remote-control-routes.js';

const run = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-rc-heal-'));
let folder = '';
let counter = 0;
/** @type {any[]} */
let launches = [];
/** @type {Map<string, any>} */
let taskRuns;
/** @type {http.Server} */
let server;
let baseUrl = '';

function configure() {
  taskRuns = new Map();
  launches = [];
  configureRemoteControl({
    taskRuns,
    buildInteractivePtyEnv: (o = {}) => ({ ...o }),
    randomSessionId: () => 'unused',
    port: 3011,
    useHttps: false,
    resolveCli: () => '/usr/local/bin/claude',
    resolveConfigDir: () => '/claude-home',
    launchTask: (spec) => {
      const runId = `run-${launches.length + 1}`;
      const pty = { pid: 1, onData() {}, write() {}, kill() { taskRuns.delete(runId); } };
      taskRuns.set(runId, { pty, clients: new Set() });
      launches.push({ spec, runId });
      return { runId, pid: 1 };
    },
  });
}

before(async () => {
  assert.ok(ISOLATED_DATA_DIR);
  const app = express();
  app.use(express.json());
  registerRemoteControlRoutes(app, {
    taskRuns: new Map(), buildInteractivePtyEnv: () => ({}), randomSessionId: () => 'x', port: 3011, useHttps: false, autostart: false,
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
  folder = path.join(root, `site-${++counter}`);
  fs.mkdirSync(folder, { recursive: true });
  resetRemoteControlForTests();
  configure();
});

const settingsFile = () => path.join(folder, '.claude', 'settings.local.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));

test('the heal hook is merged next to other hooks once and removed alone', () => {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] };
  fs.writeFileSync(settingsFile(), JSON.stringify({ env: { A: '1' }, hooks: { SessionStart: [other], Stop: [] } }));
  assert.equal(addClaudeHealHook(folder).added, true);
  assert.equal(addClaudeHealHook(folder).added, false, 'idempotent');
  const groups = readSettings().hooks.SessionStart;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], other);
  assert.equal(groups[1].hooks[0].command, `node ${JSON.stringify(CLAUDE_HEAL_SCRIPT)} --hint`);
  assert.equal(removeClaudeHealHook(folder), true);
  assert.deepEqual(readSettings(), { env: { A: '1' }, hooks: { SessionStart: [other], Stop: [] } });
  assert.equal(removeClaudeHealHook(folder), false);
});

test('a hook Cretli alone added leaves no empty containers behind; bad hooks are refused untouched', () => {
  addClaudeHealHook(folder);
  removeClaudeHealHook(folder);
  assert.deepEqual(readSettings(), {});
  const bad = JSON.stringify({ hooks: { SessionStart: {} } });
  fs.writeFileSync(settingsFile(), bad);
  assert.throws(() => addClaudeHealHook(folder), /left unchanged/);
  assert.equal(fs.readFileSync(settingsFile(), 'utf8'), bad);
});

test('an operator chat installs the hook; Remove takes it back', () => {
  const session = createRemoteControlSession({ folder });
  const hooks = readSettings().hooks.SessionStart;
  assert.ok(hooks.some((group) => group.hooks.some((hook) => hook.command.includes('cretli-mcp-heal.mjs'))));
  deleteRemoteControlSession(session.id);
  assert.equal('hooks' in readSettings(), false);
});

test('heal re-approves the server and restarts the chat once a minute at most', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    createRemoteControlSession({ folder });
    const settings = readSettings();
    settings.enabledMcpjsonServers = [];
    fs.writeFileSync(settingsFile(), JSON.stringify(settings));
    const result = healRemoteControlSession(folder);
    assert.equal(result.restartInMs, 3000);
    assert.deepEqual(readSettings().enabledMcpjsonServers, ['cretli']);
    assert.equal(launches.length, 1, 'restart waits for the answer');
    mock.timers.tick(3000);
    assert.equal(launches.length, 2);
    assert.throws(() => healRemoteControlSession(folder), /less than a minute/);
    mock.timers.tick(60_000);
    healRemoteControlSession(folder);
    assert.throws(() => healRemoteControlSession(path.join(root, 'nowhere')), /no Cretli operator chat/);
  } finally {
    mock.timers.reset();
  }
});

test('the heal endpoint takes only a managed Claude Code token from this machine', async () => {
  createRemoteControlSession({ folder });
  const heal = (/** @type {Record<string, string>} */ headers = {}) => fetch(`${baseUrl}/mcp/remote-control/heal`, { method: 'POST', headers });
  assert.equal((await heal()).status, 401);
  const staticToken = createExternalMcpClient({ name: 'x', workspaceFolder: folder }).token;
  assert.equal((await heal({ authorization: `Bearer ${staticToken}` })).status, 403);
  const tokenFile = JSON.parse(fs.readFileSync(path.join(folder, '.mcp.json'), 'utf8')).mcpServers.cretli.env.CRETLI_MCP_TOKEN_FILE;
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.equal((await heal({ authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status, 403);
  const ok = await heal({ authorization: `Bearer ${token}` });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).message, /restarts the operator chat/);
});

test('the script prints a hint and heals through the endpoint of the folder\'s .mcp.json', async () => {
  createRemoteControlSession({ folder });
  // Point the folder's connection at the test server.
  connectExternalMcpClient({ target: 'claude', folder, endpoint: { url: `${baseUrl}/mcp`, caFile: '' } });
  const sub = path.join(folder, 'src');
  fs.mkdirSync(sub);
  const hint = await run(process.execPath, [CLAUDE_HEAL_SCRIPT, '--hint'], { cwd: sub });
  assert.match(hint.stdout, /mcp__cretli__\*.*cretli-mcp-heal\.mjs/s);
  const healed = await run(process.execPath, [CLAUDE_HEAL_SCRIPT], { cwd: sub });
  assert.match(healed.stdout, /restarts the operator chat/);
  const none = await run(process.execPath, [CLAUDE_HEAL_SCRIPT, '--hint'], { cwd: os.tmpdir() });
  assert.equal(none.stdout, '', 'no hint outside a connected folder');
});
