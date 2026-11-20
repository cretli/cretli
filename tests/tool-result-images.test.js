import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { configureChatMedia } from '../lib/chat-media.js';
import { externalizeToolResultImages, chatMediaSaver } from '../lib/agent-harness/tool-result-images.ts';
import { normalizeClaudeMessage } from '../lib/agent-harness/claude-event-normalizer.ts';
import { normalizeCodexThreadEvent } from '../lib/agent-harness/codex-event-normalizer.ts';

import { handleThreadEvent } from '../lib/codex/codex-agent-ws.ts';

configureChatMedia({ dataDir: path.join(ISOLATED_DATA_DIR, 'tri-media'), enabled: true });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 7)]);
const b64 = PNG.toString('base64');
const URL_RE = /\[image: \/api\/chats\/chat-t\/media\/\d{13}-[a-f0-9-]{36}\.png image\/png 608B\]/;

const claudeMsg = (data, extra = {}) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }], ...extra }] },
});
const codexEvent = (data) => ({
  type: 'item.completed',
  item: { id: 'i1', type: 'mcp_tool_call', server: 's', tool: 'read', status: 'completed', result: { content: [{ type: 'image', data, mimeType: 'image/png' }] } },
});
const noBlob = (s) => { assert.ok(!s.includes('"data":"')); assert.ok(!/[A-Za-z0-9+/=]{200,}/.test(s)); };

test('valid PNG becomes a marker; input not mutated', () => {
  const msg = claudeMsg(b64);
  const before = JSON.stringify(msg);
  const out = externalizeToolResultImages(msg, chatMediaSaver('chat-t'));
  assert.equal(JSON.stringify(msg), before);
  assert.match(out.message.content[0].content[0].text, URL_RE);
});

test('bad magic, SVG, >5MB, save null and save throwing are omitted', () => {
  const save = chatMediaSaver('chat-t');
  const omitted = (data, s = save) => externalizeToolResultImages(claudeMsg(data), s).message.content[0].content[0].text;
  assert.equal(omitted(Buffer.from('not an image at all').toString('base64')), '[image omitted]');
  assert.equal(omitted(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')), '[image omitted]');
  const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(5 * 1024 * 1024 + 1)]).toString('base64');
  assert.equal(omitted(big), '[image omitted]');
  assert.equal(omitted(b64, () => null), '[image omitted]');
  assert.equal(omitted(b64, () => { throw new Error('x'); }), '[image omitted]');
});

test('Claude: externalize + normalize leaves no base64 in result', () => {
  const out = externalizeToolResultImages(claudeMsg(b64), chatMediaSaver('chat-t'));
  const events = normalizeClaudeMessage(out);
  const result = events.find((e) => e.result !== undefined)?.result;
  assert.match(String(result), URL_RE);
  noBlob(JSON.stringify(events));
});

test('Codex: handleThreadEvent with item.completed envelope emits no base64', () => {
  const sent = [];
  const room = {
    chatId: 'chat-t', sessionKey: 'tri-codex', transport: 'codex', cwd: '/w', sdkMode: 'agent',
    clients: new Set([{ readyState: 1, send: (d) => sent.push(JSON.parse(d)) }]),
    eventLog: [], pendingPrompts: [], _persistBuf: [],
  };
  const event = codexEvent(b64);
  const before = JSON.stringify(event);
  handleThreadEvent(room, event);
  assert.equal(JSON.stringify(event), before);
  const tool = sent.filter((p) => p.type === 'sdkEvent' && p.event?.type === 'tool_call').map((p) => p.event);
  assert.ok(tool.length > 0);
  const s = JSON.stringify(tool);
  assert.match(s, /\[image: \/api\/chats\/chat-t\/media\//);
  noBlob(s);
});

test('Codex: externalized envelope normalized by normalizeCodexThreadEvent has no base64', () => {
  const out = externalizeToolResultImages(codexEvent(b64), chatMediaSaver('chat-t'));
  const normalized = JSON.stringify(normalizeCodexThreadEvent(out));
  assert.match(normalized, /\[image: \/api\/chats\/chat-t\/media\//);
  noBlob(normalized);
});

test('GIF is saved and becomes an image/gif marker', () => {
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(40, 1)]);
  const out = externalizeToolResultImages(claudeMsg(gif.toString('base64')), chatMediaSaver('chat-t'));
  assert.match(out.message.content[0].content[0].text, /^\[image: \/api\/chats\/chat-t\/media\/\d{13}-[a-f0-9-]{36}\.gif image\/gif 46B\]$/);
});
