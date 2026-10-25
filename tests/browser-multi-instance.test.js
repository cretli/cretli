/**
 * Browser multi-instance guard — env detection and session creation gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBrowserSingleInstance,
  isBrowserMultiInstanceUnsupported,
  readBrowserRedisUrl,
} from '../lib/browser/multi-instance.js';
import { BrowserError, BrowserSessionManager } from '../lib/browser/session-manager.js';

const SCOPE = { workspaceFile: '/ws/a' };
const OWNER = 'owner-a';

const ENV_KEYS = [
  'CRETLI_REDIS_URL',
  'CURSOR_REMOTE_REDIS_URL',
  'CRETLI_BROWSER_ALLOW_MULTI_INSTANCE',
];

/** @type {Record<string, string|undefined>} */
let savedEnv = {};

test.beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function createFakeDriver() {
  return {
    name: 'fake',
    async launch() {
      return {
        isConnected: () => true,
        async newContext() {
          return {
            pages: [],
            async route() {},
            on() {},
            async newPage() {
              const page = {
                _url: 'about:blank',
                url() { return this._url; },
                on() {},
                context() { return ctx; },
                async goto() {},
                async close() {},
              };
              const ctx = {
                browser: null,
                pages: [page],
                async close() {},
              };
              page.context = () => ctx;
              return page;
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
}

function createManager(overrides = {}) {
  return new BrowserSessionManager({
    driver: createFakeDriver(),
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
    ...overrides,
  });
}

test('readBrowserRedisUrl prefers current key and legacy alias', () => {
  assert.equal(readBrowserRedisUrl({}), '');
  assert.equal(readBrowserRedisUrl({ CRETLI_REDIS_URL: 'redis://a' }), 'redis://a');
  assert.equal(readBrowserRedisUrl({ CURSOR_REMOTE_REDIS_URL: 'redis://legacy' }), 'redis://legacy');
  assert.equal(
    readBrowserRedisUrl({ CRETLI_REDIS_URL: 'redis://current', CURSOR_REMOTE_REDIS_URL: 'redis://legacy' }),
    'redis://current',
  );
});

test('isBrowserMultiInstanceUnsupported reflects Redis URL and opt-in', () => {
  assert.equal(isBrowserMultiInstanceUnsupported({}), false);
  process.env.CRETLI_REDIS_URL = 'redis://127.0.0.1:6379';
  assert.equal(isBrowserMultiInstanceUnsupported(process.env), true);
  process.env.CRETLI_BROWSER_ALLOW_MULTI_INSTANCE = '1';
  assert.equal(isBrowserMultiInstanceUnsupported(process.env), false);
  delete process.env.CRETLI_REDIS_URL;
  process.env.CURSOR_REMOTE_REDIS_URL = 'redis://legacy';
  delete process.env.CRETLI_BROWSER_ALLOW_MULTI_INSTANCE;
  assert.equal(isBrowserMultiInstanceUnsupported(process.env), true);
});

test('assertBrowserSingleInstance throws 503 when multi-instance without opt-in', () => {
  const env = { CRETLI_REDIS_URL: 'redis://127.0.0.1:6379' };
  assert.throws(
    () => assertBrowserSingleInstance(env),
    (err) => err instanceof BrowserError
      && err.code === 'browser-multi-instance-unsupported'
      && err.status === 503,
  );
  assert.doesNotThrow(() => assertBrowserSingleInstance({}));
  assert.doesNotThrow(() => assertBrowserSingleInstance({
    CRETLI_REDIS_URL: 'redis://127.0.0.1:6379',
    CRETLI_BROWSER_ALLOW_MULTI_INSTANCE: '1',
  }));
});

test('createSession rejects when multiInstanceGuard throws and does not register a session', async () => {
  process.env.CRETLI_REDIS_URL = 'redis://127.0.0.1:6379';
  const manager = createManager({
    multiInstanceGuard: () => assertBrowserSingleInstance(process.env),
  });
  await assert.rejects(
    () => manager.createSession({ ownerSessionId: OWNER, ...SCOPE }),
    (err) => err instanceof BrowserError && err.code === 'browser-multi-instance-unsupported',
  );
  assert.equal(manager.sessions.size, 0);
});

test('createSession succeeds without multiInstanceGuard (default)', async () => {
  const manager = createManager();
  const session = await manager.createSession({ ownerSessionId: OWNER, ...SCOPE });
  assert.ok(session.browserSessionId);
  assert.equal(manager.sessions.size, 1);
});
