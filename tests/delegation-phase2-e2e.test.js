import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'e2e-password-phase2';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

/**
 * @param {{ port: number, method: string, url: string, body?: object, cookie?: string, csrf?: string }} input
 */
function requestJson(input) {
  return new Promise((resolve, reject) => {
    const payload = input.body ? JSON.stringify(input.body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port: input.port,
      method: input.method,
      path: input.url,
      headers: {
        'content-type': 'application/json',
        ...(input.cookie ? { cookie: input.cookie } : {}),
        ...(input.csrf ? { 'x-cretli-csrf': input.csrf } : {}),
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += String(chunk); });
      res.on('end', () => {
        let json = {};
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          json = { raw };
        }
        const setCookie = res.headers['set-cookie'];
        const cookie = Array.isArray(setCookie)
          ? setCookie.map((row) => String(row).split(';')[0]).join('; ')
          : '';
        resolve({ status: res.statusCode, json, cookie, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    if (input.method === 'GET' && !payload) {
      // GET has no body.
    }
    req.end();
  });
}

function waitForOutput(child, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      if (pattern.test(buf)) {
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve(buf);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      reject(new Error(`Timed out waiting for ${pattern}\n${buf.slice(-2000)}`));
    }, timeoutMs).unref?.();
  });
}

