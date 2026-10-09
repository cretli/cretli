/**
 * Browser HAR recorder contract tests (P2b).
 *
 * Covers:
 * - HAR is opt-in only: disabled by default, no recorder and no file;
 * - Cookie / Set-Cookie / Authorization / Proxy-Authorization headers and
 *   detectable query/body tokens are redacted before anything is returned;
 * - a secret never appears in any chat/agent-visible payload (Network/Console
 *   pulls, session summary, HAR file);
 * - the persisted archive is size-bounded (over-limit flushes are rejected, not
 *   written partially or raw);
 * - the session-manager wiring (per-session and per-workspace opt-in).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HAR_MAX_BYTES,
  HarRecorder,
  createHarRecorder,
  harFilePath,
  redactBodyString,
  redactHarCookies,
  redactHarDocument,
  redactHarEntry,
  redactHarHeaders,
} from '../lib/browser/har.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

const WORKSPACE = '/ws/har';
const OWNER = 'owner-har';
const SECRETS = Object.freeze({
  auth: 'LEAK_AUTH_abcdef',
  cookie: 'LEAK_COOKIE_abcdef',
  setCookie: 'LEAK_SETCOOKIE_abcdef',
  proxyAuth: 'LEAK_PROXYAUTH_abcdef',
  query: 'LEAK_QUERY_abcdef',
  body: 'LEAK_BODY_abcdef',
  signature: 'LEAK_SIGNATURE_abcdef',
  console: 'LEAK_CONSOLE_abcdef',
});

/** @returns {string} a fresh temp dataDir removed by the test */
function makeDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-browser-har-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fails when any of the pinned secret stand-ins survives serialization. */
function assertNoSecrets(serialized) {
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!String(serialized).includes(secret), `secret leaked: ${secret}`);
  }
}

/* ------------------------------------------------------------------ *
 * Redaction helpers
 * ------------------------------------------------------------------ */

test('redactHarHeaders masks Cookie, Set-Cookie, Authorization and Proxy-Authorization', () => {
  const out = redactHarHeaders({
    Authorization: `Bearer ${SECRETS.auth}`,
    'Proxy-Authorization': `Basic ${SECRETS.proxyAuth}`,
    Cookie: `sid=${SECRETS.cookie}`,
    'Set-Cookie': `sid=${SECRETS.setCookie}; HttpOnly`,
    Accept: 'application/json',
  });
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out['Proxy-Authorization'], '[redacted]');
  assert.equal(out.Cookie, '[redacted]');
  assert.equal(out['Set-Cookie'], '[redacted]');
  assert.equal(out.Accept, 'application/json');
  assertNoSecrets(JSON.stringify(out));
});

test('redactHarCookies masks every cookie value regardless of name', () => {
  const out = redactHarCookies([
    { name: 'sid', value: SECRETS.cookie, domain: 'example.com', path: '/' },
    { name: 'theme', value: 'dark' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].value, '[redacted]');
  assert.equal(out[1].value, '[redacted]');
  // Non-secret metadata stays readable for debugging.
  assert.equal(out[0].domain, 'example.com');
  assertNoSecrets(JSON.stringify(out));
});

test('redactHarEntry redacts URL, query, headers, cookies and bodies', () => {
  const entry = redactHarEntry({
    request: {
      method: 'POST',
      url: `https://example.com/api?token=${SECRETS.query}&page=2`,
      headers: { Authorization: `Bearer ${SECRETS.auth}`, Accept: 'application/json' },
      cookies: [{ name: 'sid', value: SECRETS.cookie }],
      queryString: [{ name: 'token', value: SECRETS.query }, { name: 'page', value: '2' }],
      postData: { mimeType: 'application/json', text: JSON.stringify({ password: SECRETS.body, keep: 'ok' }) },
    },
    response: {
      headers: { 'Set-Cookie': `sid=${SECRETS.setCookie}` },
      cookies: [{ name: 'sid', value: SECRETS.setCookie }],
    },
  });
  const serialized = JSON.stringify(redactHarDocument({ log: { entries: [entry] } }));
  assertNoSecrets(serialized);
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /page=2/);
  assert.match(serialized, /"name":"page","value":"2"|"page"/);
  assert.match(serialized, /ok/);
});

test('redactBodyString catches query/body tokens that are neither headers nor variables', () => {
  const json = redactBodyString(JSON.stringify({
    access_token: SECRETS.query,
    api_key: 'LEAK_APIKEY',
    apikey: 'LEAK_APIKEY2',
    key: 'LEAK_KEY',
    secret: 'LEAK_SECRET',
    password: SECRETS.body,
    signature: SECRETS.signature,
    sig: 'LEAK_SIG',
    keep: 'visible',
  }));
  assertNoSecrets(json);
  assert.doesNotMatch(json, /LEAK_APIKEY|LEAK_KEY|LEAK_SECRET|LEAK_SIG/);
  assert.match(json, /visible/);
  assert.match(json, /\[redacted\]/);

  // Form-encoded bodies fall back to the shared text patterns.
  const form = redactBodyString(`token=${SECRETS.query}&page=2`);
  assert.doesNotMatch(form, new RegExp(SECRETS.query));
  assert.match(form, /token=\[redacted\]/);
});

