/**
 * Browser redaction contract tests (P0: secrets never leave Node).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSensitiveHeaderName,
  isSensitiveQueryParam,
  redactHeaders,
  redactText,
  redactTextCapped,
  redactUrl,
  redactValue,
  SENSITIVE_HEADERS,
} from '../lib/browser/redaction.js';
import { redactDebuggerPayload } from '../lib/browser/debugger.js';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';

test('redacts sensitive headers but keeps safe ones', () => {
  const out = redactHeaders({
    Authorization: 'Bearer abc123',
    Cookie: 'sid=deadbeef',
    'Set-Cookie': 'sid=deadbeef; HttpOnly',
    'X-Api-Key': 'sk-live-123',
    Accept: 'application/json',
  });
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.Cookie, '[redacted]');
  assert.equal(out['Set-Cookie'], '[redacted]');
  assert.equal(out['X-Api-Key'], '[redacted]');
  assert.equal(out.Accept, 'application/json');
  assert.equal(isSensitiveHeaderName('X-My-Token'), true);
  assert.equal(isSensitiveHeaderName('Accept'), false);
});

test('redacts sensitive query params and keeps the rest', () => {
  const out = redactUrl('https://example.com/path?token=abc123&q=hello&api_key=sk-1&page=2');
  assert.match(out, /token=(?:%5Bredacted%5D|\[redacted\])/);
  assert.match(out, /api_key=(?:%5Bredacted%5D|\[redacted\])/);
  assert.match(out, /q=hello/);
  assert.match(out, /page=2/);
  assert.equal(isSensitiveQueryParam('access_token'), true);
  assert.equal(isSensitiveQueryParam('page'), false);
});

test('redacts secrets in free text without breaking the text', () => {
  assert.equal(redactText('Authorization: Bearer abc123def'), 'Authorization: [redacted]');
  assert.equal(redactText('Set-Cookie: sid=deadbeef; HttpOnly'), 'Set-Cookie: [redacted]');
  assert.equal(redactText('password=hunter2 and token=xyz'), 'password=[redacted] and token=[redacted]');
  assert.equal(redactText('{"password":"hunter2"}'), '{"password":"[redacted]"}');
  assert.equal(redactText('api_key: sk-live-1234567890'), 'api_key: [redacted]');
});

test('strips credentials embedded in a URL', () => {
  const out = redactUrl('https://user:supersecret@example.com/private?q=1');
  assert.doesNotMatch(out, /supersecret/);
  assert.doesNotMatch(out, /user:/);
  assert.match(out, /example\.com/);
  assert.match(out, /q=1/);
});

test('redacts URL userinfo inside free text', () => {
  const out = redactText('failed to load https://alice:hunter2@example.com/x');
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /example\.com/);
});

test('redactValue recurses and caps depth/breadth', () => {
  const out = redactValue({
    Cookie: 'sid=deadbeef',
    nested: { token: 'abc123', keep: 'ok' },
    list: Array.from({ length: 5 }, (_, i) => ({ password: `p${i}` })),
  });
  assert.equal(out.Cookie, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.keep, 'ok');
  assert.equal(out.list.length, 5);
});

test('redactTextCapped bounds output bytes and flags truncation', () => {
  const capped = redactTextCapped('token=abcdefghij', 8);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.value, 'utf8') <= 8);
  const fits = redactTextCapped('token=abcdefghij', 1024);
  assert.equal(fits.truncated, false);
});

test('redacts sensitive params in the URL fragment (OAuth implicit flow)', () => {
  const out = redactUrl('https://app.test/cb#access_token=supersecret&id_token=jwt-value&state=xyz');
  assert.doesNotMatch(out, /supersecret/);
  assert.doesNotMatch(out, /jwt-value/);
  assert.match(out, /access_token=(?:%5Bredacted%5D|\[redacted\])/);
  assert.match(out, /id_token=(?:%5Bredacted%5D|\[redacted\])/);
  assert.match(out, /state=xyz/);
});

test('leaves a plain anchor fragment untouched', () => {
  const out = redactUrl('https://app.test/docs#section-two');
  assert.equal(out, 'https://app.test/docs#section-two');
});

test('redactValue masks CDP RemoteObject description for sensitive pin and bigint', () => {
  const pinShape = {
    name: 'pin',
    value: { type: 'number', value: 1234, description: '1234' },
    writable: true,
    configurable: true,
    enumerable: true,
  };
  const bigintShape = {
    name: 'apiSecret',
    value: { type: 'bigint', unserializableValue: '99887766n', description: '99887766n' },
    writable: true,
    configurable: true,
    enumerable: true,
  };
  const out = redactValue([pinShape, bigintShape], { maxDepth: 5, maxItems: 40 });
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /1234/);
  assert.doesNotMatch(text, /99887766n/);
  assert.match(text, /\[redacted\]/);
});

test('redactValue masks plain object keys with isSensitiveVariableName (watch returnByValue)', () => {
  const out = redactValue({
    type: 'object',
    value: {
      accessToken: 'LEAK_AT',
      refreshToken: 'LEAK_RT',
      clientSecret: 'LEAK_CS',
      userPassword: 'LEAK_PW',
      sessionId: 'LEAK_SID',
      count: 42,
      safeLabel: 'visible',
    },
  });
  assert.equal(out.value.accessToken, '[redacted]');
  assert.equal(out.value.refreshToken, '[redacted]');
  assert.equal(out.value.clientSecret, '[redacted]');
  assert.equal(out.value.userPassword, '[redacted]');
  assert.equal(out.value.sessionId, '[redacted]');
  assert.equal(out.value.count, 42);
  assert.equal(out.value.safeLabel, 'visible');
});

test('redactDebuggerPayload masks watch Runtime.evaluate RemoteObject returnByValue (real CDP shape)', () => {
  const payload = redactDebuggerPayload({
    result: {
      type: 'object',
      value: {
        accessToken: 'LEAK_AT',
        userPassword: 'LEAK_PW',
        sessionId: 'LEAK_SID',
        count: 42,
      },
    },
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /LEAK_AT/);
  assert.doesNotMatch(text, /LEAK_PW/);
  assert.doesNotMatch(text, /LEAK_SID/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /"count":42|"count": 42/);
});

test('redactDebuggerPayload masks returnByValue array of objects on RemoteObject.value (A-2a)', () => {
  const payload = redactDebuggerPayload({
    result: {
      type: 'object',
      value: [{ accessToken: 'LEAK_AT' }, { count: 1 }],
    },
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /LEAK_AT/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /"count":1|"count": 1/);
});

test('redactDebuggerPayload masks nested returnByValue arrays on RemoteObject.value (A-2c)', () => {
  const payload = redactDebuggerPayload({
    result: {
      type: 'object',
      value: [[{ accessToken: 'LEAK_AT' }], [{ note: 'ok', count: 1 }]],
    },
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /LEAK_AT/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /ok/);
  assert.match(text, /"count":1|"count": 1/);
});

test('redactDebuggerPayload masks sensitive sibling keys on RemoteObject (A-2b)', () => {
  const payload = redactDebuggerPayload({
    result: {
      type: 'object',
      accessToken: 'LEAK_AT',
      note: 'ok',
    },
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /LEAK_AT/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /ok/);
});

test('redactValue masks ObjectPreview properties by variable name (real CDP shape)', () => {
  const out = redactValue({
    type: 'object',
    preview: {
      type: 'object',
      properties: [
        { name: 'clientSecret', type: 'string', value: 'LEAK_CS' },
        { name: 'count', type: 'number', value: '42' },
      ],
    },
  });
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /LEAK_CS/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /42/);
});

/** Builds a nested CDP RemoteObject chain via `value` (returnByValue-style). */
function buildNestedRemoteObjectChain(depth) {
  let node = { type: 'string', value: 'leaf' };
  for (let i = 0; i < depth; i += 1) {
    node = { type: 'object', value: node };
  }
  return node;
}

