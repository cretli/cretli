import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test, { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  acquireDelegationOwnerLock, releaseDelegationOwnerLock, getDelegationOwnerLockPaths,
  getProcessStartTime, isLockSocketLive, isStoredOwnerLive,
} from '../lib/delegation-owner-lock.js';

test.after(removeIsolatedDataDir);

const lockUrl = new URL('../lib/delegation-owner-lock.js', import.meta.url).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startOwner(dir) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireDelegationOwnerLock } from ${JSON.stringify(lockUrl)};
    const lock = acquireDelegationOwnerLock({ dataDir: process.argv[1] });
    lock.server.on('listening', () => process.stdout.write('ready'));
    setInterval(() => {}, 1000);
  `, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error('owner exited: ' + code); }),
  ]);
  return child;
}

async function stopOwner(child) {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('diagnostic probe detects live, missing, regular and stale sockets asynchronously', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-probe-'));
  const sock = path.join(dir, 's');
  const server = net.createServer((socket) => socket.end());
  try {
    assert.equal(await isLockSocketLive(''), false);
    assert.equal(await isLockSocketLive(sock), false);
    fs.writeFileSync(sock, 'regular');
    assert.equal(await isLockSocketLive(sock), false);
    fs.unlinkSync(sock);
    server.listen(sock);
    await once(server, 'listening');
    assert.equal(await isLockSocketLive(sock), true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await isLockSocketLive(sock), false);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PID/start-time policy refuses unknown owners and reclaims dead or reused PIDs', () => {
  assert.equal(isStoredOwnerLive(null), true);
  assert.equal(isStoredOwnerLive({ pid: process.pid }), true);
  assert.equal(isStoredOwnerLive({ pid: process.pid, pidStart: getProcessStartTime(process.pid) }), true);
  assert.equal(isStoredOwnerLive({ pid: 2147483647 }), false);
  if (process.platform === 'linux') assert.equal(isStoredOwnerLive({ pid: process.pid, pidStart: 'different' }), false);
  for (const meta of [null, { pid: 2147483647 }, ...(process.platform === 'linux' ? [{ pid: process.pid, pidStart: 'different' }] : [])]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-owner-'));
    const paths = getDelegationOwnerLockPaths({ dataDir: dir });
    fs.mkdirSync(paths.lockDir);
    if (meta) fs.writeFileSync(paths.metaPath, JSON.stringify(meta));
    try {
      if (!meta) assert.throws(() => acquireDelegationOwnerLock({ dataDir: dir }), { code: 'DELEGATION_OWNER_LOCKED' });
      else assert.equal(acquireDelegationOwnerLock({ dataDir: dir }).pid, process.pid);
    } finally {
      releaseDelegationOwnerLock({ dataDir: dir });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('live owner refusal leaves timer gaps below 20 ms (median of five); stale socket does not block takeover', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-owner-'));
  let child = await startOwner(dir);
  try {
    const sock = getDelegationOwnerLockPaths({ dataDir: dir }).sockPath;
    assert.equal(await isLockSocketLive(sock), true);
    const gaps = [];
    for (let run = 0; run < 5; run += 1) {
      let previous = performance.now();
      let largest = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        largest = Math.max(largest, now - previous);
        previous = now;
      }, 1);
      try {
        await pause(5);
        assert.throws(() => acquireDelegationOwnerLock({ dataDir: dir }), { code: 'DELEGATION_OWNER_LOCKED' });
        await pause(5);
      } finally { clearInterval(timer); }
      gaps.push(largest);
    }
    const median = gaps.sort((a, b) => a - b)[2];
    assert.ok(median < 20, `median timer gap ${median} ms; samples ${gaps}`);
    await stopOwner(child);
    child = null;
    assert.equal(fs.statSync(sock).isSocket(), true, 'killed owner leaves its socket file');
    assert.equal(await isLockSocketLive(sock), false);
    assert.equal(acquireDelegationOwnerLock({ dataDir: dir }).pid, process.pid);
  } finally {
    if (child) await stopOwner(child);
    releaseDelegationOwnerLock({ dataDir: dir });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('probe timeout and connect/error completion destroy the socket and retain its error listener', async () => {
  for (const outcome of ['timeout', 'connect', 'error', 'throw']) {
    let destroyed = 0;
    const socket = new EventEmitter();
    socket.destroy = () => {
      destroyed += 1;
      assert.ok(socket.listenerCount('error') > 0);
      setImmediate(() => socket.emit('error', new Error('late error')));
    };
    const patched = mock.method(net, 'createConnection', () => {
      if (outcome === 'throw') throw new Error('connection setup failed');
      if (outcome !== 'timeout') setImmediate(() => socket.emit(outcome));
      return socket;
    });
    try {
      assert.equal(await isLockSocketLive('/diagnostic.sock'), outcome === 'connect');
      assert.equal(destroyed, outcome === 'throw' ? 0 : 1);
      await new Promise((resolve) => setImmediate(resolve));
    } finally { patched.mock.restore(); }
  }
});
