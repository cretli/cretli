import assert from 'node:assert/strict';
import {
  accumulateStreamText,
  createRunAssistantStreamCapture,
  extractLatestPlanMarkdownFromEvents,
  extractPlanTextFromSdkEvent,
  noteRunAssistantStreamEvent,
  readRunAssistantStreamCombinedText,
  rebuildAssistantTextFromHistoryEvents,
  resetRunAssistantStreamCapture,
} from '../lib/sdk/sdk-plan-text.js';

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

function assistantEvent(text, id = '', streamTextMode = '') {
  const message = { role: 'assistant', content: [{ type: 'text', text }] };
  if (id) message.id = id;
  const event = { type: 'assistant', message };
  if (streamTextMode) event.streamTextMode = streamTextMode;
  return event;
}

runCase('accumulateStreamText snapshot: prefix replace and shrink guard', () => {
  assert.equal(accumulateStreamText('', 'Hello'), 'Hello');
  assert.equal(accumulateStreamText('Hello', 'Hello world'), 'Hello world');
  assert.equal(accumulateStreamText('Hello world', 'Hello'), 'Hello world');
  assert.equal(accumulateStreamText('Hello ', 'world', 'snapshot'), 'Hello world');
});

runCase('accumulateStreamText delta: always append including repeats and prefix chunks', () => {
  assert.equal(accumulateStreamText('', 'a', 'delta'), 'a');
  assert.equal(accumulateStreamText('a', 'a', 'delta'), 'aa');
  assert.equal(accumulateStreamText('aa', 'a', 'delta'), 'aaa');
  assert.equal(accumulateStreamText('Hello wor', 'ld', 'delta'), 'Hello world');
  assert.equal(accumulateStreamText('ab', 'a', 'delta'), 'aba');
  assert.equal(accumulateStreamText('longer text', 'a', 'delta'), 'longer texta');
});

runCase('comment then progressive Raport snapshots stay separate items', () => {
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('Komentarz. '));
  for (const part of ['R', 'Ra', 'Rap', 'Raport']) {
    noteRunAssistantStreamEvent(state, assistantEvent(part));
  }
  assert.equal(readRunAssistantStreamCombinedText(state), 'Komentarz.\n\nRaport');
});

runCase('diagnosis loop size stays O(content) not O(n^2) prefixes', () => {
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('Komentarz. '));
  for (const part of ['R', 'Ra', 'Rap', 'Raport']) {
    noteRunAssistantStreamEvent(state, assistantEvent(part));
  }
  const combined = readRunAssistantStreamCombinedText(state);
  assert.equal(combined.length < 50, true);
  assert.equal(combined.includes('RRa'), false);
});

runCase('progressive snapshots on one message id coalesce', () => {
  const state = createRunAssistantStreamCapture();
  for (const text of ['# Step 1', '# Step 1\n# Step 2']) {
    noteRunAssistantStreamEvent(state, assistantEvent(text, 'msg-1'));
  }
  assert.equal(readRunAssistantStreamCombinedText(state), '# Step 1\n# Step 2');
});

runCase('delta chunks append within the same anonymous item', () => {
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('Zaczynam od ', '', 'delta'));
  noteRunAssistantStreamEvent(state, assistantEvent('lokalnego kodu.\n\n- punkt', '', 'delta'));
  assert.equal(readRunAssistantStreamCombinedText(state), 'Zaczynam od lokalnego kodu.\n\n- punkt');
});

runCase('anonymous delta Hello wor + ld stays one item', () => {
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('Hello wor', '', 'delta'));
  noteRunAssistantStreamEvent(state, assistantEvent('ld', '', 'delta'));
  assert.equal(readRunAssistantStreamCombinedText(state), 'Hello world');
});

runCase('delta stream preserves repeated a tokens as aaa', () => {
  const state = createRunAssistantStreamCapture();
  for (const chunk of ['a', 'a', 'a']) {
    noteRunAssistantStreamEvent(state, assistantEvent(chunk, '', 'delta'));
  }
  assert.equal(readRunAssistantStreamCombinedText(state), 'aaa');
});

runCase('multiple assistant messages join with blank line', () => {
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('First reply', 'm1'));
  noteRunAssistantStreamEvent(state, { type: 'tool_call', name: 'Read' });
  noteRunAssistantStreamEvent(state, assistantEvent('Final answer', 'm2'));
  assert.equal(readRunAssistantStreamCombinedText(state), 'First reply\n\nFinal answer');
});

