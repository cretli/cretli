import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectQwenRunErrorMessages,
  formatQwenApiErrorMessage,
  isFatalQwenApiError,
  readNewQwenApiErrorsFromJsonl,
  readQwenApiErrorFromMessage,
  readQwenProviderErrorProse,
  resolveQwenApiErrorCode,
  sanitizeQwenProjectId,
} from '../qwen-api-error.js';

assert.equal(sanitizeQwenProjectId('/home/user/www/example.com'), '-home-user-www-example-com');

const quotaMessage =
  '429 Your token-plan 1-week quota has been exhausted. The quota will reset at 09-10 09:31:00 UTC.';
const quota = readQwenApiErrorFromMessage({
  type: 'system',
  subtype: 'ui_telemetry',
  systemPayload: {
    uiEvent: {
      'event.name': 'qwen-code.api_error',
      error_message: quotaMessage,
      error_type: 'RateLimitError',
      status_code: 429,
    },
  },
});
assert.equal(quota?.message, quotaMessage);
assert.equal(quota?.statusCode, 429);
assert.equal(isFatalQwenApiError(quota), true);
assert.equal(resolveQwenApiErrorCode(quota), 'qwen_quota');
assert.equal(formatQwenApiErrorMessage(quota), quotaMessage);

assert.equal(isFatalQwenApiError({ message: 'too many requests', statusCode: 429 }), false);
assert.equal(resolveQwenApiErrorCode({ message: 'too many requests', statusCode: 429 }), 'qwen_rate_limit');
assert.equal(isFatalQwenApiError({ message: '404 Model not exist.', statusCode: 404 }), true);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-api-error-'));
const jsonl = path.join(dir, 'session.jsonl');
fs.writeFileSync(jsonl, `${JSON.stringify({ type: 'user', message: { role: 'user' } })}\n`);
const state = { offset: 0 };
assert.equal(readNewQwenApiErrorsFromJsonl(jsonl, state).length, 0);
fs.appendFileSync(jsonl, `${JSON.stringify({
  type: 'system',
  subtype: 'ui_telemetry',
  systemPayload: {
    uiEvent: {
      'event.name': 'qwen-code.api_error',
      error_message: quotaMessage,
      error_type: 'RateLimitError',
      status_code: 429,
    },
  },
})}\n`);
const added = readNewQwenApiErrorsFromJsonl(jsonl, state);
assert.equal(added.length, 1);
assert.equal(added[0].message, quotaMessage);
assert.equal(readNewQwenApiErrorsFromJsonl(jsonl, state).length, 0);
fs.rmSync(dir, { recursive: true, force: true });

// A quota failure can surface only as assistant prose (the CLI formats the
// provider error as its answer) while the result record is empty. The run error
// must still pick that prose up so the shared usage-limit store locks Qwen
// until the reset the provider stated.
const quotaProse =
  'Quota exhausted: Your token-plan 1-month quota has been exhausted. The quota will reset at 11-04 16:00:00 UTC.\n\n'
  + 'Please retry after the reset time, or switch to another API key / auth method. '
  + '(cause: insufficient_quota: 429 Your token-plan 1-month quota has been exhausted. '
  + 'The quota will reset at 11-04 16:00:00 UTC.)';
assert.equal(readQwenProviderErrorProse(quotaProse), quotaProse);
assert.equal(readQwenProviderErrorProse('Here is the plan you asked for.'), '');
assert.equal(readQwenProviderErrorProse(''), '');

// A normal answer is never promoted to the run error; only the empty result
// error plus the provider prose remain as candidates, in that order.
{
  const messages = collectQwenRunErrorMessages({
    resultErrorMessage: '',
    resultText: '',
    assistantText: quotaProse,
  });
  assert.deepEqual(messages, [quotaProse]);
}
{
  const generic = 'Rate limit reached. Try again later.';
  const messages = collectQwenRunErrorMessages({
    resultErrorMessage: generic,
    resultText: generic,
    assistantText: quotaProse,
  });
  assert.deepEqual(messages, [generic, quotaProse], 'the clock-bearing prose must stay a candidate');
}
{
  const messages = collectQwenRunErrorMessages({
    resultErrorMessage: 'Qwen run failed',
    assistantText: 'I would start by reviewing the todo plan.',
  });
  assert.deepEqual(messages, ['Qwen run failed']);
}

console.log('qwen-api-error.test.js OK');
