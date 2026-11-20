/** DOM of the Tasks dropdown list (running runs + startable tasks), built with DOM nodes, no HTML strings. */
import { t } from '../../../i18n/index.js';
import { isAutoStartExcludedTask } from '../services/tasksAutostart.js';

export const TASK_VALUE_PREFIX = 'task:';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function headerItem(text) {
  return el('li', 'chat-list-item chat-list-item-header', text);
}

function taskItem({ value, label, title, selected, stateClass, hint }) {
  const li = el('li', 'chat-list-item' + (selected ? ' is-active' : ''));
  li.setAttribute('role', 'option');
  li.dataset.taskValue = value;
  li.dataset.taskLabel = label;
  li.tabIndex = -1;
  const state = el('span', 'chat-list-item-state ' + stateClass);
  state.setAttribute('aria-hidden', 'true');
  const titleEl = el('span', 'chat-list-item-title', title);
  if (hint) titleEl.title = hint;
  li.append(state, titleEl);
  if (hint) {
    const hintEl = el('span', 'chat-list-item-hint', hint);
    hintEl.style.fontSize = 'var(--cr-font-size-xs)';
    hintEl.style.color = 'var(--cr-text-muted)';
    li.appendChild(hintEl);
  }
  return li;
}

export function buildTaskListNodes({ orderedTaskRuns, orderedTasksAvailable, selectedValue }) {
  const frag = document.createDocumentFragment();
  const running = orderedTaskRuns.map((r) => taskItem({
    value: r.id,
    label: r.taskLabel,
    title: r.taskLabel + (r.runId ? '' : t('tasks.connectingSuffix')),
    selected: selectedValue === r.id,
    stateClass: 'chat-list-item-state--active',
  }));
  const showFolderHeaders = new Set(
    orderedTasksAvailable.map((task) => task.folderName).filter(Boolean)
  ).size > 1;
  let lastFolderHeader = null;
  const devBuildWarning = t('tasks.devBuildWarning');
  const available = [];
  for (const task of orderedTasksAvailable) {
    const value = TASK_VALUE_PREFIX + task.label;
    if (showFolderHeaders && task.folderName && task.folderName !== lastFolderHeader) {
      available.push(headerItem(task.folderName));
    }
    if (task.folderName) lastFolderHeader = task.folderName;
    available.push(taskItem({
      value,
      label: task.label,
      title: task.label,
      selected: selectedValue === value,
      stateClass: 'chat-list-item-state--idle',
      hint: isAutoStartExcludedTask(task.label) ? devBuildWarning : '',
    }));
  }
  if (running.length) frag.append(headerItem(t('tasks.active')), ...running);
  if (available.length) frag.append(headerItem(t('tasks.available')), ...available);
  if (!running.length && !available.length) {
    frag.appendChild(el('li', 'chat-list-item tasks-start-empty', t('tasks.none')));
  }
  return frag;
}
