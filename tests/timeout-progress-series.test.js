import assert from 'node:assert/strict';
import {
  findAdjacentTimeoutProgressSeriesBlock,
  foldTrailingTimeoutProgressSeriesBlocks,
  isTimeoutProgressSeriesBlock,
  isTimeoutProgressSeriesSkipNode,
  listTrailingTimeoutProgressSeriesBlocks,
  TIMEOUT_PROGRESS_SERIES_CLASS,
  TIMEOUT_PROGRESS_UPDATES_CAP,
} from '../app_front/features/chat/timeoutProgressSeries.js';

function createNode({ className = '', hidden = false, prev = null } = {}) {
  const names = className.split(/\s+/).filter(Boolean);
  return {
    hidden,
    className,
    classList: {
      contains(name) {
        return names.includes(name);
      },
    },
    previousElementSibling: prev,
  };
}

const series = createNode({ className: TIMEOUT_PROGRESS_SERIES_CLASS });
const hiddenStatus = createNode({
  className: 'sdk-rich-line sdk-rich-line--status',
  hidden: true,
  prev: series,
});
const muted = createNode({
  className: 'sdk-rich-line sdk-rich-line--muted',
  prev: hiddenStatus,
});
const tool = createNode({ className: 'sdk-full-tool-block', prev: series });
const later = createNode({ className: 'sdk-rich-block', prev: muted });

const unmarked = createNode({ className: 'sdk-rich-block' });
unmarked.querySelector = (selector) => (
  selector === '.sdk-timeout-progress' ? { className: 'sdk-timeout-progress' } : null
);
assert.equal(isTimeoutProgressSeriesBlock(unmarked), true);
assert.equal(isTimeoutProgressSeriesSkipNode(hiddenStatus), true);
assert.equal(isTimeoutProgressSeriesSkipNode(muted), true);
assert.equal(isTimeoutProgressSeriesSkipNode(tool), false);

assert.equal(
  findAdjacentTimeoutProgressSeriesBlock({ streamLastChild: series }),
  series,
);
assert.equal(
  findAdjacentTimeoutProgressSeriesBlock({ streamLastChild: muted }),
  series,
);
assert.equal(
  findAdjacentTimeoutProgressSeriesBlock({ insertBefore: later }),
  series,
);
assert.equal(
  findAdjacentTimeoutProgressSeriesBlock({ streamLastChild: tool }),
  null,
);

const olderSeries = createNode({ className: TIMEOUT_PROGRESS_SERIES_CLASS });
const replayStatus = createNode({
  className: 'sdk-rich-line sdk-rich-line--status',
  prev: olderSeries,
});
const newerSeries = createNode({
  className: TIMEOUT_PROGRESS_SERIES_CLASS,
  prev: replayStatus,
});
assert.deepEqual(
  listTrailingTimeoutProgressSeriesBlocks({ streamLastChild: newerSeries }),
  [olderSeries, newerSeries],
);
const foldedReplay = foldTrailingTimeoutProgressSeriesBlocks(
  listTrailingTimeoutProgressSeriesBlocks({ streamLastChild: newerSeries }),
);
assert.equal(foldedReplay.keeper, newerSeries);
assert.deepEqual(foldedReplay.removed, [olderSeries]);

function createUpdatesEl(ids) {
  const children = [];
  const el = {
    children,
    get childElementCount() {
      return children.length;
    },
    get lastElementChild() {
      return children[children.length - 1] || null;
    },
    appendChild(child) {
      const fromIndex = children.indexOf(child);
      if (fromIndex >= 0) children.splice(fromIndex, 1);
      children.push(child);
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
  };
  for (const id of ids) {
    const child = {
      id,
      remove() {
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
      },
    };
    children.push(child);
  }
  return el;
}

function createSeriesBlock(ids) {
  const updatesEl = createUpdatesEl(ids);
  const block = {
    updatesEl,
    removed: false,
    querySelector(selector) {
      return selector === '.sdk-timeout-progress__updates' ? updatesEl : null;
    },
    remove() {
      block.removed = true;
    },
  };
  return block;
}

const oldestCard = createSeriesBlock(['a3', 'a2', 'a1']);
const middleCard = createSeriesBlock(['b2', 'b1']);
const newestCard = createSeriesBlock(['c2', 'c1']);
const folded = foldTrailingTimeoutProgressSeriesBlocks([
  oldestCard,
  middleCard,
  newestCard,
]);
assert.equal(folded.keeper, newestCard);
assert.deepEqual(folded.removed, [middleCard, oldestCard]);
assert.equal(oldestCard.removed, true);
assert.equal(middleCard.removed, true);
assert.equal(newestCard.removed, false);
assert.deepEqual(
  newestCard.updatesEl.children.map((child) => child.id),
  ['c2', 'c1', 'b2', 'b1', 'a3', 'a2', 'a1'],
);

const overflowIds = Array.from({ length: TIMEOUT_PROGRESS_UPDATES_CAP }, (_, i) => `n${i}`);
const overflowKeeper = createSeriesBlock(overflowIds);
const overflowOlder = createSeriesBlock(['old']);
foldTrailingTimeoutProgressSeriesBlocks([overflowOlder, overflowKeeper]);
assert.equal(overflowKeeper.updatesEl.childElementCount, TIMEOUT_PROGRESS_UPDATES_CAP);
assert.equal(overflowKeeper.updatesEl.children[0].id, 'n0');
assert.equal(
  overflowKeeper.updatesEl.children[TIMEOUT_PROGRESS_UPDATES_CAP - 1].id,
  `n${TIMEOUT_PROGRESS_UPDATES_CAP - 1}`,
);
assert.equal(overflowOlder.removed, true);

assert.equal(foldTrailingTimeoutProgressSeriesBlocks([]).keeper, null);
assert.equal(foldTrailingTimeoutProgressSeriesBlocks([newestCard]).keeper, newestCard);

console.log('timeout-progress-series tests passed.');
