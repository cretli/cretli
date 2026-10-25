import './helpers/isolated-data-dir.js';
/**
 * Leaf scope extraction: no false paths from glob fragments, comma/parenthesis
 * handling in `## Leaf scope`, glob matching, explicit scope wins over prose.
 */
import assert from 'node:assert/strict';
import { listExistingFilePathsInLeafBody } from '../lib/model-pick-leaf-size.js';
import {
  collectTodoLeafScopePaths,
  leafScopePathsCollide,
  parseExplicitLeafScopePaths,
} from '../lib/todo-parallel-scope.js';

// 1. Inline scanner skips glob fragments and bare extension tokens.
assert.deepEqual(listExistingFilePathsInLeafBody('see tests/x*.test.js and lib/*.js'), []);
assert.deepEqual(listExistingFilePathsInLeafBody('the .test.js suffix'), []);
assert.deepEqual(listExistingFilePathsInLeafBody('edit lib/a.js now'), ['lib/a.js']);
assert.deepEqual(collectTodoLeafScopePaths({ body: 'pattern tests/x*.test.js' }), []);
assert.equal(
  leafScopePathsCollide(
    collectTodoLeafScopePaths({ body: 'uses tests/x*.test.js, edits lib/a.js' }),
    collectTodoLeafScopePaths({ body: 'uses tests/y*.test.js, edits lib/b.js' }),
  ),
  false,
);

// 2. Leaf scope bullets: commas, parenthetical notes, text after first space.
const scope = [
  '## Leaf scope',
  '- lib/a.js (tylko fragment)',
  '- lib/b.js, lib/c.js',
  '- `lib/d.js`, `lib/e.js` (note, with comma)',
  '- lib/f.js tylko funkcja X',
  '- lib/{g,h}.js',
  '',
  '## Notes',
  '- lib/ignored.js',
].join('\n');
assert.deepEqual(parseExplicitLeafScopePaths(scope), [
  'lib/a.js', 'lib/b.js', 'lib/c.js', 'lib/d.js', 'lib/e.js', 'lib/f.js', 'lib/{g,h}.js',
]);

// 3. Globs are matched as globs, not as directories/files.
assert.equal(leafScopePathsCollide(['tests/x*.test.js'], ['tests/xa.test.js']), true);
assert.equal(leafScopePathsCollide(['tests/x*.test.js'], ['tests/ya.test.js']), false);
assert.equal(leafScopePathsCollide(['tests/x*.test.js'], ['lib/a.js']), false);
assert.equal(leafScopePathsCollide(['lib/**'], ['lib/deep/a.js']), true);
assert.equal(leafScopePathsCollide(['lib/*.js'], ['lib/deep/a.js']), false);
assert.equal(leafScopePathsCollide(['lib/*.js'], ['lib']), true);
assert.equal(leafScopePathsCollide(['lib/{g,h}.js'], ['lib/h.js']), true);
assert.equal(leafScopePathsCollide(['lib/{g,h}.js'], ['lib/i.js']), false);
assert.equal(leafScopePathsCollide(['lib/*.js'], ['lib/*.css']), false);
assert.equal(leafScopePathsCollide(['lib/*.js'], ['lib/a*.js']), true);
assert.equal(leafScopePathsCollide(['tests/*.test.js'], ['lib/*.js']), false);

// 4. An explicit scope is not widened by paths mentioned in the description.
const withScope = (own, mention) => ({
  body: `Diagnosis: ${mention} is slow.`,
  plan: { markdown: `## Leaf scope\n- ${own}\n` },
});
assert.deepEqual(collectTodoLeafScopePaths(withScope('lib/a.js', 'lib/shared/x.js')), ['lib/a.js']);
assert.equal(
  leafScopePathsCollide(
    collectTodoLeafScopePaths(withScope('lib/a.js', 'lib/shared/x.js')),
    collectTodoLeafScopePaths(withScope('lib/b.js', 'lib/shared/x.js')),
  ),
  false,
);

console.log('todo-parallel-scope-globs: all passed');

// F1: an explicit but empty `## Leaf scope` must not fall back to prose paths.
assert.deepEqual(collectTodoLeafScopePaths({ body: '## Leaf scope\n\nprose mentions lib/a/b.js here' }), []);
// F2: disjoint brace globs do not collide; overlapping ones do.
assert.equal(leafScopePathsCollide(['lib/{a,b}.js'], ['lib/{c,d}.js']), false);
assert.equal(leafScopePathsCollide(['lib/{a,b}.js'], ['lib/{b,c}.js']), true);
console.log('todo-parallel-scope-globs F1/F2 ok');
