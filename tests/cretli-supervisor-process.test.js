import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { processAlive } from '../lib/cretli-supervisor.js';

const entry = new URL('../scripts/cretli-supervisor.mjs', import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(20); }
  throw new Error(`Timed out: ${description}`);
}

test('isolated supervisor restarts a killed child, handles request and stops both', { timeout: 25_000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-process-'));
  const lock = path.join(temporary, 'lock/supervisor.lock');
  const dataDir = path.join(temporary, 'state');
  const fixture = path.join(temporary, 'child.mjs');
  const portHolder = net.createServer();
  await new Promise((resolve) => portHolder.listen(0, '127.0.0.1', resolve));
  const port = portHolder.address().port;
  assert.notEqual(port, 3011);
  await new Promise((resolve) => portHolder.close(resolve));
  fs.writeFileSync(fixture, `import http from 'node:http';
import fs from 'node:fs';
const server = http.createServer((req, res) => { res.end('ok'); });
server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  fs.writeFileSync(process.env.FIXTURE_READY, JSON.stringify({ pid: process.pid,
    supervisor: process.env.CRETLI_SUPERVISOR_PID, ripgrep: process.env.CURSOR_RIPGREP_PATH,
    log: process.env.CRETLI_SERVER_LOG_FILE, nodeEnv: process.env.NODE_ENV, token: process.env.CRETLI_SETUP_TOKEN, bind: process.env.CRETLI_BIND }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
  const env = { ...process.env, CRETLI_SUPERVISOR_TEST_MODE: '1', CRETLI_SUPERVISOR_TEST_LOCK: lock,
    CRETLI_SUPERVISOR_TEST_CHILD: fixture, CRETLI_DATA_DIR: dataDir, PORT: String(port), USE_HTTPS: '0', CRETLI_SETUP_TOKEN: 'supervisor-test-token', CRETLI_BIND: '0.0.0.0',
    CRETLI_SUPERVISOR_BACKOFF_MS: '40', CRETLI_SUPERVISOR_PROBE_INTERVAL_MS: '100',
    CRETLI_SUPERVISOR_STOP_TIMEOUT_MS: '1000', FIXTURE_READY: path.join(temporary, 'ready.json') };
  delete env.NODE_ENV;
  let supervisor; const childPids = new Set(); let stderr = '';
  const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'supervisor-state.json'), 'utf8')); } catch { return null; } };
  const ready = () => { try { return JSON.parse(fs.readFileSync(env.FIXTURE_READY, 'utf8')); } catch { return null; } };
  try {
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'supervisor-state.json'), 'null');
    supervisor = spawn(process.execPath, [entry.pathname], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    supervisor.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = once(supervisor, 'exit');
    const first = await waitFor(() => ready(), 'first child ready'); childPids.add(first.pid);
    assert.equal(first.supervisor, String(supervisor.pid)); assert.equal(first.ripgrep, './node_modules/.bin/rg');
    assert.equal(first.token, 'supervisor-test-token'); assert.equal(first.bind, '0.0.0.0');
    assert.equal(first.nodeEnv, undefined); assert.equal(first.log, path.join(dataDir, 'supervisor.log'));
    const duplicate = spawnSync(process.execPath, [entry.pathname], { env, encoding: 'utf8', timeout: 4000 });
    assert.equal(duplicate.status, 1, duplicate.stderr); assert.match(duplicate.stderr, /lock/i);
    assert.equal(readState().childPid, first.pid); assert.ok(processAlive(first.pid));
    const controlPath = path.join(dataDir, 'supervisor-control.json');
    fs.writeFileSync(controlPath, JSON.stringify({ pid: supervisor.pid, enabled: false }));
    await waitFor(() => readState()?.enabled === false, 'supervision disabled without stopping child');
    assert.ok(processAlive(first.pid));
    // Stale requests for a previous supervisor cannot change the current policy.
    fs.writeFileSync(controlPath, JSON.stringify({ pid: supervisor.pid + 1, enabled: true }));
    await delay(600);
    assert.equal(readState().enabled, false);
    fs.writeFileSync(controlPath, JSON.stringify({ pid: supervisor.pid, enabled: true }));
    await waitFor(() => readState()?.enabled === true, 'supervision enabled');
    assert.equal(readState().childPid, first.pid);
    assert.match(fs.readFileSync(path.join(dataDir, 'supervisor-events.log'), 'utf8'), /enabled=false/);
    process.kill(first.pid, 'SIGKILL');
    const second = await waitFor(() => { const r = ready(); return r && r.pid !== first.pid && r; }, 'replacement after SIGKILL');
    childPids.add(second.pid); assert.equal(readState().crashCount, 1);
    const requestEnv = { ...env }; delete requestEnv.CRETLI_DATA_DIR;
    const request = spawnSync(process.execPath, [entry.pathname, 'request-restart'], { env: requestEnv, encoding: 'utf8', timeout: 4000 });
    assert.equal(request.status, 0, request.stderr);
    const third = await waitFor(() => { const r = ready(); return r && r.pid !== second.pid && r; }, 'requested replacement');
    childPids.add(third.pid); assert.equal(readState().crashCount, 1);
    assert.equal(processAlive(second.pid), false);
    // A filesystem error during child events and retries must not kill supervision.
    const statePath = path.join(dataDir, 'supervisor-state.json');
    fs.unlinkSync(statePath); fs.mkdirSync(statePath);
    process.kill(third.pid, 'SIGKILL');
    const fourth = await waitFor(() => { const r = ready(); return r && r.pid !== third.pid && r; }, 'replacement despite state write failure');
    childPids.add(fourth.pid);
    await waitFor(() => stderr.includes('State write failed:'), 'state error on stderr');
    assert.ok(processAlive(supervisor.pid)); assert.ok(processAlive(fourth.pid));
    supervisor.kill('SIGTERM');
    const [code, signal] = await exit; assert.equal(code, 0, stderr); assert.equal(signal, null);
    assert.equal(processAlive(fourth.pid), false); assert.equal(fs.existsSync(lock), false);
    assert.ok(fs.statSync(statePath).isDirectory());
    const absent = spawnSync(process.execPath, [entry.pathname, 'request-restart'], { env: requestEnv, timeout: 4000 });
    assert.equal(absent.status, 3);
    fs.mkdirSync(lock);
    const unreadable = spawnSync(process.execPath, [entry.pathname, 'request-restart'], { env: requestEnv, timeout: 4000 });
    assert.equal(unreadable.status, 4);
    fs.rmdirSync(lock);
  } finally {
    const current = readState()?.childPid; if (current) childPids.add(current);
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill('SIGTERM');
      await Promise.race([once(supervisor, 'exit'), delay(1500)]);
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    }
    for (const pid of childPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('request-stop makes the real supervisor SIGTERM its child and exit without respawning', { timeout: 25_000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-stop-'));
  const lock = path.join(temporary, 'lock/supervisor.lock');
  const dataDir = path.join(temporary, 'state');
  const fixture = path.join(temporary, 'child.mjs');
  const portHolder = net.createServer();
  await new Promise((resolve) => portHolder.listen(0, '127.0.0.1', resolve));
  const port = portHolder.address().port;
  await new Promise((resolve) => portHolder.close(resolve));
  // Each start appends a line; SIGTERM leaves a marker so the test can tell who signalled the child.
  fs.writeFileSync(fixture, `import http from 'node:http';
import fs from 'node:fs';
const server = http.createServer((req, res) => { res.end('ok'); });
server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  fs.appendFileSync(process.env.FIXTURE_STARTS, process.pid + '\\n');
});
process.on('SIGTERM', () => { fs.writeFileSync(process.env.FIXTURE_TERM, 'SIGTERM'); server.close(() => process.exit(0)); });
`);
  const starts = path.join(temporary, 'starts.txt');
  const termMarker = path.join(temporary, 'term.txt');
  const env = { ...process.env, CRETLI_SUPERVISOR_TEST_MODE: '1', CRETLI_SUPERVISOR_TEST_LOCK: lock,
    CRETLI_SUPERVISOR_TEST_CHILD: fixture, CRETLI_DATA_DIR: dataDir, PORT: String(port), USE_HTTPS: '0',
    CRETLI_SUPERVISOR_BACKOFF_MS: '40', CRETLI_SUPERVISOR_PROBE_INTERVAL_MS: '100',
    CRETLI_SUPERVISOR_STOP_TIMEOUT_MS: '1000', FIXTURE_STARTS: starts, FIXTURE_TERM: termMarker };
  delete env.NODE_ENV;
  let supervisor; let stderr = ''; let childPid;
  const startedPids = () => { try { return fs.readFileSync(starts, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  try {
    supervisor = spawn(process.execPath, [entry.pathname], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    supervisor.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = once(supervisor, 'exit');
    await waitFor(() => startedPids().length === 1, 'child started');
    childPid = Number(startedPids()[0]);
    const requestEnv = { ...env }; delete requestEnv.CRETLI_DATA_DIR;
    const stop = spawnSync(process.execPath, [entry.pathname, 'request-stop'], { env: requestEnv, encoding: 'utf8', timeout: 4000 });
    assert.equal(stop.status, 0, stop.stderr);
    const [code, signal] = await exit; assert.equal(code, 0, stderr); assert.equal(signal, null);
    assert.equal(fs.readFileSync(termMarker, 'utf8'), 'SIGTERM');
    assert.equal(processAlive(childPid), false);
    await delay(300);
    assert.deepEqual(startedPids(), [String(childPid)], 'no replacement child after stop');
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'supervisor-state.json'), 'utf8'));
    assert.equal(state.state, 'stopped');
    assert.equal(fs.existsSync(lock), false);
    const absent = spawnSync(process.execPath, [entry.pathname, 'request-stop'], { env: requestEnv, encoding: 'utf8', timeout: 4000 });
    assert.equal(absent.status, 3); assert.match(absent.stderr, /No running Cretli supervisor/);
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
