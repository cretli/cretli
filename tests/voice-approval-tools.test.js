import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VOICE_APPROVAL_ANSWERS,
  collectPendingApprovals,
  createApprovalToolHandlers,
  normalizeVoiceApprovalAnswer,
  readClosedPermissionRequestIds,
  readPendingPermissionCards,
} from '../app_front/features/approval/voiceApprovalTools.js';
import { resolveVoiceNavKey } from '../app_front/features/voice/voiceNavMatch.js';
import { executeRealtimeTool } from '../app_front/features/voice/realtimeTools.js';
import { formatVoiceState } from '../app_front/features/voice/voiceStateSync.js';
import { getVoiceAction } from '../lib/voice/action-registry.js';

/**
 * @param {string} requestId
 * @param {{ action?: string, resources?: string[], command?: string }} [options]
 */
function permissionEvent(requestId, { action = 'bash', resources = [], command = '' } = {}) {
  return {
    type: 'opencode_permission',
    requestId,
    action,
    resources,
    metadata: command ? { command } : undefined,
  };
}

/**
 * @param {string} id
 * @param {string} title
 * @param {{ event?: object, count?: number }} [options]
 */
function makeChat(id, title, { event = null, count = 0 } = {}) {
  return {
    id,
    title,
    _opencodePendingPermission: event,
    _sdkServerPendingPermissionCount: count,
  };
}

/**
 * @param {{
 *   chats: object[],
 *   activeChatId: string,
 *   cards?: object[],
 *   closedRequestIds?: string[],
 *   replyResult?: object,
 * }} input
 */
function makeHarness({ chats, activeChatId, cards = [], closedRequestIds = [], replyResult = { ok: true } }) {
  const state = { chats, activeChatId, cards, closedRequestIds, replies: [] };
  const handlers = createApprovalToolHandlers({
    getActiveChat() {
      const chat = state.chats.find((entry) => entry.id === state.activeChatId);
      return chat ? { id: chat.id, title: chat.title } : null;
    },
    listPendingApprovals() {
      return collectPendingApprovals({
        chats: state.chats,
        activeChatId: state.activeChatId,
        cards: state.cards,
        closedRequestIds: state.closedRequestIds,
      });
    },
    replyToApproval(input) {
      state.replies.push(input);
      return replyResult;
    },
  });
  return { state, handlers };
}

function makeCardNode({ requestId, tool = 'bash', resources = [], className = 'sdk-rich-opencode-permission' }) {
  return {
    dataset: { requestId },
    className,
    querySelector(selector) {
      return selector === '.sdk-rich-opencode-permission-text' ? { textContent: tool } : null;
    },
    querySelectorAll(selector) {
      if (selector !== '.sdk-rich-opencode-permission-resources li') return [];
      return resources.map((text) => ({ textContent: text }));
    },
  };
}

function makeCardRoot(nodes) {
  return { querySelectorAll: () => nodes };
}

test('the approval schema exposes only once and reject and no confirm path', () => {
  const action = getVoiceAction('approval');
  assert.equal(action.handler, 'approval');
  assert.ok(['safe', 'confirm'].includes(action.risk));
  assert.deepEqual(action.required, ['action']);
  assert.deepEqual(action.properties.action.enum, ['describe_pending', 'answer']);
  assert.deepEqual(action.properties.answer.enum, ['once', 'reject']);
  assert.deepEqual(VOICE_APPROVAL_ANSWERS, ['once', 'reject']);
  assert.equal('confirm' in action.properties, false, 'no confirm variant for grants');
  assert.equal(action.properties.answer.enum.includes('always'), false);
  assert.equal(action.properties.answer.enum.includes('harness'), false);
});

test('answers normalize only to once or reject', () => {
  assert.equal(normalizeVoiceApprovalAnswer('once'), 'once');
  assert.equal(normalizeVoiceApprovalAnswer(' REJECT '), 'reject');
  for (const value of ['always', 'harness', 'yes', 'tak', '', null]) {
    assert.equal(normalizeVoiceApprovalAnswer(value), '', String(value));
  }
});

