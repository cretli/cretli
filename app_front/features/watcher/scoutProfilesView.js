/**
 * Workspace Watcher — Scout profile list (pure).
 *
 * Renders the per-profile runtime state and management actions of the Scout tab
 * (stage 5.1) from the `GET /api/workspace-watcher/scout/profiles` payload. Like
 * `watcherStatus.js` / `watcherTimeline.js` this module never touches the DOM and
 * imports no SCSS: the settings panel owns the event delegation and the busy /
 * confirmation state, so the whole list is unit-testable in Node.
 *
 * Actions rendered here are the stage-5.1 management set only. The editor, the
 * template picker, the preview and the scan history deliberately do NOT live in
 * this module (later leaves 5.2 / 5.3).
 */

import { t } from '../../i18n/index.js';
import { escapeWatcherAttr, escapeWatcherHtml, formatCountdown } from './watcherDashboard.js';

/**
 * Every action the list can render. The settings panel must wire each one; the
 * UI test asserts this list and the source stay in sync so a rendered button can
 * never be a dead action.
 */
export const SCOUT_PROFILE_ACTIONS = Object.freeze([
  'create',
  'reload',
  'duplicate',
  'toggle',
  'run',
  'archive',
  'archive-confirm',
  'archive-cancel',
]);

/** MDI icon per action (light DOM `.mdi` lives outside Shadow DOM). */
const ACTION_ICONS = Object.freeze({
  create: 'mdi-plus',
  reload: 'mdi-refresh',
  duplicate: 'mdi-content-copy',
  toggle: 'mdi-power',
  run: 'mdi-play',
  archive: 'mdi-archive-arrow-down-outline',
  'archive-confirm': 'mdi-check',
  'archive-cancel': 'mdi-close',
});

/**
 * Normalize the additive server `state` object so a legacy response (or a
 * partial test fixture) still renders honest zeros instead of `NaN`.
 *
 * @param {object | null | undefined} profile
 * @returns {{
 *   lastRunAt: string, nextRunAt: string, usedToday: number, maxPerDay: number,
 *   remainingToday: number, pendingFindings: number, running: number,
 *   blockedReason: string, archived: boolean,
 * }}
 */
export function scoutProfileState(profile) {
  const state = profile?.state && typeof profile.state === 'object' ? profile.state : {};
  const archivedFlag = state.archived === true || Boolean(String(profile?.archivedAt ?? '').trim());
  const maxPerDay = Math.max(0, Math.floor(Number(state.maxPerDay) || 0));
  const usedToday = Math.max(0, Math.floor(Number(state.usedToday) || 0));
  const remainingRaw = Number(state.remainingToday);
  return {
    lastRunAt: String(state.lastRunAt ?? '').trim(),
    nextRunAt: String(state.nextRunAt ?? '').trim(),
    usedToday,
    maxPerDay,
    remainingToday: Number.isFinite(remainingRaw)
      ? Math.max(0, Math.floor(remainingRaw))
      : Math.max(0, maxPerDay - usedToday),
    pendingFindings: Math.max(0, Math.floor(Number(state.pendingFindings) || 0)),
    running: Math.max(0, Math.floor(Number(state.running) || 0)),
    blockedReason: String(state.blockedReason ?? '').trim(),
    archived: archivedFlag,
  };
}

/**
 * Badge key for a profile: archived wins over the enabled flag because an
 * archived profile can no longer start, whatever `enabled` says.
 *
 * @param {object | null | undefined} profile
 * @returns {'archived' | 'enabled' | 'disabled'}
 */
export function scoutStateKey(profile) {
  if (scoutProfileState(profile).archived) return 'archived';
  return profile?.enabled === true ? 'enabled' : 'disabled';
}

/**
 * @param {object | null | undefined} profile
 * @returns {string}
 */
export function scoutStateLabel(profile) {
  return t(`settings.watcherScoutState_${scoutStateKey(profile)}`);
}

/**
 * Human label for a Scout block reason (`profile_scan_active`, `scout_disabled`,
 * …). Shared by the profile list and the settings run message so the two cannot
 * drift; falls back to the raw server reason when the dictionary has no entry.
 *
 * @param {unknown} reason
 * @returns {string}
 */
