import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStorageCoordinator, readFencingHwmFromDb } from '../lib/storage/coordinator.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createGroupCommitter } from '../lib/storage/group-commit.js';
import { executeCommand } from '../lib/storage/command-receipts.js';
import { StorageError } from '../lib/storage/errors.js';
import { openStorageDb, DEFAULT_STORAGE_DB_FILENAME } from '../lib/storage/db-lifecycle.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';

const HANDLERS_PATH = fileURLToPath(new URL('./fixtures/storage-group-handlers.js', import.meta.url));
const COORDINATOR_URL = new URL('../lib/storage/coordinator.js', import.meta.url).href;
const GEN = 'gen-coord';

/** @type {string} */
let root;
/** @type {Array<{ close: Function }>} */
let closers;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-coordinator-'));
  closers = [];
});

afterEach(async () => {
  for (const closer of closers) await closer.close({ timeoutMs: 1000 }).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

/** Mutable wall clock + liveness table shared by coordinators of one test. */
function world() {
  const state = { t: 1_000_000, alive: new Set([1111, 2222, 3333]) };
  return {
    state,
    now: () => state.t,
    isOwnerAlive: (/** @type {{ pid: number }} */ owner) => state.alive.has(owner.pid),
  };
}

/**
 * @param {ReturnType<typeof world>} w
 * @param {number} pid
 * @param {Record<string, unknown>} [extra]
 */
function make(w, pid, extra = {}) {
  const coordinator = createStorageCoordinator({
    controlDir: path.join(root, 'storage-control'),
    now: w.now,
    isOwnerAlive: w.isOwnerAlive,
    pid,
    pidStart: `start-${pid}`,
    autoRenew: false,
    ttlMs: 30000,
    ...extra,
  });
  closers.push({ close: async () => coordinator.close() });
  return coordinator;
}

/** @param {() => unknown} fn */
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return /** @type {any} */ (err);
  }
  return assert.fail('expected a throw');
}

/** @param {Promise<unknown>} promise */
async function rejection(promise) {
  // pauseForRestore() unref()s its drain timer; keep the loop alive while we await it.
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    await promise;
  } catch (err) {
    return /** @type {any} */ (err);
  } finally {
    clearInterval(keepAlive);
  }
  return assert.fail('expected a rejection');
}

/** Minimal host for activate(): the store reports no mark yet. */
const activationHost = { control: async () => ({ hwm: 0 }) };

/** @param {string} name */
const controlFile = (name) => path.join(root, 'storage-control', name);

async function startHost() {
  const host = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, restartBackoffMs: { initial: 10, max: 100 }, writeGate: WRITE_GATE_TEST_EXEMPTION });
  closers.push(host);
  await host.start();
  await host.command('setup', {});
  return host;
}

/**
 * @param {string} commandId
 * @param {string} k
 */
const cmd = (commandId, k) => ({ datasetGeneration: GEN, commandId, name: 'put', payload: { k, v: '1' } });

describe('lease: acquire, renew, release', () => {
  it('creates a lease with epoch 1, renews it and releases it without lowering the HWM', () => {
    const w = world();
    const a = make(w, 1111);
    const first = a.acquire();
    assert.equal(first.reason, 'created');
    assert.equal(first.epoch, 1);
    assert.equal(a.acquire().reason, 'renewed');
    w.state.t += 5000;
    assert.equal(a.renew().expiresAt, w.state.t + 30000);
    const lease = JSON.parse(fs.readFileSync(controlFile('owner-lease.json'), 'utf8'));
    assert.equal(lease.epoch, 1);
    assert.equal(lease.pid, 1111);
    assert.equal(a.release(), true);
    assert.equal(fs.existsSync(controlFile('owner-lease.json')), false);
    assert.equal(a.readHwm(), 1, 'release keeps the high-water mark');
    assert.equal(a.state, 'released');
    thrown(() => a.fenceOptions());
  });

  it('keeps epochs strictly increasing across release and restarts (new instances)', () => {
    const w = world();
    const epochs = [];
    for (let i = 0; i < 4; i += 1) {
      const c = make(w, 1111);
      epochs.push(c.acquire().epoch);
      if (i % 2 === 0) c.release();
      else w.state.t += 31000; // crash: the lease just expires
    }
    assert.deepEqual(epochs, [1, 2, 3, 4]);
  });

  it('never grants an epoch at or below a mark seen in the store', () => {
    const w = world();
    const c = make(w, 1111);
    assert.equal(c.acquire({ dbHwm: 41 }).epoch, 42);
  });
});

