import assert from 'node:assert/strict';
import {
  FINISHED_READ_VISIBLE_MS,
  resolveChatListDotState,
  resolveFinishedReadMeta,
} from '../app_front/features/chat/chatStatusMeta.js';
import { renderSidebarChatStatusHtml, isIconOnlySidebarStatus } from '../app_front/features/sidebar/sidebarChatStatus.js';
import { notifyAgentFinished } from '../lib/agent-finished-push.js';

const finished = '2026-10-13T10:00:00.000Z';
const base = Date.parse(finished);

assert.equal(resolveFinishedReadMeta({}), null);
assert.equal(resolveFinishedReadMeta({ lastFinishedAt: finished, archivedAt: 'x' }), null);
assert.equal(resolveFinishedReadMeta({ lastFinishedAt: finished }, { now: base + 1000 }).tone, 'finished');
assert.equal(
  resolveFinishedReadMeta({ lastFinishedAt: finished, lastSeenAt: '2026-10-13T09:00:00.000Z' }, { now: base }).tone,
  'finished',
);
assert.equal(
  resolveFinishedReadMeta({ lastFinishedAt: finished, lastSeenAt: '2026-10-13T10:05:00.000Z' }, { now: base + 60000 }).tone,
  'seen',
);
assert.equal(
  resolveFinishedReadMeta(
    { lastFinishedAt: finished, lastSeenAt: '2026-10-13T10:05:00.000Z' },
    { now: base + FINISHED_READ_VISIBLE_MS + 1 },
  ),
  null,
);
assert.equal(resolveChatListDotState('finished'), 'idle');
assert.equal(resolveChatListDotState('seen'), 'idle');
assert.equal(isIconOnlySidebarStatus('finished'), true);
assert.match(renderSidebarChatStatusHtml({ tone: 'finished' }), /mdi-check-circle"/);
assert.match(renderSidebarChatStatusHtml({ tone: 'seen' }), /mdi-check-circle-outline/);

const stamped = [];
const deps = { isPushAvailable: () => false, markChatFinished: (id) => stamped.push(id) };
notifyAgentFinished({ chatId: 'c1', status: 'completed' }, deps);
notifyAgentFinished({ chatId: 'c2', status: 'cancelled' }, deps);
notifyAgentFinished({ chatId: 'c3', status: 'plan_guard_cancelled' }, deps);
assert.deepEqual(stamped, ['c1']);
console.log('chat-finished-read-meta ok');
