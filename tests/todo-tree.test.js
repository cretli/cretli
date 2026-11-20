import assert from 'node:assert/strict';
import {
  TODO_MAX_DEPTH,
  collectTodoSubtreeIds,
  collectTodoSubtreeLeafIds,
  findApprovedPlanAncestor,
  isTodoNodeBlocked,
  listReadyTodoLeaves,
  renumberTodoSiblings,
  synchronizeTodoParentStatuses,
  todoNodeDepth,
  todoSubtreeHeight,
  buildTodoIndex,
  buildTodoChildrenIndex,
  filterBlockedTodoBranches,
  isTodoBranchBlocked,
  todoChildrenIndexStats,
  wouldCreateTodoParentCycle,
} from '../lib/todo-tree.js';
import { isTodoBlockedByParallelSiblingScope } from '../lib/todo-parallel-scope.js';
import { isFeedbackDerivedTodo, isFeedbackRoot } from '../lib/feedback-marker.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

runCase('TODO_MAX_DEPTH is 6', () => {
  assert.equal(TODO_MAX_DEPTH, 6);
});

runCase('wouldCreateTodoParentCycle: chain, self, and clean cases', () => {
  const items = [
    { id: 'r' },
    { id: 'a', parentId: 'r' },
    { id: 'b', parentId: 'a' },
  ];
  assert.equal(wouldCreateTodoParentCycle(items, 'r', 'b'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'a', 'b'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'a', 'a'), true);
  // 'r' is an ancestor of 'a', so parenting r under a is also a cycle.
  assert.equal(wouldCreateTodoParentCycle(items, 'r', 'a'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'a', 'r'), false);
  assert.equal(wouldCreateTodoParentCycle(items, 'b', 'r'), false);
  assert.equal(wouldCreateTodoParentCycle(items, 'b', ''), false);
  // A prebuilt index (used by the save-time integrity pass) gives the same answers.
  const index = buildTodoIndex(items);
  for (const [todoId, parentId] of [['r', 'b'], ['a', 'b'], ['r', 'a'], ['a', 'r'], ['b', 'r']]) {
    assert.equal(
      wouldCreateTodoParentCycle(items, todoId, parentId, index),
      wouldCreateTodoParentCycle(items, todoId, parentId),
      `${todoId} under ${parentId}`,
    );
  }
});

runCase('wouldCreateTodoParentCycle: cyclic stored data terminates', () => {
  const items = [
    { id: 'x', parentId: 'y' },
    { id: 'y', parentId: 'x' },
  ];
  assert.equal(wouldCreateTodoParentCycle(items, 'x', 'y'), true);
  assert.equal(wouldCreateTodoParentCycle(items, 'z', 'x'), false);
});

runCase('todoNodeDepth and todoSubtreeHeight', () => {
  const items = [
    { id: 'r' },
    { id: 'a', parentId: 'r' },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'r' },
  ];
  assert.equal(todoNodeDepth(items, 'r'), 1);
  assert.equal(todoNodeDepth(items, 'b'), 3);
  assert.equal(todoNodeDepth(items, 'missing'), 0);
  assert.equal(todoSubtreeHeight(items, 'r'), 3);
  assert.equal(todoSubtreeHeight(items, 'c'), 1);
  assert.equal(todoSubtreeHeight(items, 'missing'), 0);
});

runCase('collectTodoSubtreeIds: BFS over the whole subtree', () => {
  const items = [
    { id: 'r' },
    { id: 'a', parentId: 'r' },
    { id: 'b', parentId: 'r' },
    { id: 'leaf', parentId: 'a' },
    { id: 'other' },
  ];
  assert.deepEqual(collectTodoSubtreeIds(items, 'r'), ['r', 'a', 'b', 'leaf']);
  assert.deepEqual(collectTodoSubtreeIds(items, 'a'), ['a', 'leaf']);
  assert.deepEqual(collectTodoSubtreeIds(items, 'missing'), []);
});

