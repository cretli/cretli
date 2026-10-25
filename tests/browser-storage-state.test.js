/**
 * Tests for encrypted per-workspace Browser storageState (P2a).
 *
 * Covers the AES-256-GCM roundtrip, consent gating, TTL retention, clear,
 * stable workspace hashing and the security contract (no plaintext on disk,
 * no secret or payload in statuses/errors), plus the session-manager wiring.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserStorageError,
  DEFAULT_STORAGE_STATE_TTL_MS,
  clearAllStorageState,
  clearWorkspaceStorageState,
  deriveStorageKey,
  getConsent,
  publicStorageStateStatus,
  readStorageState,
  resolveStorageSecret,
  saveStorageState,
  setConsent,
  storageStateFilePath,
  sweepExpiredStorageState,
  workspaceProfile,
} from '../lib/browser/storage-state.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

const SECRET = 'server-secret-for-tests';
const COOKIE_VALUE = 'super-secret-session-token';
const WORKSPACE = '/ws/example';

/** @returns {string} a fresh temp dataDir removed by the test */
function makeDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** @returns {{ cookies: object[], origins: object[] }} */
function sampleState(value = COOKIE_VALUE) {
  return {
    cookies: [{ name: 'sid', value, domain: 'example.com', path: '/' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] }],
  };
}

test('workspaceProfile is a stable hash of the normalized path and never the raw path', () => {
  const a = workspaceProfile('/ws/example');
  const b = workspaceProfile('/ws/example');
  const c = workspaceProfile('/ws/other');
  const messy = workspaceProfile('/ws/./example');

  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.equal(a, messy);
  assert.notEqual(a, c);
  assert.equal(workspaceProfile(''), '');
  assert.equal(workspaceProfile('   '), '');
  assert.ok(!a.includes('example'), 'hash must not embed the raw path');
});

test('saveStorageState roundtrips through AES-256-GCM without plaintext on disk', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true, { now: 1000 });

  const state = sampleState();
  const result = saveStorageState(dir, WORKSPACE, state, { secret: SECRET, now: 1000, ttlMs: 5000 });
  assert.equal(result.saved, true);
  assert.equal(result.cookieCount, 1);
  assert.equal(result.originCount, 1);
  assert.ok(result.byteLength > 0);
  assert.equal(result.expiresAt, 6000);

  const raw = fs.readFileSync(storageStateFilePath(dir), 'utf8');
  assert.ok(!raw.includes(COOKIE_VALUE), 'plaintext cookie value must not be on disk');
  assert.ok(!raw.includes('super-secret'), 'plaintext payload must not be on disk');
  assert.ok(!raw.includes(SECRET), 'the server secret must not be on disk');
  assert.ok(!raw.includes(WORKSPACE), 'the raw workspace path must not be on disk');
  assert.ok(raw.includes(workspaceProfile(WORKSPACE)), 'the profile hash is the store key');

  const read = readStorageState(dir, WORKSPACE, { secret: SECRET, now: 2000 });
  assert.equal(read.ok, true);
  assert.deepEqual(read.state, state);
  assert.equal(read.cookieCount, 1);
});

test('without consent storageState is neither written nor read', (t) => {
  const dir = makeDataDir(t);
  const save = saveStorageState(dir, WORKSPACE, sampleState(), { secret: SECRET, now: 1000 });
  assert.deepEqual(save, { saved: false, reason: 'consent-required' });
  assert.equal(getConsent(dir, WORKSPACE), false);

  const read = readStorageState(dir, WORKSPACE, { secret: SECRET, now: 1000 });
  assert.equal(read.ok, false);
  assert.ok(['not-found', 'consent-required'].includes(read.reason));
  assert.equal(read.state, undefined);

  // Re-reading after a rejected save must still find nothing on disk.
  assert.ok(!fs.existsSync(storageStateFilePath(dir)) || !fs.readFileSync(storageStateFilePath(dir), 'utf8').includes(COOKIE_VALUE));
});

test('revoking consent drops the stored state', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);
  assert.equal(saveStorageState(dir, WORKSPACE, sampleState(), { secret: SECRET }).saved, true);

  setConsent(dir, WORKSPACE, false);
  assert.equal(getConsent(dir, WORKSPACE), false);
  const read = readStorageState(dir, WORKSPACE, { secret: SECRET });
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'consent-required');
});

