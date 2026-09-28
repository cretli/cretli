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
} from '../lib/browser/redaction.js';

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
