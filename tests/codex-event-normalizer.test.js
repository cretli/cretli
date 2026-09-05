import assert from 'node:assert/strict';
import { normalizeCodexThreadEvent, readCodexThreadId } from '../lib/agent-harness/codex-event-normalizer.js';

assert.deepEqual(normalizeCodexThreadEvent(null), []);
assert.deepEqual(normalizeCodexThreadEvent({ type: 'unknown' }), []);

const started = normalizeCodexThreadEvent({
  type: 'thread.started',
  thread_id: 'thread-1',
});
assert.equal(started[0].kind, 'thread');
assert.equal(started[0].threadId, 'thread-1');
assert.equal(readCodexThreadId({ type: 'thread.started', thread_id: 'thread-1' }), 'thread-1');

const assistant = normalizeCodexThreadEvent({
  type: 'item.completed',
  item: { id: 'msg-1', type: 'agent_message', text: 'Hello from Codex' },
});
assert.equal(assistant.length, 1);
assert.equal(assistant[0].type, 'assistant');
assert.equal(assistant[0].message.content[0].text, 'Hello from Codex');

const reasoning = normalizeCodexThreadEvent({
  type: 'item.completed',
  item: { id: 'r-1', type: 'reasoning', text: 'thinking…' },
});
assert.equal(reasoning[0].type, 'assistant');
assert.equal(reasoning[0].message.content[0].text, 'thinking…');

const toolStart = normalizeCodexThreadEvent({
  type: 'item.started',
  item: { id: 'cmd-1', type: 'command_execution', command: 'ls' },
});
assert.equal(toolStart[0].type, 'tool_call');
assert.equal(toolStart[0].name, 'shell');
assert.equal(toolStart[0].status, 'running');
assert.equal(toolStart[0].call_id, 'cmd-1');
assert.equal(toolStart[0].args.command, 'ls');

const toolStartArgv = normalizeCodexThreadEvent({
  type: 'item.started',
  item: {
    id: 'cmd-2',
    type: 'CommandExecution',
    command: ['/bin/bash', '-lc', 'pwd && rg --files | head -200'],
    parsed_cmd: [{ type: 'unknown', cmd: 'pwd && rg --files | head -200' }],
  },
});
assert.equal(toolStartArgv[0].name, 'shell');
assert.equal(toolStartArgv[0].args.command, 'pwd && rg --files | head -200');

const toolStartBash = normalizeCodexThreadEvent({
  type: 'item.started',
  item: {
    id: 'cmd-3',
    type: 'command_execution',
    command: ['/bin/bash', '-lc', 'ls'],
  },
});
assert.equal(toolStartBash[0].args.command, 'ls');

const prefersArgv = normalizeCodexThreadEvent({
  type: 'item.started',
  item: {
    id: 'cmd-4',
    type: 'CommandExecution',
    command: [
      '/bin/bash',
      '-lc',
      "rg -n '^(export |const )' app_front/Modules/Module.js",
    ],
    parsed_cmd: [{
      type: 'search',
      cmd: "rg -n '^(export '\"\\\\(|const )\" app_front/Modules/Module.js",
    }],
  },
});
assert.equal(prefersArgv[0].args.command, "rg -n '^(export |const )' app_front/Modules/Module.js");

const toolDone = normalizeCodexThreadEvent({
  type: 'item.completed',
  item: {
    id: 'cmd-1',
    type: 'command_execution',
    command: 'ls',
    aggregated_output: 'ok',
  },
});
assert.equal(toolDone[0].status, 'completed');
assert.equal(toolDone[0].result, 'ok');

const search = normalizeCodexThreadEvent({
  type: 'item.started',
  item: { id: 'ws-1', type: 'web_search', query: 'codex sdk' },
});
assert.equal(search[0].name, 'web_search');
assert.equal(search[0].args.query, 'codex sdk');

const extensionSearch = normalizeCodexThreadEvent({
  type: 'item.started',
  item: {
    id: 'ws-2',
    type: 'Extension',
    kind: 'web.search',
    query: 'https://assistant.pl',
  },
});
assert.equal(extensionSearch[0].name, 'web_search');
assert.equal(extensionSearch[0].args.query, 'https://assistant.pl');

const failed = normalizeCodexThreadEvent({
  type: 'turn.failed',
  thread_id: 'thread-1',
  error: { message: 'quota' },
});
assert.equal(failed[0].kind, 'turn');
assert.equal(failed[0].status, 'failed');
assert.equal(failed[0].message, 'quota');

const errItem = normalizeCodexThreadEvent({
  type: 'item.completed',
  item: { id: 'err-1', type: 'error', message: 'Model metadata missing' },
});
assert.equal(errItem[0].kind, 'error');
assert.equal(errItem[0].message, 'Model metadata missing');

console.log('codex-event-normalizer.test.js OK');