test('missing secret returns an explicit key-missing status and never writes plaintext', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);

  const save = saveStorageState(dir, WORKSPACE, sampleState(), { env: {} });
  assert.deepEqual(save, { saved: false, reason: 'storage-key-missing' });

  const read = readStorageState(dir, WORKSPACE, { env: {} });
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'storage-key-missing');
  assert.equal(read.state, undefined);

  const resolved = resolveStorageSecret({ dataDir: dir, env: {} });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'storage-key-missing');

  // No encrypted state and no plaintext file was written.
  const rawExists = fs.existsSync(storageStateFilePath(dir));
  if (rawExists) assert.ok(!fs.readFileSync(storageStateFilePath(dir), 'utf8').includes(COOKIE_VALUE));
});

test('a key file is an accepted secret source', (t) => {
  const dir = makeDataDir(t);
  fs.writeFileSync(path.join(dir, 'browser-storage.key'), 'file-secret\n', 'utf8');
  const resolved = resolveStorageSecret({ dataDir: dir, env: {} });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, 'file');

  setConsent(dir, WORKSPACE, true);
  assert.equal(saveStorageState(dir, WORKSPACE, sampleState(), { env: {} }).saved, true);
  const read = readStorageState(dir, WORKSPACE, { env: {} });
  assert.equal(read.ok, true);
  assert.deepEqual(read.state, sampleState());
});

test('expired entries are dropped on read and by sweep', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);
  saveStorageState(dir, WORKSPACE, sampleState(), { secret: SECRET, now: 1000, ttlMs: 1000 });

  assert.equal(readStorageState(dir, WORKSPACE, { secret: SECRET, now: 1999 }).ok, true);
  const expired = readStorageState(dir, WORKSPACE, { secret: SECRET, now: 2000 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
  // Retention: the payload is gone after the expiry read.
  assert.equal(readStorageState(dir, WORKSPACE, { secret: SECRET, now: 2001 }).reason, 'not-found');

  // Sweep has the same retention contract.
  const other = '/ws/other';
  setConsent(dir, other, true);
  saveStorageState(dir, other, sampleState('other-cookie'), { secret: SECRET, now: 1000, ttlMs: 1000 });
  const swept = sweepExpiredStorageState(dir, { now: 5000 });
  assert.equal(swept.removed, 1);
  assert.deepEqual(swept.profiles, [workspaceProfile(other)]);
  assert.equal(readStorageState(dir, other, { secret: SECRET, now: 5000 }).reason, 'not-found');
  // Consent survives a sweep.
  assert.equal(getConsent(dir, other), true);
});

test('the default TTL caps an entry that does not pass one explicitly', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);
  const result = saveStorageState(dir, WORKSPACE, sampleState(), { secret: SECRET, now: 1000 });
  assert.equal(result.expiresAt, 1000 + DEFAULT_STORAGE_STATE_TTL_MS);
});

test('clear wipes one workspace and clearAll wipes the store', (t) => {
  const dir = makeDataDir(t);
  const other = '/ws/other';
  for (const ws of [WORKSPACE, other]) {
    setConsent(dir, ws, true);
    saveStorageState(dir, ws, sampleState(), { secret: SECRET });
  }

  const kept = clearWorkspaceStorageState(dir, WORKSPACE, { keepConsent: true });
  assert.equal(kept.consent, true);
  assert.equal(getConsent(dir, WORKSPACE), true);
  assert.equal(readStorageState(dir, WORKSPACE, { secret: SECRET }).reason, 'not-found');

  const cleared = clearWorkspaceStorageState(dir, other);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.consent, false);
  assert.equal(getConsent(dir, other), false);
  assert.equal(readStorageState(dir, other, { secret: SECRET }).reason, 'consent-required');

  // Rebuild both and wipe everything.
  setConsent(dir, WORKSPACE, true);
  saveStorageState(dir, WORKSPACE, sampleState(), { secret: SECRET });
  const all = clearAllStorageState(dir);
  assert.equal(all.cleared, 1);
  assert.equal(readStorageState(dir, WORKSPACE, { secret: SECRET }).reason, 'consent-required');
  const status = publicStorageStateStatus(dir, WORKSPACE, { secret: SECRET });
  assert.equal(status.hasState, false);
  assert.equal(status.consent, false);
});

