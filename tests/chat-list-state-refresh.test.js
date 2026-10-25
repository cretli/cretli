import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatByIdMap,
  chatListVisualKey,
  createRafDebouncer,
  shouldSkipChatListItemWrite,
  shouldSkipDisconnectedBackgroundRender,
} from '../app_front/features/chat/chatListStateRefresh.js';

test('buildChatByIdMap indexes by id', () => {
  const map = buildChatByIdMap([{ id: 'a' }, { id: 'b' }, { title: 'no-id' }]);
  assert.equal(map.size, 2);
  assert.equal(map.get('a').id, 'a');
});

test('shouldSkipChatListItemWrite skips identical visual keys', () => {
  const key = chatListVisualKey('disconnected', 'disconnected', 'Disconnected');
  assert.equal(shouldSkipChatListItemWrite(key, key), true);
  assert.equal(shouldSkipChatListItemWrite(key, chatListVisualKey('idle', 'idle', 'Idle')), false);
});

test('shouldSkipDisconnectedBackgroundRender skips already-idle chats without a socket', () => {
  assert.equal(shouldSkipDisconnectedBackgroundRender(null), true);
  assert.equal(
    shouldSkipDisconnectedBackgroundRender({ ws: null, _connectionStatus: 'disconnected' }),
    true
  );
  assert.equal(
    shouldSkipDisconnectedBackgroundRender({ ws: null, _connectionStatus: 'connecting' }),
    false
  );
  assert.equal(
    shouldSkipDisconnectedBackgroundRender({ ws: {}, _connectionStatus: 'disconnected' }),
    false
  );
});

test('createRafDebouncer coalesces multiple schedule calls into one run', async () => {
  let runs = 0;
  /** @type {FrameRequestCallback | null} */
  let pending = null;
  const raf = (cb) => {
    pending = cb;
    return 1;
  };
  const caf = () => {
    pending = null;
  };
  const debouncer = createRafDebouncer(() => {
    runs += 1;
  }, { raf, caf });
  debouncer.schedule();
  debouncer.schedule();
  debouncer.schedule();
  assert.equal(runs, 0);
  assert.equal(debouncer.isScheduled(), true);
  pending();
  assert.equal(runs, 1);
  assert.equal(debouncer.isScheduled(), false);
});
