import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  formatQwenApiErrorMessage,
  isFatalQwenApiError,
  readNewQwenApiErrorsFromJsonl,
  readQwenApiErrorFromMessage,
  resolveQwenApiErrorCode,
  sanitizeQwenProjectId,
} from '../lib/qwen/qwen-api-error.js';

assert.equal(sanitizeQwenProjectId('/home/ar2oor/www/cretli.com'), '-home-ar2oor-www-cretli-com');

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

console.log('qwen-api-error.test.js OK');