test('describe_pending lists both requests with tool, chat and requestId', async () => {
  const first = permissionEvent('req-a', { action: 'bash', command: 'npm test' });
  const second = permissionEvent('req-b', { action: 'edit', resources: ['/repo/src/app.js'] });
  const { handlers } = makeHarness({
    chats: [
      makeChat('chat-1', 'Fix login', { event: first, count: 1 }),
      makeChat('chat-2', 'Voice work', { event: second, count: 1 }),
    ],
    activeChatId: 'chat-1',
  });
  const actual = await handlers.approval({ action: 'describe_pending' });
  assert.equal(actual.ok, true);
  assert.equal(actual.pending, 2);
  assert.match(actual.hint, /More than one/);
  assert.equal(actual.requests.length, 2);
  const byId = new Map(actual.requests.map((row) => [row.requestId, row]));
  assert.deepEqual(byId.get('req-a'), {
    requestId: 'req-a',
    chatId: 'chat-1',
    chat: 'Fix login',
    tool: 'bash',
    summary: 'bash: npm test',
  });
  assert.equal(byId.get('req-b').tool, 'edit');
  assert.equal(byId.get('req-b').summary, 'edit: app.js');
});

test('two pending requests: a bare yes/no does nothing and asks for clarification', async () => {
  const { state, handlers } = makeHarness({
    chats: [
      makeChat('chat-1', 'First', { event: permissionEvent('req-a'), count: 1 }),
      makeChat('chat-2', 'Second', { event: permissionEvent('req-b'), count: 1 }),
    ],
    activeChatId: 'chat-1',
  });
  for (const answer of ['once', 'reject']) {
    const actual = await handlers.approval({ action: 'answer', answer });
    assert.equal(actual.ok, false);
    assert.equal(actual.needsClarification, true);
    assert.match(actual.error, /request_id is required/);
  }
  assert.deepEqual(state.replies, [], 'an unbound answer never resolves a request');
});

test('two cards in one chat are counted even when chat state only knows one', async () => {
  const active = makeChat('chat-1', 'Busy', {
    event: permissionEvent('req-a', { action: 'bash', command: 'ls' }),
    count: 1,
  });
  const cards = [
    { requestId: 'req-a', tool: 'bash', resources: ['ls'] },
    { requestId: 'req-b', tool: 'edit', resources: ['src/b.js'] },
  ];
  const { state, handlers } = makeHarness({ chats: [active], activeChatId: 'chat-1', cards });
  const described = await handlers.approval({ action: 'describe_pending' });
  assert.equal(described.pending, 2);
  assert.equal(described.requests.length, 2);
  const bare = await handlers.approval({ action: 'answer', answer: 'once' });
  assert.equal(bare.ok, false);
  assert.equal(bare.needsClarification, true);
  assert.deepEqual(state.replies, []);
  const bound = await handlers.approval({
    action: 'answer', answer: 'once', request_id: 'req-b', chat_id: 'chat-1',
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.requestId, 'req-b');
  assert.deepEqual(state.replies, [{ chatId: 'chat-1', requestId: 'req-b', answer: 'once' }]);
});

test('a request the server counts but cannot name still forces clarification', async () => {
  const active = makeChat('chat-1', 'Busy', {
    event: permissionEvent('req-a'),
    count: 3,
  });
  const { state, handlers } = makeHarness({ chats: [active], activeChatId: 'chat-1' });
  const described = await handlers.approval({ action: 'describe_pending' });
  assert.equal(described.pending, 3);
  assert.equal(described.requests.length, 1);
  const bare = await handlers.approval({ action: 'answer', answer: 'reject' });
  assert.equal(bare.ok, false);
  assert.equal(bare.needsClarification, true);
  assert.deepEqual(state.replies, []);
});

test('chat switch between question and answer approves nothing', async () => {
  const { state, handlers } = makeHarness({
    chats: [
      makeChat('chat-1', 'Original', { event: permissionEvent('req-a'), count: 1 }),
      makeChat('chat-2', 'Other', {}),
    ],
    activeChatId: 'chat-1',
  });
  const described = await handlers.approval({ action: 'describe_pending' });
  assert.equal(described.pending, 1);
  state.activeChatId = 'chat-2';
  const withChat = await handlers.approval({
    action: 'answer', answer: 'once', request_id: 'req-a', chat_id: 'chat-1',
  });
  assert.equal(withChat.ok, false);
  assert.match(withChat.error, /active chat changed/);
  const withoutChat = await handlers.approval({
    action: 'answer', answer: 'once', request_id: 'req-a',
  });
  assert.equal(withoutChat.ok, false);
  assert.match(withoutChat.error, /active chat changed|another chat|no longer pending/);
  assert.deepEqual(state.replies, [], 'a stale chat binding never approves');
});

test('switching to the chat that owns the request still requires a fresh describe', async () => {
  const { state, handlers } = makeHarness({
    chats: [
      makeChat('chat-1', 'First', { event: permissionEvent('req-a'), count: 1 }),
      makeChat('chat-2', 'Second', { event: permissionEvent('req-b'), count: 1 }),
    ],
    activeChatId: 'chat-1',
  });
  const described = await handlers.approval({ action: 'describe_pending' });
  assert.equal(described.pending, 2);
  state.activeChatId = 'chat-2';
  const stale = await handlers.approval({
    action: 'answer', answer: 'once', request_id: 'req-b', chat_id: 'chat-2',
  });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /active chat changed/);
  assert.deepEqual(state.replies, []);
  // A fresh description in the new chat re-binds the question to that chat.
  assert.equal((await handlers.approval({ action: 'describe_pending' })).pending, 2);
  const fresh = await handlers.approval({
    action: 'answer', answer: 'reject', request_id: 'req-b', chat_id: 'chat-2',
  });
  assert.equal(fresh.ok, true);
  assert.deepEqual(state.replies, [{ chatId: 'chat-2', requestId: 'req-b', answer: 'reject' }]);
});

