import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createAntigravityLoginManager, parseAntigravityLoginUrl, registerAntigravityLoginRoutes } from '../antigravity-login.js';

const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=example&state=test';
function fixture(options = {}) {
  const children = [];
  const calls = [];
  const manager = createAntigravityLoginManager({
    cliFound: () => true, resolveCli: () => 'agy-test',
    spawnProcess: (bin, args, spawnOptions) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = (signal) => { child.signal = signal; };
      child.input = '';
      child.stdin.on('data', (chunk) => { child.input += String(chunk); });
      children.push(child); calls.push({ bin, args, spawnOptions });
      return child;
    },
    ...options,
  });
  return { manager, children, calls };
}

test('parses only Google OAuth URLs and never exposes arbitrary output', () => {
  assert.equal(parseAntigravityLoginUrl('secret text https://evil.example/auth'), '');
  assert.equal(parseAntigravityLoginUrl('https://accounts.google.com.evil.example/o/oauth2/auth'), '');
  assert.equal(parseAntigravityLoginUrl('https://accounts.google.com@evil.example/o/oauth2/auth'), '');
  assert.equal(parseAntigravityLoginUrl('https://accounts.google.com/o/oauth2/auth'), 'https://accounts.google.com/o/oauth2/auth');
  assert.equal(parseAntigravityLoginUrl(`\u001b[32mOpen: ${url}\u001b[0m\n`), url);
});

test('starts official login once, captures split output and submits code only to stdin', () => {
  const { manager, children, calls } = fixture();
  const started = manager.start();
  assert.equal(started.ok, true);
  assert.equal(manager.start().login.attemptId, started.login.attemptId);
  assert.equal(children.length, 1);
  assert.deepEqual(calls[0].args, ['acp', '--login']);
  const child = children[0];
  child.stdout.write('Open https://accounts.google.com/o/');
  child.stdout.write('oauth2/v2/auth?client_id=example&state=test\nPaste code:');
  assert.equal(manager.state().phase, 'waiting');
  assert.equal(manager.state().url, url);
  assert.equal(manager.complete(started.login.attemptId, '4/example-code').ok, true);
  assert.equal(manager.state().phase, 'submitting');
  assert.equal(child.input, '4/example-code\n');
  assert.ok(!JSON.stringify(manager.state()).includes('4/example-code'));
  assert.ok(!JSON.stringify(calls).includes('4/example-code'));
  child.exitCode = 0; child.emit('close', 0);
  assert.equal(manager.state().phase, 'completed');
  assert.equal(manager.state().url, '');
});

test('rejects stale, duplicate and multiline authorization codes', () => {
  const { manager, children } = fixture();
  const attempt = manager.start().login.attemptId;
  children[0].stdout.write(url + '\n');
  assert.equal(manager.complete('stale', 'code').ok, false);
  for (const code of ['', 'first\nsecond', 'a'.repeat(2049)]) assert.equal(manager.complete(attempt, code).ok, false);
  assert.equal(children[0].input, '');
  assert.equal(manager.complete(attempt, 'code').ok, true);
  assert.equal(manager.complete(attempt, 'second-code').ok, false);
  manager.cancel(attempt);
});

test('cancel/restart ignores late callbacks from old child; raw errors stay private', () => {
  const { manager, children } = fixture();
  const first = manager.start().login.attemptId;
  manager.cancel(first);
  assert.equal(children[0].signal, 'SIGTERM');
  assert.equal(manager.state().phase, 'cancelled');
  const second = manager.start().login.attemptId;
  children[0].stderr.write(url + '\nprivate-token');
  children[0].exitCode = 0; children[0].emit('close', 0);
  assert.equal(manager.state().phase, 'starting');
  manager.cancel(first);
  assert.equal(manager.state().attemptId, second);
  children[1].stderr.write('private-token');
  children[1].exitCode = 1; children[1].emit('close', 1);
  assert.equal(manager.state().phase, 'error');
  assert.ok(!JSON.stringify(manager.state()).includes('private-token'));
});

test('missing CLI, spawn failure and timeout are bounded failures', async () => {
  assert.equal(createAntigravityLoginManager({ cliFound: () => false }).start().ok, false);
  const spawnFailure = createAntigravityLoginManager({ cliFound: () => true, spawnProcess: () => { throw new Error('private details'); } });
  assert.equal(spawnFailure.start().ok, false);
  assert.ok(!spawnFailure.state().error.includes('private details'));
  const { manager, children } = fixture({ timeoutMs: 10 });
  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(manager.state().phase, 'error');
  assert.equal(children[0].signal, 'SIGTERM');
  children[0].exitCode = 0; children[0].emit('close', 0);
  assert.equal(manager.state().phase, 'error');
});

test('login routes reject widget/MCP access, disable caching and validate attempt', () => {
  const { manager } = fixture();
  const routes = new Map();
  const app = { get: (path, handler) => routes.set('GET ' + path, handler), post: (path, handler) => routes.set('POST ' + path, handler) };
  registerAntigravityLoginRoutes(app, manager);
  const invoke = (key, request) => {
    const result = { status: 200, body: null, headers: {} };
    const res = { status(code) { result.status = code; return this; }, set(name, value) { result.headers[name] = value; return this; }, json(body) { result.body = body; return this; } };
    routes.get(key)(request, res);
    return result;
  };
  for (const key of routes.keys()) {
    assert.equal(invoke(key, { widgetAccess: {} }).status, 403);
    assert.equal(invoke(key, { mcpIntegration: {} }).status, 403);
  }
  assert.equal(manager.state().phase, 'idle');
  const started = invoke('POST /api/antigravity/login/start', {});
  assert.equal(started.status, 200);
  assert.equal(started.headers['Cache-Control'], 'no-store');
  assert.equal(invoke('POST /api/antigravity/login/complete', { body: { attemptId: 'wrong', code: 'code' } }).status, 400);
  invoke('POST /api/antigravity/login/cancel', { body: { attemptId: started.body.login.attemptId } });
  assert.equal(manager.state().phase, 'cancelled');
});