runCase('renumberTodoSiblings: gaps, ties, and missing indexes', () => {
  const items = [
    { id: 'r1', siblingIndex: 7 },
    { id: 'r2' },
    { id: 'r3', siblingIndex: 2 },
    { id: 'c1', parentId: 'p', siblingIndex: 1 },
    { id: 'c2', parentId: 'p' },
    { id: 'p', siblingIndex: 0 },
  ];
  renumberTodoSiblings(items);
  // The global array order is untouched; only the indexes change.
  const roots = items
    .filter((row) => !row.parentId)
    .sort((a, b) => a.siblingIndex - b.siblingIndex)
    .map((row) => [row.id, row.siblingIndex]);
  // p (0) sorts first, r3 (2) before r1 (7); r2 has no index and lands last.
  assert.deepEqual(roots, [['p', 0], ['r3', 1], ['r1', 2], ['r2', 3]]);
  const children = items.filter((row) => row.parentId === 'p').map((row) => [row.id, row.siblingIndex]);
  assert.deepEqual(children, [['c1', 0], ['c2', 1]]);
});

runCase('isTodoNodeBlocked: unapproved parent plan blocks children', () => {
  const items = [
    { id: 'root', plan: { markdown: 'x' } },
    { id: 'kid', parentId: 'root' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[1]), true);
  items[0].plan.approvedAt = '2024-01-01T00:00:00.000Z';
  assert.equal(isTodoNodeBlocked(items, items[1]), false);
  assert.equal(isTodoNodeBlocked(items, items[0]), false);
});

runCase('blocked checks accept reusable id and children indexes', () => {
  const items = [
    { id: 'root', status: 'doing' },
    { id: 'first', parentId: 'root', siblingIndex: 0, status: 'ready' },
    { id: 'second', parentId: 'root', siblingIndex: 1, status: 'ready' },
    { id: 'nested', parentId: 'first', status: 'ready' },
  ];
  const index = buildTodoIndex(items);
  const children = buildTodoChildrenIndex(items);
  assert.equal(isTodoNodeBlocked(items, items[2], index, children), true);
  assert.equal(isTodoBranchBlocked(items, items[3], index, children), false);
  assert.deepEqual(filterBlockedTodoBranches(items, (row) => row.id !== 'root').map((row) => row.id), ['second']);
});

runCase('filterBlockedTodoBranches builds one child index for many sequential siblings', () => {
  const root = { id: 'root', status: 'doing', runMode: 'sequential' };
  const items = [root, ...Array.from({ length: 5000 }, (_, i) => ({
    id: `todo-${i}`, parentId: 'root', status: i < 4998 ? (i % 2 ? 'deferred' : 'done') : 'ready', siblingIndex: i,
  }))];
  const buildsBefore = todoChildrenIndexStats.builds;
  const started = Date.now();
  filterBlockedTodoBranches(items);
  const elapsed = Date.now() - started;
  assert.equal(todoChildrenIndexStats.builds - buildsBefore, 1);
  assert.ok(elapsed < 500, `batch took ${elapsed}ms`);
  assert.deepEqual(filterBlockedTodoBranches(items), items.filter((row) => isTodoBranchBlocked(items, row)));
});

runCase('reverse-ordered open siblings are summarized once for batch and memo paths', () => {
  const root = { id: 'root', status: 'doing', runMode: 'sequential' };
  const children = Array.from({ length: 3000 }, (_, i) => ({
    id: `reverse-${i}`, parentId: 'root', status: 'ready', siblingIndex: 2999 - i,
  }));
  const items = [root, ...children];
  const buildsBefore = todoChildrenIndexStats.builds;
  const blocked = filterBlockedTodoBranches(items);
  assert.equal(todoChildrenIndexStats.builds - buildsBefore, 1);
  assert.equal(blocked.length, 2999);
  assert.equal(blocked.includes(children[2999]), false);
  assert.equal(blocked.includes(children[0]), true);

  const ready = listReadyTodoLeaves(items);
  assert.deepEqual(ready, [children[2999]]);
});

runCase('blocked batch and per-node results agree for malformed and skipped tree rows', () => {
  const cases = [
    [
      { id: 'dup', status: 'doing' }, { id: 'dup', parentId: 'dup', siblingIndex: 0, status: 'ready' },
      { id: 'later', parentId: ' dup ', siblingIndex: 1, status: 'ready' },
    ],
    [
      { id: 'a', parentId: 'b', status: 'ready' }, { id: 'b', parentId: 'a', status: 'ready' },
      { id: 'c', parentId: 'a', status: 'ready' },
    ],
    [
      { id: 'root', status: 'doing' }, { id: 'idea', parentId: 'root', siblingIndex: 0, status: 'idea', nonBlocking: true },
      { id: 'later', parentId: 'root', siblingIndex: 1, status: 'ready' },
    ],
    [
      { id: 'root', status: 'doing' }, { id: 'deferred', parentId: 'root', siblingIndex: 0, status: 'deferred' },
      { id: 'later', parentId: 'root', siblingIndex: 1, status: 'ready' },
    ],
  ];
  for (const items of cases) {
    const expected = items.filter((row) => isTodoBranchBlocked(items, row));
    assert.deepEqual(filterBlockedTodoBranches(items), expected);
  }
});

