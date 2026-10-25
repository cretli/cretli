/**
 * Lit templates for the client instances panel (list, meta, logs).
 */

import { html, nothing } from 'lit';
import { t } from '../../../i18n/index.js';
import { formatBytes, formatRelativeAge } from '../services/instancesApi.js';

/**
 * @param {string} status
 * @returns {string}
 */
function statusLabel(status) {
  if (status === 'online') return t('instances.statusOnline');
  if (status === 'stale') return t('instances.statusStale');
  return t('instances.statusOffline');
}

/**
 * @param {string} kind
 * @returns {string}
 */
function kindIconClass(kind) {
  if (kind === 'pwa') return 'mdi-cellphone-link';
  if (kind === 'embed') return 'mdi-application-outline';
  return 'mdi-web';
}

/**
 * @param {string} message
 * @param {string} [extraClass]
 */
export function instancesEmptyTemplate(message, extraClass = '') {
  return html`<div class="instances-empty ${extraClass}">${message}</div>`;
}

/**
 * @param {{ instances: Array<Record<string, unknown>>, currentId: string, selectedId: string | null, onSelect: (id: string) => void }} p
 */
export function instanceListTemplate({ instances, currentId, selectedId, onSelect }) {
  if (!instances.length) return instancesEmptyTemplate(t('instances.noInstances'));
  return instances.map((instance) => {
    const id = String(instance.id || '');
    const isCurrent = id === currentId;
    const isSelected = id === selectedId;
    const status = String(instance.status || 'offline');
    const kind = String(instance.kind || 'unknown');
    const label = String(instance.label || id.slice(0, 8));
    return html`<button type="button"
      class="instances-card${isSelected ? ' is-selected' : ''}${isCurrent ? ' is-current' : ''}"
      data-instance-id=${id} role="option" aria-selected=${isSelected ? 'true' : 'false'}
      @click=${() => id && onSelect(id)}>
      <span class="instances-card-icon mdi ${kindIconClass(kind)}" aria-hidden="true"></span>
      <span class="instances-card-body">
        <span class="instances-card-title">${label}${isCurrent
          ? html` <span class="instances-this-device">${t('instances.thisDevice')}</span>`
          : nothing}</span>
        <span class="instances-card-sub">${id.slice(0, 8)} · ${formatRelativeAge(Number(instance.lastSeenAt))}</span>
      </span>
      <span class="instances-status instances-status--${status}">${statusLabel(status)}</span>
    </button>`;
  });
}

/**
 * @param {Record<string, unknown>} instance
 */
export function instanceMetaTemplate(instance) {
  const flags = [];
  if (instance.debugRemote === true) flags.push('remote');
  if (instance.debugUiFreeze === true) flags.push('ui-freeze');
  return html`<span>${t('instances.lastSeen')}: ${formatRelativeAge(Number(instance.lastSeenAt))}</span>${
    Number.isFinite(Number(instance.wsCount))
      ? html`<span>${t('instances.wsCount')}: ${String(instance.wsCount)}</span>`
      : nothing}${
    instance.activePanel
      ? html`<span>${t('instances.activePanel')}: ${String(instance.activePanel)}</span>`
      : nothing}${
    instance.activeChatId
      ? html`<span>${t('instances.activeChat')}: ${String(instance.activeChatId).slice(0, 12)}</span>`
      : nothing}${
    Number.isFinite(Number(instance.heapMiB))
      ? html`<span>${t('instances.heap')}: ${String(instance.heapMiB)} MiB</span>`
      : nothing}${
    flags.length
      ? html`<span>${t('instances.debugFlags')}: ${flags.join(', ')}</span>`
      : nothing}`;
}

/**
 * @param {string} message
 */
export function logsPlaceholderTemplate(message) {
  return html`<div class="instances-logs-empty">${message}</div>`;
}

/**
 * @param {string[]} lines
 * @param {number} totalBytes
 */
export function logLinesTemplate(lines, totalBytes) {
  return html`${lines.map((line) => html`<div class="log-line${/ui-freeze|freeze/i.test(line) ? ' log-line--freeze' : ''}">${line}</div>`)}<div class="instances-logs-footer">${t('instances.logSummary', { lines: String(lines.length), bytes: formatBytes(totalBytes) })}</div>`;
}
