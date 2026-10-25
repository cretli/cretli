import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatListRowsState } from '../app_front/state/chatListRowsState.js';

test('setChats reports only changed and removed rows, keeping identity for unchanged', () => {
  const s = createChatListRowsState();
  assert.deepEqual(s.setChats([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]).changed, ['a', 'b']);
  const rowA = s.getRow('a');
  const r = s.setChats([{ id: 'a', title: 'A' }, { id: 'b', title: 'B2' }]);
  assert.deepEqual(r, { changed: ['b'], removed: [] });
  assert.equal(s.getRow('a'), rowA);
  assert.deepEqual(s.setChats([{ id: 'b', title: 'B2' }]), { changed: [], removed: ['a'] });
});

test('revision bumps only on a real change', () => {
  const s = createChatListRowsState();
  s.setChats([{ id: 'a', title: 'A' }]);
  const rev = s.revision.get();
  s.setChats([{ id: 'a', title: 'A', streamingDelta: 'x' }]);
  assert.equal(s.revision.get(), rev);
  s.setChats([{ id: 'a', title: 'A2' }]);
  assert.equal(s.revision.get(), rev + 1);
});

test('every field the row render reads marks the row changed', () => {
  const base = { id: 'a', title: 'A' };
  const mutations = {
    title: { title: 'B' },
    agentTransport: { agentTransport: 'codex' },
    isTemporary: { isTemporary: true },
    _pushPreview: { _pushPreview: { text: 'hello' } },
    todoId: { todoId: 't1' },
    onWorktree: { onWorktree: true },
    widgetPinnedUrl: { widgetPinnedUrl: '/x' },
    archivedAt: { archivedAt: '2026-10-24T00:00:00Z' },
    harnessStateCode: { harnessState: { code: 'plugin_disabled' } },
    harnessPluginLabel: { harnessState: { code: 'plugin_disabled', plugin: { label: 'P' } } },
    forkParentChatId: { forkParentChatId: 'p' },
  };
  for (const [name, patch] of Object.entries(mutations)) {
    const s = createChatListRowsState();
    s.setChats([base]);
    assert.deepEqual(s.setChats([{ ...base, ...patch }]).changed, ['a'], `${name} must be tracked`);
  }
});

test('volatile fields the row never paints do not mark it changed', () => {
  const s = createChatListRowsState();
  s.setChats([{ id: 'a', title: 'A', updatedAt: 1 }]);
  assert.deepEqual(s.setChats([{ id: 'a', title: 'A', updatedAt: 2, model: 'm' }]).changed, []);
});
