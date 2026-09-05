import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractCodexApiErrorMessage,
  formatCodexExecFailure,
  readCodexSessionTurnError,
} from '../lib/codex/codex-exec-error.js';

const nested400 = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6-astra\' model is not supported when using Codex with a ChatGPT account."}}';

assert.equal(
  extractCodexApiErrorMessage(nested400),
  "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
);

const jsonl = [
  '{"type":"session_meta","payload":{}}',
  `{"type":"event_msg","payload":{"type":"task_complete","error":{"message":${JSON.stringify(nested400)}}}}`,
].join('\n');
assert.equal(
  readCodexSessionTurnError(jsonl),
  "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
);

assert.match(
  formatCodexExecFailure({ execMessage: 'Codex Exec exited with code 1: Reading prompt from stdin...\n' }),
  /not be available on this ChatGPT account/,
);

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-codex-exec-error-'));
const threadId = '01a070e8-7fa9-7ce1-af59-2fc2ccc88eda';
const logDir = path.join(homeDir, 'sessions', '2026', '09', '05');
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, `rollout-2026-09-05T11-31-20-${threadId}.jsonl`), jsonl);
assert.equal(
  formatCodexExecFailure({
    execMessage: 'Codex Exec exited with code 1: Reading prompt from stdin...',
    turnError: 'Model metadata for `gpt-6-astra` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    homeDir,
    threadId,
  }),
  "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.",
);

console.log('codex-exec-error.test.js OK');
