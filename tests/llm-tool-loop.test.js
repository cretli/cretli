import assert from 'node:assert/strict';
import { runLlmToolLoop } from '../lib/agent-harness/llm-tool-loop.ts';

function makeBaseOptions(overrides = {}) {
  const events = [];
  const finished = [];
  return {
    events,
    finished,
    options: {
      transport: 'test',
      providerLabel: 'Test',
      model: 'test-model',
      cwd: process.cwd(),
      mode: 'agent',
      messages: [{ role: 'user', content: 'go' }],
      callbacks: {
        onEvent: (event) => events.push(event),
        onFinished: (status, detail) => finished.push({ status, detail }),
      },
      ...overrides,
    },
  };
}

// A stream that always requests one tool call (unknown tool -> error result,
// loop keeps iterating without touching the disk).
function alwaysToolCallStream(counter) {
  return async function* streamChatCompletion() {
    counter.calls += 1;
    yield {
      toolCallDeltas: [{
        index: 0,
        id: `call-${counter.calls}`,
        function: { name: 'no_such_tool', arguments: '{}' },
      }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
  };
}

// 1. Hitting the limit reports a readable, resumable message and persists a note.
{
  const counter = { calls: 0 };
  const { options, finished } = makeBaseOptions({
    maxIterations: 3,
    streamChatCompletion: alwaysToolCallStream(counter),
  });
  const result = await runLlmToolLoop(options);
  assert.equal(counter.calls, 3);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.error, /Max tool iterations reached \(3\)/);
  assert.match(result.error, /send another message to continue/i);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'error');
  assert.equal(finished[0].detail, result.error);
  const note = result.messages[result.messages.length - 1];
  assert.equal(note.role, 'system');
  assert.match(String(note.content), /limit of 3 iterations/);
  assert.match(String(note.content), /preserved/);

  // 2. Resume: the preserved messages continue and complete normally.
  const resumed = makeBaseOptions({
    messages: result.messages,
    streamChatCompletion: async function* () {
      yield { deltaText: 'done', finishReason: 'stop' };
    },
  });
  const resumeResult = await runLlmToolLoop(resumed.options);
  assert.equal(resumeResult.ok, true);
  assert.equal(resumeResult.status, 'completed');
  assert.equal(
    resumeResult.messages.some((msg) => msg.role === 'system' && /paused/.test(String(msg.content))),
    true,
  );
}

// 3. A run without tool calls still completes on the first iteration.
{
  const { options } = makeBaseOptions({
    streamChatCompletion: async function* () {
      yield { deltaText: 'hello', finishReason: 'stop' };
    },
  });
  const result = await runLlmToolLoop(options);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
}

// 4. The default limit is raised to 100 iterations (no maxIterations passed).
{
  const counter = { calls: 0 };
  const { options } = makeBaseOptions({
    streamChatCompletion: alwaysToolCallStream(counter),
  });
  const result = await runLlmToolLoop(options);
  assert.equal(counter.calls, 100);
  assert.equal(result.status, 'error');
  assert.match(result.error, /\(100\)/);
}

/**
 * Asserts the message order a provider accepts: system messages only at the
 * front, no tool result without the assistant call that produced it, and every
 * assistant tool-call block fully answered in order.
 *
 * @param {Array<Record<string, any>>} messages
 * @param {string} label
 */
function assertProviderSafeOrder(messages, label) {
  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    if (message.role === 'system') {
      assert.ok(
        index === 0 || previous.role === 'system',
        `${label}: system message at index ${index} is not at the front`,
      );
    }
    if (message.role === 'tool') {
      assert.ok(previous, `${label}: tool result at index ${index} has no predecessor`);
      assert.notEqual(
        previous.role,
        'system',
        `${label}: role 'tool' after role 'system' at index ${index}`,
      );
    }
  });
  const askedIds = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) askedIds.add(call.id);
    }
    if (message.role === 'tool') {
      assert.ok(askedIds.has(message.tool_call_id), `${label}: orphan tool result ${message.tool_call_id}`);
    }
  }
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return;
    const expected = message.tool_calls.map((call) => call.id);
    const answered = [];
    for (let i = index + 1; i < messages.length && messages[i].role === 'tool'; i += 1) {
      answered.push(messages[i].tool_call_id);
    }
    assert.deepEqual(answered, expected, `${label}: assistant at index ${index} lost tool results`);
  });
}

