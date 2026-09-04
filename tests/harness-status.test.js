import assert from 'node:assert/strict';
import { getHarnessStatus } from '../lib/harness-status.js';

const previousCursor = process.env.CURSOR_API_KEY;
const previousOpenRouter = process.env.OPENROUTER_API_KEY;
const previousOpenCode = process.env.OPENCODE_API_KEY;
const previousZai = process.env.ZAI_API_KEY;
const previousZaiCoding = process.env.ZAI_CODING_API_KEY;
delete process.env.CURSOR_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENCODE_API_KEY;
delete process.env.ZAI_API_KEY;
delete process.env.ZAI_CODING_API_KEY;

try {
  const status = await getHarnessStatus();
  assert.equal(typeof status.sdk.available, 'boolean');
  assert.equal(typeof status.sdk.configured, 'boolean');
  assert.equal(status.openrouter.available, true);
  assert.equal(status.opencode.available, true);
  assert.equal(typeof status.codebuddy.available, 'boolean');
  assert.equal(typeof status.codebuddy.configured, 'boolean');
  assert.equal(typeof status.deepseek.available, 'boolean');
  assert.equal(typeof status.deepseek.configured, 'boolean');
  assert.equal(typeof status.codex.available, 'boolean');
  assert.equal(typeof status.codex.configured, 'boolean');
  assert.equal(typeof status.qwen.available, 'boolean');
  assert.equal(typeof status.qwen.configured, 'boolean');
  assert.equal(
    status.anyConfigured,
    status.sdk.configured
      || status.opencode.configured
      || status.openrouter.configured
      || status.codebuddy.configured
      || status.deepseek.configured
      || status.codex.configured
      || status.qwen.configured,
  );
} finally {
  if (typeof previousCursor === 'string') process.env.CURSOR_API_KEY = previousCursor;
  else delete process.env.CURSOR_API_KEY;
  if (typeof previousOpenRouter === 'string') process.env.OPENROUTER_API_KEY = previousOpenRouter;
  else delete process.env.OPENROUTER_API_KEY;
  if (typeof previousOpenCode === 'string') process.env.OPENCODE_API_KEY = previousOpenCode;
  else delete process.env.OPENCODE_API_KEY;
  if (typeof previousZai === 'string') process.env.ZAI_API_KEY = previousZai;
  else delete process.env.ZAI_API_KEY;
  if (typeof previousZaiCoding === 'string') process.env.ZAI_CODING_API_KEY = previousZaiCoding;
  else delete process.env.ZAI_CODING_API_KEY;
}

process.env.ZAI_API_KEY = ['zai.test.', 'key.1234567890'].join('');
try {
  const withZai = await getHarnessStatus();
  assert.equal(withZai.opencode.configured, true);
  assert.equal(withZai.anyConfigured, true);
} finally {
  delete process.env.ZAI_API_KEY;
  if (typeof previousZai === 'string') process.env.ZAI_API_KEY = previousZai;
}

console.log('harness-status.test.js OK');
