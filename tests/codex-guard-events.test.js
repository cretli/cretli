import assert from 'node:assert/strict';
import { normalizeCodexThreadEvent } from '../lib/agent-harness/codex-event-normalizer.js';
import { resolvePlanModeSdkEventDecision, REVIEW_GUARD_USER_MESSAGE } from '../lib/sdk/sdk-plan-guard.js';
import { buildCodexGuardEvents } from '../lib/codex/codex-guard-events.js';

// Reproduce the batch from the review: two reads followed by an opaque wrapper.
const commands = [
  'nl -ba lib/browser/redaction.js',
  'nl -ba lib/browser/debugger.js',
  '/workspace/scripts/git-wrapper.sh /workspace log -3 --oneline',
  'git log -3 --oneline',
  'rm -rf output',
];
const visibleEvents = [];
for (const [index, command] of commands.entries()) {
  const [item] = normalizeCodexThreadEvent({
    type: 'item.started',
    item: { type: 'command_execution', id: `item_${index}`, command },
  });
  const decision = resolvePlanModeSdkEventDecision({
    transport: 'codex', mode: 'agent', assignment: 'review', event: item,
  });
  const expectedDenied = index === 2 || index === 4;
  assert.equal(decision.deny, expectedDenied, command);
  if (!decision.deny) continue;
  assert.equal(decision.abortRun, true);
  const events = buildCodexGuardEvents(item, REVIEW_GUARD_USER_MESSAGE);
  assert.equal(events.length, 2);
  assert.equal(events[0].status, 'running');
  assert.equal(events[1].status, 'error');
  assert.equal(events[1].result, REVIEW_GUARD_USER_MESSAGE);
  for (const event of events) {
    assert.equal(event.call_id, item.call_id);
    assert.deepEqual(event.args, { command });
    assert.equal(event.name, 'shell');
  }
  assert.equal(item.status, 'running');
  visibleEvents.push(...events);
}
assert.deepEqual(visibleEvents.map((event) => event.args.command), [commands[2], commands[2], commands[4], commands[4]]);
console.log('codex-guard-events.test.js OK');
