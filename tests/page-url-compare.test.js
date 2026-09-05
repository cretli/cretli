import assert from 'node:assert/strict';
import test from 'node:test';
import { findChatPinnedToPageUrl, isSamePageUrl, normalizePageUrlForCompare } from '../lib/widget/widget-page-url.js';

test('normalizePageUrlForCompare strips trailing slash and hash', () => {
  const left = normalizePageUrlForCompare('http://192.0.2.10:91/foo/bar/#section');
  const right = normalizePageUrlForCompare('http://192.0.2.10:91/foo/bar');
  assert.equal(left, right);
});

test('isSamePageUrl treats equivalent host page URLs as equal', () => {
  assert.equal(
    isSamePageUrl('http://192.0.2.10:91/products/', 'http://192.0.2.10:91/products'),
    true,
  );
  assert.equal(
    isSamePageUrl('http://192.0.2.10:91/a', 'http://192.0.2.10:91/b'),
    false,
  );
});

test('findChatPinnedToPageUrl returns only one chat for equivalent URLs', () => {
  const chats = [
    { id: 'a', widgetPinnedUrl: 'http://host/page/' },
    { id: 'b', widgetPinnedUrl: 'http://host/other' },
  ];
  const linked = findChatPinnedToPageUrl(chats, 'http://host/page#top');
  assert.equal(linked?.id, 'a');
});

test('findChatPinnedToPageUrl prefers the newest pinned chat', () => {
  const chats = [
    {
      id: 'old',
      widgetPinnedUrl: 'http://host/page',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'new',
      widgetPinnedUrl: 'http://host/page/',
      createdAt: '2026-09-04T12:00:00.000Z',
      updatedAt: '2026-09-04T12:00:00.000Z',
    },
  ];
  const linked = findChatPinnedToPageUrl(chats, 'http://host/page');
  assert.equal(linked?.id, 'new');
});
