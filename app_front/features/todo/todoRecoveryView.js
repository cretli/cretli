/**
 * Workspace Watcher todo recovery read-model helpers (pure, DOM-free).
 */

import { t } from '../../i18n/index.js';

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function todoRecoveryDisplayStateKey(row) {
  const display = String(row?.displayState || row?.state || '').trim();
  return display || 'unknown';
}

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function todoRecoveryStateLabel(row) {
  const key = todoRecoveryDisplayStateKey(row);
  const labelKey = `todo.recoveryState_${key}`;
  const translated = t(labelKey);
  return translated !== labelKey ? translated : key;
}

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function todoRecoveryDetailText(row) {
  const reason = String(row?.reason || '').trim();
  const evidence = String(row?.evidence || '').trim();
  const source = String(row?.source || '').trim();
  const parts = [];
  if (evidence) parts.push(t('todo.recoveryEvidence', { evidence }));
  if (source) parts.push(t('todo.recoverySource', { source }));
  if (reason) parts.push(t('todo.recoveryReason', { reason }));
  const attempt = String(row?.attemptId || '').trim();
  if (attempt) parts.push(t('todo.recoveryAttempt', { attempt: attempt.slice(0, 8) }));
  const at = String(row?.lastConfirmedAt || '').trim();
  if (at) parts.push(t('todo.recoveryLastConfirmed', { at }));
  return parts.join(' · ');
}

/**
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function todoRecoveryUnknownHint(row) {
  if (todoRecoveryDisplayStateKey(row) !== 'unknown') return '';
  const reason = String(row?.reason || 'unknown').trim();
  return t('todo.recoveryUnknownHint', { reason });
}

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function canManualRecoverWorkspaceTodo(row) {
  return String(row?.state || '') === 'recoverable';
}

/**
 * @param {object | null | undefined} view
 * @param {string} todoId
 * @returns {object | null}
 */
export function findTodoRecoveryState(view, todoId) {
  const id = String(todoId || '').trim();
  if (!id) return null;
  const rows = Array.isArray(view?.snapshot?.doingStates) ? view.snapshot.doingStates : [];
  return rows.find((row) => String(row?.todoId || '') === id) || null;
}