runCase('duplicate rows do not overwrite canonical batch node results', () => {
  const items = [
    { id: 'x', status: 'ready' },
    { id: 'x', status: 'ready', blockedReason: 'parked' },
  ];
  assert.equal(isTodoBranchBlocked(items, items[0]), false);
  assert.equal(isTodoBranchBlocked(items, items[1]), true);
  assert.deepEqual(filterBlockedTodoBranches(items), [items[1]]);

  const planned = [
    { id: 'root', plan: { markdown: '# draft' } },
    { id: 'kid', parentId: 'root', status: 'ready' },
    { id: 'kid', status: 'ready' },
  ];
  assert.deepEqual(filterBlockedTodoBranches(planned), planned.filter((row) => isTodoBranchBlocked(planned, row)));
});

runCase('random small trees match the original blocked rule reference', () => {
  const referenceNodeBlocked = (items, item) => {
    if (String(item?.blockedReason || '').trim()) return true;
    if (!item) return false;
    const byId = new Map();
    for (const row of items) if (row?.id && !byId.has(String(row.id))) byId.set(String(row.id), row);
    const parentId = typeof item.parentId === 'string' ? item.parentId.trim() : '';
    if (!parentId) return false;
    const parent = byId.get(parentId);
    if (!parent) return false;
    if (String(parent.plan?.markdown || '').trim()) {
      const approved = isFeedbackDerivedTodo(items, parent)
        ? Boolean(String(parent.plan?.approvedAt || '').trim())
        : (() => {
          const seen = new Set();
          let current = parent;
          while (current?.id && !seen.has(current.id)) {
            seen.add(current.id);
            if (String(current.plan?.approvedAt || '').trim()) return true;
            const parentId = typeof current.parentId === 'string' ? current.parentId.trim() : '';
            current = byId.get(parentId);
          }
          return false;
        })();
      if (!approved) return true;
    }
    if (isFeedbackRoot(parent)) return false;
    if (parent.runMode !== 'parallel') {
      const ownIndex = Number.isInteger(item.siblingIndex) ? item.siblingIndex : 0;
      return items.some((row) => {
        if (!row?.id || String(row.id) === String(item.id)) return false;
        if ((typeof row.parentId === 'string' ? row.parentId.trim() : '') !== parentId) return false;
        const rowIndex = Number.isInteger(row.siblingIndex) ? row.siblingIndex : 0;
        if (rowIndex >= ownIndex) return false;
        const queue = [row];
        const seen = new Set();
        while (queue.length) {
          const current = queue.pop();
          if (!current?.id || seen.has(String(current.id))) continue;
          const id = String(current.id);
          seen.add(id);
          const canonical = byId.get(id) || current;
          if (!(canonical.status === 'idea' && canonical.nonBlocking === true)
            && canonical.status !== 'done' && canonical.status !== 'deferred') return true;
          for (const child of items) {
            if (child?.id && (typeof child.parentId === 'string' ? child.parentId.trim() : '') === id) queue.push(child);
          }
        }
        return false;
      });
    }
    return isTodoBlockedByParallelSiblingScope(items, item, byId);
  };
  const referenceBranchBlocked = (items, item) => {
    const byId = new Map();
    for (const row of items) if (row?.id && !byId.has(String(row.id))) byId.set(String(row.id), row);
    const seen = new Set();
    let current = item;
    while (current?.id && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      if (referenceNodeBlocked(items, current)) return true;
      const parentId = typeof current.parentId === 'string' ? current.parentId.trim() : '';
      current = byId.get(parentId);
    }
    return false;
  };
  let seed = 713;
  const random = (max) => {
    seed = (seed * 48271) % 0x7fffffff;
    return seed % max;
  };
  const statuses = ['ready', 'doing', 'done', 'deferred', 'idea'];
  for (let run = 0; run < 200; run += 1) {
    const items = [];
    const count = 2 + random(12);
    for (let i = 0; i < count; i += 1) {
      const row = {
        id: `r${random(Math.max(2, count - 1))}`,
        status: statuses[random(statuses.length)],
        ...(random(4) === 0 ? {} : { siblingIndex: random(6) }),
        nonBlocking: random(2) === 1,
      };
      if (i > 0 && random(4) !== 0) row.parentId = random(5) === 0 ? ` r${random(count)} ` : `r${random(count)}`;
      if (random(12) === 0) row.plan = { markdown: 'draft' };
      if (random(20) === 0) row.plan = { markdown: 'draft', approvedAt: 'approved' };
      if (random(40) === 0) row.parentId = `r${random(count)}`;
      if (random(8) === 0) row.blockedReason = 'parked';
      items.push(row);
    }
    const expected = items.filter((row) => referenceBranchBlocked(items, row));
    assert.deepEqual(filterBlockedTodoBranches(items), expected, `batch random tree ${run}`);
    assert.deepEqual(items.filter((row) => isTodoNodeBlocked(items, row)), items.filter((row) => referenceNodeBlocked(items, row)), `node random tree ${run}`);
    const readyBlocked = new Set(listReadyTodoLeaves(items));
    assert.deepEqual([...readyBlocked].filter((row) => referenceBranchBlocked(items, row)), [], `ready random tree ${run}`);
    for (const row of items) assert.equal(isTodoBranchBlocked(items, row), referenceBranchBlocked(items, row), `branch random tree ${run} row ${row.id}`);
  }
});

