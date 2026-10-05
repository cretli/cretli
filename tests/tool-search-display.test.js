import assert from 'node:assert/strict';
import {
  formatToolSearchResult,
  isFailedToolSearchResult,
  isToolSearchName,
  parseToolSearchQuery,
  presentToolSearchUpdate,
} from '../lib/agent-harness/tool-search-display.js';
import {
  isOpenSdkToolStatus,
  shouldAcceptSdkToolStatus,
} from '../lib/sdk/sdk-thinking-state.js';

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

const toolReference = '{"type":"tool_reference","tool_name":"WebSearch"}';
assert.equal(isFailedToolSearchResult(toolReference), false);
assert.equal(
  formatToolSearchResult({ query: 'select:WebSearch' }, toolReference),
  'Loaded 1 tool(s) for WebSearch',
);
assert.equal(
  formatToolSearchResult(
    { query: 'select:WebSearch' },
    { type: 'tool_reference', tool_name: 'WebSearch' },
  ),
  'Loaded 1 tool(s) for WebSearch',
);

const searchArgs = { query: 'select:WebSearch', max_results: 1 };
let status = 'running';
const started = presentToolSearchUpdate({
  status,
  args: searchArgs,
  result: undefined,
  open: isOpenSdkToolStatus(status),
});
assert.equal(started.status, 'running');
assert.equal(started.result, '');
status = shouldAcceptSdkToolStatus(started.status, 'completed') ? 'completed' : started.status;
const finished = presentToolSearchUpdate({
  status,
  args: searchArgs,
  result: toolReference,
  open: isOpenSdkToolStatus(status),
});
assert.equal(finished.status, 'completed');
assert.equal(finished.result, 'Loaded 1 tool(s) for WebSearch');

console.log('tool-search-display.test.js OK');