/* ------------------------------------------------------------------ *
 * Recorder: opt-in + size limit
 * ------------------------------------------------------------------ */

test('a disabled recorder records nothing and writes no file', (t) => {
  const dir = makeDataDir(t);
  const har = createHarRecorder({ dataDir: dir, id: 'session-off' });
  assert.equal(har.enabled, false);
  assert.equal(har.recordRequest({ requestId: 'r1', url: 'https://example.com/' }), null);
  assert.equal(har.recordResponse('r1', { status: 200 }), null);
  assert.equal(har.recordFailure('r1', { errorText: 'x' }), null);
  assert.deepEqual(har.snapshot().log.entries, []);
  assert.deepEqual(har.flush(), { written: false, reason: 'disabled' });
  assert.equal(fs.existsSync(harFilePath(dir, 'session-off')), false);
});

test('an enabled recorder writes a redacted HAR with no raw secret anywhere', (t) => {
  const dir = makeDataDir(t);
  const har = createHarRecorder({ enabled: true, dataDir: dir, id: 'session-on', maxBytes: DEFAULT_HAR_MAX_BYTES });
  const requestId = har.recordRequest({
    requestId: 'r1',
    method: 'post',
    url: `https://example.com/api?access_token=${SECRETS.query}&page=2`,
    headers: {
      Authorization: `Bearer ${SECRETS.auth}`,
      'Proxy-Authorization': `Basic ${SECRETS.proxyAuth}`,
      Cookie: `sid=${SECRETS.cookie}`,
      'Content-Type': 'application/json',
    },
    postData: JSON.stringify({ password: SECRETS.body, keep: 'ok' }),
    resourceType: 'xhr',
    at: 1000,
  });
  har.recordResponse(requestId, {
    status: 200,
    statusText: 'OK',
    headers: { 'Set-Cookie': `sid=${SECRETS.setCookie}; HttpOnly`, 'Content-Type': 'application/json' },
    at: 1010,
  });

  const snapshot = har.snapshot();
  const serialized = JSON.stringify(snapshot);
  assertNoSecrets(serialized);
  assert.equal(snapshot.log.entries.length, 1);
  assert.equal(snapshot.log.entries[0].response.status, 200);
  // HAR headers keep their spec array shape while sensitive values are masked.
  const requestHeaders = snapshot.log.entries[0].request.headers;
  assert.ok(Array.isArray(requestHeaders));
  const auth = requestHeaders.find((header) => header.name.toLowerCase() === 'authorization');
  assert.equal(auth.value, '[redacted]');
  assert.ok(Array.isArray(snapshot.log.entries[0].response.headers));
  assert.match(serialized, /page=2/);
  // Response bodies are never captured.
  assert.equal(snapshot.log.entries[0].response.content.text, undefined);

  const flushed = har.flush();
  assert.equal(flushed.written, true);
  const file = fs.readFileSync(harFilePath(dir, 'session-on'), 'utf8');
  assertNoSecrets(file);
  assert.match(file, /\[redacted\]/);
  assert.equal(har.status().entryCount, 1);
  assert.equal(har.status().written, true);
});

test('flush refuses an over-limit HAR instead of writing a partial/raw file', (t) => {
  const dir = makeDataDir(t);
  const har = new HarRecorder({ enabled: true, dataDir: dir, id: 'session-big', maxBytes: 2000 });
  har.recordRequest({
    requestId: 'r1',
    url: `https://example.com/?token=${SECRETS.query}`,
    postData: 'x'.repeat(6000),
  });
  const result = har.flush();
  assert.equal(result.written, false);
  assert.equal(result.reason, 'size-limit');
  assert.ok(result.byteLength > 2000);
  assert.equal(fs.existsSync(harFilePath(dir, 'session-big')), false);
  // The rejected document is still redacted (no raw data on the reject path).
  assertNoSecrets(JSON.stringify(har.snapshot()));
});

test('maxEntries drops the oldest rows and counts the drops', (t) => {
  const dir = makeDataDir(t);
  const har = createHarRecorder({ enabled: true, dataDir: dir, id: 'session-trim', maxEntries: 2 });
  for (let i = 0; i < 5; i += 1) har.recordRequest({ requestId: `r${i}`, url: `https://example.com/${i}` });
  assert.equal(har.status().entryCount, 2);
  assert.equal(har.status().dropped, 3);
  assert.deepEqual(har.snapshot().log.entries.map((entry) => entry.request.url), [
    'https://example.com/3',
    'https://example.com/4',
  ]);
});

