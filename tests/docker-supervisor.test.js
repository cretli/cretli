import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import yaml from 'js-yaml';

const root = path.resolve(import.meta.dirname, '..');
const healthcheck = path.join(root, 'scripts/docker-healthcheck.mjs');

for (const mode of [undefined, '0', '1']) {
  test(`entrypoint selects the expected command with supervisor=${mode}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-docker-entry-'));
    try {
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.mkdirSync(path.join(dir, 'public/dist/app'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'public/dist/app/app.bundle.js'), '');
      fs.writeFileSync(path.join(dir, '.env'), '');
      const stub = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: require('path').basename(process.argv[1]), args: process.argv.slice(2), token: process.env.CRETLI_SETUP_TOKEN, bind: process.env.CRETLI_BIND, cwd: process.cwd() }) + '\\n');
if (process.argv[2] === '-e') process.stdout.write('generated-test-token');
`;
      for (const command of ['node', 'npm']) {
        // Use the absolute runtime to avoid recursively invoking the PATH stub.
        fs.writeFileSync(path.join(dir, 'bin', command), stub.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o755 });
      }
      const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, CRETLI_APP_DIR: dir,
        COMMAND_LOG: path.join(dir, 'commands.jsonl') };
      delete env.CRETLI_DOCKER_SUPERVISOR;
      delete env.CRETLI_SETUP_TOKEN;
      delete env.CRETLI_BIND;
      if (mode !== undefined) env.CRETLI_DOCKER_SUPERVISOR = mode;
      const result = spawnSync('sh', [path.join(root, 'scripts/docker-entrypoint.sh')], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      const calls = fs.readFileSync(env.COMMAND_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(calls[1].args, ['--import', './lib/register-boot-env.js', `--env-file=${dir}/.env`, 'scripts/generate-ssl-cert.js', '--if-needed']);
      const last = calls.at(-1);
      assert.equal(last.command, mode === '1' ? 'node' : 'npm');
      assert.deepEqual(last.args, mode === '1' ? ['scripts/cretli-supervisor.mjs'] : ['start']);
      assert.equal(last.token, 'generated-test-token');
      assert.equal(last.bind, '0.0.0.0');
      assert.equal(last.cwd, dir);
      assert.equal(calls.length, 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

async function runProbe(port, useHttps) {
  const child = spawn(process.execPath, [healthcheck], {
    env: { ...process.env, PORT: String(port), USE_HTTPS: useHttps }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null, stderr);
  return code;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('healthcheck probes health path and rejects non-success and closed ports', async () => {
  let status = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/health');
    res.writeHead(status).end('ok');
  });
  const port = await listen(server);
  try {
    assert.equal(await runProbe(port, '0'), 0);
    status = 503;
    assert.equal(await runProbe(port, '0'), 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  assert.equal(await runProbe(port, '0'), 1);
});

test('healthcheck times out on a hanging server', { timeout: 15_000 }, async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  try { assert.equal(await runProbe(port, '0'), 1); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('healthcheck accepts a self-signed HTTPS certificate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-docker-tls-'));
  let server;
  try {
    const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { encoding: 'utf8' });
    assert.equal(cert.status, 0, cert.stderr);
    server = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, (_req, res) => res.end('ok'));
    const port = await listen(server);
    assert.equal(await runProbe(port, '1'), 0);
    assert.equal(await runProbe(port, 'true'), 0);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Compose supervisor settings are opt-in and allow graceful shutdown', () => {
  const override = yaml.load(fs.readFileSync(path.join(root, 'docker-compose.supervisor.yml'), 'utf8')).services.cretli;
  assert.equal(override.environment.CRETLI_DOCKER_SUPERVISOR, '1');
  assert.equal(override.init, true);
  assert.equal(override.stop_grace_period, '60s');
  assert.deepEqual(override.healthcheck, { test: ['CMD', 'node', 'scripts/docker-healthcheck.mjs'],
    start_period: '150s', interval: '30s', timeout: '15s', retries: 3 });
  const base = yaml.load(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')).services.cretli;
  assert.equal(base.environment.CRETLI_DOCKER_SUPERVISOR, undefined);
  assert.equal(base.healthcheck, undefined);
  assert.equal(base.restart, 'unless-stopped');
});
