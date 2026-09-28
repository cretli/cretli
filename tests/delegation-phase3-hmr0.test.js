import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFreePort,
  requestJson,
  stopServer,
  waitForOutput,
} from './helpers/delegation-isolated-http.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveBundle = path.join(projectRoot, 'public', 'dist', 'app', 'index.bundle.js');
const liveMtime = fs.existsSync(liveBundle) ? fs.statSync(liveBundle).mtimeMs : 0;
const liveHead = fs.existsSync(liveBundle) ? fs.readFileSync(liveBundle).subarray(0, 80).toString('utf8') : '';

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-phase3-hmr0-'));
const publicDir = path.join(isolatedRoot, 'public');
const outDir = path.join(publicDir, 'dist', 'app');
const dataDir = path.join(isolatedRoot, 'data');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.copyFileSync(path.join(projectRoot, 'public', 'index.html'), path.join(publicDir, 'index.html'));
if (fs.existsSync(path.join(projectRoot, 'public', 'login.html'))) {
  fs.copyFileSync(path.join(projectRoot, 'public', 'login.html'), path.join(publicDir, 'login.html'));
}
fs.writeFileSync(path.join(outDir, 'index.bundle.js'), '/* stale dist without settings delegations */\n', 'utf8');

const webpackBin = path.join(projectRoot, 'node_modules', '.bin', 'webpack');
const built = spawnSync(webpackBin, [
  '--config', 'webpack.dev.js',
  '--no-watch',
  '--output-path', outDir,
], {
  cwd: path.join(projectRoot, 'app_front'),
  env: {
    ...process.env,
    CRETLI_FRONT_HMR: '0',
    CURSOR_REMOTE_FRONT_HMR: '0',
  },
  encoding: 'utf8',
});
assert.equal(built.status, 0, built.stderr || built.stdout);
const bundlePath = path.join(outDir, 'index.bundle.js');
const cssPath = path.join(outDir, 'index.css');
assert.equal(fs.existsSync(bundlePath), true);
assert.equal(fs.existsSync(cssPath), true);
const js = fs.readFileSync(bundlePath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
assert.match(js, /delegation-center-list/);
assert.match(css, /delegation-center/);
assert.equal(js.includes('/* stale dist without settings delegations */'), false);
if (fs.existsSync(liveBundle)) {
  assert.equal(fs.statSync(liveBundle).mtimeMs, liveMtime);
  assert.equal(fs.readFileSync(liveBundle).subarray(0, 80).toString('utf8'), liveHead);
}

const port = await getFreePort();
const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    PORT: String(port),
    USE_HTTPS: '0',
    CRETLI_BIND: '127.0.0.1',
    CRETLI_DATA_DIR: dataDir,
    CURSOR_REMOTE_DATA_DIR: dataDir,
    CRETLI_PUBLIC_DIR: publicDir,
    CRETLI_FRONT_HMR: '0',
    CRETLI_TEST_CHAT_RUN_ADAPTER: '1',
    CURSOR_REMOTE_FRONT_HOT_FALLBACK: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  await waitForOutput(child, /Cretli: http:\/\/localhost:/, 40000);
  const servedJs = await requestJson({ port, method: 'GET', url: '/dist/app/index.bundle.js' });
  const servedCss = await requestJson({ port, method: 'GET', url: '/dist/app/index.css' });
  assert.match(String(servedJs.raw || ''), /delegation-center-list/);
  assert.match(String(servedCss.raw || ''), /delegation-center/);
  assert.equal(String(servedJs.raw || '').includes('/* stale dist without settings delegations */'), false);
  const setup = await requestJson({
    port,
    method: 'POST',
    url: '/api/setup',
    body: { password: 'e2e-password-phase3-hmr0' },
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.json));
  const page = await requestJson({
    port,
    method: 'GET',
    url: '/',
    cookie: setup.cookie,
  });
  assert.match(String(page.raw || ''), /delegation-center-list/);
  const settings = await requestJson({
    port,
    method: 'GET',
    url: '/settings/delegations',
    cookie: setup.cookie,
  });
  assert.match(String(settings.raw || ''), /data-settings-tab="delegations"/);
  assert.match(String(settings.raw || ''), /delegation-center-list/);
} finally {
  await stopServer(child, 'SIGTERM');
  fs.rmSync(isolatedRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  gate: 'D5',
  command: 'CRETLI_FRONT_HMR=0 ../node_modules/.bin/webpack --config webpack.dev.js --no-watch',
  cwd: 'app_front',
  exit: built.status,
  liveDistUnchanged: true,
  isolatedPort: port,
}));
console.log('delegation-phase3-hmr0.test.js OK');
