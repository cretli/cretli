/**
 * Worktree marker for sidebar chats.
 *
 * A chat whose linked task tree owns a live worktree is annotated by the server
 * (`onWorktree: true`). The marker must survive the runtime chat-row allowlists,
 * drive the sidebar/repaint signatures, and render exactly one compact badge.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  collectLiveWorktreeTodoIds,
  markWorktreeChats,
} from '../lib/chat-list-payload.js';
import {
  createRuntimeChatFromServerRow,
  mergeExistingChatFromServerRow,
} from '../app_front/features/chat/chatListServerReconcile.js';
import { sanitizeChatRowForBootCache } from '../app_front/features/chat/chatLocalBootCache.js';
import { buildSidebarChatRowHtml } from '../app_front/features/sidebar/sidebarChatRowModel.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRepo(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

function makeReconcileCtx() {
  return {
    readChatBufferForChatRestore: () => null,
    chatBufferMax: 100,
    blockedTransitions: [],
    restoredTransitions: [],
    hydratePresenceChat: () => false,
    presenceDirtyIds: [],
  };
}

test('collectLiveWorktreeTodoIds keeps only live records and dedupes ids', () => {
  const ids = collectLiveWorktreeTodoIds([
    { todoId: ' t1 ', worktreePath: '/wt/t1' },
    { todoId: 't1', worktreePath: '/wt/t1' },
    { todoId: 't2', worktreePath: '/wt/t2', cleanedAt: '2026-01-01T00:00:00.000Z' },
    { todoId: 't3', worktreePath: '' },
    { todoId: '', worktreePath: '/wt/x' },
    null,
    'nope',
  ]);
  assert.deepEqual([...ids], ['t1']);
  assert.equal(collectLiveWorktreeTodoIds(null).size, 0);
});

test('markWorktreeChats flags only chats whose todo owns a live worktree', () => {
  const rows = [
    { id: 'a', todoId: 't1' },
    { id: 'b', todoId: 't2' },
    { id: 'c' },
  ];
  const marked = markWorktreeChats(rows, new Set(['t1']));
  assert.equal(marked[0].onWorktree, true);
  assert.equal('onWorktree' in marked[1], false);
  assert.equal('onWorktree' in marked[2], false);
  assert.equal('onWorktree' in rows[0], false, 'input rows are not mutated');
  assert.equal(markWorktreeChats(rows, new Set()), rows, 'an empty set is a no-op');
});

test('runtime reconcile carries onWorktree onto merged and created rows', () => {
  const ctx = makeReconcileCtx();
  const existing = { id: 'a', title: 'A', summaries: [] };
  mergeExistingChatFromServerRow(
    existing,
    { id: 'a', title: 'A', todoId: 't1', onWorktree: true },
    ctx,
  );
  assert.equal(existing.onWorktree, true);
  mergeExistingChatFromServerRow(existing, { id: 'a', title: 'A', todoId: 't1' }, ctx);
  assert.equal('onWorktree' in existing, false, 'a cleaned worktree clears the marker');
  const created = createRuntimeChatFromServerRow(
    { id: 'b', title: 'B', todoId: 't1', onWorktree: true },
    makeReconcileCtx(),
  );
  assert.equal(created.onWorktree, true);
  const plain = createRuntimeChatFromServerRow({ id: 'c', title: 'C' }, makeReconcileCtx());
  assert.equal('onWorktree' in plain, false);
});

test('boot cache keeps a live worktree marker only when true', () => {
  assert.equal(sanitizeChatRowForBootCache({ id: 'a', onWorktree: true }).onWorktree, true);
  assert.equal('onWorktree' in sanitizeChatRowForBootCache({ id: 'b', onWorktree: false }), false);
});

test('sidebar row renders one worktree badge only for onWorktree chats', () => {
  const deps = {
    t: (key) => key,
    escapeHtml: (v) => String(v ?? ''),
    resolveChatState: () => 'idle',
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Idle' }),
    canPinChatToUrl: () => false,
    resolveSidebarHarnessIcon: () => 'cursor.svg',
    renderChatActionButtonsHtml: () => '',
  };
  const marked = buildSidebarChatRowHtml(
    { id: 'a', title: 'Alpha', agentTransport: 'sdk', todoId: 't1', onWorktree: true },
    'a',
    { level: 0, parentId: '' },
    deps,
  );
  assert.match(marked, /sidebar-chat-item-worktree-badge/);
  assert.match(marked, /sidebar\.worktreeTitle/);
  const plain = buildSidebarChatRowHtml(
    { id: 'a', title: 'Alpha', agentTransport: 'sdk', todoId: 't1' },
    'a',
    { level: 0, parentId: '' },
    deps,
  );
  assert.doesNotMatch(plain, /sidebar-chat-item-worktree-badge/);
});

test('sidebar and repaint signatures react to onWorktree', () => {
  const sidebar = readRepo('app_front/features/sidebar/sidebarView.js');
  assert.equal(
    sidebar.match(/c\.onWorktree \? 'W' : ''/g)?.length,
    2,
    'both workspace signatures include the marker',
  );
  assert.match(
    readRepo('app_front/features/chat/chatController.js'),
    /chat\.onWorktree === true \? '1' : '0'/,
  );
});
