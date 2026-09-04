import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractAssetVersionFromHeaders,
  extractFrontAssetVersion,
  hasNewerFrontAssetVersion,
  readBootAssetVersionFromDocument,
  readScriptAssetVersion,
  resolvePolledFrontAssetVersion,
} from '../app_front/features/pwa/pwaUpdatePrompt.js';

test('readScriptAssetVersion reads the cache-bust query', () => {
  assert.equal(readScriptAssetVersion('/dist/app/index.bundle.js?v=1700000000000'), '1700000000000');
  assert.equal(readScriptAssetVersion('/dist/app/index.bundle.js'), '');
  assert.equal(readScriptAssetVersion(''), '');
});

test('extractFrontAssetVersion reads health payloads', () => {
  assert.equal(extractFrontAssetVersion({ frontAssetVersion: '42' }), '42');
  assert.equal(extractFrontAssetVersion({ frontAssetVersion: 42 }), '42');
  assert.equal(extractFrontAssetVersion({ ok: true }), '');
  assert.equal(extractFrontAssetVersion(null), '');
});

test('hasNewerFrontAssetVersion requires both versions and a mismatch', () => {
  assert.equal(hasNewerFrontAssetVersion('1', '2'), true);
  assert.equal(hasNewerFrontAssetVersion('1', '1'), false);
  assert.equal(hasNewerFrontAssetVersion('', '2'), false);
  assert.equal(hasNewerFrontAssetVersion('1', ''), false);
});

test('readBootAssetVersionFromDocument finds the SPA bundle query', () => {
  const inputScripts = [
    { getAttribute: (name) => (name === 'src' ? '/dist/app/vendor.bundle.js?v=1' : null) },
    { getAttribute: (name) => (name === 'src' ? '/dist/app/index.bundle.js?v=99' : null) },
  ];
  const inputRoot = {
    querySelectorAll: (selector) => (selector === 'script[src]' ? inputScripts : []),
  };
  assert.equal(readBootAssetVersionFromDocument(inputRoot), '99');
});

test('extractAssetVersionFromHeaders prefers last-modified over etag', () => {
  const inputHeaders = {
    get: (name) => {
      if (name === 'last-modified') return 'Thu, 03 Sep 2026 21:25:58 GMT';
      if (name === 'etag') return 'W/"abc"';
      return null;
    },
  };
  assert.equal(
    extractAssetVersionFromHeaders(inputHeaders),
    'Thu, 03 Sep 2026 21:25:58 GMT',
  );
});

test('resolvePolledFrontAssetVersion prefers health over bundle headers', () => {
  assert.deepEqual(
    resolvePolledFrontAssetVersion({ healthVersion: '100', headerVersion: 'etag' }),
    { source: 'health', version: '100' },
  );
  assert.deepEqual(
    resolvePolledFrontAssetVersion({ headerVersion: 'etag' }),
    { source: 'head', version: 'etag' },
  );
  assert.deepEqual(resolvePolledFrontAssetVersion({}), { source: '', version: '' });
});

