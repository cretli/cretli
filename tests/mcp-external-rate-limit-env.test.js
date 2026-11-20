import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_MCP_RATE_LIMIT_PER_WINDOW,
  consumeExternalMcpRateLimit,
  resolveExternalMcpRateLimit,
  setExternalMcpRateLimit,
} from '../lib/mcp/mcp-external-audit.js';

test('CRETLI_EXTERNAL_MCP_RATE_LIMIT overrides the per-window limit', () => {
  assert.equal(resolveExternalMcpRateLimit({}), EXTERNAL_MCP_RATE_LIMIT_PER_WINDOW);
  assert.equal(resolveExternalMcpRateLimit({ CRETLI_EXTERNAL_MCP_RATE_LIMIT: '300' }), 300);
  for (const bad of ['0', '-5', '2.5', 'abc', '']) {
    assert.equal(resolveExternalMcpRateLimit({ CRETLI_EXTERNAL_MCP_RATE_LIMIT: bad }), EXTERNAL_MCP_RATE_LIMIT_PER_WINDOW, bad);
  }
});

test('a raised limit lets more calls through in one window', () => {
  setExternalMcpRateLimit(resolveExternalMcpRateLimit({ CRETLI_EXTERNAL_MCP_RATE_LIMIT: '100' }));
  try {
    const now = 1_000_000;
    for (let i = 0; i < 100; i += 1) assert.equal(consumeExternalMcpRateLimit('client-a', 1, now), true);
    assert.equal(consumeExternalMcpRateLimit('client-a', 1, now), false);
  } finally {
    setExternalMcpRateLimit(EXTERNAL_MCP_RATE_LIMIT_PER_WINDOW);
  }
});
