import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { installAntigravityCli, registerAntigravityInstallRoute, ANTIGRAVITY_INSTALL_SCRIPT_URL } from '../antigravity-install.js';
import { resolveAntigravityCli, defaultAntigravityInstallPath } from '../antigravity-config.js';

const SCRIPT = '#!/bin/bash\nset -euo pipefail\necho ok\n';

function tempHome(t, { withBinary = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (withBinary) {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  }
  return home;
}

const okFetch = (body = SCRIPT, status = 200) => async (url) => {
  assert.equal(url, ANTIGRAVITY_INSTALL_SCRIPT_URL);
  return { ok: status >= 200 && status < 300, status, text: async () => body };
};

function fakeSpawn({ code = 0, stderr = '', onSpawn } = {}) {
  const calls = [];
  const impl = (cmd, args, options) => {
    calls.push({ cmd, args, options, script: fs.readFileSync(args[0], 'utf8') });
    onSpawn?.();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      if (stderr) child.stderr.write(stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { impl, calls };
}

test('runs the fetched official script with bash, no arguments, and reports the installed binary', async (t) => {
  const home = tempHome(t);
  const spawn = fakeSpawn({ onSpawn: () => {
    // The real installer writes ~/.local/bin/agy; emulate it.
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'agy'), '#!/bin/sh\n', { mode: 0o755 });
  } });
  const result = await installAntigravityCli({ fetchImpl: okFetch(), spawnImpl: spawn.impl, platform: 'linux', env: { HOME: home, PATH: '' } });
  assert.deepEqual(result, { ok: true, binPath: path.join(home, '.local', 'bin', 'agy') });
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, 'bash');
  assert.equal(spawn.calls[0].args.length, 1, 'the bootstrapper rejects unknown flags');
  assert.equal(spawn.calls[0].script, SCRIPT);
  assert.equal(fs.existsSync(path.dirname(spawn.calls[0].args[0])), false, 'the temp script is removed');
});

test('Windows is refused without downloading anything', async () => {
  let fetched = false;
  const result = await installAntigravityCli({ fetchImpl: async () => { fetched = true; }, platform: 'win32' });
  assert.equal(result.code, 'unsupported_platform');
  assert.equal(fetched, false);
});

test('a failed download or an unexpected body never runs anything', async (t) => {
  const spawn = fakeSpawn();
  const env = { HOME: tempHome(t) };
  assert.equal((await installAntigravityCli({ fetchImpl: okFetch(SCRIPT, 503), spawnImpl: spawn.impl, platform: 'linux', env })).code, 'download_failed');
  assert.equal((await installAntigravityCli({ fetchImpl: okFetch('<html>captive portal</html>'), spawnImpl: spawn.impl, platform: 'linux', env })).code, 'unexpected_installer');
  assert.equal((await installAntigravityCli({ fetchImpl: async () => { throw new Error('offline'); }, spawnImpl: spawn.impl, platform: 'darwin', env })).code, 'download_failed');
  assert.equal(spawn.calls.length, 0);
});

test('installer failure returns the tail of its output; a clean exit without a binary is reported', async (t) => {
  const env = { HOME: tempHome(t) };
  const failed = await installAntigravityCli({ fetchImpl: okFetch(), spawnImpl: fakeSpawn({ code: 1, stderr: 'line1\nSecurity Halt: checksum mismatch\n' }).impl, platform: 'linux', env });
  assert.equal(failed.code, 'installer_failed');
  assert.match(failed.error, /checksum mismatch/);
  const missing = await installAntigravityCli({ fetchImpl: okFetch(), spawnImpl: fakeSpawn().impl, platform: 'linux', env });
  assert.equal(missing.code, 'binary_missing');
});

test('resolution falls back to the installer location when agy is not on PATH', (t) => {
  const home = tempHome(t, { withBinary: true });
  assert.equal(defaultAntigravityInstallPath({ HOME: home }), path.join(home, '.local', 'bin', 'agy'));
  assert.equal(resolveAntigravityCli({ HOME: home, PATH: '' }, {}), path.join(home, '.local', 'bin', 'agy'));
  assert.equal(resolveAntigravityCli({ HOME: tempHome(t), PATH: '' }, {}), 'agy', 'nothing installed: keep the PATH name');
  assert.equal(resolveAntigravityCli({ HOME: home, PATH: '', ANTIGRAVITY_BIN: '/opt/agy' }, {}), '/opt/agy', 'explicit configuration wins');
  assert.equal(resolveAntigravityCli({ HOME: home, PATH: '' }, { antigravityBin: '/srv/agy' }), '/srv/agy');
});

test('the install route refuses widget and MCP callers and serialises runs', async () => {
  const routes = {};
  registerAntigravityInstallRoute({ post: (url, handler) => { routes[url] = handler; } }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, binPath: '/x/agy' };
  });
  const handler = routes['/api/antigravity/install'];
  const response = () => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    return res;
  };
  const widget = response();
  await handler({ widgetAccess: true }, widget);
  assert.equal(widget.statusCode, 403);
  const first = response();
  const second = response();
  await Promise.all([handler({}, first), handler({}, second)]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
});