test('redactDebuggerPayload caps wide root returnByValue array (cost boundary)', () => {
  const wide = Array.from({ length: 5000 }, (_, i) => ({ k: i }));
  const payload = redactDebuggerPayload({
    result: { type: 'object', value: wide },
  }, BROWSER_LIMITS);
  const arr = payload.value.result.value;
  assert.ok(Array.isArray(arr));
  assert.ok(arr.length <= BROWSER_LIMITS.DEBUGGER_REDACT_MAX_ITEMS);
});

test('redactDebuggerPayload survives deep RemoteObject chain without RangeError', () => {
  const chain = buildNestedRemoteObjectChain(15000);
  let payload;
  assert.doesNotThrow(() => {
    payload = redactDebuggerPayload({ result: chain }, BROWSER_LIMITS);
  });
  const text = JSON.stringify(payload.value);
  assert.match(text, /\[truncated\]/);
  assert.doesNotMatch(text, /LEAK_SHALLOW/);
});

/** Builds a nested CDP RemoteObject chain via `value: [next]` (mixed array path). */
function buildNestedRemoteObjectArrayChain(depth, leafValue = 'LEAF_SECRET') {
  let node = { type: 'string', value: leafValue };
  for (let i = 0; i < depth; i += 1) {
    node = { type: 'object', value: [node] };
  }
  return node;
}

/** Builds a nested CDP RemoteObject chain via `properties` (mixed scope path). */
function buildNestedRemoteObjectPropertiesChain(depth, leafValue = 'LEAF_SECRET') {
  let node = { type: 'string', value: leafValue };
  for (let i = 0; i < depth; i += 1) {
    node = { type: 'object', properties: [{ name: 'child', value: node }] };
  }
  return node;
}

/** Builds a nested chain via property descriptors that expose only `get` (accessor path). */
function buildNestedRemoteObjectGetterChain(depth, leafValue = 'LEAF') {
  let node = { type: 'string', value: leafValue };
  for (let i = 0; i < depth; i += 1) {
    node = { type: 'object', properties: [{ name: 'child', get: node }] };
  }
  return node;
}