runCase('legal repeated tokens and whitespace are preserved (delta mode)', () => {
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('token', 'stream-1', 'delta'));
  noteRunAssistantStreamEvent(state, assistantEvent(' token', 'stream-1', 'delta'));
  assert.equal(readRunAssistantStreamCombinedText(state), 'token token');
});

runCase('CreatePlan tool and assistant text share one run stream', () => {
  const planMarkdown = '# Plan title\n\n- step one\n- step two';
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('Draft intro.', 'm1', 'delta'));
  noteRunAssistantStreamEvent(state, {
    type: 'tool_call',
    name: 'CreatePlan',
    args: { plan: planMarkdown },
  });
  noteRunAssistantStreamEvent(state, assistantEvent('Done.', 'm2', 'delta'));
  assert.equal(readRunAssistantStreamCombinedText(state), 'Draft intro.\n\nDone.');
  assert.equal(
    extractPlanTextFromSdkEvent({
      type: 'tool_call',
      name: 'CreatePlan',
      args: { plan: planMarkdown },
    }),
    planMarkdown,
  );
});

runCase('final snapshot replaces shorter prefix on same item', () => {
  const state = createRunAssistantStreamCapture();
  noteRunAssistantStreamEvent(state, assistantEvent('Raport', 'final'));
  noteRunAssistantStreamEvent(state, assistantEvent('Raport\n\nTASK: implement\nVERDICT: PASS', 'final'));
  assert.equal(readRunAssistantStreamCombinedText(state), 'Raport\n\nTASK: implement\nVERDICT: PASS');
});

runCase('rebuildAssistantTextFromHistoryStore respects user turn boundaries', () => {
  const state = createRunAssistantStreamCapture();
  const text = rebuildAssistantTextFromHistoryEvents(state, [
    {
      seq: 1,
      rec: { kind: 'sdk', event: assistantEvent('First reply', 'a1') },
    },
    { seq: 2, rec: { kind: 'localUser' } },
    {
      seq: 3,
      rec: { kind: 'sdk', event: assistantEvent('Final answer', 'a2') },
    },
  ]);
  assert.equal(text, 'Final answer');
});

runCase('extractPlanTextFromSdkEvent: reads args.plan', () => {
  const actualPlan = extractPlanTextFromSdkEvent({
    type: 'tool_call',
    args: { plan: '# Full plan\n\n- step' },
  });
  assert.equal(actualPlan, '# Full plan\n\n- step');
});

runCase('extractLatestPlanMarkdownFromEvents: prefers CreatePlan over short assistant closer', () => {
  const inputEvents = [
    {
      seq: 1,
      rec: {
        kind: 'sdk',
        event: { type: 'assistant', message: { content: [{ type: 'text', text: 'and the scope of OSS fixes.' }] } },
      },
    },
    {
      seq: 2,
      rec: {
        kind: 'sdk',
        event: {
          type: 'tool_call',
          name: 'CreatePlan',
          args: { plan: '# System analysis\n\n## Verdict\n\nSuitable for OSS.' },
        },
      },
    },
    {
      seq: 3,
      rec: {
        kind: 'sdk',
        event: {
          type: 'tool_call',
          name: 'CreatePlan',
          args: { plan: '# System analysis\n\n## Verdict\n\nSuitable for OSS.\n\n## Details\n\nLists and mermaid.' },
        },
      },
    },
  ];
  const actualMarkdown = extractLatestPlanMarkdownFromEvents(inputEvents);
  assert.match(actualMarkdown, /## Verdict/);
  assert.match(actualMarkdown, /Lists and mermaid/);
  assert.equal(actualMarkdown.includes('the scope of OSS fixes'), false);
});

runCase('extractLatestPlanMarkdownFromEvents: later shorter complete plan replaces', () => {
  const inputEvents = [
    {
      seq: 1,
      rec: {
        kind: 'localUser',
        text: 'plan v1',
      },
    },
    {
      seq: 2,
      rec: {
        kind: 'sdk',
        event: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '# Long plan\n\n## One\n\nLots of extra context that is now stale.' }] },
        },
      },
    },
    {
      seq: 3,
      rec: {
        kind: 'localUser',
        text: 'shorten it',
      },
    },
    {
      seq: 4,
      rec: {
        kind: 'sdk',
        event: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '# Short plan\n\n- do the work' }] },
        },
      },
    },
  ];
  const actualMarkdown = extractLatestPlanMarkdownFromEvents(inputEvents);
  assert.match(actualMarkdown, /Short plan/);
  assert.equal(actualMarkdown.includes('stale'), false);
});

process.exit(failed ? 1 : 0);