describe('lease: contention and takeover', () => {
  it('refuses a second coordinator while the owner is alive and unexpired (busy, safe details)', () => {
    const w = world();
    const a = make(w, 1111);
    const b = make(w, 2222);
    a.acquire();
    const err = thrown(() => b.acquire());
    assert.ok(err instanceof StorageError);
    assert.equal(err.code, 'busy');
    assert.equal(err.details.conflictKind, 'owner_held');
    assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(err.toJSON().details))).sort(), ['commitState', 'conflictKind', 'operation']);
    assert.doesNotMatch(JSON.stringify(err.toJSON()), /storage-control|1111|token/);
    assert.equal(b.state, 'idle');
  });

  it('two coordinators racing: exactly one owns, the other is refused', () => {
    const w = world();
    const racers = [make(w, 1111), make(w, 2222), make(w, 3333)];
    const outcomes = racers.map((c) => {
      try {
        return c.acquire().epoch;
      } catch (err) {
        return /** @type {any} */ (err).code;
      }
    });
    assert.equal(outcomes.filter((o) => o === 1).length, 1);
    assert.equal(outcomes.filter((o) => o === 'busy').length, 2);
  });

  it('takes over when the owner process is dead, even before expiry, with epoch + 1', () => {
    const w = world();
    const a = make(w, 1111);
    const b = make(w, 2222);
    a.acquire();
    w.state.alive.delete(1111);
    const taken = b.acquire();
    assert.equal(taken.reason, 'takeover');
    assert.equal(taken.epoch, 2);
    assert.equal(taken.previousEpoch, 1);
  });

  it('takes over an expired lease whose owner pid is still alive; the old owner is then fenced', () => {
    const w = world();
    const a = make(w, 1111);
    const b = make(w, 2222);
    a.acquire();
    w.state.t += 29999;
    assert.equal(thrown(() => b.acquire()).code, 'busy', 'one ms before expiry the lease still holds');
    w.state.t += 1;
    assert.equal(b.acquire().epoch, 2);
    const err = thrown(() => a.renew());
    assert.equal(err.code, 'conflict');
    assert.equal(err.details.conflictKind, 'fenced');
    assert.equal(a.state, 'fenced');
    assert.equal(thrown(() => a.fenceOptions()).details.conflictKind, 'fenced');
    // The new owner is untouched and the old one cannot delete its lease.
    assert.equal(a.release(), false);
    assert.equal(JSON.parse(fs.readFileSync(controlFile('owner-lease.json'), 'utf8')).epoch, 2);
  });

  it('a lapsed owner that was not taken over renews itself on the next write check', async () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    await a.activate(activationHost);
    w.state.t += 40000;
    assert.deepEqual(a.fenceOptions(), { fenceEpoch: 1 });
    assert.equal(a.getSnapshot().expiresAt, w.state.t + 30000);
  });

  it('recovers a stale control lock left by a dead process', () => {
    const w = world();
    fs.mkdirSync(path.dirname(controlFile('x')), { recursive: true });
    fs.writeFileSync(controlFile('control.lock'), JSON.stringify({ pid: 9999, pidStart: 'x', at: w.state.t }));
    const c = make(w, 1111);
    assert.equal(c.acquire().epoch, 1);
    // A live holder blocks with busy, however old its lock is (stalled holder).
    fs.writeFileSync(controlFile('control.lock'), JSON.stringify({ pid: 2222, pidStart: 'x', at: w.state.t, token: 'held' }));
    assert.equal(thrown(() => c.acquire()).details.conflictKind, 'control_locked');
    w.state.t += 10 * 60 * 1000;
    assert.equal(thrown(() => c.acquire()).details.conflictKind, 'control_locked');
    assert.equal(JSON.parse(fs.readFileSync(controlFile('control.lock'), 'utf8')).token, 'held', 'a live holder\'s lock is not touched');
    w.state.alive.delete(2222);
    assert.equal(c.acquire().reason, 'renewed');
  });

  it('acquireAsync waits for a busy lock without blocking the event loop', async () => {
    const w = world();
    fs.mkdirSync(path.dirname(controlFile('x')), { recursive: true });
    fs.writeFileSync(controlFile('control.lock'), JSON.stringify({ pid: 2222, pidStart: 'x', at: w.state.t, token: 'held' }));
    const c = make(w, 1111);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    // The live holder lets go after ~60 ms; the waiter must get in afterwards.
    setTimeout(() => fs.unlinkSync(controlFile('control.lock')), 60);
    try {
      const granted = await c.acquireAsync({ lockWaitMs: 2000, pollMs: 5 });
      assert.equal(granted.epoch, 1);
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 2, `a 10 ms timer must fire while waiting (fired ${ticks}x)`);
  });

  it('acquireAsync gives up after lockWaitMs with busy / lock_wait_timeout', async () => {
    const w = world();
    fs.mkdirSync(path.dirname(controlFile('x')), { recursive: true });
    fs.writeFileSync(controlFile('control.lock'), JSON.stringify({ pid: 2222, pidStart: 'x', at: w.state.t, token: 'held' }));
    const c = make(w, 1111);
    const started = Date.now();
    const err = await rejection(c.acquireAsync({ lockWaitMs: 50, pollMs: 5 }));
    assert.equal(err.details.conflictKind, 'lock_wait_timeout');
    assert.ok(Date.now() - started < 1500, 'the wait is bounded');
    assert.equal(JSON.parse(fs.readFileSync(controlFile('control.lock'), 'utf8')).token, 'held');
  });

  it('acquireAsync does not wait for a live owner (owner_held is immediate)', async () => {
    const w = world();
    make(w, 1111).acquire();
    const err = await rejection(make(w, 2222).acquireAsync({ lockWaitMs: 5000 }));
    assert.equal(err.details.conflictKind, 'owner_held');
  });

  it('breakStaleLock never clobbers a lock another process created while it was judging', () => {
    const w = world();
    fs.mkdirSync(path.dirname(controlFile('x')), { recursive: true });
    const lockPath = controlFile('control.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 9999, pidStart: 'x', at: w.state.t, token: 'dead' }));
    const fresh = JSON.stringify({ pid: 2222, pidStart: 'x', at: w.state.t, token: 'fresh' });
    let swapped = false;
    const racing = {
      ...fs,
      // The dead holder's lock is replaced right before we move it aside.
      renameSync(from, to) {
        if (!swapped && from === lockPath) {
          swapped = true;
          fs.writeFileSync(lockPath, fresh);
        }
        return fs.renameSync(from, to);
      },
    };
    const c = make(w, 1111, { fs: racing });
    assert.equal(thrown(() => c.acquire()).details.conflictKind, 'control_locked');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), fresh, 'the fresh lock is restored intact');
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)).filter((n) => n.endsWith('.stale')), []);
  });

  it('breakStaleLock restore (link) never overwrites a lock created after the move-aside', () => {
    const w = world();
    fs.mkdirSync(path.dirname(controlFile('x')), { recursive: true });
    const lockPath = controlFile('control.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 9999, pidStart: 'x', at: w.state.t, token: 'dead' }));
    const swapFresh = JSON.stringify({ pid: 2222, pidStart: 'x', at: w.state.t, token: 'swap' });
    const newest = JSON.stringify({ pid: 3333, pidStart: 'x', at: w.state.t, token: 'newest' });
    let swapped = false;
    const racing = {
      ...fs,
      renameSync(from, to) {
        if (!swapped && from === lockPath) {
          swapped = true;
          fs.writeFileSync(lockPath, swapFresh);
        }
        return fs.renameSync(from, to);
      },
      // A third process takes the (now vacant) lock before we restore.
      linkSync(from, to) {
        if (to === lockPath) fs.writeFileSync(lockPath, newest);
        return fs.linkSync(from, to);
      },
    };
    const c = make(w, 1111, { fs: racing });
    assert.equal(thrown(() => c.acquire()).details.conflictKind, 'control_locked');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), newest, 'the newer lock wins; restore does not overwrite');
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)).filter((n) => n.endsWith('.stale')), []);
  });

  it('breaks a torn lock file only once it is older than lockStaleMs', () => {
    const w = world();
    fs.mkdirSync(path.dirname(controlFile('x')), { recursive: true });
    fs.writeFileSync(controlFile('control.lock'), '{"pid":');
    const c = make(w, 1111, { lockStaleMs: 10000 });
    const real = Date.now();
    const skewed = make(w, 1111, { lockStaleMs: 10000, now: () => real });
    assert.equal(thrown(() => skewed.acquire()).details.conflictKind, 'control_locked', 'a fresh torn file may be a creator mid-write');
    const old = new Date(real - 60000);
    fs.utimesSync(controlFile('control.lock'), old, old);
    assert.equal(skewed.acquire().epoch, 1);
    assert.equal(c.state, 'idle');
  });

  it('a stalled live holder keeps the critical section; its token-checked unlock never removes a foreign lock', () => {
    const w = world();
    const lockPath = controlFile('control.lock');
    let intruder = null;
    const spyFs = {
      ...fs,
      readFileSync: (file, enc) => {
        // While A is inside its critical section (reading the lease), B tries to enter far past lockStaleMs.
        if (typeof file === 'string' && file.endsWith('owner-lease.json') && !intruder) {
          intruder = 'tried';
          w.state.t += 10 * 60 * 1000;
          const b = make(w, 2222);
          intruder = thrown(() => b.acquire());
        }
        return fs.readFileSync(file, enc);
      },
    };
    const a = make(w, 1111, { fs: spyFs });
    a.acquire();
    assert.equal(intruder.details.conflictKind, 'control_locked', 'B must not enter while the live holder A is stalled');
    assert.equal(fs.existsSync(lockPath), false);

    // If the lock was replaced (a foreign token), the holder's finally leaves it alone.
    const swapFs = {
      ...fs,
      writeFileSync: fs.writeFileSync,
      renameSync: (from, to) => {
        fs.renameSync(from, to);
        if (String(to).endsWith('owner-lease.json')) fs.writeFileSync(lockPath, JSON.stringify({ pid: 3333, pidStart: 'x', at: w.state.t, token: 'foreign' }));
      },
    };
    const c = make(w, 1111, { fs: swapFs });
    a.release();
    c.acquire();
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'foreign');
  });

  it('removes a torn lock file when writing the lock content fails', () => {
    const w = world();
    let lockFd = -1;
    const brokenFs = {
      ...fs,
      openSync: (file, ...rest) => {
        const fd = fs.openSync(file, ...rest);
        if (String(file).endsWith('control.lock')) lockFd = fd;
        return fd;
      },
      writeSync: (fd, ...rest) => {
        if (fd === lockFd) throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
        return fs.writeSync(fd, ...rest);
      },
    };
    const a = make(w, 1111, { fs: brokenFs });
    assert.equal(thrown(() => a.acquire()).code, 'full_disk');
    assert.equal(fs.existsSync(controlFile('control.lock')), false);
    assert.equal(make(w, 2222).acquire().epoch, 1);
  });

  it('real processes racing for the same control dir: exactly one wins', async () => {
    const dir = path.join(root, 'storage-control');
    const script = `
      import { createStorageCoordinator } from ${JSON.stringify(COORDINATOR_URL)};
      const c = createStorageCoordinator({ controlDir: ${JSON.stringify(dir)}, autoRenew: false });
      const start = Number(process.argv[1]);
      while (Date.now() < start) {}
      try { const r = c.acquire(); console.log(JSON.stringify({ ok: true, epoch: r.epoch })); await new Promise((res) => setTimeout(res, 300)); }
      catch (err) { console.log(JSON.stringify({ ok: false, code: err.code })); }
    `;
    const startAt = String(Date.now() + 600);
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, startAt], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.once('error', reject);
      child.once('close', () => resolve(JSON.parse(out.trim().split('\n').pop() || '{}')));
    })));
    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
    assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'busy'), JSON.stringify(results));
    assert.equal(results.find((r) => r.ok).epoch, 1);
  });
});

