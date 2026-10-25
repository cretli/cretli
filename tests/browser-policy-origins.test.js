import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserPolicyOrigins } from '../app_front/features/settings/browserPolicyOrigins.js';

test('origins are normalized, deduplicated and default to http', () => {
  const { origins, invalid } = parseBrowserPolicyOrigins([
    'http://localhost:3010/Users/profile',
    '  localhost:3010  ',
    '',
    'https://your-pc:3011',
    'HTTPS://Example.com/path?q=1',
  ].join('\n'));
  assert.deepEqual(origins, ['http://localhost:3010', 'https://your-pc:3011', 'https://example.com']);
  assert.deepEqual(invalid, []);
});

test('non-http schemes, credentials and garbage are reported, not dropped', () => {
  const { origins, invalid } = parseBrowserPolicyOrigins('ftp://example.com\nhttp://user:pw@example.com\nhttp://\nhttps://ok.test');
  assert.deepEqual(origins, ['https://ok.test']);
  assert.deepEqual(invalid, ['ftp://example.com', 'http://user:pw@example.com', 'http://']);
});
