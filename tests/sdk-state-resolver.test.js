/**
 * Regression tests: resolving the agent state from SDK WS messages.
 * Guards against the "Running in the timeline but Ready in the top badge" regression.
 */
import { resolveAgentStateFromMessage } from '../app_front/features/chat/sdkStateResolver.js';

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`OK: ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL: ${name}`);
  }
}

function msg(type, extra = {}) {
  return { type, ...extra };
}

// hello: busy true -> active
ok('hello busy=true -> active', resolveAgentStateFromMessage('idle', msg('hello', { transport: 'cursor-sdk', busy: true })) === 'active');
// hello: busy false, no queue -> idle
ok('hello busy=false without queue -> idle', resolveAgentStateFromMessage('active', msg('hello', { transport: 'cursor-sdk', busy: false })) === 'idle');
// hello: busy false but the queue is not empty -> active ("Running vs Ready" regression)
ok('hello busy=false with queue -> active', resolveAgentStateFromMessage('idle', msg('hello', { transport: 'cursor-sdk', busy: false, queuedPrompts: ['a'] })) === 'active');
// hello: no busy flag, no queue -> idle
ok('hello without busy -> idle', resolveAgentStateFromMessage('active', msg('hello', { transport: 'cursor-sdk' })) === 'idle');
// hello from a non-cursor-sdk transport -> null
ok('hello from qwen -> idle', resolveAgentStateFromMessage('active', msg('hello', { transport: 'qwen' })) === 'idle');
ok('hello from qwen busy=true -> active', resolveAgentStateFromMessage('idle', msg('hello', { transport: 'qwen', busy: true })) === 'active');
ok('hello from another transport -> null', resolveAgentStateFromMessage('idle', msg('hello', { transport: 'other' })) === null);

// sdkBusy -> active; sdkBusy busy=false -> idle
ok('sdkBusy -> active', resolveAgentStateFromMessage('idle', msg('sdkBusy', { busy: true })) === 'active');
ok('sdkBusy busy=false -> idle', resolveAgentStateFromMessage('active', msg('sdkBusy', { busy: false })) === 'idle');
// sdkQueued -> active
ok('sdkQueued -> active', resolveAgentStateFromMessage('idle', msg('sdkQueued', { text: 'x', position: 1 })) === 'active');
// sdkPromptStarted -> active
ok('sdkPromptStarted -> active', resolveAgentStateFromMessage('idle', msg('sdkPromptStarted', { text: 'x' })) === 'active');
// sdkEvent -> active
ok('sdkEvent -> active', resolveAgentStateFromMessage('idle', msg('sdkEvent', { event: {} })) === 'active');
// sdkRunFinished -> idle
ok('sdkRunFinished -> idle', resolveAgentStateFromMessage('active', msg('sdkRunFinished', { status: 'completed' })) === 'idle');
// sdkRunFinished with a queue -> active, no "Ready" badge flicker
ok(
  'sdkRunFinished with queue -> active',
  resolveAgentStateFromMessage(
    'active',
    msg('sdkRunFinished', { status: 'completed', remaining: 1 })
  ) === 'active'
);
// sdkError -> null (the transport layer sets the state, taking the queue into account)
ok('sdkError -> null', resolveAgentStateFromMessage('active', msg('sdkError', { code: 'run_failed' })) === null);
// sdkPlanGuard -> null (the incoming sdkRunFinished takes over the state)
ok('sdkPlanGuard -> null', resolveAgentStateFromMessage('active', msg('sdkPlanGuard', { toolName: 'edit' })) === null);
// unknown type -> null
ok('unknown type -> null', resolveAgentStateFromMessage('idle', msg('pong')) === null);
// null msg -> null
ok('null msg -> null', resolveAgentStateFromMessage('idle', null) === null);

console.log(`\n${fail === 0 ? `All sdk state resolver tests passed (${pass}).` : `${fail} test(s) failed.`}`);
if (fail > 0) process.exit(1);