test('a single request body capture is bounded by maxBodyBytes', (t) => {
  const dir = makeDataDir(t);
  const har = createHarRecorder({ enabled: true, dataDir: dir, id: 'session-body', maxBodyBytes: 64 });
  har.recordRequest({ requestId: 'r1', url: 'https://example.com/', postData: 'y'.repeat(5000) });
  const body = har.snapshot().log.entries[0].request.postData.text;
  assert.ok(Buffer.byteLength(body, 'utf8') < 256);
  assert.match(body, /\[truncated\]/);
});

/* ------------------------------------------------------------------ *
 * Session-manager integration
 * ------------------------------------------------------------------ */

/**
 * Minimal Playwright stand-in that lets a test emit request/response/failure
 * events. `state.pages` exposes the created page so the test can drive it.
 */
function createHarDriver() {
  const state = { pages: [], contextOptions: [] };
  class FakePage {
    constructor() {
      this._handlers = new Map();
      this._closed = false;
    }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event, arg) {
      for (const handler of this._handlers.get(event) || []) handler(arg);
    }
    isClosed() { return this._closed; }
    url() { return 'about:blank'; }
    mainFrame() { return null; }
    async close() {
      this._closed = true;
      this.emit('close');
    }
  }
  class FakeContext {
    constructor() { this.pages = []; this.routes = []; }
    on() {}
    async route(_pattern, handler) { this.routes.push(handler); }
    async newPage() {
      const page = new FakePage();
      this.pages.push(page);
      state.pages.push(page);
      return page;
    }
    async close() { for (const page of this.pages) await page.close(); }
  }
  class FakeBrowser {
    async newContext(options) {
      state.contextOptions.push(options || {});
      return new FakeContext();
    }
    isConnected() { return true; }
    async close() {}
  }
  return {
    state,
    driver: { name: 'fake', async launch() { return new FakeBrowser(); } },
  };
}

/**
 * @param {{ dataDir?: string, recordHarPolicy?: boolean, har?: boolean, maxBytes?: number }} [overrides]
 */
function createManager(overrides = {}) {
  const { driver, state } = createHarDriver();
  const managerOptions = {
    driver,
    driverStatus: { status: 'available' },
    dataDir: overrides.dataDir,
    resolvePolicy: () => ({
      allowedOrigins: ['https://example.com'],
      blockedPorts: [],
      unblockedPorts: [],
      recordHar: overrides.recordHarPolicy === true,
    }),
    lookup: async () => [{ address: '93.184.216.34' }],
  };
  if (overrides.har !== false) {
    managerOptions.har = { dataDir: overrides.dataDir, maxBytes: overrides.maxBytes };
  }
  return {
    manager: new BrowserSessionManager(managerOptions),
    state,
  };
}

/** @param {{ url: string, method?: string, headers?: object, postData?: string|null, resourceType?: string }} input */
function makeRequest(input) {
  return {
    method: () => input.method || 'GET',
    url: () => input.url,
    headers: () => input.headers || {},
    postData: () => (input.postData === undefined ? null : input.postData),
    resourceType: () => input.resourceType || 'xhr',
  };
}

/** @param {object} request @param {{ status?: number, headers?: object, statusText?: string }} [input] */
function makeResponse(request, input = {}) {
  const response = {
    status: input.status || 200,
    statusText: input.statusText || 'OK',
    headers: input.headers || {},
  };
  return {
    request: () => request,
    status: () => response.status,
    statusText: () => response.statusText,
    ok: () => true,
    headers: () => response.headers,
  };
}

test('without opt-in the manager never builds a recorder or writes a HAR file', async (t) => {
  const dir = makeDataDir(t);
  const { manager, state } = createManager({ dataDir: dir });
  const session = await manager.createSession({ ownerSessionId: OWNER, workspaceFile: WORKSPACE });
  assert.equal(session.recordHar, false);
  assert.deepEqual(session.har, { enabled: false });

  const page = state.pages[0];
  const request = makeRequest({
    url: `https://example.com/?token=${SECRETS.query}`,
    headers: { Authorization: `Bearer ${SECRETS.auth}` },
  });
  page.emit('request', request);
  page.emit('response', makeResponse(request, { headers: { 'Set-Cookie': `sid=${SECRETS.setCookie}` } }));

  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test', scope: { workspaceFile: WORKSPACE } });
  assert.equal(fs.existsSync(harFilePath(dir, session.browserSessionId)), false);
});

