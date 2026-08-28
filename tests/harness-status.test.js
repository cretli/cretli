import assert from 'node:assert/strict';
import { getHarnessStatus } from '../lib/harness-status.js';

const previousCursor = process.env.CURSOR_API_KEY;
const previousOpenRouter = process.env.OPENROUTER_API_KEY;
const previousOpenCode = process.env.OPENCODE_API_KEY;
delete process.env.CURSOR_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENCODE_API_KEY;

try {
  const status = await getHarnessStatus();
  assert.equal(typeof status.sdk.available, 'boolean');
  assert.equal(typeof status.sdk.configured, 'boolean');
  assert.equal(status.openrouter.available, true);
  assert.equal(status.opencode.available, true);
  assert.equal(status.anyConfigured, status.sdk.configured || status.opencode.configured || status.openrouter.configured);
} finally {
  if (typeof previousCursor === 'string') process.env.CURSOR_API_KEY = previousCursor;
  else delete process.env.CURSOR_API_KEY;
  if (typeof previousOpenRouter === 'string') process.env.OPENROUTER_API_KEY = previousOpenRouter;
  else delete process.env.OPENROUTER_API_KEY;
  if (typeof previousOpenCode === 'string') process.env.OPENCODE_API_KEY = previousOpenCode;
  else delete process.env.OPENCODE_API_KEY;
}

console.log('harness-status.test.js OK');
