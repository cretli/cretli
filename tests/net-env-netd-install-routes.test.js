import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-netd-install-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = temp;
const auth = await import('../lib/auth.js');
const { registerNetEnvRoutes } = await import('../lib/routes/net-env-routes.js');
const { createHelperInstaller, buildElevationCommand, buildInstallerArgs } = await import('../lib/port-exposure/helper-installer.js');
const { createNetEnvService } = await import('../lib/net-env/index.js');

const STAGING = 'C:\\Users\\x\\AppData\\Local\\Temp\\cretli-netd-abc';
const fakeStage = async () => ({ ok: true, windowsDir: STAGING, cleanup() {} });
const service = createNetEnvService({ platform: 'linux', release: 'generic', executor: async () => '', getHost: () => '198.51.100.2', getBind: () => '127.0.0.1', getLanExposed: () => false });

async function withServer(installer, fn) {
  assert.equal(auth.setPassword('test-password-for-netd-install').ok, true);
  const session = auth.createSession();
  const app = express();
  app.use(express.json());
  registerNetEnvRoutes(app, { service, installer });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/net-env/netd`;
  const headers = { cookie: `cr_session=${encodeURIComponent(session)}`, 'content-type': 'application/json', 'x-cretli-csrf': auth.getCsrfTokenForSessionToken(session) };
  try { await fn(base, headers); } finally { await new Promise((r) => server.close(r)); }
}

test('install runs fixed server-built arguments and ignores client data', async () => {
  const calls = [];
  const installer = createHelperInstaller({ isWsl: () => true, stage: fakeStage, run: async (file, args) => { calls.push({ file, args }); return { stdout: '', code: 0 }; } });
  await withServer(installer, async (base, headers) => {
    assert.equal((await fetch(`${base}/install`, { method: 'POST' })).status, 401);
    const { 'x-cretli-csrf': _csrf, ...noCsrf } = headers;
    assert.equal((await fetch(`${base}/install`, { method: 'POST', headers: noCsrf, body: '{}' })).status, 403);
    const res = await fetch(`${base}/install?reinstall=1`, { method: 'POST', headers, body: JSON.stringify({ user: 'evil', args: ['-Command', 'calc'], path: 'C:\\x' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, state: 'success' });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.deepEqual(calls[0].args, buildElevationCommand('reinstall', STAGING));
  const script = calls[0].args[3];
  assert.match(script, /-Verb RunAs -Wait -PassThru/);
  assert.match(script, /-Reinstall/);
  assert.doesNotMatch(script, /evil|calc|C:\\x/);
  assert.deepEqual(buildInstallerArgs('uninstall', STAGING).slice(-2), ['-Yes', '-Uninstall']);
});

test('refuses on a host that is not WSL', async () => {
  let ran = false;
  const installer = createHelperInstaller({ isWsl: () => false, stage: fakeStage, run: async () => { ran = true; return { code: 0 }; } });
  await withServer(installer, async (base, headers) => {
    const res = await fetch(`${base}/install`, { method: 'POST', headers, body: '{}' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'not-wsl');
  });
  assert.equal(ran, false);
});

test('a parallel call gets busy while one run is in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const installer = createHelperInstaller({ isWsl: () => true, stage: fakeStage, run: async () => { await gate; return { code: 0 }; } });
  const first = installer.execute('install');
  await new Promise((r) => setTimeout(r, 10));
  const second = await installer.execute('uninstall');
  assert.equal(second.state, 'busy');
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).ok, true);
  assert.equal(installer.isBusy(), false);
});

test('exit code 1223 or a UAC cancel message maps to cancelled', async () => {
  for (const result of [{ code: 1223 }, { code: 1, stderr: 'The operation was canceled by the user.' }]) {
    const installer = createHelperInstaller({ isWsl: () => true, stage: fakeStage, run: async () => result });
    await withServer(installer, async (base, headers) => {
      const body = await (await fetch(`${base}/install`, { method: 'POST', headers, body: '{}' })).json();
      assert.equal(body.state, 'cancelled');
      assert.equal(body.ok, false);
    });
  }
});

test('timeout and other failures map to failed with the last log line', async () => {
  const timedOut = createHelperInstaller({ isWsl: () => true, stage: fakeStage, run: async () => ({ code: null, timedOut: true }) });
  assert.equal((await timedOut.execute('install')).state, 'failed');
  const failed = createHelperInstaller({ isWsl: () => true, stage: fakeStage, run: async () => ({ code: 1, stderr: 'a\nboom last line\n' }) });
  const r = await failed.execute('install');
  assert.deepEqual([r.state, r.message], ['failed', 'boom last line']);
  assert.equal(failed.isBusy(), false);
});

test('install-info exposes the installer hash and takes no input', async () => {
  const installer = createHelperInstaller({ isWsl: () => true, getSha: () => 'ab'.repeat(32) });
  await withServer(installer, async (base, headers) => {
    const body = await (await fetch(`${base}/install-info`, { headers })).json();
    assert.equal(body.sha256, 'ab'.repeat(32));
    assert.equal(body.supported, true);
  });
  fs.rmSync(temp, { recursive: true, force: true });
});
