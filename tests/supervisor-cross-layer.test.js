import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createAutostart } from '../lib/autostart/index.js';

const root = new URL('../', import.meta.url).pathname;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(20); }
  throw new Error('Timed out waiting for isolated supervisor transition');
}

test('autostart dry-run through crash recovery, shell restart, loop and durable alert', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.cretli-cross-layer-'));
  const tree = path.join(home, 'my-app');
  const data = path.join(home, 'state');
  const statePath = path.join(data, 'supervisor-state.json');
  const storePath = path.join(data, 'notifications.json');
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const state = () => read(statePath);
  let supervisor;
  const pids = new Set();
  let stderr = '';
  const holder = net.createServer();
  try {
    fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(tree, 'package.json'), '{"type":"module"}');
    // Only production modules are shared; every writable path belongs to this fixture.
    fs.symlinkSync(path.join(root, 'lib'), path.join(tree, 'lib'));
    for (const name of ['cretli-supervisor.mjs', 'task-restart-server.sh']) {
      fs.copyFileSync(path.join(root, 'scripts', name), path.join(tree, 'scripts', name));
    }
    const calls = [];
    const adapter = createAutostart({ root: tree, home, env: { HOME: home }, platform: 'linux', release: 'Linux',
      exec: async (...args) => { calls.push(args); return { stdout: '' }; } });
    const before = fs.readdirSync(home, { recursive: true });
    const install = await adapter.install();
    assert.equal(install.supported, true);
    assert.deepEqual(fs.readdirSync(home, { recursive: true }), before, 'dry-run writes nothing');
    assert.ok(calls.every(([cmd, args]) => cmd === 'systemctl' && args.join(' ') === '--user show-environment'));
    assert.match(install.content, /cretli-supervisor\.mjs/);
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = holder.address().port;
    assert.notEqual(port, 3011);
    await new Promise((resolve) => holder.close(resolve));
    const fixture = path.join(home, 'server.mjs');
    fs.writeFileSync(fixture, `import http from 'node:http';
import fs from 'node:fs';
import { readSupervisorStatus } from ${JSON.stringify(path.join(root, 'lib/autostart/supervisor-status.js'))};
import { publishSupervisorAlert } from ${JSON.stringify(path.join(root, 'lib/notifications/supervisor-producer.ts'))};
const server = http.createServer((req, res) => res.end(String(process.pid)));
server.listen(Number(process.env.PORT), '127.0.0.1', async () => {
  const status = readSupervisorStatus();
  const alert = await publishSupervisorAlert({ dataDir: process.env.CRETLI_DATA_DIR, storePath: process.env.ALERT_STORE, broadcast: false });
  fs.appendFileSync(process.env.STARTS, JSON.stringify({ pid: process.pid, status, alert }) + '\\n');
});
process.on('SIGTERM', () => { fs.appendFileSync(process.env.STOPS, String(process.pid) + '\\n'); server.close(() => process.exit(0)); });
`);
    const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
    for (const name of ['lsof', 'npm']) {
      fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho forbidden >> "$FORBIDDEN"\nexit 99\n', { mode: 0o700 });
    }
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), USE_HTTPS: '0',
      CRETLI_DATA_DIR: data, CRETLI_SUPERVISOR_TEST_MODE: '1', CRETLI_SUPERVISOR_TEST_LOCK: path.join(tree, 'data/supervisor.lock'),
      CRETLI_SUPERVISOR_TEST_CHILD: fixture, CRETLI_SUPERVISOR_BACKOFF_MS: '30', CRETLI_SUPERVISOR_MAX_BACKOFF_MS: '60',
      CRETLI_SUPERVISOR_CRASH_LIMIT: '3', CRETLI_SUPERVISOR_STOP_TIMEOUT_MS: '1000',
      STARTS: path.join(home, 'starts'), STOPS: path.join(home, 'stops'), ALERT_STORE: storePath, FORBIDDEN: path.join(home, 'forbidden') };
    const starts = () => { try { return fs.readFileSync(env.STARTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
    const next = async (count) => {
      const rows = await waitFor(() => starts().length === count && starts());
      for (const row of rows) pids.add(row.pid);
      return rows.at(-1);
    };
    const shellRestart = () => {
      const result = spawnSync('bash', [path.join(tree, 'scripts/task-restart-server.sh')], { cwd: home, env, encoding: 'utf8', timeout: 4000 });
      assert.equal(result.status, 0, result.stderr);
    };
    supervisor = spawn(process.execPath, [path.join(tree, 'scripts/cretli-supervisor.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    supervisor.stderr.on('data', (chunk) => { stderr += chunk; });
    const first = await next(1);
    process.kill(first.pid, 'SIGKILL');
    const second = await next(2);
    assert.notEqual(second.pid, first.pid); assert.equal(state().crashCount, 1);
    shellRestart();
    const third = await next(3);
    assert.notEqual(third.pid, second.pid); assert.equal(state().crashCount, 1);
    assert.ok(fs.readFileSync(env.STOPS, 'utf8').includes(String(second.pid)), 'listener received graceful supervisor stop');
    assert.equal(fs.existsSync(env.FORBIDDEN), false, 'shell never probes listeners or starts npm');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), String(third.pid));
    const duplicate = spawnSync(process.execPath, [path.join(tree, 'scripts/cretli-supervisor.mjs')], { env, encoding: 'utf8', timeout: 4000 });
    assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /lock/i);
    process.kill(third.pid, 'SIGKILL');
    const fourth = await next(4); process.kill(fourth.pid, 'SIGKILL');
    const loop = await waitFor(() => state()?.state === 'crash_loop' && state());
    assert.equal(loop.childPid, null); assert.equal(loop.crashCount, 3);
    assert.equal(starts().length, 4);
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    assert.equal(fs.existsSync(storePath), false, 'no producer runs while API is down');
    shellRestart();
    const recovered = await next(5);
    assert.equal(state().crashCount, 0, 'SIGUSR2 clears loop counter');
    assert.equal(recovered.status.active, true); assert.equal(recovered.status.stale, false);
    assert.equal(recovered.status.crashLoopAt, loop.crashLoopAt);
    assert.equal(recovered.alert.created, true);
    shellRestart();
    const repeated = await next(6);
    assert.equal(repeated.status.crashLoopAt, loop.crashLoopAt);
    assert.equal(repeated.alert.created, false, 'new server process deduplicates the persisted alert');
    const { listNotifications } = await import('../lib/notifications/notification-store.ts');
    assert.equal(listNotifications({}, { storePath }).items.length, 1);
    assert.equal(fs.existsSync(env.FORBIDDEN), false);
    supervisor.kill('SIGTERM');
    const [code] = await once(supervisor, 'exit'); assert.equal(code, 0, stderr);
  } finally {
    if (holder.listening) await new Promise((resolve) => holder.close(resolve));
    if (state()?.childPid) pids.add(state().childPid);
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill('SIGTERM');
      await Promise.race([once(supervisor, 'exit'), delay(1500)]);
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill('SIGKILL'); await once(supervisor, 'exit');
      }
    }
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
