import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  applyArchiveScrollAnchor,
  archiveWindowChatIds,
  buildArchiveRowOffsetPrefix,
  computeArchiveListScrollTopForAnchor,
  computeSidebarArchiveMountedRowLimit,
  findArchiveRowIndexAtScroll,
  selectArchiveVisibleWindow,
  shouldArchiveScrollAnchorCompensate,
  SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX,
} from '../app_front/features/sidebar/sidebarArchiveVirtualizer.js';
import { __resetSidebarArchiveVirtualStateForTest } from '../app_front/features/sidebar/sidebarArchiveVirtualState.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('mounted row limit for test viewport is 21 rows', () => {
  const limit = computeSidebarArchiveMountedRowLimit(SIDEBAR_ARCHIVE_TEST_VIEWPORT_HEIGHT_PX);
  assert.equal(limit, 21);
});

test('1500 and 10000 archived rows stay within viewport budget', () => {
  const limit = computeSidebarArchiveMountedRowLimit(400);
  for (const total of [1500, 10000]) {
    const atTop = selectArchiveVisibleWindow(total, 0, 400, null, { maxMounted: limit });
    assert.ok(atTop.endIndex - atTop.startIndex <= limit, `top window for ${total}`);
    const prefix = buildArchiveRowOffsetPrefix(Array.from({ length: total }, () => 32));
    const midIndex = findArchiveRowIndexAtScroll(prefix, 32 * 500);
    const midScroll = 32 * Math.max(0, midIndex - 2);
    const mid = selectArchiveVisibleWindow(total, midScroll, 400, null, { maxMounted: limit });
    assert.ok(mid.endIndex - mid.startIndex <= limit, `mid window for ${total}`);
    assert.ok(mid.startIndex > 0, `mid window scrolls for ${total}`);
  }
});

test('variable row heights shift window without exceeding budget', () => {
  const heights = [32, 32, 64, 32, 96, 32, 32, 32, 32, 32];
  const prefix = buildArchiveRowOffsetPrefix(heights);
  const scrollTop = prefix[4];
  const window = selectArchiveVisibleWindow(heights.length, scrollTop, 400, heights, { maxMounted: 8 });
  assert.ok(window.endIndex - window.startIndex <= 8);
  assert.ok(window.topSpacerPx >= 0);
  assert.ok(window.bottomSpacerPx >= 0);
  assert.equal(window.topSpacerPx, prefix[window.startIndex]);
});

test('scroll anchoring compensates top spacer growth', () => {
  const nextScroll = applyArchiveScrollAnchor(100, 160, 250);
  assert.equal(nextScroll, 310);
});

test('scroll anchor compensation skips when startIndex moves', () => {
  assert.equal(shouldArchiveScrollAnchorCompensate(10, 14, 320, 448), false);
  assert.equal(shouldArchiveScrollAnchorCompensate(10, 10, 320, 336), true);
});

test('computeArchiveListScrollTopForAnchor centers active row', () => {
  const scrollTop = computeArchiveListScrollTopForAnchor(200, 150, 400, null);
  assert.ok(scrollTop > 0);
  assert.ok(scrollTop < 150 * 32);
});

test('archiveWindowChatIds uses stable chat ids from tree slice', () => {
  const tree = [
    { chat: { id: 'a' } },
    { chat: { id: 'b' } },
    { chat: { id: 'c' } },
  ];
  const ids = archiveWindowChatIds({ startIndex: 1, endIndex: 3 }, tree);
  assert.deepEqual(ids, ['b', 'c']);
});

test('active chat anchor expands window to include anchor index', () => {
  const total = 200;
  const window = selectArchiveVisibleWindow(total, 0, 400, null, {
    maxMounted: 21,
    anchorIndex: 150,
  });
  assert.ok(window.startIndex <= 150);
  assert.ok(window.endIndex > 150);
});

test('documentation records custom window choice', () => {
  const doc = readFileSync(resolve(repoRoot, 'docs/archive-virtualization-7.2.md'), 'utf8');
  assert.match(doc, /custom viewport window/i);
  assert.match(doc, /@lit-labs\/virtualizer/);
  assert.match(doc, /\b21\b/);
});

test('virtual state resets in tests', () => {
  __resetSidebarArchiveVirtualStateForTest();
  assert.ok(true);
});
