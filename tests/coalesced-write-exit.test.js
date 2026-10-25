import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const childScript = path.resolve('tests/helpers/coalesced-exit-child.js');
const serverSource = fs.readFileSync(path.resolve('server.js'), 'utf8');
const shutdownFallbackMatch = serverSource.match(/setTimeout\(\(\) => process\.exit\(1\), (\d+)\)/);
assert.ok(shutdownFallbackMatch, 'server shutdown fallback must remain configured');
const SHUTDOWN_FALLBACK_MS = Number(shutdownFallbackMatch[1]);

async function getFreePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

function waitForOutput(child, pattern, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += String(chunk);
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve(output);
    };
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      reject(new Error(`Timed out waiting for server output:\n${output.slice(-2000)}`));
    }, timeoutMs);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

test('a direct process.exit flushes a pending write synchronously', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-exit-flush-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'direct.json');
  const result = spawnSync(process.execPath, [childScript, file, 'direct']);
  assert.equal(result.status, 7, result.stderr.toString());
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode: 'direct' });
});

test('the unref timer lets an idle child exit and its exit hook persists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-unref-flush-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'natural.json');
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [childScript, file, 'natural'], { timeout: 2000 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.ok(Date.now() - startedAt < 2000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode: 'natural' });
});

test('SIGTERM flushes a pending write before child exit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-signal-flush-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'signal.json');
  const child = spawn(process.execPath, [childScript, file, 'signal'], { stdio: 'pipe' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill('SIGTERM');
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode: 'signal' });
});

test('real shutdownDelegationAndExit flushes pending data within its configured bound', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-real-shutdown-flush-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shutdown.json');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(await getFreePort()),
      USE_HTTPS: '0',
      CRETLI_BIND: '127.0.0.1',
      CRETLI_DATA_DIR: dir,
      CURSOR_REMOTE_DATA_DIR: dir,
      CRETLI_TEST_CHAT_RUN_ADAPTER: '1',
      CRETLI_TEST_COALESCED_SHUTDOWN_FILE: file,
      CURSOR_REMOTE_FRONT_HOT_FALLBACK: '0',
      CRETLI_DELEGATION_EMPTY_FAVORITES: 'all',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
  });
  await waitForOutput(child, /Cretli: http:\/\/localhost:/);
  assert.equal(fs.existsSync(file), false, 'write must still be pending before shutdown');
  const shutdownStartedAt = Date.now();
  child.kill('SIGTERM');
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('server exceeded the configured shutdown fallback'));
    }, SHUTDOWN_FALLBACK_MS);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 0, signal: null });
  assert.ok(Date.now() - shutdownStartedAt < SHUTDOWN_FALLBACK_MS);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { source: 'shutdown-test' });
});

test('server registers the exit flush before early boot exits', () => {
  assert.ok(serverSource.indexOf("process.on('exit'") < serverSource.indexOf('process.exit(1)'));
  assert.match(serverSource, /shutdownDelegationAndExit[\s\S]*flushCoalescedWrites\(\)[\s\S]*process\.exit\(code\)/);
});
