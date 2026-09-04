import assert from 'node:assert/strict';
import {
  formatToolSearchResult,
  isFailedToolSearchResult,
  isToolSearchName,
  parseToolSearchQuery,
} from '../lib/agent-harness/tool-search-display.js';

assert.equal(isToolSearchName('tool_search'), true);
assert.equal(isToolSearchName('ToolSearch'), true);
assert.equal(isToolSearchName('web_fetch'), false);

assert.equal(parseToolSearchQuery('select:exit_plan_mode'), 'exit_plan_mode');
assert.equal(parseToolSearchQuery('select:task_stop'), 'task_stop');
assert.equal(parseToolSearchQuery('exit plan mode approve'), 'exit plan mode approve');

assert.equal(isFailedToolSearchResult('1 missing'), true);
assert.equal(isFailedToolSearchResult('Loaded 5 tool(s)'), false);
assert.equal(isFailedToolSearchResult('Not found: exit_plan_mode'), true);

assert.equal(
  formatToolSearchResult({ query: 'select:exit_plan_mode' }, '1 missing'),
  'Not found: exit_plan_mode',
);
assert.equal(
  formatToolSearchResult({ query: 'select:task_stop' }, 'Loaded 1 tool(s)'),
  'Loaded 1 tool(s) for task_stop',
);
assert.equal(
  formatToolSearchResult({ query: 'exit plan mode approve' }, 'Loaded 5 tool(s)'),
  'Loaded 5 tool(s) for exit plan mode approve',
);

console.log('tool-search-display.test.js OK');
