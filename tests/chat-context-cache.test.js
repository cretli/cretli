import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCodexContextUsage } from '../lib/codex/codex-context-usage.ts';
import { applyCodexMeasuredContextUsage, buildChatContextSnapshot, resetChatContextMeterState } from '../app_front/features/chat/chatContextMeter.js';
import { renderChatContextCacheHtml } from '../app_front/features/chat/chatContextBreakdownView.js';
const t = (key, values = {}) => `${key} ${Object.values(values).join(' ')}`;
const parse = (cached) => parseCodexContextUsage(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: cached, output_tokens: 100, total_tokens: 1100 }, model_context_window: 10000 } } }));

test('cache read counters survive measurements without reducing context occupancy', () => {
  const chat = { agentTransport: 'codex' };
  applyCodexMeasuredContextUsage(chat, parse(800));
  const snapshot = buildChatContextSnapshot(chat);
  assert.equal(snapshot.cacheReadTokens, 800);
  assert.equal(snapshot.fillPercent, 11);
  const html = renderChatContextCacheHtml(snapshot, t);
  assert.match(html, /80\.0%/);
  assert.match(html, /contextCacheNew 200/);
  resetChatContextMeterState(chat, { markFreshSession: true });
  assert.equal(buildChatContextSnapshot(chat).cacheReadTokens, null);
});

test('missing and invalid cache values stay unknown; measured zero is valid', () => {
  for (const value of [undefined, null, -1, 2000]) assert.equal(parse(value).usage.cacheReadTokens, null);
  const chat = { agentTransport: 'codex' };
  applyCodexMeasuredContextUsage(chat, parse(0));
  assert.match(renderChatContextCacheHtml(buildChatContextSnapshot(chat), t), /0\.0%/);
  assert.match(renderChatContextCacheHtml({ transport: 'codex', inputTokens: 1000, cacheReadTokens: null }, t), /contextCacheUnknown/);
  assert.equal(renderChatContextCacheHtml({ transport: 'claude' }, t), '');
});
