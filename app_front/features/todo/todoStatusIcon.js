import { collectTodoSubtreeIds } from '../../../lib/todo-tree.js';
import { isTodoAwaitingIntegration } from '../../../lib/todo-integration-state.js';

const WAITING_TONES = new Set(['awaiting', 'approval', 'question', 'textarea', 'choice']);
const STATUS_ICONS = {
  idea: 'mdi-lightbulb-outline',
  ready: 'mdi-clock-outline',
  doing: 'mdi-cog-outline',
  done: 'mdi-check-circle-outline',
  deferred: 'mdi-calendar-clock-outline',
};

const OPEN_STATUSES = new Set(['idea', 'ready', 'doing']);
const CLOSABLE_REVIEW_STATES = new Set(['passed', 'manual']);

/**
 * A leaf whose code review passed but whose status was never set to `done`
 * (typically work driven from an ad-hoc chat instead of the todo orchestrator).
 * The row offers a one-click close instead of looking unstarted.
 *
 * @param {object | null | undefined} item
 * @param {object[]} [items]
 * @returns {boolean}
 */
export function isTodoReviewedButOpen(item, items = []) {
  if (!item?.id || !OPEN_STATUSES.has(String(item.status || 'idea'))) return false;
  if (!CLOSABLE_REVIEW_STATES.has(String(item?.review?.code?.state || ''))) return false;
  if (isTodoAwaitingIntegration(item)) return false;
  const id = String(item.id);
  return !(Array.isArray(items) ? items : []).some((row) => String(row?.parentId || '') === id);
}

/** Resolve activity from live chat state, including collapsed descendants. */
export function resolveTodoStatusIcon(item, items = [], chats = [], getState = () => null) {
  const status = String(item?.status || 'idea');
  const base = { icon: STATUS_ICONS[status] || STATUS_ICONS.idea, spinning: false, labelKey: `todo.status${status[0]?.toUpperCase()}${status.slice(1)}`, title: '' };
  // A worktree PASS waits for a human, not for an agent: show the integration
  // marker instead of the generic `doing` spinner.
  if (isTodoAwaitingIntegration(item)) {
    return { icon: 'mdi-source-branch-check', spinning: false, labelKey: 'todo.statusIntegrationReady', title: String(item?.title || '') };
  }
  if (status === 'done' || status === 'deferred') return base;
  const ids = new Set(collectTodoSubtreeIds(items, item?.id));
  ids.add(String(item?.id || ''));
  const branch = items.filter((row) => ids.has(row.id) && row.status !== 'done');
  if (!branch.some((row) => row.id === item?.id)) branch.push(item);
  let waiting = null;
  for (const row of branch) {
    const linked = new Set(Array.isArray(row?.agentChatIds) ? row.agentChatIds : (row?.chats || []).filter((chat) => !chat.deleted && chat.roles?.some((role) => ['executor', 'delegate', 'orchestrator'].includes(role))).map((chat) => chat.id));
    for (const id of [row?.chatId, row?.orchestratorChatId]) if (id) linked.add(id);
    for (const chat of chats) {
      if (chat.todoId ? chat.todoId !== row?.id : !linked.has(chat.id)) continue;
      const state = getState(chat);
      if (state?.tone === 'active') return { icon: 'mdi-cog-outline', spinning: true, labelKey: 'todo.agentWorking', title: String(row?.title || '') };
      if (WAITING_TONES.has(state?.tone)) waiting = { icon: 'mdi-pause-circle-outline', spinning: false, labelKey: 'todo.agentWaiting', title: String(row?.title || '') };
    }
  }
  if (waiting) return waiting;
  if (isTodoReviewedButOpen(item, items)) {
    return { icon: 'mdi-check-decagram-outline', spinning: false, labelKey: 'todo.statusReviewedOpen', title: String(item?.title || '') };
  }
  return base;
}
