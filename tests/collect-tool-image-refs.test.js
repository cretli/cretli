import test from 'node:test';
import assert from 'node:assert/strict';
import { collectToolImageRefs, isImageOnlyToolOutput } from '../app_front/features/chat/history/services/inlineImages.js';

const FILE = '1700000000000-0a1b2c3d-0000-4000-8000-0123456789ab.jpg';
const URL_ = `/api/chats/chat-1/media/${FILE}`;

test('reads structured frame.mediaUrl', () => {
  const refs = collectToolImageRefs({ result: { structuredContent: { frame: { mediaUrl: URL_ } } } });
  assert.deepEqual(refs.map((r) => r.href), [URL_]);
});

test('reads Preview line and deduplicates against structured url', () => {
  const refs = collectToolImageRefs({
    result: { structuredContent: { frame: { mediaUrl: URL_ } }, content: [{ text: `Screenshot saved\nPreview: ${URL_}` }] },
  });
  assert.equal(refs.length, 1);
});

test('reads chat-media path from args', () => {
  const refs = collectToolImageRefs({ args: { path: `/data/chat-media/chat-2/${FILE}` } });
  assert.deepEqual(refs.map((r) => r.href), [`/api/chats/chat-2/media/${FILE}`]);
});

test('ignores foreign and malformed urls', () => {
  assert.deepEqual(collectToolImageRefs({ result: { text: 'Preview: https://evil.test/a.jpg' } }), []);
  assert.deepEqual(collectToolImageRefs({ result: { text: 'Preview: /api/chats/c/media/x.svg' } }), []);
  assert.deepEqual(collectToolImageRefs(null), []);
});

test('recognizes the [image: <url> mime bytes] marker', () => {
  const refs = collectToolImageRefs({ result: `see [image: ${URL_} image/png 608B] done` });
  assert.deepEqual(refs.map((r) => r.href), [URL_]);
  assert.deepEqual(collectToolImageRefs({ result: '[image: https://evil.test/a.png image/png 1B]' }), []);
});

test('uses the read file path as the image caption', () => {
  const refs = collectToolImageRefs({
    args: { file_path: '/repo/out/preview.png' },
    result: `[image: ${URL_} image/jpeg 608B]`,
  });
  assert.deepEqual(refs, [{ source: '/repo/out/preview.png', href: URL_ }]);
});

test('detects output made only of image markers', () => {
  assert.equal(isImageOnlyToolOutput(`[image: ${URL_} image/jpeg 608B]`), true);
  assert.equal(isImageOnlyToolOutput(` [image: ${URL_} image/png 1B]\n[image: ${URL_} image/png 2B] `), true);
  assert.equal(isImageOnlyToolOutput(`done [image: ${URL_} image/png 1B]`), false);
  assert.equal(isImageOnlyToolOutput('[image omitted]'), false);
  assert.equal(isImageOnlyToolOutput(null), false);
});
