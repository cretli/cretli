import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createSupervisor } from '../lib/cretli-supervisor.js';
import { assertSupervisorOwner, createSupervisorControl, supervisorManager } from '../lib/autostart/supervisor-control.js';
import { registerSupervisorRoutes } from '../lib/routes/supervisor-routes.js';

test('disabled supervision keeps the child alive, aborts probes, and resumes health checks on enable', async () => {
  let now = 0, resolveProbe, signal;
  const child = Object.assign(new EventEmitter(), { pid: 22, signals: [], kill(s) { this.signals.push(s); } });
  const engine = createSupervisor({ spawn: () => child,
    fetch: (input) => { signal = input.signal; return new Promise((resolve) => { resolveProbe = resolve; }); },
    clock: { now: () => now, setTimeout: () => 1, clearTimeout() {} }, writeState() {}, finish() {},
    config: { graceMs: 1, probeIntervalMs: 10, failureLimit: 1 } });
  engine.start(); now = 10;
  const probe = engine.tick();
  engine.setEnabled(false);
  assert.equal(signal.aborted, true);
  resolveProbe({ ok: false }); await probe;
  assert.equal(engine.snapshot().enabled, false);
  now = 20; await engine.tick();
  assert.deepEqual(child.signals, []);
  engine.setEnabled(true); now = 30;
  const next = engine.tick(); resolveProbe({ ok: false }); await next;
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('disabled supervision never automatically respawns an exited child', () => {
  let starts = 0, timers = 0;
  const child = Object.assign(new EventEmitter(), { pid: 22, kill() {} });
  const engine = createSupervisor({ spawn: () => { starts++; return child; }, fetch: async () => ({ ok: true }),
    clock: { now: () => 10, setTimeout: () => { timers++; return 1; }, clearTimeout() {} },
    writeState() {}, finish() {} });
  engine.start(); engine.setEnabled(false); child.emit('close', 1, null);
  assert.equal(starts, 1); assert.equal(timers, 0); assert.equal(engine.snapshot().state, 'stopped');
  engine.setEnabled(true); assert.equal(starts, 2);
});

test('restart of a verified systemd supervisor uses its actual manager, not a second instance', async () => {
  assertSupervisorOwner({ root: '/repo', pid: 12, env: { CRETLI_SUPERVISOR_PID: '12' }, command: () => 'node /repo/scripts/cretli-supervisor.mjs' });
  assert.throws(() => assertSupervisorOwner({ root: '/repo', pid: 12, env: { CRETLI_SUPERVISOR_PID: '12' }, command: () => 'node /foreign/server.js' }));
  let called;
  const manager = await supervisorManager(12, { platform: 'linux', read: () => '0::/system.slice/cretli.service\n',
    run: async (...args) => { called = args; return { stdout: 'Restart=always\nMainPID=12\n' }; } });
  assert.equal(manager, 'systemd'); assert.equal(called[1].includes('--user'), false);
  await assert.rejects(supervisorManager(12, { platform: 'linux', read: () => '0::/system.slice/cretli.service\n',
    run: async () => ({ stdout: 'Restart=no\nMainPID=12\n' }) }));
});

test('logs are bounded and credentials are redacted without returning arbitrary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-logs-'));
  try {
    fs.writeFileSync(path.join(dir, 'supervisor.log'), `${'noise\n'.repeat(5000)}token=private-value\nAuthorization: Bearer abcdefghijk\n`);
    const control = createSupervisorControl({ dataDir: dir, env: {} });
    const logs = control.logs();
    assert.ok(logs.server.length <= 4096);
    assert.doesNotMatch(logs.server, /private-value|abcdefghijk/);
    assert.equal(logs.events, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP controls reject non-session clients, enforce confirmation, and serialize restarts with updates', async () => {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (!req.headers['x-test-client']) return res.sendStatus(401);
    if (req.headers['x-test-client'] === 'widget') req.widgetAccess = {};
    if (req.headers['x-test-client'] === 'mcp') req.mcpIntegration = {};
    next();
  });
  let allow = false, scheduled, run = 0, enabled;
  registerSupervisorRoutes(app, { control: { status: () => ({ active: true }), logs: () => ({ events: 'event', server: 'server' }),
    setEnabled: (value) => { enabled = value; }, restart: async () => () => { run++; } },
  claim: () => allow ? { allowed: true, operationId: 'slot' } : { allowed: false, status: 409, errorKey: 'update.activeRuns' },
  release() {}, schedule: (fn) => { scheduled = fn; } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/settings/supervisor`;
  const request = (client, body, suffix = '') => fetch(url + suffix, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(client ? { 'x-test-client': client } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await request()).status, 401);
    for (const client of ['widget', 'mcp']) {
      assert.equal((await request(client)).status, 403);
      assert.equal((await request(client, null, '/logs')).status, 403);
      assert.equal((await request(client, { action: 'restart', confirm: true })).status, 403);
    }
    const status = await request('session'); assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal((await request('session', { action: 'restart' })).status, 400);
    assert.equal((await request('session', { action: 'arbitrary', confirm: true })).status, 400);
    assert.equal((await request('session', { action: 'disable', confirm: true })).status, 202); assert.equal(enabled, false);
    assert.equal((await request('session', { action: 'enable', confirm: true })).status, 202); assert.equal(enabled, true);
    assert.equal((await request('session', { action: 'restart', confirm: true })).status, 409); assert.equal(scheduled, undefined);
    allow = true;
    assert.equal((await request('session', { action: 'restart', confirm: true })).status, 202); assert.equal(run, 0);
    assert.equal((await request('session', { action: 'restart', confirm: true })).status, 409);
    await scheduled(); assert.equal(run, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