function spawnServer({ port, dataDir }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      USE_HTTPS: '0',
      CRETLI_BIND: '127.0.0.1',
      CRETLI_DATA_DIR: dataDir,
      CURSOR_REMOTE_DATA_DIR: dataDir,
      CRETLI_FRONT_HMR: '0',
      CRETLI_TEST_CHAT_RUN_ADAPTER: '1',
      CURSOR_REMOTE_FRONT_HOT_FALLBACK: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function stopServer(child, signal = 'SIGTERM') {
  if (!child || child.killed || child.exitCode != null) return child?.exitCode ?? 0;
  child.kill(signal);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve('timeout');
    }, 10000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function pollRuntime(input) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < 15000) {
    last = await requestJson({
      port: input.port,
      method: 'GET',
      url: '/api/delegations/runtime',
      cookie: input.cookie,
    });
    const state = String(last?.json?.runtime?.lifecycle?.state || '');
    if (input.want === 'ready' && state === 'ready' && last.json?.runtime?.workerRunning) return last;
    if (input.want === 'degraded' && (state === 'degraded' || last.json?.runtime?.degraded === true)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-e2e-del-'));
const chatId = crypto.randomUUID();
fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({
  chats: [{
    id: chatId,
    title: 'E2E parent',
    cursorSessionId: crypto.randomUUID(),
    agentTransport: 'opencode',
    sdkMode: 'agent',
    workspaceFolder: dataDir,
    model: 'opencode/test',
    createdAt: new Date().toISOString(),
  }],
}, null, 2));

const children = [];
try {
  const port = await getFreePort();
  const child = spawnServer({ port, dataDir });
  children.push(child);
  await waitForOutput(child, /Cretli: http:\/\/localhost:/);
  const setup = await requestJson({
    port,
    method: 'POST',
    url: '/api/setup',
    body: { password: PASSWORD },
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.json));
  const session = { cookie: setup.cookie, csrf: setup.json.csrfToken };
  const health = await pollRuntime({ port, cookie: session.cookie, want: 'ready' });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.runtime.processAlive, true);
  assert.equal(health.json.runtime.workerRunning, true);
  assert.notEqual(health.json.runtime.lifecycle.state, 'initializing');
  const page = await requestJson({
    port,
    method: 'GET',
    url: '/',
    cookie: session.cookie,
  });
  assert.match(String(page.raw || ''), /delegation-center-list/);
  const caps = await requestJson({
    port,
    method: 'GET',
    url: '/api/delegations/executors',
    cookie: session.cookie,
  });
  assert.equal(caps.json.ok, true);
  assert.ok(Array.isArray(caps.json.capabilities));
  const started = await requestJson({
    port,
    method: 'POST',
    url: `/api/chats/${chatId}/delegations`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {
      sourceKind: 'text',
      taskText: 'isolated e2e job',
      executor: { transport: 'opencode', model: 'opencode/test' },
      idempotencyKey: crypto.randomUUID(),
    },
  });
  assert.equal(started.json.ok, true, JSON.stringify(started.json));
  const jobId = started.json.delegation.id;
  const list = await requestJson({
    port,
    method: 'GET',
    url: '/api/delegations',
    cookie: session.cookie,
  });
  assert.equal(list.json.delegations.length >= 1, true);
  assert.equal(list.json.delegations[0].planMarkdown, undefined);
  const detail = await requestJson({
    port,
    method: 'GET',
    url: `/api/delegations/${jobId}?field=summary`,
    cookie: session.cookie,
  });
  assert.equal(detail.json.delegation.id, jobId);
  assert.equal(detail.json.delegation.planMarkdown, undefined);
  const cancelled = await requestJson({
    port,
    method: 'POST',
    url: `/api/delegations/${jobId}/cancel`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  assert.equal(cancelled.json.ok, true, JSON.stringify(cancelled.json));
  const retried = await requestJson({
    port,
    method: 'POST',
    url: `/api/delegations/${jobId}/retry`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  assert.equal(retried.json.ok, true, JSON.stringify(retried.json));
  const retryDelivery = await requestJson({
    port,
    method: 'POST',
    url: `/api/delegations/${jobId}/retry-delivery`,
    cookie: session.cookie,
    csrf: session.csrf,
    body: {},
  });
  assert.equal(retryDelivery.status, 400, JSON.stringify(retryDelivery.json));
  assert.equal(retryDelivery.json.code, 'mailbox_id_required');

  const port2 = await getFreePort();
  const second = spawnServer({ port: port2, dataDir });
  children.push(second);
  await waitForOutput(second, /Cretli: http:\/\/localhost:/);
  const login2 = await requestJson({
    port: port2,
    method: 'POST',
    url: '/api/login',
    body: { password: PASSWORD },
  });
  assert.equal(login2.status, 200, JSON.stringify(login2.json));
  const health2 = await pollRuntime({ port: port2, cookie: login2.cookie, want: 'degraded' });
  assert.equal(health2.json.runtime.processAlive, true);
  assert.equal(health2.json.runtime.lifecycle.state, 'degraded');
  assert.match(String(health2.json.runtime.code || health2.json.runtime.lifecycle?.error?.code || ''), /DELEGATION_OWNER_LOCKED|OWNER/);
  const denied = await requestJson({
    port: port2,
    method: 'POST',
    url: `/api/chats/${chatId}/delegations`,
    cookie: login2.cookie,
    csrf: login2.json.csrfToken,
    body: {
      sourceKind: 'text',
      taskText: 'second writer',
      executor: { transport: 'opencode', model: 'opencode/test' },
      idempotencyKey: crypto.randomUUID(),
    },
  });
  assert.equal(denied.json.ok, false);
  assert.equal(denied.json.code, 'runtime_not_ready');
  const secondExit = await stopServer(second, 'SIGTERM');
  assert.notEqual(secondExit, 'timeout');

  const termExit = await stopServer(child, 'SIGTERM');
  assert.notEqual(termExit, 'timeout');

  const port3 = await getFreePort();
  const restarted = spawnServer({ port: port3, dataDir });
  children.push(restarted);
  await waitForOutput(restarted, /Cretli: http:\/\/localhost:/);
  const login3 = await requestJson({
    port: port3,
    method: 'POST',
    url: '/api/login',
    body: { password: PASSWORD },
  });
  assert.equal(login3.status, 200, JSON.stringify(login3.json));
  const health3 = await pollRuntime({ port: port3, cookie: login3.cookie, want: 'ready' });
  assert.equal(health3.json.runtime.workerRunning, true);
  assert.equal(health3.json.runtime.lifecycle.state, 'ready');
  const afterRestart = await requestJson({
    port: port3,
    method: 'GET',
    url: '/api/delegations',
    cookie: login3.cookie,
  });
  const sameJobs = afterRestart.json.delegations.filter((row) => row.id === jobId);
  assert.equal(sameJobs.length, 1);
  await stopServer(restarted, 'SIGTERM');
} finally {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('delegation-phase2-e2e.test.js OK');
