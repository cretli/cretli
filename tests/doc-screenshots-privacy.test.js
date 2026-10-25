import test from 'node:test';
import assert from 'node:assert/strict';
import { findPrivateMatches, assertScreenshotClean } from '../scripts/lib/doc-screenshot-privacy.mjs';

test('privacy gate rejects private paths, addresses and injected identifiers', () => {
  const ctx = { username: 'private-user', hostname: 'private-host', privateTokens: 'secret-brand' };
  for (const text of ['/home/x/', '/Users/x/', 'C:\\Users\\x', '192.168.1.5', '10.0.0.7', '172.31.2.5', 'jan@firma.pl', 'PRIVATE-USER', 'private-host', 'secret-brand']) {
    assert.ok(findPrivateMatches(text, ctx).length, text);
  }
  for (const text of ['Neutral demo text', 'v10.2.1', 'user@example.com', 'user@example.org', 'prefixprivate-hostsuffix']) {
    assert.deepEqual(findPrivateMatches(text, ctx), []);
  }
  assert.throws(() => assertScreenshotClean({ domText: 'Clean', ocrText: '/home/x/', ctx }), /Privacy gate/);
  assert.doesNotThrow(() => assertScreenshotClean({ domText: 'Clean', ocrText: 'Also clean', ctx }));
});
