/**
 * Workspace Watcher — Scout scan history for one profile (pure).
 *
 * Renders the per-profile scan log of the Scout tab (stage 5.3) from the
 * `GET /api/workspace-watcher/scout/history` payload: status, start/finish, the
 * server-recorded executor, the measured usage (or an explicit "no data"), the
 * added/merged/dropped counters, drop reasons, the error/blocked text and the
 * scan/chat/run references plus the profile revision.
 *
 * Like `scoutProfilesView.js` this module never touches the DOM and imports no
 * SCSS, so the whole surface is unit-testable in Node; the settings panel owns
 * event delegation and the busy state.
 *
 * Two contracts are deliberate and must not be "improved" away:
 *   - Retention is server-side (last ~100 scans per profile, ~1000 per
 *     workspace). A scan the server no longer retains simply does not appear —
 *     this renderer never invents a row and never shows a synthetic "older
 *     scans were pruned" entry.
 *   - A missing measurement is `null`, NOT zero. `scoutScanUsageParts()` returns
 *     no numbers at all in that case and the row prints the "no data" label, so
 *     an unmeasured scan can never be read as a free one. The public entry also
 *     carries no `submitToken`: there is nothing secret to render here.
 */

import { t } from '../../i18n/index.js';
import { escapeWatcherAttr, escapeWatcherHtml, shortId } from './watcherDashboard.js';
import { scoutReasonText } from './scoutProfilesView.js';

/**
 * Every action this surface can render. The settings panel must wire each one;
 * the UI test asserts this list and the panel source stay in sync so a rendered
 * button can never be a dead action.
 */
export const SCOUT_HISTORY_ACTIONS = Object.freeze([
  'history-reload',
  'history-more',
]);

/** Scan lifecycle states the server settles a history entry into. */
export const SCOUT_HISTORY_STATUSES = Object.freeze([
  'reserved',
  'running',
  'completed',
  'failed',
  'interrupted',
  'uncertain',
]);

/** Drop reasons the runner records (`scoutDropReasons` on the server). */
export const SCOUT_HISTORY_DROP_REASONS = Object.freeze([
  'capacity_exceeded',
  'duplicate_in_scan',
  'existing_todo',
  'already_resolved',
  'already_explored',
  'prior_review',
]);

/** One page of the scan log; "Load more" grows the requested `max` by this. */
export const SCOUT_HISTORY_PAGE_SIZE = 20;

/** Non-terminal states are still in flight, so they own a scan slot. */
const NON_TERMINAL_STATUSES = ['reserved', 'running', 'uncertain'];

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Human label for a scan status. Unknown server states fall back to the raw
 * value instead of being silently relabelled "completed".
 *
 * @param {unknown} status
 * @returns {string}
 */