test('a late answer after the request was decided in the UI does nothing', async () => {
  const active = makeChat('chat-1', 'Current', { event: permissionEvent('req-a'), count: 1 });
  const { state, handlers } = makeHarness({ chats: [active], activeChatId: 'chat-1' });
  assert.equal((await handlers.approval({ action: 'describe_pending' })).pending, 1);
  // The UI button resolved the request: chat state clears and the card is gone.
  active._opencodePendingPermission = null;
  active._sdkServerPendingPermissionCount = 0;
  state.cards = [];
  const actual = await handlers.approval({
    action: 'answer', answer: 'once', request_id: 'req-a', chat_id: 'chat-1',
  });
  assert.equal(actual.ok, false);
  assert.match(actual.error, /no longer pending/);
  assert.deepEqual(state.replies, []);
});

test('UI-answered and resolved cards are not treated as pending', () => {
  const cards = [
    makeCardNode({ requestId: 'open' }),
    makeCardNode({ requestId: 'answered', className: 'sdk-rich-opencode-permission sdk-rich-opencode-permission--answered' }),
    makeCardNode({ requestId: 'resolved', className: 'sdk-rich-opencode-permission sdk-rich-opencode-permission--resolved' }),
  ];
  const actual = readPendingPermissionCards(makeCardRoot(cards));
  assert.deepEqual(actual.map((card) => card.requestId), ['open']);
  assert.deepEqual(readPendingPermissionCards(null), []);
  assert.deepEqual(readClosedPermissionRequestIds(makeCardRoot(cards)), ['answered', 'resolved']);
});

test('an answered card blocks a racing voice answer before server resolution', async () => {
  const active = makeChat('chat-1', 'Current', { event: permissionEvent('req-a'), count: 1 });
  const closedIds = readClosedPermissionRequestIds(makeCardRoot([
    makeCardNode({
      requestId: 'req-a',
      className: 'sdk-rich-opencode-permission sdk-rich-opencode-permission--answered',
    }),
  ]));
  const { state, handlers } = makeHarness({
    chats: [active],
    activeChatId: 'chat-1',
    closedRequestIds: closedIds,
  });
  const described = await handlers.approval({ action: 'describe_pending' });
  assert.equal(described.requests.length, 0, 'the answered request is not offered');
  const actual = await handlers.approval({
    action: 'answer', answer: 'once', request_id: 'req-a', chat_id: 'chat-1',
  });
  assert.equal(actual.ok, false);
  assert.match(actual.error, /no longer pending|not described/);
  assert.deepEqual(state.replies, []);
});

