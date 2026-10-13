import assert from 'node:assert/strict';
import {
  assessParallelImplementParentWidth,
  readDelegationParallelImplementFanout,
} from '../lib/delegation-width.js';
import {
  assessParallelRunModeForSiblings,
  collectTodoLeafScopePaths,
  isTodoBlockedByParallelSiblingScope,
  leafScopePathsCollide,
  listParallelSiblingScopeCollisions,
  normalizeLeafScopePath,
} from '../lib/todo-parallel-scope.js';
import { isTodoNodeBlocked, listReadyTodoLeaves, buildTodoIndex } from '../lib/todo-tree.js';

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

runCase('normalizeLeafScopePath strips slashes and case', () => {
  assert.equal(normalizeLeafScopePath('/Lib/Foo.JS/'), 'lib/foo.js');
});

runCase('leafScopePathsCollide: exact, prefix, and disjoint', () => {
  assert.equal(leafScopePathsCollide(['lib/a.js'], ['lib/a.js']), true);
  assert.equal(leafScopePathsCollide(['lib/foo'], ['lib/foo/bar.js']), true);
  assert.equal(leafScopePathsCollide(['lib/a.js'], ['lib/b.js']), false);
  assert.equal(leafScopePathsCollide([], ['lib/a.js']), true);
});

runCase('collectTodoLeafScopePaths reads explicit bullets and inline paths', () => {
  const todo = {
    body: 'Touch lib/one.js and docs/readme.md',
    plan: {
      markdown: '## Leaf scope\n- lib/two.js\n',
    },
  };
  const paths = collectTodoLeafScopePaths(todo);
  assert.ok(paths.includes('lib/one.js'));
  assert.ok(paths.includes('lib/two.js'));
  assert.ok(paths.includes('docs/readme.md'));
});

runCase('listParallelSiblingScopeCollisions reports overlapping siblings', () => {
  const items = [
    { id: 'root', runMode: 'parallel' },
    { id: 'a', parentId: 'root', body: '## Leaf scope\n- lib/shared.js\n' },
    { id: 'b', parentId: 'root', body: '## Leaf scope\n- lib/shared.js\n' },
    { id: 'c', parentId: 'root', body: '## Leaf scope\n- lib/other.js\n' },
  ];
  const collisions = listParallelSiblingScopeCollisions(items, 'root');
  assert.equal(collisions.length, 1);
  assert.equal(assessParallelRunModeForSiblings(items, 'root').ok, false);
  items[1].body = '## Leaf scope\n- lib/a.js\n';
  items[2].body = '## Leaf scope\n- lib/b.js\n';
  assert.equal(assessParallelRunModeForSiblings(items, 'root').ok, true);
});

runCase('isTodoNodeBlocked: parallel parent blocks ready leaf when doing sibling overlaps scope', () => {
  const items = [
    { id: 'root', runMode: 'parallel', plan: { approvedAt: 'yes' } },
    {
      id: 'a',
      parentId: 'root',
      siblingIndex: 0,
      status: 'doing',
      body: '## Leaf scope\n- lib/a.js\n',
    },
    {
      id: 'b',
      parentId: 'root',
      siblingIndex: 1,
      status: 'ready',
      body: '## Leaf scope\n- lib/a.js\n',
    },
    {
      id: 'c',
      parentId: 'root',
      siblingIndex: 2,
      status: 'ready',
      body: '## Leaf scope\n- lib/c.js\n',
    },
  ];
  const index = buildTodoIndex(items);
  assert.equal(isTodoBlockedByParallelSiblingScope(items, items[2], index), true);
  assert.equal(isTodoNodeBlocked(items, items[2]), true);
  assert.equal(isTodoNodeBlocked(items, items[3]), false);
  assert.deepEqual(listReadyTodoLeaves(items).map((row) => row.id).sort(), ['c']);
});

runCase('assessParallelImplementParentWidth allows disjoint leaf implements', () => {
  const active = [{
    id: 'd1',
    assignment: 'implement',
    leafId: 'aaaa1111-0000-4000-8000-000000000001',
  }];
  const blocked = assessParallelImplementParentWidth({
    implementRows: active,
    incomingLeafId: 'bbbb2222-0000-4000-8000-000000000002',
    fanout: 2,
    resolveLeafScopePaths: (leafId) => (
      String(leafId).startsWith('aaaa') ? ['lib/a.js'] : ['lib/b.js']
    ),
  });
  assert.equal(blocked.ok, true);
  const collide = assessParallelImplementParentWidth({
    implementRows: active,
    incomingLeafId: 'bbbb2222-0000-4000-8000-000000000002',
    fanout: 2,
    resolveLeafScopePaths: () => ['lib/a.js'],
  });
  assert.equal(collide.ok, false);
});

runCase('assessParallelImplementParentWidth enforces fanout cap', () => {
  const active = [
    { id: 'd1', assignment: 'implement', leafId: 'aaaa1111-0000-4000-8000-000000000001' },
    { id: 'd2', assignment: 'implement', leafId: 'bbbb2222-0000-4000-8000-000000000002' },
  ];
  const width = assessParallelImplementParentWidth({
    implementRows: active,
    incomingLeafId: 'cccc3333-0000-4000-8000-000000000003',
    fanout: 2,
    resolveLeafScopePaths: (leafId) => [`lib/${String(leafId).slice(0, 4)}.js`],
  });
  assert.equal(width.ok, false);
  assert.equal(width.code, 'parallel_implement_fanout_full');
});

runCase('readDelegationParallelImplementFanout defaults to 2', () => {
  const previous = process.env.CRETLI_DELEGATION_PARALLEL_IMPLEMENT_FANOUT;
  delete process.env.CURSOR_REMOTE_DELEGATION_PARALLEL_IMPLEMENT_FANOUT;
  delete process.env.CRETLI_DELEGATION_PARALLEL_IMPLEMENT_FANOUT;
  assert.equal(readDelegationParallelImplementFanout(), 2);
  process.env.CRETLI_DELEGATION_PARALLEL_IMPLEMENT_FANOUT = '1';
  assert.equal(readDelegationParallelImplementFanout(), 1);
  if (previous === undefined) delete process.env.CRETLI_DELEGATION_PARALLEL_IMPLEMENT_FANOUT;
  else process.env.CRETLI_DELEGATION_PARALLEL_IMPLEMENT_FANOUT = previous;
});

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`\nAll ${8} todo-parallel-collision cases passed.`);
}