describe('control files: atomicity and corruption', () => {
  it('ignores a partial tmp file left by a crash and sweeps it on the next mutation', () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    const partial = controlFile('owner-lease.json.4242.deadbeef.tmp');
    fs.writeFileSync(partial, '{"schema":1,"epoch":999,"own');
    assert.equal(JSON.parse(fs.readFileSync(controlFile('owner-lease.json'), 'utf8')).epoch, 1);
    w.state.t += 31000;
    const b = make(w, 2222);
    assert.equal(b.acquire().epoch, 2, 'the partial tmp never counts');
    assert.equal(fs.existsSync(partial), false);
  });

  it('keeps the previous file intact when the rename fails mid-write', () => {
    const w = world();
    const failingRename = { ...fs, renameSync: () => { throw Object.assign(new Error('boom /secret'), { code: 'EIO' }); } };
    const a = make(w, 1111);
    a.acquire();
    const before = fs.readFileSync(controlFile('owner-lease.json'), 'utf8');
    w.state.t += 31000;
    const b = make(w, 2222, { fs: failingRename });
    const err = thrown(() => b.acquire());
    assert.equal(err.code, 'io');
    assert.equal(fs.readFileSync(controlFile('owner-lease.json'), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(controlFile('x'))).filter((n) => n.endsWith('.tmp')), []);
    assert.equal(fs.existsSync(controlFile('control.lock')), false, 'the lock is released on failure');
  });

  it('fails closed on a damaged HWM or lease file instead of reading it as 0', () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    a.release();
    fs.writeFileSync(controlFile('fencing-hwm.json'), '{not json');
    const b = make(w, 2222);
    assert.equal(thrown(() => b.acquire()).code, 'corrupt');
    fs.writeFileSync(controlFile('fencing-hwm.json'), JSON.stringify({ schema: 1, hwm: 1 }));
    fs.writeFileSync(controlFile('owner-lease.json'), JSON.stringify({ schema: 99 }));
    assert.equal(thrown(() => b.acquire()).code, 'corrupt');
  });

  it('fails closed on schema-valid files with garbage fields (HWM and lease)', () => {
    const w = world();
    for (const hwm of [undefined, 'x', -1, 1.5, null, Number.MAX_SAFE_INTEGER + 10]) {
      fs.rmSync(path.join(root, 'storage-control'), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'storage-control'), { recursive: true });
      fs.writeFileSync(controlFile('fencing-hwm.json'), JSON.stringify({ schema: 1, hwm }));
      const c = make(w, 1111);
      assert.equal(thrown(() => c.acquire()).code, 'corrupt', `hwm=${String(hwm)}`);
      assert.equal(fs.existsSync(controlFile('owner-lease.json')), false);
      assert.equal(thrown(() => c.readHwm()).code, 'corrupt');
    }
    const good = { schema: 1, ownerToken: 't', pid: 4242, pidStart: 's', epoch: 3, acquiredAt: 1, heartbeatAt: 1, expiresAt: 5 };
    const bads = [{ pid: 'x' }, { pid: 0 }, { pid: 1.5 }, { epoch: -1 }, { epoch: 'a' }, { epoch: 0 }, { expiresAt: 'soon' }, { expiresAt: null }, { expiresAt: -5 }, { ownerToken: '' }, { ownerToken: 5 }];
    for (const bad of bads) {
      fs.rmSync(path.join(root, 'storage-control'), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, 'storage-control'), { recursive: true });
      fs.writeFileSync(controlFile('owner-lease.json'), JSON.stringify({ ...good, ...bad }));
      w.state.alive.delete(4242);
      const c = make(w, 1111);
      assert.equal(thrown(() => c.acquire()).code, 'corrupt', JSON.stringify(bad));
      assert.equal(c.state, 'idle');
      assert.equal(fs.existsSync(controlFile('fencing-hwm.json')), false, 'no HWM written on a corrupt lease');
    }
  });

  it('a corrupt restore-pause marker fails acquire before any mutation', () => {
    const w = world();
    fs.mkdirSync(path.join(root, 'storage-control'), { recursive: true });
    fs.writeFileSync(controlFile('restore-pause.json'), '{broken');
    const c = make(w, 1111);
    assert.equal(thrown(() => c.acquire()).code, 'corrupt');
    assert.equal(c.state, 'idle');
    assert.equal(c.epoch, 0);
    assert.equal(fs.existsSync(controlFile('owner-lease.json')), false);
    assert.equal(fs.existsSync(controlFile('fencing-hwm.json')), false);
    fs.writeFileSync(controlFile('restore-pause.json'), JSON.stringify({ schema: 99 }));
    assert.equal(thrown(() => c.acquire()).code, 'corrupt');
    assert.equal(fs.existsSync(controlFile('owner-lease.json')), false);
  });

  it('a crash between the HWM write and the lease write only skips an epoch', () => {
    const w = world();
    let armed = true;
    const crashingFs = {
      ...fs,
      renameSync: (from, to) => {
        if (armed && String(to).endsWith('owner-lease.json')) throw Object.assign(new Error('crash'), { code: 'EIO' });
        return fs.renameSync(from, to);
      },
    };
    const a = make(w, 1111, { fs: crashingFs });
    assert.equal(thrown(() => a.acquire()).code, 'io');
    assert.equal(a.state, 'idle');
    assert.equal(fs.existsSync(controlFile('owner-lease.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(controlFile('fencing-hwm.json'), 'utf8')).hwm, 1, 'HWM was written first');
    armed = false;
    const b = make(w, 2222);
    assert.equal(b.acquire().epoch, 2, 'epoch 1 is skipped, never reused');
    // Same crash on a takeover: the old lease stays, the HWM runs ahead.
    armed = true;
    w.state.alive.delete(2222);
    const c = make(w, 3333, { fs: crashingFs });
    assert.equal(thrown(() => c.acquire()).code, 'io');
    assert.equal(JSON.parse(fs.readFileSync(controlFile('owner-lease.json'), 'utf8')).epoch, 2);
    armed = false;
    assert.equal(make(w, 1111).acquire().epoch, 4);
  });

  it('reports a failed directory fsync after the rename as io (not known to be durable)', () => {
    const w = world();
    const noDirSync = {
      ...fs,
      fsyncSync: (fd) => {
        if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('x'), { code: 'EIO' });
        return fs.fsyncSync(fd);
      },
    };
    const a = make(w, 1111, { fs: noDirSync });
    assert.equal(thrown(() => a.acquire()).code, 'io');
    assert.equal(a.state, 'idle');
    assert.equal(fs.existsSync(controlFile('control.lock')), false);
    // The replaced file is harmless: epochs stay monotonic for the next owner.
    assert.equal(make(w, 2222).acquire().epoch >= 2, true);
  });
});

