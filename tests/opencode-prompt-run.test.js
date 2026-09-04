import assert from 'node:assert/strict';
import {
  formatOpenCodeSessionError,
  normalizeOpenCodeEvent,
} from '../lib/agent-harness/opencode-event-normalizer.js';
import {
  createOpenCodePromptRunWaiter,
  bumpOpenCodePromptRunActivity,
  notifyOpenCodePromptRunEnd,
  resolveOpenCodeFirstEventTimeoutMs,
  resolveOpenCodePromptRunFromEvent,
  resolveOpenCodePromptTimeoutMs,
  shouldBumpOpenCodePromptRunActivity,
} from '../lib/opencode/opencode-prompt-run.js';

assert.ok(resolveOpenCodePromptTimeoutMs() >= 60000);
assert.ok(resolveOpenCodeFirstEventTimeoutMs() >= 60000);
const previousFirstEventTimeoutEnv = process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS;
process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS = '45000';
assert.equal(resolveOpenCodeFirstEventTimeoutMs(), 60000);
process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS = '90000';
assert.equal(resolveOpenCodeFirstEventTimeoutMs(), 90000);
if (previousFirstEventTimeoutEnv === undefined) {
  delete process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS;
} else {
  process.env.OPENCODE_FIRST_EVENT_TIMEOUT_MS = previousFirstEventTimeoutEnv;
}

assert.equal(
  formatOpenCodeSessionError({
    name: 'APIError',
    data: { message: 'Billing required', isRetryable: false },
  }),
  'Billing required',
);

assert.equal(
  formatOpenCodeSessionError({
    name: 'ProviderAuthError',
    data: { providerID: 'opencode', message: 'Invalid API key' },
  }),
  'Invalid API key',
);

const errorEvents = normalizeOpenCodeEvent({
  type: 'session.error',
  properties: {
    sessionID: 'sess-1',
    error: {
      name: 'APIError',
      data: { message: 'Model not available', isRetryable: false },
    },
  },
}, { opencodeSessionId: 'sess-1' });
assert.equal(errorEvents[0].kind, 'error');
assert.match(errorEvents[0].message, /Model not available/);

assert.deepEqual(
  resolveOpenCodePromptRunFromEvent({
    type: 'session.error',
    properties: {
      sessionID: 'sess-1',
      error: { data: { message: 'No payment method' } },
    },
  }, { opencodeSessionId: 'sess-1' }),
  { status: 'error', message: 'No payment method' },
);

const room = {};
const waiter = createOpenCodePromptRunWaiter(room, 5000);
const resolved = resolveOpenCodePromptRunFromEvent({
  type: 'session.idle',
  properties: { sessionID: 'sess-2' },
}, { opencodeSessionId: 'sess-2' });
assert.deepEqual(resolved, { status: 'completed' });
notifyOpenCodePromptRunEnd(room, resolved);
const result = await waiter;
assert.equal(result.status, 'completed');

assert.equal(
  shouldBumpOpenCodePromptRunActivity({
    type: 'message.part.updated',
    properties: { sessionID: 'sess-1' },
  }, { opencodeSessionId: 'sess-1' }),
  true,
);
assert.equal(
  shouldBumpOpenCodePromptRunActivity({
    type: 'message.part.updated',
    properties: { sessionID: 'sess-2' },
  }, { opencodeSessionId: 'sess-1' }),
  false,
);
assert.equal(
  shouldBumpOpenCodePromptRunActivity({
    type: 'message.part.updated',
    properties: { sessionId: 'sess-1' },
  }, { opencodeSessionId: 'sess-1' }),
  true,
);
assert.equal(
  shouldBumpOpenCodePromptRunActivity({
    type: 'message.part.updated',
    properties: {},
  }, { opencodeSessionId: 'sess-1' }),
  false,
);

const room2 = {};
const slowWaiter = createOpenCodePromptRunWaiter(room2, 200);
let timedOut = false;
slowWaiter.catch(() => { timedOut = true; });
await new Promise((r) => setTimeout(r, 50));
bumpOpenCodePromptRunActivity(room2);
await new Promise((r) => setTimeout(r, 160));
assert.equal(timedOut, false);
notifyOpenCodePromptRunEnd(room2, { status: 'completed' });
await slowWaiter;

const room3 = {};
const firstEventWaiter = createOpenCodePromptRunWaiter(room3, 5000, 35);
const firstEventTimeoutMessage = await firstEventWaiter
  .then(() => '')
  .catch((err) => (err instanceof Error ? err.message : String(err)));
assert.match(firstEventTimeoutMessage, /first event timed out/i);

const room4 = {};
const firstEventBumpedWaiter = createOpenCodePromptRunWaiter(room4, 180, 35);
await new Promise((r) => setTimeout(r, 20));
bumpOpenCodePromptRunActivity(room4);
await new Promise((r) => setTimeout(r, 120));
notifyOpenCodePromptRunEnd(room4, { status: 'completed' });
const bumpedResult = await firstEventBumpedWaiter;
assert.equal(bumpedResult.status, 'completed');

console.log('opencode-prompt-run.test.js OK');
