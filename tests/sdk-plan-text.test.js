import assert from 'node:assert/strict';
import {
  accumulateStreamText,
  extractLatestPlanMarkdownFromEvents,
  extractPlanTextFromSdkEvent,
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

runCase('accumulateStreamText: grows snapshots and appends deltas', () => {
  assert.equal(accumulateStreamText('', 'Hello'), 'Hello');
  assert.equal(accumulateStreamText('Hello', 'Hello world'), 'Hello world');
  assert.equal(accumulateStreamText('Hello world', 'Hello'), 'Hello world');
  assert.equal(accumulateStreamText('Hello ', 'world'), 'Hello world');
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

process.exit(failed ? 1 : 0);