describe('fencing against the store', () => {
  it('refuses a commit with an epoch below the stored mark (command, group commit, control)', async () => {
    const host = await startHost();
    const w = world();
    const a = make(w, 1111);
    const b = make(w, 2222);
    const guardedA = a.guardHost(host);
    const guardedB = b.guardHost(host);
    a.acquire();
    await a.activate(host);
    assert.equal((await executeCommand(guardedA, cmd('c-a1', 'a1'))).replayed, false);
    // Takeover: the zombie (a) does not know yet and keeps its renew pending.
    w.state.alive.delete(1111);
    assert.equal(b.acquire().epoch, 2);
    assert.deepEqual(await b.activate(host), { epoch: 2, dbHwm: 2 });
    assert.equal(await host.query('applyCount', { k: 'a1' }), 1);

    const zombie = await rejection(host.command('put', { datasetGeneration: GEN, commandId: 'c-z', name: 'put', payload: { k: 'z', v: '1' } }, { fenceEpoch: 1 }));
    assert.equal(zombie.code, 'conflict');
    assert.equal(zombie.details.conflictKind, 'fenced');
    assert.equal(zombie.details.commitState, 'not_committed');
    assert.equal(zombie.details.expectedRevision, 2);
    const viaReceipt = await rejection(executeCommand({ ...host, command: (n, p, o) => host.command(n, p, { ...o, fenceEpoch: 1 }) }, cmd('c-z2', 'z2')));
    assert.equal(viaReceipt.details.conflictKind, 'fenced');
    const batchHost = { ...host, commandBatch: (m, o) => host.commandBatch(m, { ...o, fenceEpoch: 1 }) };
    const gcZombie = createGroupCommitter({ host: batchHost, maxFlushAttempts: 1 });
    const batchErr = await rejection(gcZombie.submit(cmd('c-z3', 'z3')));
    assert.equal(batchErr.details.conflictKind, 'fenced');
    assert.equal((await rejection(host.control('fence', { fenceEpoch: 1 }))).details.conflictKind, 'fenced');
    assert.equal(await host.query('applyCount', { k: 'z' }), 0);
    assert.equal(await host.query('applyCount', { k: 'z2' }), 0);
    assert.equal(await host.query('applyCount', { k: 'z3' }), 0);

    // The new owner commits normally, singly and in a group.
    assert.equal((await executeCommand(guardedB, cmd('c-b1', 'b1'))).replayed, false);
    const gc = createGroupCommitter({ host: guardedB });
    const pending = gc.submit(cmd('c-b2', 'b2'));
    await gc.flush();
    assert.equal((await pending).replayed, false);
    // The old coordinator's own guard also refuses once it learns it was fenced.
    assert.equal(thrown(() => a.renew()).details.conflictKind, 'fenced');
    assert.equal((await rejection(executeCommand(guardedA, cmd('c-a2', 'a2')))).details.conflictKind, 'fenced');
    assert.equal(await host.query('applyCount', { k: 'a2' }), 0);
  });

  it('rejects an invalid fenceEpoch before queueing and ignores a caller-supplied epoch through the guard', async () => {
    const host = await startHost();
    const bad = await rejection(host.command('put', {}, { fenceEpoch: -1 }));
    assert.equal(bad.details.operation, 'invalid_request');
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    await a.activate(host);
    const guarded = a.guardHost(host);
    // A forged higher epoch must not be able to raise the mark through the guard.
    await executeCommand(guarded, { ...cmd('c-f', 'f'), fenceEpoch: 50 });
    const calls = [];
    const spy = a.guardHost({ ...host, command: (n, p, o) => { calls.push(o.fenceEpoch); return host.command(n, p, o); } });
    await executeCommand(spy, cmd('c-f2', 'f2'));
    assert.deepEqual(calls, [1]);
  });

  it('mirrors the HWM in the store (schema v2) and in the control dir; a mismatch resolves to the max', async () => {
    const host = await startHost();
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    assert.equal(a.readHwm(), 1);
    assert.deepEqual(await a.activate(host), { epoch: 1, dbHwm: 1 });
    a.release();
    await host.close({ timeoutMs: 1000 });
    const handle = openStorageDb({ dir: root });
    try {
      assert.equal(readFencingHwmFromDb(handle.db), 1);
      assert.equal(handle.schemaVersion >= 2, true);
      // Store ahead of the control dir (e.g. control dir restored from an old backup).
      handle.db.prepare('UPDATE storage_fencing SET hwm = 7 WHERE id = 1').run();
    } finally {
      handle.close();
    }
    const host2 = await (async () => {
      const h = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
      closers.push(h);
      await h.start();
      return h;
    })();
    const b = make(w, 2222);
    assert.equal(b.acquire().epoch, 2, 'the control file alone would grant epoch 2');
    const activated = await b.activate(host2);
    assert.equal(activated.epoch, 8, 'activate bumps the epoch above the store mark');
    assert.equal(activated.dbHwm, 8);
    assert.equal(b.readHwm(), 8);
    // The other direction: the control dir is ahead, the store gets raised.
    const c = make(w, 3333);
    b.release();
    assert.equal(c.reconcileHwm(20), 20);
    assert.equal(c.acquire().epoch, 21);
    assert.equal((await c.activate(host2)).dbHwm, 21);
    assert.equal(fs.existsSync(path.join(root, DEFAULT_STORAGE_DB_FILENAME)), true);
  });

  it('a store without the storage_fencing row fails closed (corrupt), never as mark 0', async () => {
    const host = await startHost();
    await host.close({ timeoutMs: 1000 });
    const handle = openStorageDb({ dir: root });
    try {
      assert.equal(readFencingHwmFromDb(handle.db), 0);
      handle.db.exec('DELETE FROM storage_fencing');
      assert.equal(thrown(() => readFencingHwmFromDb(handle.db)).code, 'corrupt');
    } finally {
      handle.close();
    }
    const h = createStorageWorkerHost({ dbDir: root, handlersPath: HANDLERS_PATH, writeGate: WRITE_GATE_TEST_EXEMPTION });
    closers.push(h);
    await h.start();
    const control = await rejection(h.control('fence'));
    assert.equal(control.code, 'corrupt');
    const write = await rejection(h.command('put', { datasetGeneration: GEN, commandId: 'c-nr', name: 'put', payload: { k: 'nr', v: '1' } }, { fenceEpoch: 1 }));
    assert.equal(write.code, 'corrupt');
    assert.equal(write.details.commitState, 'not_committed');
    // Without a fence epoch nothing reads the row (unchanged behaviour).
    assert.equal((await executeCommand(h, cmd('c-nr2', 'nr2'))).replayed, false);
  });

  it('absent fenceEpoch keeps the previous behaviour (no check, mark untouched)', async () => {
    const host = await startHost();
    await executeCommand(host, cmd('c-plain', 'plain'));
    assert.equal((await host.control('fence')).hwm, 0);
  });
});

