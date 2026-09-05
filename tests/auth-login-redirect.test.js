import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLoginRedirect } from '../lib/auth.js';

test('a plain request redirects to bare /login', () => {
  assert.equal(buildLoginRedirect({ originalUrl: '/' }), '/login');
  assert.equal(buildLoginRedirect({}), '/login');
});

test('deep-link params survive the redirect to /login', () => {
  const actual = buildLoginRedirect({ originalUrl: '/?panel=chat&chat=abc-123' });
  assert.equal(actual, `/login?next=${encodeURIComponent('/?panel=chat&chat=abc-123')}`);
  const next = new URLSearchParams(actual.split('?')[1]).get('next');
  assert.equal(next, '/?panel=chat&chat=abc-123');
});

test('the next target stays same-origin even for attacker-controlled input', () => {
  const actual = buildLoginRedirect({ originalUrl: '/?next=https://evil.example.com' });
  const next = new URLSearchParams(actual.split('?')[1]).get('next');
  assert.ok(next.startsWith('/?'), `expected a relative path, got ${next}`);
  const resolved = new URL(next, 'https://cretli.local');
  assert.equal(resolved.origin, 'https://cretli.local');
});

test('SPA view paths survive the redirect to /login', () => {
  const actual = buildLoginRedirect({ originalUrl: '/settings/workspace?source=pwa' });
  assert.equal(actual, `/login?next=${encodeURIComponent('/settings/workspace?source=pwa')}`);
});

test('non-shell paths do not become login next targets', () => {
  assert.equal(buildLoginRedirect({ originalUrl: '/api/settings' }), '/login');
  assert.equal(buildLoginRedirect({ originalUrl: '//evil.example.com' }), '/login');
  assert.equal(buildLoginRedirect({ originalUrl: '/login' }), '/login');
});