test('with opt-in the secrets stay out of every chat-visible payload and the HAR file', async (t) => {
  const dir = makeDataDir(t);
  const { manager, state } = createManager({ dataDir: dir });
  const session = await manager.createSession({
    ownerSessionId: OWNER,
    workspaceFile: WORKSPACE,
    recordHar: true,
  });
  assert.equal(session.recordHar, true);

  const tabId = session.tabs[0].browserTabId;
  const page = state.pages[0];
  page.emit('console', {
    type: () => 'log',
    text: () => `Authorization: Bearer ${SECRETS.console}`,
    location: () => ({}),
  });
  const request = makeRequest({
    url: `https://example.com/api?access_token=${SECRETS.query}&page=2`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRETS.auth}`,
      Cookie: `sid=${SECRETS.cookie}`,
      Accept: 'application/json',
    },
    postData: JSON.stringify({ password: SECRETS.body, signature: SECRETS.signature, keep: 'ok' }),
  });
  page.emit('request', request);
  page.emit('response', makeResponse(request, {
    status: 201,
    headers: { 'Set-Cookie': `sid=${SECRETS.setCookie}; HttpOnly`, 'Content-Type': 'application/json' },
  }));

  const network = manager.pullNetwork(session.browserSessionId, tabId, OWNER, { since: 0 }, { workspaceFile: WORKSPACE });
  const consolePull = manager.pullConsole(session.browserSessionId, tabId, OWNER, { since: 0 }, { workspaceFile: WORKSPACE });
  const summary = manager.summarizeSession(manager.sessions.get(session.browserSessionId));
  const visible = JSON.stringify({ network, consolePull, summary });
  assertNoSecrets(visible);
  assert.equal(network.entries.length, 1);
  assert.equal(network.entries[0].status, 201);

  const flushed = await manager.closeSession(session.browserSessionId, OWNER, {
    reason: 'test',
    scope: { workspaceFile: WORKSPACE },
  });
  assert.equal(flushed.closed, true);
  const file = fs.readFileSync(harFilePath(dir, session.browserSessionId), 'utf8');
  assertNoSecrets(file);
  assert.match(file, /\[redacted\]/);
  assert.match(file, /page=2/);
  assert.match(file, /ok/);
});

test('the workspace policy flag is a valid per-workspace opt-in', async (t) => {
  const dir = makeDataDir(t);
  const { manager, state } = createManager({ dataDir: dir, recordHarPolicy: true });
  const session = await manager.createSession({ ownerSessionId: OWNER, workspaceFile: WORKSPACE });
  assert.equal(session.recordHar, true);

  const page = state.pages[0];
  const request = makeRequest({ url: `https://example.com/?token=${SECRETS.query}` });
  page.emit('request', request);
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test', scope: { workspaceFile: WORKSPACE } });
  const file = fs.readFileSync(harFilePath(dir, session.browserSessionId), 'utf8');
  assertNoSecrets(file);
});

test('an opt-in without manager HAR capability still writes nothing', async (t) => {
  const dir = makeDataDir(t);
  const { manager } = createManager({ dataDir: dir, har: false });
  const session = await manager.createSession({
    ownerSessionId: OWNER,
    workspaceFile: WORKSPACE,
    recordHar: true,
  });
  assert.equal(session.recordHar, false);
  assert.equal(manager.getHarStatus(WORKSPACE).enabled, false);
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test', scope: { workspaceFile: WORKSPACE } });
  assert.equal(fs.existsSync(harFilePath(dir, session.browserSessionId)), false);
});

test('getHarStatus exposes only capability/opt-in metadata and never entries', async (t) => {
  const dir = makeDataDir(t);
  const { manager } = createManager({ dataDir: dir, recordHarPolicy: true });
  const session = await manager.createSession({
    ownerSessionId: OWNER,
    workspaceFile: WORKSPACE,
    recordHar: true,
  });
  const status = manager.getHarStatus(WORKSPACE);
  assert.deepEqual(status, { enabled: true, workspaceOptIn: true });
  const summary = manager.summarizeSession(manager.sessions.get(session.browserSessionId));
  assert.equal(summary.recordHar, true);
  assert.equal(typeof summary.har.entryCount, 'number');
  assert.equal(summary.har.lastWrite, null);
  assertNoSecrets(JSON.stringify({ status, summary }));
  await manager.closeSession(session.browserSessionId, OWNER, { reason: 'test', scope: { workspaceFile: WORKSPACE } });
});

test('redactPullPayload is a shared defensive pass even without a buffer redaction', () => {
  const { manager } = createManager({ dataDir: '/tmp/unused-har' });
  const payload = manager.redactPullPayload({
    entries: [{
      requestId: 'r1',
      url: 'https://example.com/?token=RAW',
      headers: { Authorization: `Bearer ${SECRETS.auth}`, Cookie: `sid=${SECRETS.cookie}` },
      token: SECRETS.query,
      keep: 'ok',
    }],
    nextSince: 1,
  });
  assertNoSecrets(JSON.stringify(payload));
  assert.equal(payload.entries[0].keep, 'ok');
  assert.equal(payload.nextSince, 1);
});
