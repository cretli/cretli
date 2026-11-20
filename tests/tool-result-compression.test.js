import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripAnsi, collapseWhitespace, dedupeRepeatedLines, minifyJson, headTail, compressToolResult, recoverToolResult } from '../lib/tool-result-compression/index.js';
import { compressMcpTextResult, formatMcpToolResult } from '../lib/mcp/mcp-runtime.js';

test('strategies produce deterministic compact text', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(collapseWhitespace('a   b\n\n\n c'), 'a b\n\n c');
  assert.equal(dedupeRepeatedLines('x\nx\ny'), 'x\n[previous line repeated 1 times]\ny');
  assert.equal(minifyJson('{ "a": 1 }'), '{"a":1}');
  assert.match(headTail('a'.repeat(100), 10), /elided 90 characters/);
  assert.equal(minifyJson('plain text'), 'plain text');
});

test('opt-in and exact recovery', () => {
  const original = '\x1b[31mhello\x1b[0m\n'.repeat(1000);
  assert.equal(compressToolResult(original), original);
  const first = compressToolResult(original, { enabled: true });
  assert.equal(first, compressToolResult(original, { enabled: true }));
  const id = first.match(/full tool result: ([a-f0-9]{64})/)[1];
  assert.equal(recoverToolResult(id), original);
});

test('MCP image and mixed content remain byte-identical, including text', () => {
  process.env.CRETLI_TOOL_RESULT_COMPRESSION = '1';
  try {
    const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
    const text = { type: 'text', text: 'same line\n'.repeat(1500) };
    for (const content of [[image], [text, image]]) {
      const result = { content };
      assert.equal(compressMcpTextResult(result, 'read_image'), formatMcpToolResult(result));
      assert.deepEqual(result.content, content);
    }
    const error = { isError: true, content: [text] };
    assert.equal(compressMcpTextResult(error, 'failed_tool'), formatMcpToolResult(error));
  } finally {
    delete process.env.CRETLI_TOOL_RESULT_COMPRESSION;
  }
});
removeIsolatedDataDir();