export function scoutReasonText(reason) {
  const key = String(reason || '').trim();
  if (!key) return '';
  const i18nKey = `settings.watcherScoutReason_${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/** Format a refused start without hiding a concrete Git diagnostic behind its reason code. */
export function scoutRunResultText(result) {
  const error = result?.error;
  const detail = typeof error === 'string' ? error : String(error?.message || '');
  if (result?.reason === 'scope_error' && detail) return detail;
  return scoutReasonText(result?.reason) || detail || t('settings.watcherScoutRunError');
}

/**
 * Collapse whitespace and bound the objective so one profile cannot blow up the
 * list row. `max` counts the ellipsis.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function truncateScoutText(value, max = 140) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(1, Math.floor(Number(max) || 140));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * `used / max · remaining` for one profile. `maxPerDay = 0` still renders as
 * `0 / 0`, which the badge/blocked reason explains.
 *
 * @param {object | null | undefined} profile
 * @returns {string}
 */
export function scoutLimitText(profile) {
  const state = scoutProfileState(profile);
  return t('settings.watcherScoutLimit', {
    used: state.usedToday,
    max: state.maxPerDay,
    remaining: state.remainingToday,
  });
}

/**
 * Next automatic run in epoch ms, or `0` when the profile is manual / disabled /
 * archived.
 *
 * @param {object | null | undefined} profile
 * @returns {number}
 */
export function scoutNextRunMs(profile) {
  const ms = Date.parse(scoutProfileState(profile).nextRunAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Human next-run text. A manual profile is never "due now"; an interval profile
 * shows a countdown, and a past instant reads as "due now".
 *
 * @param {object | null | undefined} profile
 * @param {number} [now]
 * @returns {string}
 */
export function scoutNextRunText(profile, now = Date.now()) {
  const state = scoutProfileState(profile);
  if (state.archived) return t('settings.watcherScoutNextArchived');
  const scheduleMode = String(profile?.schedule?.mode ?? 'manual').trim();
  if (profile?.enabled !== true || scheduleMode !== 'interval') {
    return t('settings.watcherScoutNextManual');
  }
  const ms = scoutNextRunMs(profile);
  if (!ms) return t('settings.watcherScoutNextManual');
  if (ms <= now) return t('settings.watcherScoutDueNow');
  return formatCountdown(ms, now);
}

/**
 * @param {object | null | undefined} profile
 * @returns {string}
 */
export function scoutLastRunText(profile) {
  const last = scoutProfileState(profile).lastRunAt;
  return last || t('settings.watcherScoutNever');
}

/**
 * Whether one action must render disabled.
 *
 * `run` and `archive` are disabled for an archived profile (archiving blocks all
 * future starts); `toggle` is disabled too, because flipping `enabled` on an
 * archived row could never start anything. A manual run stays available for a
 * disabled but non-archived profile — the server gates it separately.
 *
 * @param {object | null | undefined} profile
 * @param {string} action
 * @param {{ busy?: boolean }} [options]
 * @returns {boolean}
 */
export function scoutActionDisabled(profile, action, options = {}) {
  if (action === 'create' || action === 'reload') return options.busy === true;
  if (options.busy === true) return true;
  const state = scoutProfileState(profile);
  if (action === 'run' || action === 'archive' || action === 'toggle') return state.archived;
  return false;
}

/**
 * i18n key of one action label. `toggle` depends on the current enabled flag.
 *
 * @param {string} action
 * @param {object | null | undefined} profile
 * @returns {string}
 */
function actionLabelKey(action, profile) {
  switch (action) {
    case 'create': return 'settings.watcherScoutNew';
    case 'reload': return 'settings.watcherScoutReload';
    case 'duplicate': return 'settings.watcherScoutDuplicate';
    case 'toggle': return profile?.enabled === true ? 'settings.watcherScoutDisable' : 'settings.watcherScoutEnable';
    case 'run': return 'settings.watcherScoutRunNow';
    case 'archive': return 'settings.watcherScoutArchive';
    case 'archive-confirm': return 'settings.watcherScoutArchiveConfirm';
    case 'archive-cancel': return 'settings.watcherScoutCancel';
    default: return action;
  }
}

/**
 * One action button. The label is passed in for the archive-confirm pair so the
 * confirm prompt can reuse the same builder.
 *
 * @param {string} action
 * @param {object | null | undefined} profile
 * @param {{ busy?: boolean, label?: string, disabled?: boolean }} [options]
 * @returns {string}
 */
export function renderScoutProfileActionButton(action, profile = null, options = {}) {
  const id = String(profile?.id ?? '').trim();
  const label = String(options.label ?? '').trim() || t(actionLabelKey(action, profile));
  const disabled = options.disabled === true || scoutActionDisabled(profile, action, { busy: options.busy === true });
  const icon = ACTION_ICONS[action] || 'mdi-dots-horizontal';
  return `<button type="button" class="watcher-scout-action" data-scout-action="${escapeWatcherAttr(action)}"`
    + (id ? ` data-scout-id="${escapeWatcherAttr(id)}"` : '')
    + ` title="${escapeWatcherAttr(label)}" aria-label="${escapeWatcherAttr(label)}"`
    + (disabled ? ' disabled aria-disabled="true"' : '')
    + '>'
    + `<span class="mdi ${escapeWatcherAttr(icon)}" aria-hidden="true"></span>`
    + `<span class="watcher-scout-action-label">${escapeWatcherHtml(label)}</span>`
    + '</button>';
}

/**
 * Badge + meta line of one profile row.
 *
 * @param {object} profile
 * @param {number} now
 * @returns {string}
 */
function renderScoutProfileMeta(profile, now) {
  const state = scoutProfileState(profile);
  const pending = t('settings.watcherScoutPendingCount', { count: state.pendingFindings });
  const running = t('settings.watcherScoutRunningCount', { count: state.running });
  const nextMs = scoutNextRunMs(profile);
  // An interval profile that is actually enabled gets a live countdown node, so
  // the settings ticker keeps it honest instead of freezing at render time.
  const liveCountdown = !state.archived
    && profile?.enabled === true
    && String(profile?.schedule?.mode ?? 'manual').trim() === 'interval'
    && nextMs > 0;
  const nextValue = liveCountdown
    ? `<span data-watcher-countdown="${escapeWatcherAttr(String(nextMs))}">${escapeWatcherHtml(scoutNextRunText(profile, now))}</span>`
    : escapeWatcherHtml(scoutNextRunText(profile, now));
  const blocked = state.blockedReason
    ? `<p class="cr-hint watcher-scout-blocked"><span class="watcher-scout-state" data-scout-state="blocked">${escapeWatcherHtml(t('settings.watcherScoutBlocked'))}</span> ${escapeWatcherHtml(scoutReasonText(state.blockedReason))}</p>`
    : '';
  return '<div class="watcher-scout-meta">'
    + `<p class="cr-hint"><span class="watcher-scout-meta-label">${escapeWatcherHtml(t('settings.watcherScoutLastRun'))}:</span> ${escapeWatcherHtml(scoutLastRunText(profile))}</p>`
    + `<p class="cr-hint"><span class="watcher-scout-meta-label">${escapeWatcherHtml(t('settings.watcherScoutNextRun'))}:</span> ${nextValue}</p>`
    + `<p class="cr-hint"><span class="watcher-scout-meta-label">${escapeWatcherHtml(t('settings.watcherScoutLimitLabel'))}:</span> ${escapeWatcherHtml(scoutLimitText(profile))}</p>`
    + `<p class="cr-hint">${escapeWatcherHtml(pending)} · ${escapeWatcherHtml(running)}</p>`
    + blocked
    + '</div>';
}

/**
 * Unique default name for a new profile: `New Scout`, then `New Scout 2`, …
 * Purely local; the server still validates the final name.
 *
 * @param {unknown[]} [existingNames]
 * @param {string} [base]
 * @returns {string}
 */
export function nextScoutProfileName(existingNames = [], base = t('settings.watcherScoutNewDefaultName')) {
  const used = new Set(
    (Array.isArray(existingNames) ? existingNames : []).map((name) => String(name ?? '').trim()),
  );
  const root = String(base ?? '').trim() || 'Scout';
  if (!used.has(root)) return root;
  let index = 2;
  while (used.has(`${root} ${index}`)) index += 1;
  return `${root} ${index}`;
}

/**
 * One `<li>` of the profile list. `confirmArchive` swaps the management buttons
 * for the inline confirm pair, so the destructive action needs a second click.
 *
 * @param {object} profile
 * @param {{ now?: number, busy?: boolean, confirmArchive?: boolean }} [options]
 * @returns {string}
 */
export function renderScoutProfileRow(profile, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const id = String(profile?.id ?? '').trim();
  const busy = options.busy === true;
  const name = String(profile?.name ?? '').trim() || id || '—';
  const objective = truncateScoutText(profile?.objective);
  const badgeKey = scoutStateKey(profile);
  const actions = options.confirmArchive === true
    ? renderScoutProfileActionButton('archive-confirm', profile, { busy })
      + renderScoutProfileActionButton('archive-cancel', profile, { busy })
    : renderScoutProfileActionButton('toggle', profile, { busy })
      + renderScoutProfileActionButton('run', profile, { busy })
      + renderScoutProfileActionButton('duplicate', profile, { busy })
      + renderScoutProfileActionButton('archive', profile, { busy });
  return `<li class="watcher-scout-profile" data-scout-id="${escapeWatcherAttr(id)}"`
    + ` data-scout-state="${escapeWatcherAttr(badgeKey)}"`
    + (busy ? ' data-scout-busy="true" aria-busy="true"' : '')
    + '>'
    + '<div class="watcher-scout-profile-head">'
    + `<span class="watcher-scout-profile-name" title="${escapeWatcherAttr(name)}">${escapeWatcherHtml(name)}</span>`
    + `<span class="watcher-scout-state" data-scout-state="${escapeWatcherAttr(badgeKey)}">${escapeWatcherHtml(scoutStateLabel(profile))}</span>`
    + '</div>'
    + `<p class="cr-hint watcher-scout-objective" title="${escapeWatcherAttr(String(profile?.objective ?? ''))}">${escapeWatcherHtml(objective || '—')}</p>`
    + renderScoutProfileMeta(profile, now)
    + `<div class="watcher-scout-profile-actions">${actions}</div>`
    + (options.confirmArchive === true
      ? `<p class="cr-hint watcher-scout-confirm-hint">${escapeWatcherHtml(t('settings.watcherScoutArchiveConfirmHint'))}</p>`
      : '')
    + '</li>';
}

/**
 * The whole Scout profile list: header, optional status message and one of the
 * loading / error / empty / populated states.
 *
 * @param {{
 *   loading?: boolean,
 *   error?: string,
 *   profiles?: object[],
 *   busy?: boolean,
 *   busyId?: string,
 *   busyAction?: string,
 *   confirmArchiveId?: string,
 *   message?: string,
 *   messageTone?: 'ok' | 'error',
 *   now?: number,
 * }} [view]
 * @returns {string}
 */
export function renderScoutProfilesHtml(view = {}) {
  const now = Number.isFinite(view.now) ? Number(view.now) : Date.now();
  const profiles = Array.isArray(view.profiles) ? view.profiles.filter(Boolean) : [];
  const busyId = String(view.busyId ?? '').trim();
  const busyAction = String(view.busyAction ?? '').trim();
  const globalBusy = view.busy === true || busyAction === 'create' || busyAction === 'reload';
  const confirmArchiveId = String(view.confirmArchiveId ?? '').trim();
  const error = String(view.error ?? '').trim();
  const message = String(view.message ?? '').trim();
  const messageTone = view.messageTone === 'error' ? 'error' : 'ok';

  const header = '<div class="watcher-scout-profiles-head">'
    + `<h4 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutProfilesTitle'))}</h4>`
    + '<div class="watcher-scout-profiles-actions">'
    + renderScoutProfileActionButton('create', null, { busy: globalBusy || Boolean(busyId) })
    + renderScoutProfileActionButton('reload', null, { busy: globalBusy || Boolean(busyId) })
    + '</div></div>';
  const messageHtml = message
    ? `<p class="cr-status watcher-scout-message" data-tone="${escapeWatcherAttr(messageTone)}" role="status">${escapeWatcherHtml(message)}</p>`
    : '';

  let body;
  if (view.loading === true) {
    body = `<p class="cr-hint" data-scout-profiles-loading role="status">${escapeWatcherHtml(t('settings.watcherScoutProfilesLoading'))}</p>`;
  } else if (error) {
    body = '<div class="message watcher-scout-error" data-tone="error" role="alert" data-scout-profiles-error>'
      + escapeWatcherHtml(error)
      + '</div>';
  } else if (profiles.length === 0) {
    body = `<p class="cr-hint" data-scout-profiles-empty>${escapeWatcherHtml(t('settings.watcherScoutProfilesEmpty'))}</p>`;
  } else {
    const rows = profiles.map((profile) => {
      const id = String(profile?.id ?? '').trim();
      return renderScoutProfileRow(profile, {
        now,
        busy: Boolean(id) && id === busyId,
        confirmArchive: Boolean(id) && id === confirmArchiveId,
      });
    }).join('');
    body = `<ul class="watcher-scout-profiles" role="list" aria-label="${escapeWatcherAttr(t('settings.watcherScoutProfilesTitle'))}">${rows}</ul>`;
  }

  return `<div class="cr-card watcher-form watcher-scout-profiles-card">${header}${messageHtml}${body}</div>`;
}