describe('restore pause', () => {
  it('rejects new writes with busy, waits for in-flight writes, allows reads and persists the marker', async () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve('done'); });
    const calls = [];
    const host = {
      command: (n, p, o) => { calls.push(o.fenceEpoch); return gate; },
      commandBatch: () => Promise.resolve('batch'),
      query: () => Promise.resolve('read'),
      control: () => Promise.resolve('ctl'),
    };
    const guarded = a.guardHost(host);
    await a.activate(activationHost);
    const inflight = guarded.command('put', {});
    let drained = false;
    const pausing = a.pauseForRestore().then((r) => { drained = true; return r; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false, 'pause waits for the in-flight write');
    assert.equal(fs.existsSync(controlFile('restore-pause.json')), true, 'marker is durable before draining');
    const refused = await rejection(guarded.commandBatch([], {}));
    assert.equal(refused.code, 'busy');
    assert.equal(refused.details.conflictKind, 'restore_paused');
    assert.equal(refused.details.commitState, 'not_committed');
    assert.equal(await guarded.query('q', {}), 'read');
    assert.equal(await guarded.control('ping'), 'ctl');
    release();
    assert.equal(await inflight, 'done');
    assert.deepEqual(await pausing, { drained: 1 });
    assert.equal(a.getSnapshot().inFlightWrites, 0);
    a.resumeAfterRestore();
    assert.equal(fs.existsSync(controlFile('restore-pause.json')), false);
    assert.equal(await guarded.commandBatch([], {}), 'batch');
  });

  it('keeps the pause across a crash/restart until resumeAfterRestore()', async () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    await a.pauseForRestore({ reason: 'test restore' });
    // Crash: no release; the successor takes over after the process dies.
    w.state.alive.delete(1111);
    const b = make(w, 2222);
    const acquired = b.acquire();
    await b.activate(activationHost);
    assert.equal(acquired.restorePaused, true);
    assert.equal(b.readRestorePause(), true);
    const err = thrown(() => b.fenceOptions());
    assert.equal(err.code, 'busy');
    assert.equal(err.details.conflictKind, 'restore_paused');
    b.resumeAfterRestore();
    assert.deepEqual(b.fenceOptions(), { fenceEpoch: 2 });
  });

  it('times out the drain with busy but keeps the pause in force', async () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    const stuck = new Promise(() => {});
    await a.activate(activationHost);
    const guarded = a.guardHost({ command: () => stuck, commandBatch: () => stuck, query: () => stuck, control: () => stuck });
    guarded.command('put', {});
    const err = await rejection(a.pauseForRestore({ timeoutMs: 20 }));
    assert.equal(err.details.conflictKind, 'drain_timeout');
    assert.equal(thrown(() => a.fenceOptions()).details.conflictKind, 'restore_paused');
    assert.equal(a.readRestorePause(), true);
  });

  it('a zombie owner can neither write nor delete the pause marker', async () => {
    const w = world();
    const a = make(w, 1111);
    const b = make(w, 2222);
    a.acquire();
    w.state.alive.delete(1111);
    b.acquire();
    // a does not know yet: its pause/resume must verify the lease under the lock.
    assert.equal((await rejection(a.pauseForRestore())).details.conflictKind, 'fenced');
    assert.equal(fs.existsSync(controlFile('restore-pause.json')), false, 'zombie wrote no marker');
    assert.equal(a.state, 'fenced');
    await b.pauseForRestore();
    const c = make(w, 3333);
    assert.equal(thrown(() => c.resumeAfterRestore()).details.conflictKind, 'not_owner');
    assert.equal(fs.existsSync(controlFile('restore-pause.json')), true);
    // A fenced-but-believing owner (state owner, lease replaced) cannot delete it either.
    const d = make(w, 4444);
    w.state.alive.delete(2222);
    d.acquire();
    assert.equal(d.readRestorePause(), true);
    assert.equal(thrown(() => b.resumeAfterRestore()).details.conflictKind, 'fenced');
    assert.equal(fs.existsSync(controlFile('restore-pause.json')), true, 'zombie did not delete the marker');
  });

  it('validates pauseForRestore timeoutMs before writing the marker', async () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    for (const bad of [0, -1, Number.NaN, Infinity, '5']) {
      const err = await rejection(a.pauseForRestore({ timeoutMs: bad }));
      assert.ok(err instanceof TypeError, String(bad));
    }
    assert.equal(fs.existsSync(controlFile('restore-pause.json')), false);
  });

  it('a live owner observes a restore pause written by another process (renew and guarded writes)', async () => {
    const w = world();
    const a = make(w, 1111, { pauseCheckMs: 250 });
    a.acquire();
    await a.activate(activationHost);
    const guarded = a.guardHost({ command: async () => 'ok', commandBatch: async () => 'ok', query: async () => 'r', control: async () => ({ hwm: 0 }) });
    assert.equal(await guarded.command('put', {}, {}), 'ok');
    // An external restore tool drops the marker.
    fs.writeFileSync(controlFile('restore-pause.json'), `${JSON.stringify({ schema: 1, pausedAt: w.state.t, epoch: 0, pid: 9999, reason: 'external' })}\n`);
    assert.equal(await guarded.command('put', {}, {}), 'ok', 'within the cache window the old view may be used');
    w.state.t += 300;
    const refused = await rejection(guarded.command('put', {}, {}));
    assert.equal(refused.details.conflictKind, 'restore_paused');
    assert.equal(a.getSnapshot().paused, true);
    // Removing it again is observed as well, through renew().
    fs.rmSync(controlFile('restore-pause.json'));
    a.renew();
    assert.equal(a.getSnapshot().paused, false);
    assert.equal(await guarded.command('put', {}, {}), 'ok');
    // Renew picks the marker up without any write in between.
    fs.writeFileSync(controlFile('restore-pause.json'), `${JSON.stringify({ schema: 1, pausedAt: 1, epoch: 0, pid: 1, reason: 'x' })}\n`);
    a.renew();
    assert.equal(a.getSnapshot().paused, true);
    // A damaged marker fails writes closed.
    fs.writeFileSync(controlFile('restore-pause.json'), 'garbage');
    w.state.t += 300;
    assert.equal((await rejection(guarded.command('put', {}, {}))).code, 'corrupt');
  });

  it('refuses guarded writes before activate() and after the epoch changes', async () => {
    const w = world();
    const a = make(w, 1111);
    a.acquire();
    const calls = [];
    const guarded = a.guardHost({ command: async () => { calls.push('c'); return 'ok'; }, commandBatch: async () => 'ok', query: async () => 'r', control: async () => ({ hwm: 0 }) });
    const early = await rejection(guarded.command('put', {}, {}));
    assert.equal(early.code, 'conflict');
    assert.equal(early.details.conflictKind, 'not_activated');
    assert.deepEqual(calls, []);
    assert.equal(await guarded.query('q', {}), 'r', 'reads need no activation');
    await a.activate(activationHost);
    assert.equal(await guarded.command('put', {}, {}), 'ok');
    // Store ahead: activate bumps the epoch and re-activates at the new one.
    const ahead = { control: async (op, opts) => ({ hwm: opts?.fenceEpoch ?? 9 }) };
    await a.activate(ahead);
    assert.equal(a.epoch, 10);
    assert.equal(await guarded.command('put', {}, {}), 'ok');
  });

  it('only the owner can pause or resume', async () => {
    const w = world();
    const a = make(w, 1111);
    assert.equal((await rejection(a.pauseForRestore())).details.conflictKind, 'not_owner');
    assert.equal(thrown(() => a.resumeAfterRestore()).details.conflictKind, 'not_owner');
  });
});

