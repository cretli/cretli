import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchiveRowIndexById } from '../app_front/features/sidebar/sidebarArchiveVirtualizer.js';

/**
 * Regression guard for the archive virtual-scroll hot path:
 * `_measureMountedRowHeights` used to call `rows.findIndex(...)` for every
 * mounted host on every sync, i.e. O(rows · mountedRows) rescans of a ~1.8k row
 * tree. The group now builds a `chatId -> index` map once per sync via
 * `buildArchiveRowIndexById`. Mounted rows still receive `requestUpdate()` on
 * every group `updated()` so harness icons and favorites stay in sync.
 *
 * Tests stay behavioural: a Proxy counts real array reads instead of grepping
 * the source for `findIndex`.
 */

/**
 * @param {number} n
 * @returns {{ rows: Array<{ chat: { id: string } }>, reads: () => number }}
 */
function countingRows(n) {
  let numericReads = 0;
  const target = Array.from({ length: n }, (_, i) => ({ chat: { id: `arch-${i}` } }));
  const rows = new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) numericReads += 1;
      return Reflect.get(obj, prop, receiver);
    },
  });
  return { rows, reads: () => numericReads };
}

test('buildArchiveRowIndexById builds in one linear pass and lookups never rescan rows', () => {
  const n = 1785;
  const { rows, reads } = countingRows(n);
  const index = buildArchiveRowIndexById(rows);
  assert.equal(index.size, n);
  const readsAfterBuild = reads();
  assert.equal(readsAfterBuild, n, 'index build must read each row exactly once');

  // Simulate the mounted-host lookups that used to run one `findIndex` per host.
  const mountedHostIds = Array.from({ length: 31 }, (_, i) => `arch-${i * 7}`);
  for (const id of mountedHostIds) {
    assert.equal(index.get(id), Number(id.slice('arch-'.length)));
  }
  assert.equal(
    reads(),
    readsAfterBuild,
    'chatId lookups must be Map hits, not rows rescans',
  );
});

test('buildArchiveRowIndexById keeps the first duplicate id and skips blanks', () => {
  const index = buildArchiveRowIndexById([
    { chat: { id: 'a' } },
    { chat: { id: '   ' } },
    { chat: { id: 'a' } },
    { chat: {} },
    null,
    { chat: { id: 'b' } },
  ]);
  assert.equal(index.get('a'), 0);
  assert.equal(index.get('b'), 5);
  assert.equal(index.size, 2);
});

test('buildArchiveRowIndexById tolerates non-array input', () => {
  assert.equal(buildArchiveRowIndexById(null).size, 0);
  assert.equal(buildArchiveRowIndexById(undefined).size, 0);
});
