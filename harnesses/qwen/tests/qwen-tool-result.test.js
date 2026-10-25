import assert from 'node:assert/strict';
import { isDeniedQwenToolResult, isFailedQwenToolResult, stringifyQwenToolResult } from '../qwen-tool-result.js';

assert.equal(isDeniedQwenToolResult('[Operation Cancelled] Reason: Denied'), true);
assert.equal(isDeniedQwenToolResult('Listed 7 item(s)'), false);
assert.equal(isDeniedQwenToolResult('User declined to answer the questions.'), true);
assert.equal(isFailedQwenToolResult('[Operation Cancelled] Reason: Denied'), true);
assert.equal(
  isFailedQwenToolResult(
    'File `/home/user/www/example.com/index.php` has not been read in this session. Use the `read_file` tool first to load the current content (read the full file – overwriting replaces every byte, so any unseen bytes would be discarded) before overwriting it.',
  ),
  true,
);
assert.equal(isFailedQwenToolResult('Listed 7 item(s)'), false);

assert.equal(stringifyQwenToolResult([{ text: 'a' }, 'b']), 'a\nb');
assert.equal(stringifyQwenToolResult(null), '');

console.log('qwen-tool-result.test.js ok');
