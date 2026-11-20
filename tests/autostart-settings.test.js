import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { spawnSync } from 'node:child_process';
import { requireAuth } from '../lib/auth.js';
import { registerAutostartRoutes } from '../lib/routes/autostart-routes.js';
import { readSupervisorStatus } from '../lib/autostart/supervisor-status.js';
import { publishSupervisorAlert } from '../lib/notifications/supervisor-producer.ts';
import { AUTOSTART_ACTIVATION_KEYS, autostartActivationMessage } from '../app_front/features/settings/autostartActivation.js';
import { pl } from '../app_front/i18n/pl.js';
import { en } from '../app_front/i18n/en.js';
import { listNotifications } from '../lib/notifications/notification-store.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-autostart-api-'));
const statePath = path.join(dir, 'supervisor-state.json');
const storePath = path.join(dir, 'notifications.json');
let installed = false, fail = false, supported = true, platform = 'systemd';
const calls = [];
let releaseOperation, operationEntered;
let heldOperation;
const adapter = {
  status: async () => ({ supported, installed, platform, env: { SECRET: 'private-value' } }),
  install: async (options) => { calls.push(['install', options]); if (heldOperation) { operationEntered(); await heldOperation; } if (fail) throw new Error('SECRET=private-value'); installed = true; return { activation: 'Next login', warnings: [] }; },
  uninstall: async (options) => { calls.push(['uninstall', options]); installed = false; return { activation: platform === 'launchd' ? 'Running server and supervisor are not stopped. Stop it now with: launchctl bootout gui/501/com.cretli.supervisor' : 'Running server and supervisor are not stopped. systemctl --user stop cretli.service', warnings: [] }; },
};
const app = express(); app.use(express.json());
app.use((req, res, next) => {
  const token = req.headers['x-test-token'];
  if (!token) return requireAuth(req, res, next);
  if (token === 'widget') req.widgetAccess = {};
  if (token === 'mcp') req.mcpIntegration = {};
  next();
});
registerAutostartRoutes(app, { adapter, supervisor: () => readSupervisorStatus({ statePath, env: {}, ppid: 10 }) });
const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/api/settings/autostart`;
async function request(token, body) {
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers: { ...(token ? { 'x-test-token': token } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
try {
  assert.ok([401, 403].includes((await request()).status));
  for (const token of ['widget', 'mcp']) {
    assert.equal((await request(token)).status, 403);
    assert.equal((await request(token, { confirm: true, enabled: true })).status, 403);
  }
  assert.equal((await request('session')).status, 200);
  for (const enabled of [true, false]) assert.equal((await request('session', { enabled })).status, 400);
  assert.equal(calls.length, 0);
  const enabled = await request('session', { enabled: true, confirm: true });
  assert.equal(enabled.data.installed, true);
  assert.equal(enabled.data.activationCode, 'next_boot');
  const disabled = await request('session', { enabled: false, confirm: true });
  assert.equal(disabled.data.serverKeepsRunning, true);
  assert.equal(disabled.data.activationCode, 'removed_systemd');
  assert.equal(disabled.data.stopCommand, 'systemctl --user stop cretli.service');
  assert.match(disabled.data.activation, /not stopped.*systemctl/);
  assert.deepEqual(calls, [['install', { apply: true, start: false, linger: false }], ['uninstall', { apply: true, start: false, linger: false }]]);
  heldOperation = new Promise((resolve) => { releaseOperation = resolve; });
  const entered = new Promise((resolve) => { operationEntered = resolve; });
  const firstOperation = request('session', { enabled: true, confirm: true });
  await entered;
  const countWhileHeld = calls.length;
  const concurrent = await request('session', { enabled: false, confirm: true });
  assert.equal(concurrent.status, 409);
  assert.match(concurrent.data.error, /already in progress/);
  assert.equal(calls.length, countWhileHeld, 'rejected POST must not call the adapter');
  releaseOperation();
  assert.equal((await firstOperation).status, 200);
  heldOperation = undefined;
  fail = true;
  const failure = await request('session', { enabled: true, confirm: true });
  assert.equal(failure.status, 503); assert.doesNotMatch(JSON.stringify(failure), /private-value|SECRET=/);
  fail = false;
  assert.equal((await request('session', { enabled: true, confirm: true })).status, 200, 'failure releases the operation lock');
  for (const dictionary of [pl, en]) {
    const translate = (key) => key.split('.').reduce((value, part) => value?.[part], dictionary);
    for (const [code, key] of Object.entries(AUTOSTART_ACTIVATION_KEYS)) {
      assert.equal(typeof translate(key), 'string', key);
      assert.equal(autostartActivationMessage({ activationCode: code }, translate), translate(key));
    }
    assert.equal(autostartActivationMessage({ activationCode: 'unknown', activation: 'RAW ENGLISH', warnings: ['RAW WARNING'] }, translate), translate('settings.autostartApplied'));
    const message = autostartActivationMessage(disabled.data, translate);
    assert.ok(message.endsWith(disabled.data.stopCommand));
    assert.doesNotMatch(message, /Running server and supervisor are not stopped/);
  }
  for (const kind of ['launchd', 'wsl', 'termux']) {
    platform = kind;
    const removed = await request('session', { enabled: false, confirm: true });
    assert.equal(removed.data.activationCode, `removed_${kind}`);
    assert.equal(removed.data.stopCommand, kind === 'launchd' ? 'launchctl bootout gui/501/com.cretli.supervisor' : null);
  }
  supported = false; assert.equal((await request('session')).data.supported, false);
  assert.equal(readSupervisorStatus({ statePath }).hasData, false);
  fs.writeFileSync(statePath, 'broken'); assert.equal(readSupervisorStatus({ statePath }).hasData, false);
  const row = { pid: 10, childPid: process.pid, state: 'running', lastCrash: { at: '2026-10-30T10:00:00Z', reason: 'child_exit:1' }, crashLoopAt: '2026-10-30T10:00:00Z', crashLoopReason: 'health_probe_failed', env: { SECRET: 'private-value' }, logTail: 'SECRET=private-value' };
  fs.writeFileSync(statePath, JSON.stringify(row));
  assert.equal(readSupervisorStatus({ statePath, env: {}, ppid: 10 }).stale, true);
  assert.equal(readSupervisorStatus({ statePath, env: { CRETLI_SUPERVISOR_PID: '10' }, ppid: 10 }).active, true);
  assert.equal(readSupervisorStatus({ statePath, env: { CRETLI_SUPERVISOR_PID: '10' }, ppid: 10 }).stale, false);
  assert.doesNotMatch(JSON.stringify((await request('session')).data), /private-value|logTail|SECRET/);
  assert.equal((await publishSupervisorAlert({ dataDir: dir, storePath, broadcast: false })).created, true);
  const replay = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { publishSupervisorAlert } from './lib/notifications/supervisor-producer.ts';
    const result = await publishSupervisorAlert({ dataDir: process.env.TEST_SUPERVISOR_DIR, storePath: process.env.TEST_SUPERVISOR_STORE, broadcast: false });
    if (result.created) process.exit(1);
  `], { env: { ...process.env, CRETLI_DATA_DIR: dir, TEST_SUPERVISOR_DIR: dir, TEST_SUPERVISOR_STORE: storePath }, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr);
  row.state = 'running';
  fs.writeFileSync(statePath, JSON.stringify(row));
  assert.equal((await publishSupervisorAlert({ dataDir: dir, storePath, broadcast: false })).created, false);
  row.state = 'crash_loop'; row.crashLoopAt = '2026-10-31T10:00:00Z';
  fs.writeFileSync(statePath, JSON.stringify(row));
  assert.equal((await publishSupervisorAlert({ dataDir: dir, storePath, broadcast: false })).created, true);
  assert.equal(listNotifications({}, { storePath }).items.length, 2);
  row.lastCrash.reason = 'token=private-value'; row.crashLoopReason = 'SECRET=private-value';
  fs.writeFileSync(statePath, JSON.stringify(row));
  assert.equal(readSupervisorStatus({ statePath }).lastCrash.reason, null);
  assert.equal(readSupervisorStatus({ statePath }).crashLoopReason, null);
  const mcpSource = fs.readFileSync(new URL('../lib/mcp/mcp-external-operator-tools.js', import.meta.url), 'utf8');
  assert.match(mcpSource, /case 'operator_watcher_status':[\s\S]*?supervisor: readSupervisorStatus/);
  console.log('autostart settings: PASS');
} finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
