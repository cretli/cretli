import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearReuseChatReservationsForTests,
  isReuseChatReserved,
  releaseReuseChat,
  reserveReuseChat,
  resolveTodoExecutorChatId,
  resolveTodoReuseCandidates,
  todoReuseLimits,
} from '../lib/todo-chat-reuse.js';

const warm = (expiresInMs = 120_000, inputTokens = 12_000) => ({
  cache: { state: 'warm', ttlKnown: true, expiresInMs },
  context: { inputTokens },
});

function fixture(overrides = {}) {
  const items = overrides.items || [
    { id: 'root', status: 'doing', siblingIndex: 0, orchestratorChatId: 'root-chat' },
    { id: 'previous', parentId: 'root', siblingIndex: 0, status: 'done', chatId: 'candidate' },
    { id: 'target', parentId: 'root', siblingIndex: 1, status: 'ready' },
  ];
  const chats = overrides.chats || [
    { id: 'candidate', title: 'Previous stage', agentTransport: 'claude', model: 'sonnet' },
    { id: 'root-chat', title: 'Root', agentTransport: 'claude' },
  ];
  return {
    items,
    todoId: 'target',
    chats,
    delegations: [],
    ownerInputs: { activeChatIds: [], activeDelegations: [], chatRows: [] },
    watcherCycleTodoIds: [],
    getCacheFreshness: () => warm(),
    isChatBusy: () => false,
    hasActiveDelegations: () => false,
    isWatcherCycleChat: () => false,
    isReserved: () => false,
    executionFolder: '',
    ...overrides,
  };
}

test('executor resolution prefers chat, then orchestrator, then latest finished implement/fix delegation', () => {
  const rows = [
    { leafId: 'leaf', assignment: 'implement', parentChatId: 'old', finishedAt: '2026-01-01T00:00:00Z' },
    { leafId: 'leaf', assignment: 'fix', parentChatId: 'new', finishedAt: '2026-01-02T00:00:00Z' },
  ];
  assert.equal(resolveTodoExecutorChatId({ id: 'leaf', chatId: 'direct', orchestratorChatId: 'orch' }, rows), 'direct');
  assert.equal(resolveTodoExecutorChatId({ id: 'leaf', orchestratorChatId: 'orch' }, rows), 'orch');
  assert.equal(resolveTodoExecutorChatId({ id: 'leaf', linkedChatIds: ['ignored'] }, rows), 'new');
});

test('candidate sources are ordered and deduplicated', () => {
  const input = fixture({
    items: [
      { id: 'root', status: 'doing', orchestratorChatId: 'root-chat' },
      { id: 'previous', parentId: 'root', siblingIndex: 0, status: 'done', orchestratorChatId: 'candidate' },
      { id: 'target', parentId: 'root', siblingIndex: 1, status: 'ready', chatId: 'candidate' },
    ],
  });
  assert.deepEqual(resolveTodoReuseCandidates(input).map((row) => row.chatId), ['candidate', 'root-chat']);
});

test('warm cache thresholds are inclusive and unknown/cold/expiring/large contexts are rejected', () => {
  assert.equal(resolveTodoReuseCandidates(fixture({ getCacheFreshness: () => warm(60_000, 300_000) }))[0].eligible, true);
  const cases = [
    ['cache_unknown', { cache: { state: 'warm', ttlKnown: false, expiresInMs: 120_000 }, context: { inputTokens: 1 } }],
    ['cache_cold', { cache: { state: 'cold', ttlKnown: true, expiresInMs: 0 }, context: { inputTokens: 1 } }],
    ['cache_expiring', warm(59_999, 1)],
    ['context_too_large', warm(120_000, 300_001)],
  ];
  for (const [reason, freshness] of cases) {
    assert.equal(resolveTodoReuseCandidates(fixture({ getCacheFreshness: () => freshness }))[0].reason, reason);
  }
});

test('reason priority covers watcher, ownership, run, delegation, reservation, todo and folder gates', () => {
  const predicates = [
    ['tree_owned_by_watcher', { watcherCycleTodoIds: ['root'] }],
    ['owned_by_watcher', { isWatcherCycleChat: (chatId) => chatId === 'candidate' }],
    ['busy', { isChatBusy: () => true }],
    ['delegations_active', { hasActiveDelegations: () => true }],
    ['reserved', { isReserved: () => true }],
    ['folder_mismatch', { executionFolder: '/worktree' }],
  ];
  for (const [reason, extra] of predicates) {
    const candidate = resolveTodoReuseCandidates(fixture(extra)).find((row) => row.chatId === 'candidate');
    assert.equal(candidate.reason, reason);
  }
  const claimed = fixture({
    items: [
      { id: 'root', status: 'doing' },
      { id: 'previous', parentId: 'root', siblingIndex: 0, status: 'done', chatId: 'candidate' },
      { id: 'target', parentId: 'root', siblingIndex: 1, status: 'ready' },
      { id: 'other', parentId: 'root', siblingIndex: 2, status: 'doing', chatId: 'candidate' },
    ],
  });
  assert.equal(resolveTodoReuseCandidates(claimed)[0].reason, 'claimed_by_other_todo');
});