test('replayed cards without a live pending signal are ignored', () => {
  const active = makeChat('chat-1', 'Stale', { count: 0 });
  const cards = [{ requestId: 'old', tool: 'bash', resources: ['npm test'] }];
  const snapshot = collectPendingApprovals({ chats: [active], activeChatId: 'chat-1', cards });
  assert.equal(snapshot.total, 0);
  assert.deepEqual(snapshot.requests, []);
});

test('once and reject execute only for a bound, still-pending request', async () => {
  for (const answer of ['once', 'reject']) {
    const { state, handlers } = makeHarness({
      chats: [makeChat('chat-1', 'Only', { event: permissionEvent('req-a'), count: 1 })],
      activeChatId: 'chat-1',
    });
    await handlers.approval({ action: 'describe_pending' });
    const actual = await handlers.approval({
      action: 'answer', answer, request_id: 'req-a', chat_id: 'chat-1',
    });
    assert.equal(actual.ok, true);
    assert.equal(actual.answer, answer);
    assert.equal(actual.requestId, 'req-a');
    assert.equal(actual.chatId, 'chat-1');
    assert.deepEqual(state.replies, [{ chatId: 'chat-1', requestId: 'req-a', answer }]);
  }
});

test('a single pending request is never answered without a described request_id', async () => {
  const { state, handlers } = makeHarness({
    chats: [makeChat('chat-1', 'Only', { event: permissionEvent('req-a'), count: 1 })],
    activeChatId: 'chat-1',
  });
  const bare = await handlers.approval({ action: 'answer', answer: 'once' });
  assert.equal(bare.ok, false);
  assert.equal(bare.needsClarification, true);
  const undescribed = await handlers.approval({ action: 'answer', answer: 'once', request_id: 'req-a' });
  assert.equal(undescribed.ok, false);
  assert.match(undescribed.error, /not described/);
  assert.deepEqual(state.replies, []);
  const described = await handlers.approval({ action: 'describe_pending' });
  assert.equal(described.untrusted, true);
  assert.match(described.note, /untrusted/);
  const ok = await handlers.approval({ action: 'answer', answer: 'once', request_id: 'req-a' });
  assert.equal(ok.ok, true);
  assert.deepEqual(state.replies, [{ chatId: 'chat-1', requestId: 'req-a', answer: 'once' }]);
  const again = await handlers.approval({ action: 'answer', answer: 'once', request_id: 'req-a' });
  assert.equal(again.ok, false, 'a second voice answer for the same request is refused');
  assert.equal(state.replies.length, 1);
});

test('R1 described, decided in UI, R2 appears: neither a bare nor an R1 answer approves R2', async () => {
  const chat = makeChat('chat-1', 'A', { event: permissionEvent('req-1'), count: 1 });
  const { state, handlers } = makeHarness({ chats: [chat], activeChatId: 'chat-1' });
  await handlers.approval({ action: 'describe_pending' });
  chat._opencodePendingPermission = permissionEvent('req-2');
  const bare = await handlers.approval({ action: 'answer', answer: 'once' });
  assert.equal(bare.ok, false);
  const stale = await handlers.approval({ action: 'answer', answer: 'once', request_id: 'req-1' });
  assert.equal(stale.ok, false);
  const fresh = await handlers.approval({ action: 'answer', answer: 'once', request_id: 'req-2' });
  assert.equal(fresh.ok, false, 'R2 was never described');
  assert.deepEqual(state.replies, []);
});

