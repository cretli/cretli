import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyCodexBreakdownRecord, buildCodexContextBreakdown, createCodexBreakdownState, readCodexContextBreakdown } from '../lib/codex/codex-context-breakdown.ts';
import { readCodexContextUsage } from '../lib/codex/codex-context-usage.ts';
import { randomUUID } from 'node:crypto';
import { appendChatHistoryEvents, loadChatHistory, deleteChatHistory, summarizeChatHistoryUsage } from '../lib/persist/chat-history-persist.js';
import { renderChatContextBreakdownHtml } from '../app_front/features/chat/chatContextBreakdownView.js';
import { applyCodexMeasuredContextUsage, buildChatContextSnapshot } from '../app_front/features/chat/chatContextMeter.js';

const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
const jsonl = (...records) => records.map((row) => JSON.stringify(row)).join('\n') + '\n';
const row = (breakdown, id) => breakdown.rows.find((item) => item.id === id);
const countRecord = { type: 'event_msg', timestamp: '2026-10-14T12:00:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9000, output_tokens: 1000, total_tokens: 10000 }, model_context_window: 100000 } } };

test('categorizes recorded text, omits encrypted reasoning and never persists source text', () => {
  const state = createCodexBreakdownState();
  const records = [
    { type: 'session_meta', payload: { base_instructions: { text: 'private-system'.repeat(10) } } },
    message('user', 'private-message'.repeat(10)),
    message('developer', 'private-instructions'.repeat(10)),
    message('developer', '<skills_instructions>private-skills</skills_instructions>'),
    message('user', '# AGENTS.md instructions for private-folder\nprivate-memory'),
    { type: 'response_item', payload: { type: 'custom_tool_call', input: 'private-arguments' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'private-output' } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'secret-ciphertext' } },
  ];
  records.forEach((record) => applyCodexBreakdownRecord(state, record));
  const snapshot = buildCodexContextBreakdown(state);
  for (const id of ['messages', 'instructions', 'skills', 'memory', 'systemPrompt', 'toolCalls', 'toolResults']) assert.ok(row(snapshot, id).tokens > 0);
  assert.equal(row(snapshot, 'reasoning').tokens, null);
  assert.equal(row(snapshot, 'systemTools').tokens, null);
  assert.equal(row(snapshot, 'agents').count, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-|secret-/);
});

test('catalog sharing a user message with rules is not counted entirely as skills', () => {
  const state = createCodexBreakdownState();
  applyCodexBreakdownRecord(state, message('user', '[AVAILABLE AGENT SKILLS]\nshort catalog\n[WORKSPACE CURSOR RULES]\n' + 'rules and bundled request'.repeat(100)));
  const snapshot = buildCodexContextBreakdown(state);
  assert.ok(row(snapshot, 'instructions').tokens > row(snapshot, 'skills').tokens);
});

test('compaction replaces the counted transcript and unavailable replacements are partial', () => {
  const state = createCodexBreakdownState();
  applyCodexBreakdownRecord(state, message('user', 'old '.repeat(1000)));
  applyCodexBreakdownRecord(state, { type: 'compacted', payload: { replacement_history: [message('user', 'summary').payload] } });
  const snapshot = buildCodexContextBreakdown(state);
  assert.equal(row(snapshot, 'messages').tokens, 2);
  assert.equal(snapshot.complete, true);
  applyCodexBreakdownRecord(state, { type: 'compacted', payload: { message: 'summary' } });
  assert.equal(buildCodexContextBreakdown(state).complete, false);
});