export function scoutScanStatusText(status) {
  const key = asText(status);
  if (!key) return t('settings.watcherScoutScanStatus_unknown');
  const i18nKey = `settings.watcherScoutScanStatus_${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/**
 * Whether a settled scan is still occupying its profile's slot. Mirrors the
 * server's `WORKSPACE_SCOUT_SCAN_NON_TERMINAL_STATUSES` so the badge and the
 * scheduler can never disagree about "this scan is not over".
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function scoutScanIsOpen(status) {
  return NON_TERMINAL_STATUSES.includes(asText(status));
}

/**
 * Human label for one drop reason, with the same dictionary fallback style as
 * `scoutReasonText`. A reason the client does not know is shown verbatim rather
 * than dropped, because `capacity_exceeded` in particular is the only evidence
 * that a full mailbox refused new work.
 *
 * @param {unknown} reason
 * @returns {string}
 */
export function scoutScanDropReasonText(reason) {
  const key = asText(reason);
  if (!key) return '';
  const i18nKey = `settings.watcherScoutDropReason_${key}`;
  const text = t(i18nKey);
  if (text !== i18nKey) return text;
  const generic = scoutReasonText(key);
  return generic || key;
}

/**
 * The `capacity_exceeded` overflow of one scan, read from its drop reasons.
 *
 * @param {object | null | undefined} entry
 * @returns {boolean}
 */
export function scoutScanCapacityExceeded(entry) {
  const reasons = Array.isArray(entry?.reasons) ? entry.reasons : [];
  return reasons.some((reason) => asText(reason) === 'capacity_exceeded');
}

/**
 * Split the stored `usage` object into the numbers the ledger actually
 * measured. An absent, empty or all-non-numeric value yields an empty list,
 * which the row renders as the honest "no data" label. Zero is only ever
 * reported when the ledger itself recorded a zero on a measured event.
 *
 * @param {object | null | undefined} usage
 * @returns {{ measured: boolean, parts: string[] }}
 */
export function scoutScanUsageParts(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return { measured: false, parts: [] };
  /** @type {string[]} */
  const parts = [];
  const tokens = asCount(usage.tokens ?? usage.totalTokens);
  if (tokens != null) parts.push(t('settings.watcherScoutScanUsageTokens', { n: tokens }));
  const usd = asCount(usage.usd ?? usage.costUsd);
  if (usd != null) parts.push(t('settings.watcherScoutScanUsageCost', { n: usd }));
  const events = asCount(usage.eventCount ?? usage.events);
  if (events != null) parts.push(t('settings.watcherScoutScanUsageEvents', { n: events }));
  return { measured: parts.length > 0, parts };
}

/**
 * One-line usage text: the measured numbers, or the explicit "no data" label.
 *
 * @param {object | null | undefined} usage
 * @returns {string}
 */
export function scoutScanUsageText(usage) {
  const { measured, parts } = scoutScanUsageParts(usage);
  if (!measured) return t('settings.watcherScoutScanNoUsage');
  return parts.join(' · ');
}

/**
 * Executor text from the server-recorded `executor` of the scan. An empty
 * executor is reported as "not recorded", never guessed from the profile.
 *
 * @param {object | null | undefined} entry
 * @returns {string}
 */
export function scoutScanExecutorText(entry) {
  const harness = asText(entry?.executor?.harness);
  const model = asText(entry?.executor?.model);
  if (harness && model) return `${harness} · ${model}`;
  if (harness || model) return harness || model;
  return t('settings.watcherScoutScanNoExecutor');
}

/**
 * A timestamp as the server stored it (ISO, no locale guesswork), or the
 * "not finished" placeholder for an open scan.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function scoutScanTimeText(value) {
  return asText(value) || t('settings.watcherScoutScanNoFinish');
}

/**
 * `added / merged / dropped` for one scan. Counts are shown even when zero:
 * unlike `usage`, a zero here IS a real measurement (the scan ran and produced
 * nothing), so hiding it would be the lie.
 *
 * @param {object | null | undefined} entry
 * @returns {string}
 */
export function scoutScanCountsText(entry) {
  return t('settings.watcherScoutScanCounts', {
    added: asCount(entry?.added) ?? 0,
    merged: asCount(entry?.merged) ?? 0,
    dropped: asCount(entry?.dropped) ?? 0,
  });
}

/**
 * The `<select>` options of the profile filter: the stored profiles plus any
 * profile id that still owns a scan but was since removed, so filtering by it
 * can never produce an unexplainable empty list.
 *
 * @param {object[] | undefined} profiles
 * @param {object[] | undefined} history
 * @returns {Array<{ id: string, name: string }>}
 */
export function scoutHistoryProfileOptions(profiles, history) {
  /** @type {Map<string, string>} */
  const byId = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const id = asText(profile?.id);
    if (!id || byId.has(id)) continue;
    byId.set(id, asText(profile?.name) || id);
  }
  for (const entry of Array.isArray(history) ? history : []) {
    const id = asText(entry?.scoutId);
    if (id && !byId.has(id)) byId.set(id, id);
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * One icon+label action button inside the history card.
 *
 * @param {string} action
 * @param {string} label
 * @param {{ icon?: string, disabled?: boolean }} [options]
 * @returns {string}
 */
export function renderScoutHistoryButton(action, label, options = {}) {
  const icon = asText(options.icon) || 'mdi-refresh';
  return `<button type="button" class="watcher-scout-action" data-scout-history-action="${escapeWatcherAttr(action)}"`
    + ` title="${escapeWatcherAttr(label)}" aria-label="${escapeWatcherAttr(label)}"`
    + (options.disabled === true ? ' disabled aria-disabled="true"' : '')
    + '>'
    + `<span class="mdi ${escapeWatcherAttr(icon)}" aria-hidden="true"></span>`
    + `<span class="watcher-scout-action-label">${escapeWatcherHtml(label)}</span>`
    + '</button>';
}

/**
 * The filter bar: one real `<select>` per criterion plus the reload action. It
 * is a native control so Tab/arrow keys and a screen reader work without extra
 * ARIA, and the label is bound by `for`/`id`.
 *
 * @param {{ profiles?: object[], history?: object[], scoutId?: string, busy?: boolean }} [view]
 * @returns {string}
 */
function renderScoutHistoryFilters(view = {}) {
  const options = scoutHistoryProfileOptions(view.profiles, view.history);
  const selected = asText(view.scoutId);
  const busy = view.busy === true;
  const rows = options.map((option) => (
    `<option value="${escapeWatcherAttr(option.id)}"${option.id === selected ? ' selected' : ''}>`
    + `${escapeWatcherHtml(option.name)}</option>`
  )).join('');
  const unknownProfile = selected && !options.some((option) => option.id === selected)
    ? `<option value="${escapeWatcherAttr(selected)}" selected>${escapeWatcherHtml(selected)}</option>`
    : '';
  return '<div class="watcher-scout-history-filters">'
    + '<div class="cr-field watcher-scout-history-filter">'
    + `<label class="cr-field-label" for="watcher-scout-history-profile">${escapeWatcherHtml(t('settings.watcherScoutHistoryProfile'))}</label>`
    + `<select id="watcher-scout-history-profile" class="watcher-scout-filter-control"`
    + ` data-scout-history-filter="scoutId"${busy ? ' disabled' : ''}>`
    + `<option value="">${escapeWatcherHtml(t('settings.watcherScoutHistoryAllProfiles'))}</option>`
    + rows
    + unknownProfile
    + '</select>'
    + '</div>'
    + '<div class="watcher-scout-profiles-actions">'
    + renderScoutHistoryButton('history-reload', t('settings.watcherScoutHistoryReload'), { icon: 'mdi-refresh', disabled: busy })
    + '</div>'
    + '</div>';
}

/**
 * One `<li>` of the scan log.
 *
 * @param {object} entry
 * @param {{ busy?: boolean }} [options]
 * @returns {string}
 */
export function renderScoutScanRow(entry, options = {}) {
  const scanId = asText(entry?.scanId);
  const status = asText(entry?.status);
  const reasons = (Array.isArray(entry?.reasons) ? entry.reasons : []).map(scoutScanDropReasonText).filter(Boolean);
  const error = asText(entry?.error);
  const overflow = scoutScanCapacityExceeded(entry);
  const revision = asCount(entry?.scoutRevision);
  const metaLabel = (text) => `<span class="watcher-scout-meta-label">${escapeWatcherHtml(text)}</span>`;
  const refs = [];
  if (scanId) refs.push(`<code title="${escapeWatcherAttr(scanId)}">${escapeWatcherHtml(shortId(scanId))}</code>`);
  if (asText(entry?.chatId)) refs.push(`<code title="${escapeWatcherAttr(asText(entry.chatId))}">${escapeWatcherHtml(shortId(entry.chatId))}</code>`);
  if (asText(entry?.runId)) refs.push(`<code title="${escapeWatcherAttr(asText(entry.runId))}">${escapeWatcherHtml(shortId(entry.runId))}</code>`);
  if (revision != null && revision > 0) {
    refs.push(t('settings.watcherScoutScanRevision', { n: revision }));
  }
  return `<li class="watcher-scout-scan" data-scout-scan-status="${escapeWatcherAttr(status)}"`
    + (scanId ? ` data-scout-scan-id="${escapeWatcherAttr(scanId)}"` : '')
    + (options.busy === true ? ' aria-busy="true"' : '')
    + '>'
    + '<div class="watcher-scout-scan-head">'
    + `<span class="watcher-scout-state" data-scout-scan-state="${escapeWatcherAttr(status || 'unknown')}">`
    + escapeWatcherHtml(scoutScanStatusText(entry?.status))
    + '</span>'
    + (overflow
      ? `<span class="watcher-scout-state" data-scout-scan-state="overflow">${escapeWatcherHtml(t('settings.watcherScoutScanOverflowBadge'))}</span>`
      : '')
    + `<span class="watcher-scout-scan-times"><span title="${escapeWatcherAttr(asText(entry?.startedAt))}">${escapeWatcherHtml(scoutScanTimeText(entry?.startedAt))}</span>`
    + `<span class="watcher-scout-scan-arrow" aria-hidden="true">→</span>`
    + `<span title="${escapeWatcherAttr(asText(entry?.finishedAt))}">${escapeWatcherHtml(scoutScanTimeText(entry?.finishedAt))}</span></span>`
    + '</div>'
    + '<div class="watcher-scout-meta">'
    + `<p class="cr-hint">${metaLabel(t('settings.watcherScoutScanExecutor'))}: ${escapeWatcherHtml(scoutScanExecutorText(entry))}</p>`
    + `<p class="cr-hint" data-scout-scan-usage="${scoutScanUsageParts(entry?.usage).measured ? 'measured' : 'none'}">`
    + `${metaLabel(t('settings.watcherScoutScanUsage'))}: ${escapeWatcherHtml(scoutScanUsageText(entry?.usage))}</p>`
    + `<p class="cr-hint">${metaLabel(t('settings.watcherScoutScanCountsLabel'))}: ${escapeWatcherHtml(scoutScanCountsText(entry))}</p>`
    + `<p class="cr-hint">${metaLabel(t('settings.watcherScoutScanProfile'))}: ${escapeWatcherHtml(asText(entry?.scoutId) || t('settings.watcherScoutScanNoProfile'))}</p>`
    + '</div>'
    + (reasons.length
      ? `<p class="cr-hint watcher-scout-scan-reasons"${overflow ? ' data-scout-scan-overflow="true"' : ''}>`
        + `${metaLabel(t('settings.watcherScoutScanReasons'))}: ${escapeWatcherHtml(reasons.join(' · '))}</p>`
      : '')
    + (entry?.scopeResolution?.resolvedBase
      ? `<p class="cr-hint" data-scout-resolved-base>${escapeWatcherHtml(t('settings.watcherScoutResolvedBase'))}: <code>${escapeWatcherHtml(entry.scopeResolution.resolvedBase)} (${escapeWatcherHtml(entry.scopeResolution.baseCommit)})</code></p>`
      : '')
    + (entry?.scopeResolution?.diagnostics || []).map((diagnostic) => `<p class="cr-hint" data-scout-git-diagnostic="${escapeWatcherAttr(diagnostic.code)}">${escapeWatcherHtml(diagnostic.message)}</p>`).join('')
    + (error
      ? `<p class="cr-hint watcher-scout-scan-error" role="status" data-tone="error">`
        + `${metaLabel(t('settings.watcherScoutScanError'))}: ${escapeWatcherHtml(error)}</p>`
      : '')
    + (refs.length
      ? `<p class="cr-hint watcher-scout-scan-refs">${metaLabel(t('settings.watcherScoutScanRefs'))}: ${refs.join(' · ')}</p>`
      : '')
    + '</li>';
}

/**
 * The whole scan-history card: title, profile filter, optional status message
 * and one of the loading / error / empty / populated states, then the bounded
 * "load more" step when the server reports more scans than this page shows.
 *
 * @param {{
 *   loading?: boolean,
 *   error?: string,
 *   history?: object[],
 *   total?: number,
 *   profiles?: object[],
 *   scoutId?: string,
 *   max?: number,
 *   busy?: boolean,
 *   message?: string,
 *   messageTone?: 'ok' | 'error',
 * }} [view]
 * @returns {string}
 */
export function renderScoutHistoryHtml(view = {}) {
  const history = Array.isArray(view.history) ? view.history.filter(Boolean) : [];
  const busy = view.busy === true;
  const error = asText(view.error);
  const message = asText(view.message);
  const messageTone = view.messageTone === 'error' ? 'error' : 'ok';
  const total = asCount(view.total);
  const hidden = total != null && total > history.length ? total - history.length : 0;
  const historyMoreStep = hidden > 0 ? Math.min(hidden, SCOUT_HISTORY_PAGE_SIZE) : SCOUT_HISTORY_PAGE_SIZE;

  const header = '<div class="watcher-scout-profiles-head">'
    + `<h4 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutHistoryTitle'))}</h4>`
    + '</div>';
  const hint = `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutHistoryHint'))}</p>`;
  const filters = renderScoutHistoryFilters({ ...view, busy });
  const statusHtml = message
    ? `<p class="cr-status watcher-scout-message" data-tone="${escapeWatcherAttr(messageTone)}" role="status">${escapeWatcherHtml(message)}</p>`
    : '';

  let body;
  if (view.loading === true) {
    body = `<p class="cr-hint" data-scout-history-loading role="status">${escapeWatcherHtml(t('settings.watcherScoutHistoryLoading'))}</p>`;
  } else if (error) {
    body = '<div class="message watcher-scout-error" data-tone="error" role="alert" data-scout-history-error>'
      + escapeWatcherHtml(error)
      + '</div>';
  } else if (history.length === 0) {
    body = `<p class="cr-hint" data-scout-history-empty>${escapeWatcherHtml(t('settings.watcherScoutHistoryEmpty'))}</p>`;
  } else {
    const rows = history.map((entry) => renderScoutScanRow(entry, { busy })).join('');
    body = `<ul class="watcher-scout-scans" role="list" aria-label="${escapeWatcherAttr(t('settings.watcherScoutHistoryTitle'))}">${rows}</ul>`
      + `<p class="cr-hint" data-scout-history-count role="status">${escapeWatcherHtml(t('settings.watcherScoutHistoryCount', {
        shown: history.length,
        total: total != null ? total : history.length,
      }))}</p>`
      + (hidden > 0
        ? `<div class="cr-row watcher-scout-profile-actions">${renderScoutHistoryButton('history-more', t('settings.watcherScoutHistoryMore', { n: historyMoreStep }), {
          icon: 'mdi-database-arrow-down',
          disabled: busy,
        })}</div>`
        : '');
  }

  return '<div class="cr-card watcher-form watcher-scout-history-card" data-scout-history>'
    + header
    + hint
    + filters
    + statusHtml
    + body
    + '</div>';
}
