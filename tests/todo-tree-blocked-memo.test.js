import assert from 'node:assert/strict';
import {
  isTodoBranchBlocked,
  isTodoNodeBlocked,
  listReadyTodoLeaves,
  todoBlockedMemoStats,
} from '../lib/todo-tree.js';

const mk = (id, extra = {}) => ({ id, title: id, status: 'ready', ...extra });
const items = () => [
  mk('root', { status: 'doing' }),
  mk('a', { parentId: 'root', siblingIndex: 0 }),
  mk('b', { parentId: 'root', siblingIndex: 1 }),
  mk('b1', { parentId: 'b', siblingIndex: 0 }),
];

// Same answers as the unmemoized node walk.
const list = items();
for (const row of list) {
  const expected = (() => {
    const seen = new Set();
    let cur = row;
    const byId = new Map(list.map((r) => [r.id, r]));
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (isTodoNodeBlocked(list, cur, byId)) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  })();
  assert.equal(isTodoBranchBlocked(list, row), expected, row.id);
}

// Memo is reused across calls on an unchanged array.
const stable = items();
isTodoBranchBlocked(stable, stable[2]);
const builds = todoBlockedMemoStats.builds;
isTodoBranchBlocked(stable, stable[3]);
listReadyTodoLeaves(stable);
assert.equal(todoBlockedMemoStats.builds, builds, 'no rebuild while unchanged');

// In-place mutation invalidates it.
assert.equal(isTodoBranchBlocked(stable, stable[2]), true, 'b waits for a');
stable[1].status = 'done';
assert.equal(isTodoBranchBlocked(stable, stable[2]), false, 'a done unblocks b');
assert.equal(isTodoBranchBlocked(stable, stable[3]), false);
stable[1].status = 'ready';
assert.equal(isTodoBranchBlocked(stable, stable[3]), true, 'child of a blocked node is blocked');
stable[2].blockedReason = 'manual';
assert.equal(isTodoBranchBlocked(stable, stable[3]), true);
assert.deepEqual(listReadyTodoLeaves(stable).map((r) => r.id), ['a']);

// A row from another array falls back to the plain path.
const other = items();
assert.equal(isTodoBranchBlocked(other, { ...other[2] }), true);

console.log('todo-tree-blocked-memo ok');
