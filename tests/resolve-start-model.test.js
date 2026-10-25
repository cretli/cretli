import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTodoStartModel } from '../lib/routes/resolve-start-model.js';
import { resolveTodoStartModel as reExported } from '../lib/routes/todos-routes.js';

test('todos-routes re-exports the shared helper', () => {
  assert.equal(reExported, resolveTodoStartModel);
});

test('sdk keeps the configured fallback, other harnesses get no model for empty/auto', () => {
  assert.equal(resolveTodoStartModel('sdk', '', 'auto'), 'auto');
  assert.equal(resolveTodoStartModel('sdk', 'gpt-x', 'auto'), 'gpt-x');
  for (const transport of ['claude', 'codex', 'opencode']) {
    assert.equal(resolveTodoStartModel(transport, '', 'auto'), '');
    assert.equal(resolveTodoStartModel(transport, undefined, 'auto'), '');
    assert.equal(resolveTodoStartModel(transport, ' Auto ', 'auto'), '');
    assert.equal(resolveTodoStartModel(transport, 'opus', 'auto'), 'opus');
  }
});