test('publicStorageStateStatus exposes metadata and counters only', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);
  saveStorageState(dir, WORKSPACE, sampleState(), { secret: SECRET, now: 1000, ttlMs: 5000 });

  const status = publicStorageStateStatus(dir, WORKSPACE, { secret: SECRET, now: 2000 });
  assert.equal(status.workspace, workspaceProfile(WORKSPACE));
  assert.equal(status.consent, true);
  assert.equal(status.keyAvailable, true);
  assert.equal(status.hasState, true);
  assert.equal(status.expired, false);
  assert.equal(status.cookieCount, 1);
  assert.equal(status.originCount, 1);
  assert.ok(status.byteLength > 0);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(COOKIE_VALUE), 'status must never leak cookie values');
  assert.ok(!serialized.includes(SECRET), 'status must never leak the secret');
});

test('a wrong key cannot decrypt and never leaks the payload', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);
  saveStorageState(dir, WORKSPACE, sampleState(), { secret: 'key-a' });

  const read = readStorageState(dir, WORKSPACE, { secret: 'key-b' });
  assert.equal(read.ok, false);
  assert.equal(read.reason, 'decrypt-failed');
  assert.equal(read.state, undefined);
  assert.ok(!JSON.stringify(read).includes(COOKIE_VALUE));
});

test('error messages never contain the secret or the payload', (t) => {
  assert.throws(
    () => deriveStorageKey(''),
    (err) => {
      assert.ok(err instanceof BrowserStorageError);
      assert.equal(err.code, 'storage-key-missing');
      assert.ok(!err.message.includes(SECRET));
      return true;
    },
  );
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);
  const result = saveStorageState(dir, WORKSPACE, sampleState(), { secret: '', env: {} });
  assert.equal(result.reason, 'storage-key-missing');
  assert.ok(!JSON.stringify(result).includes(COOKIE_VALUE));
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('an empty storage state is not persisted', (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, WORKSPACE, true);
  const result = saveStorageState(dir, WORKSPACE, { cookies: [], origins: [] }, { secret: SECRET });
  assert.deepEqual(result, { saved: false, reason: 'empty-state' });
  assert.equal(readStorageState(dir, WORKSPACE, { secret: SECRET }).reason, 'not-found');
});

/* ------------------------------------------------------------------ *
 * Session-manager integration
 * ------------------------------------------------------------------ */

const SCOPE = { workspaceFile: '/ws/example' };
const OWNER = 'owner-a';

/**
 * Minimal Playwright stand-in that also implements `context.storageState()`.
 * `contextOptions` records every `newContext` call so the test can assert the
 * storageState wiring without a real Chromium.
 * @param {{ initial?: object, fail?: boolean }} [options]
 */
function createStorageDriver(options = {}) {
  const state = {
    contextOptions: [],
    storageStateCalls: 0,
    current: options.initial || { cookies: [], origins: [] },
    closed: false,
  };
  class FakePage {
    constructor() { this._closed = false; }
    on() {}
    isClosed() { return this._closed; }
    url() { return 'about:blank'; }
    mainFrame() { return null; }
    async close() { this._closed = true; }
  }
  class FakeContext {
    constructor() { this.routes = []; this.closed = false; }
    on() {}
    async route(_pattern, handler) { this.routes.push(handler); }
    async newPage() { return new FakePage(); }
    async storageState() {
      state.storageStateCalls += 1;
      if (options.fail) throw new Error('storageState boom');
      return state.current;
    }
    async close() { this.closed = true; }
  }
  class FakeBrowser {
    constructor() { this.closed = false; }
    async newContext(opts) {
      state.contextOptions.push(opts || {});
      return new FakeContext();
    }
    isConnected() { return !this.closed; }
    async close() { this.closed = true; }
  }
  return {
    state,
    driver: {
      name: 'fake',
      async launch() { return new FakeBrowser(); },
    },
  };
}

function createManager(overrides = {}) {
  const { driver, state } = createStorageDriver(overrides.driverOptions);
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available' },
    dataDir: overrides.dataDir,
    storageState: { dataDir: overrides.dataDir, secret: overrides.secret ?? SECRET },
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    ...(overrides.manager || {}),
  });
  return { manager, state };
}