runCase('isTodoNodeBlocked: approved top parent unlocks an unapproved intermediate plan', () => {
  const items = [
    { id: 'root', status: 'doing', plan: { markdown: '# module', approvedAt: 'yes' } },
    { id: 'phase', parentId: 'root', status: 'ready', plan: { markdown: '# phase draft' } },
    { id: 'leaf', parentId: 'phase', status: 'ready' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[2]), false);
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['leaf']);
  items[0].plan = { markdown: '# module' };
  assert.equal(isTodoNodeBlocked(items, items[2]), true);
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), []);
});

runCase('isTodoNodeBlocked: a grouping parent without a plan does not block', () => {
  const items = [
    { id: 'group' },
    { id: 'kid', parentId: 'group', status: 'ready' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[1]), false);
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['kid']);
});

runCase('isTodoNodeBlocked: sequential parent blocks on earlier unfinished sibling', () => {
  const items = [
    { id: 'root', plan: { approvedAt: 'yes' }, runMode: 'sequential' },
    { id: 's0', parentId: 'root', siblingIndex: 0, status: 'doing' },
    { id: 's1', parentId: 'root', siblingIndex: 1, status: 'idea' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[1]), false);
  assert.equal(isTodoNodeBlocked(items, items[2]), true);
  items[1].status = 'done';
  assert.equal(isTodoNodeBlocked(items, items[2]), false);
});

runCase('isTodoNodeBlocked: parallel parent ignores earlier siblings', () => {
  const items = [
    { id: 'root', plan: { approvedAt: 'yes' }, runMode: 'parallel' },
    { id: 's0', parentId: 'root', siblingIndex: 0, status: 'doing', body: '## Leaf scope\n- lib/s0.js\n' },
    { id: 's1', parentId: 'root', siblingIndex: 1, status: 'idea', body: '## Leaf scope\n- lib/s1.js\n' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[2]), false);
});