/** Descriptor with shallow `value` and deep `get` chain (CDP accessor + data). */
function buildGetBesideValueChain(depth, leafValue = 'DEEP_LEAF') {
  let getNode = { type: 'string', value: leafValue };
  for (let i = 0; i < depth; i += 1) {
    getNode = {
      type: 'object',
      properties: [{
        name: 'x',
        value: { type: 'string', value: 'v' },
        get: getNode,
      }],
    };
  }
  return getNode;
}

test('redactDebuggerPayload survives 20k RemoteObject chain via value array without RangeError (mixed depth)', () => {
  const chain = buildNestedRemoteObjectArrayChain(20000);
  let payload;
  assert.doesNotThrow(() => {
    payload = redactDebuggerPayload({ result: chain }, BROWSER_LIMITS);
  });
  const text = JSON.stringify(payload.value);
  assert.match(text, /\[truncated\]/);
  assert.doesNotMatch(text, /LEAF_SECRET/);
});

test('redactDebuggerPayload survives 20k RemoteObject chain via properties without RangeError (mixed depth)', () => {
  const chain = buildNestedRemoteObjectPropertiesChain(20000);
  let payload;
  assert.doesNotThrow(() => {
    payload = redactDebuggerPayload({ result: chain }, BROWSER_LIMITS);
  });
  const text = JSON.stringify(payload.value);
  assert.match(text, /\[truncated\]/);
  assert.doesNotMatch(text, /LEAF_SECRET/);
});

test('redactDebuggerPayload survives 20k getter-only property chain without RangeError', () => {
  const chain = buildNestedRemoteObjectGetterChain(20000);
  let payload;
  assert.doesNotThrow(() => {
    payload = redactDebuggerPayload({ result: chain }, BROWSER_LIMITS);
  });
  const text = JSON.stringify(payload.value);
  assert.match(text, /\[truncated\]/);
  assert.doesNotMatch(text, /LEAF/);
});

test('redactDebuggerPayload survives 20k get beside value property chain without RangeError', () => {
  const chain = buildGetBesideValueChain(20000);
  let payload;
  assert.doesNotThrow(() => {
    payload = redactDebuggerPayload({ result: chain }, BROWSER_LIMITS);
  });
  const text = JSON.stringify(payload.value);
  assert.match(text, /\[truncated\]/);
  assert.doesNotMatch(text, /DEEP_LEAF/);
});

test('redactDebuggerPayload regresses nested returnByValue secret and wide array cap (r9)', () => {
  const nestedSecret = redactDebuggerPayload({
    result: {
      type: 'object',
      value: [[{ accessToken: 'LEAK_AT' }], [{ note: 'ok', count: 42 }]],
    },
  }, BROWSER_LIMITS);
  const nestedText = JSON.stringify(nestedSecret.value);
  assert.doesNotMatch(nestedText, /LEAK_AT/);
  assert.match(nestedText, /\[redacted\]/);
  assert.match(nestedText, /"count":42|"count": 42/);
  const wide = Array.from({ length: 5000 }, (_, i) => ({ k: i }));
  const widePayload = redactDebuggerPayload({
    result: { type: 'object', value: wide },
  }, BROWSER_LIMITS);
  const arr = widePayload.value.result.value;
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, BROWSER_LIMITS.DEBUGGER_REDACT_MAX_ITEMS);
});

test('redactDebuggerPayload redacts shallow secret on mixed value-array path (depth budget)', () => {
  const payload = redactDebuggerPayload({
    result: {
      type: 'object',
      value: [{ accessToken: 'LEAK_AT', note: 'ok', count: 42 }],
    },
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /LEAK_AT/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /"count":42|"count": 42/);
  assert.match(text, /ok/);
});

test('redactDebuggerPayload redacts shallow sensitive key beside deep RemoteObject value', () => {
  const inner = buildNestedRemoteObjectChain(200);
  const payload = redactDebuggerPayload({
    result: {
      type: 'object',
      accessToken: 'LEAK_SHALLOW',
      note: 'ok',
      value: inner.value,
    },
  }, BROWSER_LIMITS);
  const text = JSON.stringify(payload.value);
  assert.doesNotMatch(text, /LEAK_SHALLOW/);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /ok/);
});

test('treats the Browser local-login token as a sensitive header', () => {
  // `x-cretli-local-login` is a passwordless credential, so it is both redacted
  // in diagnostics and cleared by the cross-origin header strip. Removing it
  // from the sensitive list would silently re-open both leaks.
  assert.equal(isSensitiveHeaderName('x-cretli-local-login'), true);
  assert.equal(isSensitiveHeaderName('X-Cretli-Local-Login'), true);
  assert.equal(SENSITIVE_HEADERS.includes('x-cretli-local-login'), true);
  // A stand-in value, never the live token: a failing assert would echo it.
  const out = redactHeaders({ 'x-cretli-local-login': 'a'.repeat(48), Accept: 'text/html' });
  assert.equal(out['x-cretli-local-login'], '[redacted]');
  assert.doesNotMatch(JSON.stringify(out), /aaaa/);
  assert.equal(out.Accept, 'text/html');
});
