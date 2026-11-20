import './helpers/isolated-data-dir.js';
/**
 * The `## Leaf scope` section in the plan must be enough for scope detection
 * when the body is cut to the MAX_BODY_LEN cap.
 */
import assert from 'node:assert/strict';
import { MAX_BODY_LEN } from '../lib/persist/todos-persist.js';
import { collectTodoLeafScopePaths, parseExplicitLeafScopePaths } from '../lib/todo-parallel-scope.js';

const scope = '## Leaf scope\n- `lib/alpha.js`\n- `tests/alpha.test.js`\n\n## Notes\nmore\n';
// Scope placed at the end of an oversized body is lost by the cap.
const fillerLine = 'filler line\n';
// Sized from the cap so the scope always lands past it, whatever the current limit is.
const longBody = `${fillerLine.repeat(Math.ceil(MAX_BODY_LEN / fillerLine.length) + 1)}${scope}`;
const cutBody = longBody.slice(0, MAX_BODY_LEN);

assert.ok(longBody.length > MAX_BODY_LEN);
assert.deepEqual(parseExplicitLeafScopePaths(cutBody), []);
// The plan keeps the section, so the collected scope is intact.
assert.deepEqual(
  collectTodoLeafScopePaths({ body: cutBody, plan: { markdown: scope } }),
  ['lib/alpha.js', 'tests/alpha.test.js'],
);
console.log('todo-parallel-scope-truncation: all passed');
