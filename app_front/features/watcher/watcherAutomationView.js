/**
 * Workspace Watcher — automation state block for the Todo "Watcher" tab.
 *
 * Shows whether auto-integrate / auto-restart are on, what the auto-integrator
 * did recently (from the persisted `automaticIntegrations` audit) and a one-click
 * "pause automation" that switches both policies off. Built with DOM nodes only
 * (no innerHTML); the host re-renders it from the cached watcher view.
 */

import { t } from '../../i18n/index.js';

const HOUR_MS = 3600000;
/** Audit reasons that mean "committed locally, waiting for the confirmation step". */
const PENDING_REASONS = new Set(['publication_pending', 'confirmation_pending']);

/**
 * Pure summary of the automation state for one watcher view.
 *
 * @param {any} view
 * @param {number} [now]
 * @returns {{
 *   integrate: boolean, restart: boolean, paused: boolean, anyOn: boolean,
 *   pending: number, commitsLastHour: number, returned: number,
 *   last: { at: string, ok: boolean, reason: string, todoId: string } | null,
 * }}
 */
export function summarizeWatcherAutomation(view, now = Date.now()) {
  const watcher = view?.watcher || {};
  const policy = watcher.policy || {};
  const audit = Array.isArray(watcher.automaticIntegrations) ? watcher.automaticIntegrations : [];
  const integrate = policy.autoIntegrate === true;
  const restart = policy.autoRestart === true;
  const last = audit.length ? audit[audit.length - 1] : null;
  return {
    integrate,
    restart,
    paused: watcher.paused === true,
    anyOn: integrate || restart,
    pending: audit.filter((entry) => PENDING_REASONS.has(String(entry?.reason || ''))).length,
    commitsLastHour: audit.filter((entry) => entry?.ok === true && Date.parse(entry.at) > now - HOUR_MS).length,
    returned: audit.filter((entry) => entry?.ok !== true && !PENDING_REASONS.has(String(entry?.reason || ''))).length,
    last: last
      ? { at: String(last.at || ''), ok: last.ok === true, reason: String(last.reason || ''), todoId: String(last.todoId || '') }
      : null,
  };
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function row(label, value) {
  const el = document.createElement('div');
  el.className = 'todo-watcher-automation-row';
  const name = document.createElement('span');
  name.className = 'todo-watcher-automation-label';
  name.textContent = label;
  const text = document.createElement('span');
  text.className = 'todo-watcher-automation-value';
  text.textContent = value;
  el.append(name, text);
  return el;
}

/**
 * Re-render the block into `host`. Hidden while no view is available.
 *
 * @param {HTMLElement | null} host
 * @param {any} view
 * @param {{ busy?: boolean, error?: string }} [options]
 */
export function paintWatcherAutomation(host, view, options = {}) {
  if (!host) return;
  host.replaceChildren();
  if (!view?.watcher) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const s = summarizeWatcherAutomation(view);
  const onOff = (on) => t(on ? 'todo.watcherAutomationOn' : 'todo.watcherAutomationOff');

  const head = document.createElement('div');
  head.className = 'todo-watcher-automation-head';
  const title = document.createElement('span');
  title.className = 'todo-watcher-title';
  title.textContent = t('todo.watcherAutomationTitle');
  const pill = document.createElement('span');
  pill.className = 'todo-watcher-pill';
  pill.dataset.tone = s.anyOn && !s.paused ? 'working' : 'paused';
  pill.textContent = s.anyOn && s.paused ? t('todo.watcherAutomationPausedByWatcher') : onOff(s.anyOn);
  const spacer = document.createElement('span');
  spacer.className = 'todo-watcher-spacer';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'todo-watcher-btn';
  button.dataset.watcherAutomationPause = '';
  button.disabled = !s.anyOn || options.busy === true;
  button.title = t('todo.watcherAutomationPauseHint');
  const icon = document.createElement('span');
  icon.className = 'mdi mdi-pause';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.textContent = t(options.busy ? 'todo.watcherAutomationPausing' : 'todo.watcherAutomationPause');
  button.append(icon, label);
  head.append(title, pill, spacer, button);

  const lastText = s.last
    ? `${s.last.at} · ${s.last.ok ? t('todo.watcherAutomationResultOk') : s.last.reason || t('todo.watcherAutomationResultFailed')}`
    : t('todo.watcherAutomationNone');
  host.append(
    head,
    row(t('todo.watcherAutomationIntegrate'), onOff(s.integrate)),
    row(t('todo.watcherAutomationRestart'), onOff(s.restart)),
    row(t('todo.watcherAutomationQueue'), String(s.pending)),
    row(t('todo.watcherAutomationCommits'), String(s.commitsLastHour)),
    row(t('todo.watcherAutomationReturns'), String(s.returned)),
    row(t('todo.watcherAutomationLastEntry'), lastText),
  );
  if (options.error) {
    const err = document.createElement('p');
    err.className = 'todo-watcher-error';
    err.textContent = options.error;
    host.append(err);
  }
}