describe('timers', () => {
  it('auto-renews with an unref-ed timer and leaves no timer after release or loss', () => {
    const w = world();
    const scheduled = [];
    const fakeTimers = {
      setTimeout: (fn, ms) => { const h = { fn: () => { h.cleared = true; fn(); }, ms, cleared: false, unref() {} }; scheduled.push(h); return h; },
      clearTimeout: (h) => { if (h) h.cleared = true; },
    };
    const lost = [];
    const a = make(w, 1111, { autoRenew: true, timers: fakeTimers, onLost: (info) => lost.push(info.reason) });
    a.acquire();
    assert.equal(a.getSnapshot().renewTimerActive, true);
    assert.equal(scheduled.at(-1).ms, 10000);
    w.state.t += 10000;
    scheduled.at(-1).fn();
    assert.equal(scheduled.length, 2, 'renewing schedules the next beat');
    assert.equal(JSON.parse(fs.readFileSync(controlFile('owner-lease.json'), 'utf8')).heartbeatAt, w.state.t);
    a.release();
    assert.equal(scheduled.filter((h) => !h.cleared).length, 0);
    assert.equal(a.getSnapshot().renewTimerActive, false);

    const b = make(w, 2222, { autoRenew: true, timers: fakeTimers, onLost: (info) => lost.push(info.reason) });
    b.acquire();
    w.state.alive.delete(2222);
    make(w, 3333).acquire();
    scheduled.at(-1).fn();
    assert.deepEqual(lost, ['lease_lost']);
    assert.equal(scheduled.filter((h) => !h.cleared).length, 0, 'no beat is rescheduled after the loss');
  });

  it('real timers: a closed coordinator holds no active Timeout resource', async () => {
    const a = createStorageCoordinator({ controlDir: path.join(root, 'storage-control'), ttlMs: 60000 });
    const before = process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
    a.acquire();
    a.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length, before);
  });
});
