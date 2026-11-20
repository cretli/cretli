import { html } from 'lit';
import { t } from '../../../i18n/index.js';

export function emitTodoPriorityChange(card, item, event) {
  const id = item?.id ? String(item.id) : '';
  if (id) card._emit('todo-priority-change', { id, priority: String(event?.detail?.value || '') });
}

export function emitTodoExecutionModeChange(card, item, event) {
  const id = item?.id ? String(item.id) : '';
  if (!id) return;
  const raw = String(event?.detail?.value || '').trim();
  const executionMode = raw === 'worktree' || raw === 'project' ? raw : 'inherit';
  card._emit('todo-executionmode-change', { id, executionMode });
}

export function renderTodoPriorityField(item, card) {
  const priorityOptions = [
    { value: '', label: t('todo.priorityDefault') },
    { value: 'urgent', label: t('todo.priorityUrgent') },
    { value: 'high', label: t('todo.priorityHigh') },
    { value: 'normal', label: t('todo.priorityNormal') },
    { value: 'low', label: t('todo.priorityLow') },
    { value: 'background', label: t('todo.priorityBackground') },
  ];
  return html`<label class="cr-field">
    <span class="cr-field-label">${t('todo.priority')}</span>
    <cr-bar-select class="todo-editor-priority" size="md" aria-label=${t('todo.priority')}
      .value=${String(item?.priority || '')} .options=${priorityOptions}
      @cr-change=${(event) => emitTodoPriorityChange(card, item, event)}></cr-bar-select>
  </label>`;
}