test('with consent the manager hydrates the context and saves the state on close', async (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, SCOPE.workspaceFile, true);
  const seeded = sampleState('seeded-cookie');
  saveStorageState(dir, SCOPE.workspaceFile, seeded, { secret: SECRET });

  const { manager, state } = createManager({ dataDir: dir });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.ok(session.tabs.length >= 1);
  assert.deepEqual(state.contextOptions[0].storageState, seeded);

  // Simulate the page updating its cookies, then closing the session.
  state.current = sampleState('updated-cookie');
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test' });

  const read = readStorageState(dir, SCOPE.workspaceFile, { secret: SECRET });
  assert.equal(read.ok, true);
  assert.equal(read.state.cookies[0].value, 'updated-cookie');
});

test('consent without prior state bootstraps the store on first close', async (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, SCOPE.workspaceFile, true);
  // First run: consent exists but no payload was ever persisted (this is also
  // the state after TTL expiry or `clear(..., { keepConsent: true })`).
  assert.equal(readStorageState(dir, SCOPE.workspaceFile, { secret: SECRET }).reason, 'not-found');

  const { manager, state } = createManager({ dataDir: dir });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  // Nothing to hydrate on the very first session.
  assert.equal(state.contextOptions[0].storageState, undefined);

  // The first close must write the live state, even though there was nothing
  // to read back at session start.
  state.current = sampleState('bootstrapped-cookie');
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test' });

  assert.equal(state.storageStateCalls, 1, 'a consented session must read its state on close');
  const read = readStorageState(dir, SCOPE.workspaceFile, { secret: SECRET });
  assert.equal(read.ok, true);
  assert.equal(read.state.cookies[0].value, 'bootstrapped-cookie');
});

test('without consent the context is ephemeral and close writes nothing', async (t) => {
  const dir = makeDataDir(t);
  const { manager, state } = createManager({ dataDir: dir });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.equal(state.contextOptions[0].storageState, undefined);

  // No consent means the status has no persisted entry even after close.
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test' });
  assert.equal(state.storageStateCalls, 0, 'an ephemeral session must not even read storageState');
  assert.equal(manager.getStorageStateStatus(SCOPE.workspaceFile).hasState, false);
  assert.equal(readStorageState(dir, SCOPE.workspaceFile, { secret: SECRET }).reason, 'consent-required');
});

test('a storageState read failure on close is swallowed (best-effort)', async (t) => {
  const dir = makeDataDir(t);
  setConsent(dir, SCOPE.workspaceFile, true);
  saveStorageState(dir, SCOPE.workspaceFile, sampleState(), { secret: SECRET });

  const { manager } = createManager({ dataDir: dir, driverOptions: { fail: true } });
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  // Rejects only if the closed session throws; a best-effort failure must not.
  await assert.doesNotReject(() => manager.closeSession(session.browserSessionId, OWNER, { reason: 'test' }));
});

test('storage-state routes report metadata for the current workspace', async (t) => {
  const dir = makeDataDir(t);
  const manager = new BrowserSessionManager({
    driver: null,
    driverStatus: { status: 'browser-unavailable' },
    dataDir: dir,
    storageState: { dataDir: dir, secret: SECRET },
    resolvePolicy: () => ({ allowedOrigins: [], blockedPorts: [], unblockedPorts: [] }),
  });
  const empty = manager.getStorageStateStatus(SCOPE.workspaceFile);
  assert.equal(empty.enabled, true);
  assert.equal(empty.consent, false);
  assert.equal(empty.hasState, false);

  // A manager without the storageState config stays disabled.
  const disabled = new BrowserSessionManager({ driver: null, dataDir: dir });
  assert.deepEqual(disabled.getStorageStateStatus(SCOPE.workspaceFile), { enabled: false });

  // Expired entries surface as metadata without touching the payload.
  setConsent(dir, SCOPE.workspaceFile, true);
  saveStorageState(dir, SCOPE.workspaceFile, sampleState(), { secret: SECRET, ttlMs: 1000 });
  const status = manager.getStorageStateStatus(SCOPE.workspaceFile);
  assert.equal(status.consent, true);
  assert.ok(status.cookieCount === 1 || status.expired === true);
});
