import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearWidgetAuth,
  consumeWidgetOpenOnLoad,
  getOrCreatePageSessionId,
  loadStoredWidgetAuth,
  markWidgetOpenOnLoad,
  parseWidgetTokenExpiry,
  saveWidgetAuth,
} from '../app_front/embed/widgetSession.js';

const installationId = 'inst-1';
const origin = 'http://192.168.1.10:91';

function makeToken(expMs) {
  const payload = Buffer.from(JSON.stringify({
    installationId,
    pageSessionId: 'page-abc',
    exp: expMs,
  })).toString('base64url');
  return `${payload}.sig`;
}

test('getOrCreatePageSessionId reuses stable value for installation and origin', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };

  const first = getOrCreatePageSessionId(installationId, origin);
  const second = getOrCreatePageSessionId(installationId, origin);
  assert.equal(second, first);
  assert.match(first, /^page-inst-1-http:\/\/192\.168\.1\.10:91$/);
});

test('saveWidgetAuth and loadStoredWidgetAuth round-trip while token is valid', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };

  const pageSessionId = 'page-abc';
  const accessToken = makeToken(Date.now() + 60_000);
  const installation = { id: installationId, allowedOrigins: [origin] };
  saveWidgetAuth(installationId, origin, {
    pageSessionId,
    accessToken,
    installation,
  });

  const restored = loadStoredWidgetAuth(installationId, origin, pageSessionId);
  assert.ok(restored);
  assert.equal(restored.accessToken, accessToken);
  assert.equal(restored.installation.id, installationId);
});

test('loadStoredWidgetAuth drops expired token', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };

  const pageSessionId = 'page-expired';
  saveWidgetAuth(installationId, origin, {
    pageSessionId,
    accessToken: makeToken(Date.now() - 1),
    installation: { id: installationId },
  });

  assert.equal(loadStoredWidgetAuth(installationId, origin, pageSessionId), null);
});

test('parseWidgetTokenExpiry reads exp from base64url payload', () => {
  const exp = Date.now() + 120_000;
  assert.equal(parseWidgetTokenExpiry(makeToken(exp)), exp);
});

test('clearWidgetAuth removes stored auth', () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };

  const pageSessionId = 'page-clear';
  saveWidgetAuth(installationId, origin, {
    pageSessionId,
    accessToken: makeToken(Date.now() + 60_000),
    installation: { id: installationId },
  });
  clearWidgetAuth(installationId, origin);
  assert.equal(loadStoredWidgetAuth(installationId, origin, pageSessionId), null);
});

test('markWidgetOpenOnLoad and consumeWidgetOpenOnLoad round-trip once per navigation', () => {
  const storage = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); },
    removeItem: (key) => { storage.delete(key); },
  };

  assert.equal(consumeWidgetOpenOnLoad(installationId, origin), false);
  markWidgetOpenOnLoad(installationId, origin);
  assert.equal(consumeWidgetOpenOnLoad(installationId, origin), true);
  assert.equal(consumeWidgetOpenOnLoad(installationId, origin), false);
});