test('foreign tree owners remain visible after excluding the candidate itself', () => {
  const items = [
    { id: 'root', status: 'doing', orchestratorChatId: 'recent' },
    { id: 'previous', parentId: 'root', siblingIndex: 0, status: 'done', chatId: 'candidate' },
    { id: 'target', parentId: 'root', siblingIndex: 1, status: 'ready' },
    { id: 'other', parentId: 'root', siblingIndex: 2, status: 'doing', chatId: 'foreign', orchestratorChatId: 'recent' },
  ];
  assert.equal(resolveTodoReuseCandidates(fixture({ items, ownerInputs: { activeChatIds: ['foreign'] } }))[0].reason, 'tree_busy');
  assert.equal(resolveTodoReuseCandidates(fixture({
    items,
    ownerInputs: { activeDelegations: [{ parentChatId: 'foreign', childChatId: 'child', leafId: 'other' }] },
  }))[0].reason, 'tree_busy');
  assert.equal(resolveTodoReuseCandidates(fixture({
    items,
    ownerInputs: { chatRows: [{ id: 'recent', createdAt: new Date().toISOString() }], now: Date.now() },
  }))[0].reason, 'tree_owned_by_other');
  const onlyCandidate = fixture({ ownerInputs: { activeChatIds: ['candidate'] } });
  assert.equal(resolveTodoReuseCandidates(onlyCandidate)[0].eligible, true);
});

test('reservations are exclusive, owner-aware, releasable and expire', () => {
  clearReuseChatReservationsForTests();
  assert.equal(reserveReuseChat('chat', 'one', 100, 1_000), true);
  assert.equal(reserveReuseChat('chat', 'two', 100, 1_001), false);
  assert.equal(isReuseChatReserved('chat', 'one', 1_001), false);
  assert.equal(isReuseChatReserved('chat', 'two', 1_001), true);
  releaseReuseChat('chat', 'one');
  assert.equal(isReuseChatReserved('chat', 'two', 1_002), false);
  assert.equal(reserveReuseChat('chat', 'one', 100, 2_000), true);
  assert.equal(reserveReuseChat('chat', 'two', 100, 2_101), true);
});

test('environment limits accept non-negative values and fall back safely', () => {
  assert.deepEqual(todoReuseLimits({
    CRETLI_TODO_REUSE_MAX_CONTEXT_TOKENS: '42',
    CRETLI_TODO_REUSE_MIN_CACHE_MS: '7',
  }), { maxContextTokens: 42, minRemainingMs: 7 });
  assert.deepEqual(todoReuseLimits({
    CRETLI_TODO_REUSE_MAX_CONTEXT_TOKENS: '-1',
    CRETLI_TODO_REUSE_MIN_CACHE_MS: 'nope',
  }), { maxContextTokens: 300_000, minRemainingMs: 60_000 });
});

test('renewing a reservation extends its TTL for the owner and fails once another todo took the expired chat', () => {
  clearReuseChatReservationsForTests();
  const t0 = 1_000_000;
  assert.equal(reserveReuseChat('chat-r', 'todo-a', 1000, t0), true);
  // Owner renews inside the TTL: the expiry moves forward.
  assert.equal(reserveReuseChat('chat-r', 'todo-a', 1000, t0 + 900), true);
  assert.equal(isReuseChatReserved('chat-r', 'todo-b', t0 + 1500), true);
  // After the renewed TTL elapses another todo takes the chat; the old owner's renewal is refused.
  assert.equal(reserveReuseChat('chat-r', 'todo-b', 1000, t0 + 2000), true);
  assert.equal(reserveReuseChat('chat-r', 'todo-a', 1000, t0 + 2100), false);
  clearReuseChatReservationsForTests();
});

test('same-todo requests with different owners cannot share a reservation; the owner can renew and release', () => {
  clearReuseChatReservationsForTests();
  assert.equal(reserveReuseChat('chat-o', 'todo', 1000, 100, 'req-1'), true);
  assert.equal(reserveReuseChat('chat-o', 'todo', 1000, 200, 'req-2'), false);
  assert.equal(reserveReuseChat('chat-o', 'todo', 1000, 300, 'req-1'), true);
  releaseReuseChat('chat-o', 'todo', 'req-2');
  assert.equal(reserveReuseChat('chat-o', 'todo', 1000, 400, 'req-2'), false);
  releaseReuseChat('chat-o', 'todo', 'req-1');
  assert.equal(reserveReuseChat('chat-o', 'todo', 1000, 500, 'req-2'), true);
  clearReuseChatReservationsForTests();
});
