import assert from 'node:assert/strict';
import {
  isUserCancelledSetupMessage,
  parseTimeoutProgressNotice,
  SUMMARY_FORK_META_LINE_PATTERNS,
} from '../lib/notices.js';

assert.equal(isUserCancelledSetupMessage('cancelled by the user'), true);
assert.equal(isUserCancelledSetupMessage('Anulowano przez użytkownika'), true);
assert.equal(isUserCancelledSetupMessage('network timeout'), false);

const startedPl = parseTimeoutProgressNotice(
  '[SDK] Wysłano prompt. Czekam na pierwszą odpowiedź agenta',
);
assert.equal(startedPl?.isStarted, true);

const startedEn = parseTimeoutProgressNotice(
  "[SDK] Prompt sent. Waiting for the agent's first response",
);
assert.equal(startedEn?.isStarted, true);

const waiting = parseTimeoutProgressNotice(
  '[OpenCode] Still waiting for the first event (12s). Warning threshold in about 8s.',
);
assert.equal(waiting?.idleSeconds, 12);
assert.equal(waiting?.remainingSeconds, 8);

const waitingPl = parseTimeoutProgressNotice(
  '[SDK] Brak nowych zdarzeń od (5s). Timeout za ok. 3s.',
);
assert.equal(waitingPl?.idleSeconds, 5);
assert.equal(waitingPl?.remainingSeconds, 3);

assert.equal(
  SUMMARY_FORK_META_LINE_PATTERNS.some((pattern) => pattern.test('[SDK] No new events')),
  true,
);

console.log('All notices tests passed.');