test('bounded reader handles append, partial lines, restarts and oversized logs incrementally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-context-breakdown-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, jsonl(message('user', 'hello')));
    assert.equal(row(readCodexContextBreakdown(file), 'messages').count, 1);
    assert.equal(row(readCodexContextBreakdown(file), 'messages').count, 1);
    const next = JSON.stringify(message('user', 'next'));
    fs.appendFileSync(file, next.slice(0, 20));
    assert.equal(readCodexContextBreakdown(file).caughtUp, false);
    fs.appendFileSync(file, next.slice(20) + '\n');
    assert.equal(row(readCodexContextBreakdown(file), 'messages').count, 2);
    fs.writeFileSync(file, jsonl(message('user', 'new')));
    assert.equal(row(readCodexContextBreakdown(file), 'messages').count, 1);
    const largeFile = path.join(dir, 'large.jsonl');
    const line = jsonl(message('user', 'x'.repeat(300000)));
    fs.writeFileSync(largeFile, line.repeat(10));
    assert.equal(readCodexContextBreakdown(largeFile).caughtUp, false);
    const complete = readCodexContextBreakdown(largeFile);
    assert.equal(complete.caughtUp, true);
    assert.equal(row(complete, 'messages').count, 10);
    assert.equal(readCodexContextBreakdown(path.join(dir, 'absent')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('numeric snapshot travels through CLI context telemetry, stored history and frontend details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-context-breakdown-'));
  const file = path.join(dir, 'session.jsonl');
  try {
    fs.writeFileSync(file, jsonl(message('user', 'sample'), countRecord));
    const event = readCodexContextUsage({ homeDir: dir, threadId: 'root', filePath: file });
    const stored = summarizeChatHistoryUsage([{ rec: { kind: 'sdk', harness: 'codex', event } }]);
    assert.deepEqual(stored.lastContextUsage.breakdown, event.breakdown);
    const restored = JSON.parse(JSON.stringify(stored.lastContextUsage));
    const chat = { agentTransport: 'codex' };
    applyCodexMeasuredContextUsage(chat, restored);
    const snapshot = buildChatContextSnapshot(chat);
    assert.equal(snapshot.fillPercent, 10);
    assert.deepEqual(snapshot.breakdown, event.breakdown);
    const t = (key) => key;
    const html = renderChatContextBreakdownHtml(snapshot, t);
    assert.match(html, /contextPartMessages/);
    assert.match(html, /contextPartFree/);
    assert.match(html, /90\.0%/);
    assert.match(html, /contextBreakdownEstimate/);
    assert.match(html, /contextBreakdownUnavailable/);
    assert.equal(renderChatContextBreakdownHtml({}, t), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('breakdown is saved to disk and restored when the native session log is gone', () => {
  const chatId = randomUUID();
  const state = createCodexBreakdownState();
  applyCodexBreakdownRecord(state, message('user', 'private-text-never-copied'));
  const event = { type: 'context_usage', source: 'codex-cli', usage: { inputTokens: 9000, outputTokens: 1000, totalTokens: 10000 }, contextWindowTokens: 100000, breakdown: buildCodexContextBreakdown(state) };
  try {
    const result = appendChatHistoryEvents(chatId, 'test-session', [{ rec: { kind: 'sdk', harness: 'codex', event } }]);
    assert.equal(result.ok, true);
    assert.equal(result.appended.length, 1);
    const file = path.join(ISOLATED_DATA_DIR, 'chat-history', `${chatId}.json`);
    const serialized = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(serialized, /private-text/);
    assert.deepEqual(JSON.parse(serialized).events[0].rec.event.breakdown, event.breakdown);
    const loaded = loadChatHistory(chatId);
    assert.deepEqual(loaded.usageSummary.lastContextUsage.breakdown, event.breakdown);
  } finally { deleteChatHistory(chatId); }
});


test('image and audio encodings do not inflate tool text estimates', () => {
  const state = createCodexBreakdownState();
  applyCodexBreakdownRecord(state, { type: 'response_item', payload: { type: 'custom_tool_call_output', output: [
    { type: 'text', text: 'test' },
    { type: 'image', data: 'x'.repeat(1000000) },
    { type: 'input_image', image_url: 'data:image/png;base64,' + 'x'.repeat(1000000) },
  ] } });
  assert.equal(row(buildCodexContextBreakdown(state), 'toolResults').tokens, 1);
});
