import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSwipeOffset,
  shouldCommitArchiveSwipe,
} from '../app_front/features/sidebar/sidebarChatSwipeArchive.js';

test('swipe offset follows the finger then resists past the threshold', () => {
  assert.equal(resolveSwipeOffset(-20), 0);
  assert.equal(resolveSwipeOffset(40), 40);
  assert.ok(resolveSwipeOffset(200) < 200);
  assert.ok(resolveSwipeOffset(200) > 84);
});

test('commit needs the threshold or a quick flick', () => {
  assert.equal(shouldCommitArchiveSwipe({ dx: 90, velocityX: 0 }), true);
  assert.equal(shouldCommitArchiveSwipe({ dx: 50, velocityX: 0.1 }), false);
  assert.equal(shouldCommitArchiveSwipe({ dx: 50, velocityX: 1 }), true);
  assert.equal(shouldCommitArchiveSwipe({ dx: 20, velocityX: 2 }), false);
});