/**
 * Builds a tool-heavy conversation like an orchestrator chat produces, including
 * one wide fan-out (a single assistant message with several tool calls) and the
 * trailing system note an iteration-limit pause appends.
 *
 * @param {{ groups: number, fanoutAt: number, fanoutSize: number, pauseNote: boolean }} input
 * @returns {Array<Record<string, any>>}
 */
function buildLongConversation({ groups, fanoutAt, fanoutSize, pauseNote }) {
  const messages = [{ role: 'system', content: 'main system prompt' }];
  for (let i = 0; i < groups; i += 1) {
    messages.push({ role: 'user', content: `question ${i}` });
    const size = i === fanoutAt ? fanoutSize : 1;
    const toolCalls = [];
    for (let k = 0; k < size; k += 1) {
      toolCalls.push({ id: `call-${i}-${k}`, type: 'function', function: { name: 'read_file', arguments: '{}' } });
    }
    messages.push({ role: 'assistant', content: null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: `result ${call.id}` });
    }
    messages.push({ role: 'assistant', content: `answer ${i}` });
  }
  if (pauseNote) {
    messages.push({ role: 'system', content: 'The tool loop reached its per-run limit of 100 iterations and was paused.' });
  }
  messages.push({ role: 'user', content: 'next prompt' });
  return messages;
}

// 5. Trimming to the message budget must cut between tool-call groups.
// Regression: a Mistral orchestrator chat over the budget was trimmed in the
// middle of a tool fan-out, so the request went out as [system, system, tool, …]
// and the provider answered 400 invalid_request_message_order
// "Unexpected role 'tool' after role 'system'".
{
  const budgets = [];
  for (let groups = 14; groups <= 40; groups += 1) {
    for (const pauseNote of [false, true]) {
      for (const fanoutAt of [3, 9, 15]) {
        const conversation = buildLongConversation({ groups, fanoutAt, fanoutSize: 8, pauseNote });
        if (conversation.length <= 80) continue;
        const label = `groups=${groups} pauseNote=${pauseNote} fanoutAt=${fanoutAt}`;
        const sent = [];
        const { options } = makeBaseOptions({
          messages: conversation,
          streamChatCompletion: async function* (request) {
            // Snapshot: the loop keeps appending to the same array after the request.
            sent.push([...request.messages]);
            yield { deltaText: 'done', finishReason: 'stop' };
          },
        });
        const result = await runLlmToolLoop(options);
        assert.equal(result.status, 'completed', label);
        assert.equal(sent.length, 1, label);
        assertProviderSafeOrder(sent[0], label);
        assert.ok(sent[0].length <= 80, `${label}: sent ${sent[0].length} messages, budget is 80`);
        assert.equal(sent[0][sent[0].length - 1].content, 'next prompt', `${label}: newest prompt was trimmed away`);
        budgets.push(sent[0].length);
      }
    }
  }
  assert.ok(budgets.length > 100, `expected a sweep over the budget, got ${budgets.length} cases`);
}

// 6. A room already holding a poisoned conversation (orphan tool results in
// front, a system note left in the middle by an earlier bad trim) is repaired
// before the next request, without waiting for the budget to be exceeded.
{
  const poisoned = [
    { role: 'system', content: 'main system prompt' },
    { role: 'system', content: 'The tool loop reached its per-run limit of 100 iterations and was paused.' },
    { role: 'tool', tool_call_id: 'call-gone-1', content: 'orphan result' },
    { role: 'tool', tool_call_id: 'call-gone-2', content: 'orphan result' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-live', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-live', content: 'live result' },
    { role: 'system', content: 'a note left in the middle of the conversation' },
    { role: 'user', content: 'next prompt' },
  ];
  const sent = [];
  const { options } = makeBaseOptions({
    messages: poisoned,
    streamChatCompletion: async function* (request) {
      sent.push([...request.messages]);
      yield { deltaText: 'done', finishReason: 'stop' };
    },
  });
  const result = await runLlmToolLoop(options);
  assert.equal(result.status, 'completed');
  assertProviderSafeOrder(sent[0], 'poisoned room');
  assert.deepEqual(
    sent[0].filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ['call-live'],
    'orphan tool results must be dropped, answered ones kept',
  );
  assert.equal(sent[0][sent[0].length - 1].content, 'next prompt');
}

console.log('llm-tool-loop.test.js OK');