test('switching to a chat with its own pending request needs describe before answering', async () => {
  const { state, handlers } = makeHarness({
    chats: [
      makeChat('chat-a', 'A', {}),
      makeChat('chat-b', 'B', { event: permissionEvent('req-b'), count: 1 }),
    ],
    activeChatId: 'chat-a',
  });
  await handlers.approval({ action: 'describe_pending' });
  state.activeChatId = 'chat-b';
  assert.equal((await handlers.approval({ action: 'answer', answer: 'once' })).ok, false);
  assert.equal((await handlers.approval({ action: 'answer', answer: 'once', request_id: 'req-b' })).ok, false);
  assert.deepEqual(state.replies, []);
  await handlers.approval({ action: 'describe_pending' });
  assert.equal((await handlers.approval({ action: 'answer', answer: 'reject', request_id: 'req-b' })).ok, true);
  assert.deepEqual(state.replies, [{ chatId: 'chat-b', requestId: 'req-b', answer: 'reject' }]);
});

test('always and harness are impossible by voice — no reply and no grant path', async () => {
  const throwIfCalled = () => {
    throw new Error('approval dependencies must not run for an invalid answer');
  };
  const handlers = createApprovalToolHandlers({
    getActiveChat: throwIfCalled,
    listPendingApprovals: throwIfCalled,
    replyToApproval: throwIfCalled,
  });
  for (const attempt of [
    { answer: 'always' },
    { answer: 'harness' },
    { answer: 'always', confirm: true },
    { answer: 'harness', request_id: 'req-a', chat_id: 'chat-1', confirm: true },
  ]) {
    const actual = await handlers.approval({ action: 'answer', ...attempt });
    assert.equal(actual.ok, false, JSON.stringify(attempt));
    assert.match(actual.error, /once or reject/);
    assert.match(actual.error, /Always and harness grants/);
  }
});

test('the wired client handler also refuses always and harness', async () => {
  for (const answer of ['always', 'harness']) {
    const actual = await executeRealtimeTool('approval', {
      action: 'answer',
      answer,
      request_id: 'req-a',
      chat_id: 'chat-1',
    });
    assert.equal(actual.ok, false, answer);
    assert.match(actual.error, /once or reject/);
  }
});

test('handler rejects unknown actions and missing bindings safely', async () => {
  const { state, handlers } = makeHarness({
    chats: [makeChat('chat-1', 'Only', { event: permissionEvent('req-a'), count: 1 })],
    activeChatId: 'chat-1',
  });
  assert.equal((await handlers.approval({ action: 'grant' })).ok, false);
  assert.equal((await handlers.approval({ action: 'answer', answer: 'yes' })).ok, false);
  assert.equal((await handlers.approval({
    action: 'answer', answer: 'once', request_id: 'missing', chat_id: 'chat-1',
  })).ok, false);
  assert.equal((await handlers.approval({ action: 'answer', answer: 'once', chat_id: 'other' })).ok, false);
  assert.deepEqual(state.replies, []);
  const none = makeHarness({ chats: [], activeChatId: '' });
  const described = await none.handlers.approval({ action: 'describe_pending' });
  assert.deepEqual(described, { ok: true, pending: 0, hint: 'No permission request is waiting.' });
  assert.equal((await none.handlers.approval({ action: 'answer', answer: 'once' })).ok, false);
});

test('state block carries the pending summary and requestId', () => {
  const text = formatVoiceState({
    chatId: 'c1',
    title: 'Fix login',
    pendingApproval: {
      kind: 'permission',
      summary: 'bash: npm test',
      requestId: 'req-123',
      count: 2,
    },
  });
  assert.match(text, /pending_approval: permission "bash: npm test" \(request req-123\) x2/);
  assert.match(formatVoiceState({}), /pending_approval: none/);
});

test('send_nav keeps its TUI navigation behaviour', () => {
  const action = getVoiceAction('send_nav');
  assert.equal(action.handler, 'send_nav');
  assert.equal(action.risk, 'safe');
  assert.deepEqual(action.required, ['key']);
  assert.equal(resolveVoiceNavKey('tak'), 'y');
  assert.equal(resolveVoiceNavKey('nie'), 'n');
  assert.equal(resolveVoiceNavKey('enter'), 'enter');
  assert.equal(resolveVoiceNavKey('góra'), 'up');
});