runCase('listReadyTodoLeaves: filters done/doing/idea, non-leaves, and blocked', () => {
  const items = [
    { id: 'root', runMode: 'parallel', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', status: 'ready', body: '## Leaf scope\n- lib/a.js\n' },
    { id: 'b', parentId: 'root', status: 'done' },
    { id: 'c', parentId: 'root', status: 'doing', body: '## Leaf scope\n- lib/c.js\n' },
    { id: 'e', parentId: 'root', status: 'idea' },
    { id: 'd', parentId: 'root', status: 'ready', plan: { approvedAt: 'yes' }, body: '## Leaf scope\n- lib/d.js\n' },
    { id: 'd1', parentId: 'd', status: 'ready', body: '## Leaf scope\n- lib/d1.js\n' },
    { id: 'solo', status: 'ready' },
    { id: 'blockedParent', plan: { markdown: 'no approval' } },
    { id: 'blockedKid', parentId: 'blockedParent', status: 'ready' },
  ];
  const ready = listReadyTodoLeaves(items);
  const readyIds = ready.map((row) => row.id).sort();
  // 'root' has children; 'b' done; 'c' doing; 'e' idea (excluded);
  // 'd' has child d1; d1 ready; 'a' ready; 'solo' ready;
  // 'blockedKid' blocked by unapproved parent plan.
  assert.deepEqual(readyIds, ['a', 'd1', 'solo']);
});

runCase('listReadyTodoLeaves: rootId limits to a subtree', () => {
  const items = [
    { id: 'root', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', status: 'ready' },
    { id: 'b', parentId: 'root', status: 'ready' },
    { id: 'other', status: 'ready' },
  ];
  const ready = listReadyTodoLeaves(items, { rootId: 'a' });
  assert.deepEqual(ready.map((row) => row.id), ['a']);
  assert.deepEqual(listReadyTodoLeaves(items, { rootId: 'missing' }), []);
  assert.deepEqual(listReadyTodoLeaves([]), []);
});

runCase('listReadyTodoLeaves: rootId scope still sees earlier siblings of a sequential parent', () => {
  const items = [
    { id: 'root', runMode: 'sequential', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', siblingIndex: 0, status: 'ready' },
    { id: 'b', parentId: 'root', siblingIndex: 1, status: 'ready' },
  ];
  assert.deepEqual(listReadyTodoLeaves(items, { rootId: 'b' }), []);
});

runCase('listReadyTodoLeaves: a blocked ancestor blocks its descendants', () => {
  const items = [
    { id: 'root', runMode: 'sequential', plan: { approvedAt: 'yes' } },
    { id: 'a', parentId: 'root', siblingIndex: 0, status: 'ready' },
    { id: 'b', parentId: 'root', siblingIndex: 1, status: 'ready', plan: { approvedAt: 'yes' } },
    { id: 'b1', parentId: 'b', siblingIndex: 0, status: 'ready' },
  ];
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['a']);
});

runCase('default sequential blocks a later subtree until the earlier subtree is complete', () => {
  const items = [
    { id: 'r' },
    { id: 'a', parentId: 'r', siblingIndex: 0, status: 'done' },
    { id: 'a1', parentId: 'a', siblingIndex: 0, status: 'ready' },
    { id: 'b', parentId: 'r', siblingIndex: 1, status: 'ready' },
    { id: 'b1', parentId: 'b', status: 'ready' },
  ];
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['a1']);
  items[2].status = 'done';
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['b1']);
});

runCase('parent statuses complete and reopen bottom-up at every depth without changing leaves', () => {
  const items = [
    { id: 'r', status: 'done' },
    { id: 'p', parentId: 'r', status: 'done' },
    { id: 'c', parentId: 'p', status: 'doing' },
  ];
  synchronizeTodoParentStatuses(items);
  assert.deepEqual(items.map((row) => row.status), ['doing', 'doing', 'doing']);
  items[2].status = 'done';
  synchronizeTodoParentStatuses(items);
  assert.deepEqual(items.map((row) => row.status), ['done', 'done', 'done']);
  items[2].status = 'ready';
  synchronizeTodoParentStatuses(items);
  assert.deepEqual(items.map((row) => row.status), ['ready', 'ready', 'ready']);
});

runCase('parent becomes deferred when children are only done/deferred with at least one deferred', () => {
  const items = [
    { id: 'p', status: 'idea' },
    { id: 'a', parentId: 'p', status: 'done' },
    { id: 'b', parentId: 'p', status: 'deferred' },
  ];
  synchronizeTodoParentStatuses(items);
  assert.equal(items[0].status, 'deferred');
  // done wins when every child is done
  items[2].status = 'done';
  synchronizeTodoParentStatuses(items);
  assert.equal(items[0].status, 'done');
  // all children deferred
  items[1].status = 'deferred';
  items[2].status = 'deferred';
  synchronizeTodoParentStatuses(items);
  assert.equal(items[0].status, 'deferred');
});

