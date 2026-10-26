import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyScoutMutation } from '../lib/routes/mcp-external-routes.js';
import { EXTERNAL_OPERATOR_TOOLS } from '../lib/mcp/mcp-external-operator-tools.js';
import { OPERATOR_RULES } from '../lib/mcp/mcp-external-guide.js';

test('classifyScoutMutation flags every mutating scout action and no read', () => {
  for (const action of ['create', 'update', 'duplicate', 'archive', 'run', 'from_template', 'restore']) {
    assert.equal(classifyScoutMutation('scout_profiles', action), 'scout_profile', action);
  }
  for (const action of ['accept', 'reject', 'submit']) {
    assert.equal(classifyScoutMutation('scout_findings', action), 'scout_findings', action);
  }
  for (const action of ['list', 'get', 'preview', 'history', 'templates', 'restore_preview', '', undefined]) {
    assert.equal(classifyScoutMutation('scout_profiles', action), null, String(action));
  }
  assert.equal(classifyScoutMutation('scout_findings', 'list'), null);
  assert.equal(classifyScoutMutation('scout_findings', undefined), null);
  assert.equal(classifyScoutMutation('todo_create', 'create'), null, 'other tools are never classified');
  assert.equal(classifyScoutMutation('scout_findings', 'create'), null, 'actions are matched per tool');
});

test('operator_scout_enable is declared with required confirm', () => {
  const tool = EXTERNAL_OPERATOR_TOOLS.find((row) => row.name === 'operator_scout_enable');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['enabled', 'confirm']);
  assert.equal(tool.inputSchema.properties.enabled.type, 'boolean');
});

test('operator guide mentions scout tools', () => {
  const text = OPERATOR_RULES.join(' ');
  assert.match(text, /scout_profiles/);
  assert.match(text, /operator_scout_enable/);
});
