import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatDrop } from '../app_front/features/sidebar/sidebarChatDrop.js';
import {
  collectNestedBlockIndexes,
  isChatRowDraggable,
  readDropParentChatId,
  resolveBlockNest,
  selectDraggableChatRows,
} from '../app_front/features/sidebar/sidebarChatDragBlock.js';

test('readDropParentChatId keeps the resolved parent instead of the folder root', () => {
  const items = [
    { id: 'a', top: 0, bottom: 40, isChild: false, level: 0, parentId: '' },
    { id: 'b', top: 40, bottom: 80, isChild: true, level: 1, parentId: 'a' },
    { id: 'c1', top: 80, bottom: 120, isChild: true, level: 2, parentId: 'b' },
    { id: 'c2', top: 120, bottom: 160, isChild: true, level: 2, parentId: 'b' },
  ];
  const drop = resolveChatDrop({ items, y: 90, draggedIds: ['c2'] });
  assert.equal(drop.parentChatId, 'b');
  assert.equal(readDropParentChatId(drop), 'b');
});

test('stale root nest-level swallows following grandchildren until metadata is updated', () => {
  const stale = [
    { id: 'a', level: 0 },
    { id: 'b', level: 1 },
    { id: 'x', level: 0 },
    { id: 'c1', level: 2 },
    { id: 'c2', level: 2 },
  ];
  const swallowed = collectNestedBlockIndexes(stale, 2).map((idx) => stale[idx].id);
  assert.deepEqual(swallowed, ['x', 'c1', 'c2']);
  const nest = resolveBlockNest({ parentChatId: 'b', parentLevel: 1, relativeLevels: [0] });
  assert.equal(nest.parentId, 'b');
  assert.equal(nest.rootLevel, 2);
  const updated = [
    { id: 'a', level: 0 },
    { id: 'b', level: 1 },
    { id: 'x', level: nest.rootLevel },
    { id: 'c1', level: 2 },
    { id: 'c2', level: 2 },
  ];
  const captured = collectNestedBlockIndexes(updated, 2).map((idx) => updated[idx].id);
  assert.deepEqual(captured, ['x']);
});

test('resolveBlockNest preserves subtree offsets when the root changes depth', () => {
  const nest = resolveBlockNest({
    parentChatId: 'b',
    parentLevel: 1,
    relativeLevels: [0, 1],
  });
  assert.deepEqual(nest.levels, [2, 3]);
  assert.equal(nest.indentLevels[0], 2);
});

test('resolveBlockNest clamps visual indent after depth 8', () => {
  const nest = resolveBlockNest({ parentChatId: 'p', parentLevel: 10, relativeLevels: [0] });
  assert.equal(nest.rootLevel, 11);
  assert.equal(nest.indentLevels[0], 8);
});

test('isChatRowDraggable rejects archived, hidden, folded and group rows', () => {
  assert.equal(isChatRowDraggable({ id: 'a' }), true);
  assert.equal(isChatRowDraggable({ id: 'a', archived: '1' }), false);
  assert.equal(isChatRowDraggable({ id: 'a', hidden: true }), false);
  assert.equal(isChatRowDraggable({ id: 'a', subchatHidden: true }), false);
  assert.equal(isChatRowDraggable({ id: 'subchat-group:p', isGroup: true }), false);
  assert.equal(isChatRowDraggable(null), false);
});

test('selectDraggableChatRows drops hidden tree records from a drag measurement', () => {
  const rows = [
    { id: 'visible', top: 0, bottom: 40 },
    { id: 'archived', archived: '1', top: 40, bottom: 80 },
    { id: 'folded', subchatHidden: true, top: 80, bottom: 120 },
    { id: 'hidden-attr', hidden: true, top: 120, bottom: 160 },
    { id: '', top: 160, bottom: 200 },
    { id: 'kept', top: 200, bottom: 240 },
  ];
  assert.deepEqual(selectDraggableChatRows(rows).map((row) => row.id), ['visible', 'kept']);
});
