import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNewChatRecency, sortLocationOptionsByRecency, sortModelOptionsByRecency, sortWorkspacesByRecency,
} from '../app_front/features/chat/newChatRecency.js';
import { encodeNewChatModelChoice as model } from '../app_front/features/chat/newChatModelOptions.js';
import { encodeNewChatLocation as loc } from '../app_front/features/chat/newChatLocationOptions.js';

const at = (iso) => ({ lastSeenAt: iso, createdAt: iso });
const chats = [
  { id: 'a', workspaceFile: 'w1', agentTransport: 'claude', model: 'opus', workspaceFolder: '/p/one', ...at('2026-11-01T10:00:00Z') },
  { id: 'b', workspaceFile: 'w2', agentTransport: 'codex', model: 'gpt', workspaceFolder: '/p/two', ...at('2026-11-20T10:00:00Z') },
  { id: 'c', workspaceFile: 'w1', agentTransport: 'claude', model: 'sonnet', workspaceFolder: '/p/one', ...at('2026-11-10T10:00:00Z') },
];
const recency = buildNewChatRecency(chats);

test('workspaces newest first, unused keep their order', () => {
  const list = [{ workspaceFile: 'w3' }, { workspaceFile: 'w1' }, { workspaceFile: 'w2' }];
  assert.deepEqual(sortWorkspacesByRecency(list, recency).map((w) => w.workspaceFile), ['w2', 'w1', 'w3']);
});

test('model rows: harnesses by newest model, models by recency, variants stay together', () => {
  const row = (harness, name, variantOf, group) => ({ value: model(harness, name), variantOf, group });
  const rows = [
    row('claude', 'opus::low', 'claude\0opus', 'Claude'), row('claude', 'sonnet', 'claude\0sonnet', 'Claude'),
    row('codex', 'gpt', undefined, 'Codex'),
  ];
  const sorted = sortModelOptionsByRecency(rows, buildNewChatRecency([
    { ...chats[1] }, { ...chats[2] }, { ...chats[0], model: 'opus::low', lastSeenAt: '2026-11-02T10:00:00Z' },
  ]));
  assert.deepEqual(sorted.map((r) => r.group + ':' + r.value.split('"')[3]), ['Codex:gpt', 'Claude:sonnet', 'Claude:opus::low']);
});

test('locations: folders newest first, plain row before worktrees', () => {
  const rows = [loc('/p/one', ''), loc('/p/one', 't1'), loc('/p/two', '')].map((value) => ({ value }));
  assert.deepEqual(sortLocationOptionsByRecency(rows, recency).map((r) => r.value), [loc('/p/two', ''), loc('/p/one', ''), loc('/p/one', 't1')]);
});