runCase('deferred parent: a doing/ready/idea child changes the derived status; restore goes to idea or ready', () => {
  const items = [
    { id: 'p', status: 'deferred' },
    { id: 'a', parentId: 'p', status: 'deferred' },
    { id: 'b', parentId: 'p', status: 'deferred' },
  ];
  items[1].status = 'idea';
  synchronizeTodoParentStatuses(items);
  assert.equal(items[0].status, 'idea', 'restored parent falls back to idea');
  items[0].status = 'deferred';
  items[1].status = 'ready';
  synchronizeTodoParentStatuses(items);
  assert.equal(items[0].status, 'ready', 'a ready child makes the restored parent ready');
  items[0].status = 'deferred';
  items[1].status = 'doing';
  synchronizeTodoParentStatuses(items);
  assert.equal(items[0].status, 'doing');
  // nested: deferred propagates bottom-up
  const nested = [
    { id: 'r', status: 'idea' },
    { id: 'm', parentId: 'r', status: 'idea' },
    { id: 'l', parentId: 'm', status: 'deferred' },
  ];
  synchronizeTodoParentStatuses(nested);
  assert.deepEqual(nested.map((row) => row.status), ['deferred', 'deferred', 'deferred']);
});

runCase('isTodoNodeBlocked: deferred siblings (whole subtree) do not block a sequential sequence', () => {
  const items = [
    { id: 'p', status: 'ready' },
    { id: 'a', parentId: 'p', siblingIndex: 0, status: 'deferred' },
    { id: 'b', parentId: 'p', siblingIndex: 1, status: 'ready' },
    { id: 'c', parentId: 'p', siblingIndex: 2, status: 'ready' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[2]), false, 'deferred earlier sibling is skipped');
  assert.equal(isTodoNodeBlocked(items, items[3]), true, 'a ready earlier sibling still blocks');
  // deferred container with only deferred/done descendants is skipped too
  const tree = [
    { id: 'p', status: 'ready' },
    { id: 'g', parentId: 'p', siblingIndex: 0, status: 'deferred' },
    { id: 'g1', parentId: 'g', siblingIndex: 0, status: 'deferred' },
    { id: 'g2', parentId: 'g', siblingIndex: 1, status: 'done' },
    { id: 'n', parentId: 'p', siblingIndex: 1, status: 'ready' },
  ];
  assert.equal(isTodoNodeBlocked(tree, tree[4]), false);
  // mixed deferred + idea container still blocks
  tree[3].status = 'idea';
  assert.equal(isTodoNodeBlocked(tree, tree[4]), true, 'mixed deferred+idea container still blocks');
});

runCase('listReadyTodoLeaves never returns deferred leaves and skips them in the sequence', () => {
  const items = [
    { id: 'p', status: 'ready' },
    { id: 'a', parentId: 'p', siblingIndex: 0, status: 'deferred' },
    { id: 'b', parentId: 'p', siblingIndex: 1, status: 'ready' },
  ];
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id), ['b']);
  assert.deepEqual(listReadyTodoLeaves([{ id: 'x', status: 'deferred' }]), []);
});

const seqTree = (/** @type {any} */ first) => [
  { id: 'p', title: 'Parent', status: 'ready' },
  { id: 'a', parentId: 'p', siblingIndex: 0, status: 'idea', ...first },
  { id: 'b', parentId: 'p', siblingIndex: 1, status: 'ready' },
];

runCase('nonBlocking: an idea sibling blocks later siblings by default', () => {
  const items = seqTree({});
  assert.equal(isTodoNodeBlocked(items, items[2]), true);
  assert.deepEqual(listReadyTodoLeaves(items).map((r) => r.id), []);
});

runCase('nonBlocking: only an explicit true lets an idea sibling be skipped', () => {
  for (const value of [false, 'true', 1, undefined]) {
    const items = seqTree({ nonBlocking: value });
    assert.equal(isTodoNodeBlocked(items, items[2]), true, `nonBlocking=${String(value)}`);
  }
  const items = seqTree({ nonBlocking: true });
  assert.equal(isTodoNodeBlocked(items, items[2]), false);
  assert.deepEqual(listReadyTodoLeaves(items).map((r) => r.id), ['b']);
});

runCase('nonBlocking: ignored once the node is no longer idea', () => {
  for (const status of ['ready', 'doing']) {
    const items = seqTree({ status, nonBlocking: true });
    assert.equal(isTodoNodeBlocked(items, items[2]), true, status);
  }
});

runCase('nonBlocking: an open descendant of a nonBlocking idea still blocks', () => {
  const items = [
    { id: 'p', status: 'ready' },
    { id: 'a', parentId: 'p', siblingIndex: 0, status: 'idea', nonBlocking: true },
    { id: 'a1', parentId: 'a', siblingIndex: 0, status: 'ready' },
    { id: 'b', parentId: 'p', siblingIndex: 1, status: 'ready' },
  ];
  assert.equal(isTodoNodeBlocked(items, items[3]), true);
});

