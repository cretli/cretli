import { t } from '../../i18n/index.js';

/**
 * Static option lists for <cr-todo-card>: tab order, status choices and chat
 * role labels. Kept outside the component so the card holds rendering only.
 */

export const TODO_TABS = ['overview', 'plan', 'notes', 'chats', 'history', 'usage', 'settings'];

export function getTodoStatusOptions() {
  return [
    { value: 'idea', label: t('todo.statusIdea') },
    { value: 'ready', label: t('todo.statusReady') },
    { value: 'doing', label: t('todo.statusDoing') },
    { value: 'done', label: t('todo.statusDone') },
    { value: 'deferred', label: t('todo.statusDeferred') },
  ];
}

export const ROLE_KEYS = {
  creator: 'todo.roleCreator',
  planner: 'todo.rolePlanner',
  executor: 'todo.roleExecutor',
  orchestrator: 'todo.roleOrchestrator',
  linked: 'todo.roleLinked',
  delegate: 'todo.roleDelegate',
};