runCase('nonBlocking: parent with idea(nonBlocking)+done children never becomes done', () => {
  for (const before of ['done', 'ready', 'doing', 'idea']) {
    const items = [
      { id: 'p', status: before },
      { id: 'a', parentId: 'p', siblingIndex: 0, status: 'idea', nonBlocking: true },
      { id: 'b', parentId: 'p', siblingIndex: 1, status: 'done' },
    ];
    synchronizeTodoParentStatuses(items);
    assert.notEqual(items[0].status, 'done', `before=${before}`);
  }
  const items = [
    { id: 'p', status: 'done' },
    { id: 'a', parentId: 'p', siblingIndex: 0, status: 'idea', nonBlocking: true },
    { id: 'b', parentId: 'p', siblingIndex: 1, status: 'done' },
  ];
  synchronizeTodoParentStatuses(items);
  assert.equal(items[0].status, 'doing', 'a done child plus an open idea child derives doing');
});

process.exit(failed ? 1 : 0);

// findApprovedPlanAncestor: the nearest strict ancestor with an approved plan.
{
  const items = [
    { id: 'r', plan: { markdown: 'root', approvedAt: '2026-01-01' }, title: 'Root' },
    { id: 'm', parentId: 'r', plan: { markdown: 'draft' } },
    { id: 'l', parentId: 'm' },
    { id: 'x', plan: { approvedAt: '2026-01-01' } },
    { id: 'y', parentId: 'x' },
  ];
  assert.deepEqual(findApprovedPlanAncestor(items, items[2]), { id: 'r', title: 'Root', approvedAt: '2026-01-01' });
  assert.equal(findApprovedPlanAncestor(items, items[0]), null, 'own approval is not an ancestor');
  // Same rule as hasApprovedPlanOnNodeOrAncestor: approvedAt alone counts.
  assert.equal(findApprovedPlanAncestor(items, items[4])?.id, 'x');
  assert.equal(findApprovedPlanAncestor(items, { id: 'z' }), null);
}

// collectTodoSubtreeLeafIds: leaves below the root, depth-first in siblingIndex order.
{
  const items = [
    { id: 'r' },
    { id: 'b', parentId: 'r', siblingIndex: 1 },
    { id: 'a', parentId: 'r', siblingIndex: 0 },
    { id: 'a2', parentId: 'a', siblingIndex: 1 },
    { id: 'a1', parentId: 'a', siblingIndex: 0 },
    { id: 'c', parentId: 'r' },
    { id: 'x' },
  ];
  assert.deepEqual(collectTodoSubtreeLeafIds(items, 'r'), ['a1', 'a2', 'b', 'c']);
  assert.deepEqual(collectTodoSubtreeLeafIds(items, 'a'), ['a1', 'a2']);
  assert.deepEqual(collectTodoSubtreeLeafIds(items, 'x'), [], 'a leaf root has no leaves below it');
  assert.deepEqual(collectTodoSubtreeLeafIds(items, 'missing'), []);
}

// MCP reports are independent: the backlog root never orders them, while a nested group still does.
{
  const { FEEDBACK_ROOT_MARKER } = await import('../lib/feedback-marker.js');
  const items = [
    { id: 'root', parentId: '', status: 'doing', body: `${FEEDBACK_ROOT_MARKER}\nx` },
    { id: 'first', parentId: 'root', siblingIndex: 0, status: 'idea', body: '' },
    { id: 'second', parentId: 'root', siblingIndex: 1, status: 'idea', body: '' },
    { id: 'step1', parentId: 'second', siblingIndex: 0, status: 'idea', body: '' },
    { id: 'step2', parentId: 'second', siblingIndex: 1, status: 'idea', body: '' },
    { id: 'plain', parentId: '', status: 'doing', body: 'plain' },
    { id: 'a', parentId: 'plain', siblingIndex: 0, status: 'idea', body: '' },
    { id: 'b', parentId: 'plain', siblingIndex: 1, status: 'idea', body: '' },
  ];
  const byId = (id) => items.find((row) => row.id === id);
  assert.equal(isTodoNodeBlocked(items, byId('second')), false);
  assert.equal(isTodoNodeBlocked(items, byId('step2')), true);
  assert.equal(isTodoNodeBlocked(items, byId('b')), true);
}
