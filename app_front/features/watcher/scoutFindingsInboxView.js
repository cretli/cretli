/**
 * Workspace Watcher — shared Scout proposal inbox (pure).
 *
 * Renders one workspace-wide mailbox of proposals from
 * `GET /api/workspace-watcher/scout` (action=list) with filters by profile
 * (Scout), category and status. Every row carries the full server-owned
 * `sources[]` attribution — the profile, the scan, the chat/run, the executor
 * and the profile revision — and the `todoId` of the TODO it became, so
 * "which Scout produced this" stays readable after `scoutScanHistory` has
 * retained the scan away (the attribution lives on the finding, not on the
 * scan log).
 *
 * Like the 5.1/5.2 view modules this file never touches the DOM and imports no
 * SCSS; the settings panel owns delegation and busy state.
 *
 * Contracts that are deliberate:
 *   - There is NO approve-plan action anywhere here. Accept/reject only decide
 *     the proposal; the TODO stays `idea` with an unapproved plan draft.
 *   - Ordering stays the server's honest newest-first order. Pagination only
 *     grows the requested `max`, so the first pending proposal can never be
 *     pushed off by a newer one, and the card always states how many of the
 *     total are shown.
 *   - With `policy.scoutAutoCreate` the server already captured submitted
 *     results into `idea` TODOs under the scan-group parent at submit time, so
 *     the card says that instead of demanding a second "accept" click.
 */

import { t } from '../../i18n/index.js';
import { escapeWatcherAttr, escapeWatcherHtml, shortId } from './watcherDashboard.js';
import { truncateScoutText } from './scoutProfilesView.js';

/**
 * Every action this surface can render. The settings panel must wire each one;
 * the UI test asserts this list and the panel source stay in sync so a rendered
 * button can never be a dead action.
 */
export const SCOUT_INBOX_ACTIONS = Object.freeze([
  'inbox-reload',
  'inbox-accept',
  'inbox-reject',
  'inbox-more',
  'inbox-sources-more',
  'open-todo',
]);

/** Must match `WORKSPACE_SCOUT_CATEGORIES` on the server. */
export const SCOUT_INBOX_CATEGORIES = Object.freeze([
  'bug',
  'improvement',
  'refactor',
  'security',
  'opportunity',
  'documentation',
]);

/** Must match `WORKSPACE_SCOUT_FINDING_STATUSES` minus the empty default. */
export const SCOUT_INBOX_STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);

/** One page of the mailbox; "Load more" grows the requested `max` by this. */
export const SCOUT_INBOX_PAGE_SIZE = 25;

/** Sources revealed per click on "show more" inside one finding. */
export const SCOUT_INBOX_SOURCE_PAGE_SIZE = 3;

/** Files listed before the count collapses into a "+N" hint. */
const MAX_VISIBLE_FILES = 6;

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
 * Human label for a proposal status. An unknown server status falls back to the
 * raw value rather than being relabelled "pending".
 *
 * @param {unknown} status
 * @returns {string}
 */
export function scoutFindingStatusText(status) {
  const key = asText(status);
  if (!key) return t('settings.watcherScoutFindingStatus_unknown');
  const i18nKey = `settings.watcherScoutFindingStatus_${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/**
 * Human label for one of the six fixed categories.
 *
 * @param {unknown} category
 * @returns {string}
 */
export function scoutFindingCategoryText(category) {
  const key = asText(category);
  if (!key) return '';
  const i18nKey = `settings.watcherScoutCategory_${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/**
 * The server-owned attribution list of one finding. A finding without the
 * `sources[]` collection falls back to the legacy v1 `source` / `scanId`
 * fields so an older proposal still reports where it came from instead of
 * rendering as unattributed.
 *
 * @param {object | null | undefined} finding
 * @returns {object[]}
 */
export function scoutFindingSources(finding) {
  const sources = Array.isArray(finding?.sources) ? finding.sources.filter(Boolean) : [];
  if (sources.length) return sources;
  const legacy = finding?.source && typeof finding.source === 'object' ? finding.source : null;
  const scanId = asText(finding?.scanId);
  const chatId = asText(finding?.sourceChatId);
  if (!legacy && !scanId && !chatId) return [];
  return [{
    scoutId: asText(finding?.scoutId),
    scanId,
    chatId: asText(legacy?.chatId) || chatId,
    runId: asText(legacy?.runId),
    scanner: asText(legacy?.scanner),
    harness: asText(legacy?.harness),
    model: asText(legacy?.model),
    at: '',
    scoutRevision: 0,
  }];
}

/**
 * A readable profile name for one attribution entry. A profile that was since
 * archived or deleted still resolves to its id — never to a blank, because an
 * unattributed source would silently break the "visible in every source
 * profile" rule.
 *
 * @param {object} source
 * @param {object[] | undefined} profiles
 * @returns {string}
 */
export function scoutSourceProfileLabel(source, profiles) {
  const id = asText(source?.scoutId);
  if (!id) return t('settings.watcherScoutInboxNoProfile');
  const match = (Array.isArray(profiles) ? profiles : [])
    .find((profile) => asText(profile?.id) === id);
  const name = asText(match?.name);
  return name ? `${name} (${shortId(id)})` : id;
}

/**
 * The readable detail line of one attribution entry: executor, revision and
 * scan/chat references. Empty fields are omitted, never faked.
 *
 * @param {object} source
 * @returns {string}
 */
export function scoutSourceDetailText(source) {
  /** @type {string[]} */
  const parts = [];
  const harness = asText(source?.harness) || asText(source?.scanner);
  const model = asText(source?.model);
  if (harness && model) parts.push(`${harness} · ${model}`);
  else if (harness || model) parts.push(harness || model);
  const revision = asCount(source?.scoutRevision);
  if (revision != null && revision > 0) {
    parts.push(t('settings.watcherScoutScanRevision', { n: revision }));
  }
  if (asText(source?.at)) parts.push(asText(source.at));
  return parts.join(' · ');
}

/**
 * Window one finding's source list for display. The full count is always
 * reported by the caller so a collapsed list is visible as collapsed.
 *
 * @param {object[]} sources
 * @param {number} [shown]
 * @returns {{ visible: object[], hidden: number }}
 */
export function scoutFindingSourceWindow(sources, shown = SCOUT_INBOX_SOURCE_PAGE_SIZE) {
  const list = Array.isArray(sources) ? sources : [];
  const size = Math.max(1, Math.floor(Number(shown) || SCOUT_INBOX_SOURCE_PAGE_SIZE));
  if (list.length <= size) return { visible: list, hidden: 0 };
  return { visible: list.slice(0, size), hidden: list.length - size };
}

/**
 * How many sources of one finding the operator has already revealed.
 *
 * @param {object} finding
 * @param {Record<string, number> | Map<string, number> | undefined} expanded
 * @returns {number}
 */
export function scoutFindingSourceLimit(finding, expanded) {
  const id = asText(finding?.id);
  if (!id || !expanded) return SCOUT_INBOX_SOURCE_PAGE_SIZE;
  const value = expanded instanceof Map ? expanded.get(id) : expanded[id];
  const number = Math.floor(Number(value) || 0);
  return number > SCOUT_INBOX_SOURCE_PAGE_SIZE ? number : SCOUT_INBOX_SOURCE_PAGE_SIZE;
}

/**
 * One action button inside the inbox (icon + label, real `<button>`).
 *
 * @param {string} action
 * @param {string} label
 * @param {{ findingId?: string, todoId?: string, icon?: string, disabled?: boolean, variant?: string }} [options]
 * @returns {string}
 */
export function renderScoutInboxButton(action, label, options = {}) {
  const findingId = asText(options.findingId);
  const todoId = asText(options.todoId);
  const icon = asText(options.icon) || 'mdi-dots-horizontal';
  const variant = asText(options.variant);
  return '<button type="button" class="watcher-scout-action"'
    + (variant ? ` data-scout-action-variant="${escapeWatcherAttr(variant)}"` : '')
    + ` data-scout-inbox-action="${escapeWatcherAttr(action)}"`
    + (findingId ? ` data-scout-finding-id="${escapeWatcherAttr(findingId)}"` : '')
    + (todoId ? ` data-scout-todo-id="${escapeWatcherAttr(todoId)}"` : '')
    + ` title="${escapeWatcherAttr(label)}" aria-label="${escapeWatcherAttr(label)}"`
    + (options.disabled === true ? ' disabled aria-disabled="true"' : '')
    + '>'
    + `<span class="mdi ${escapeWatcherAttr(icon)}" aria-hidden="true"></span>`
    + `<span class="watcher-scout-action-label">${escapeWatcherHtml(label)}</span>`
    + '</button>';
}

/**
 * The three-criterion filter bar as native `<select>` controls plus the reload
 * action, so the whole bar is keyboard reachable in reading order.
 *
 * @param {{ profiles?: object[], scoutId?: string, category?: string, status?: string, busy?: boolean }} [view]
 * @returns {string}
 */
function renderScoutInboxFilters(view = {}) {
  const busy = view.busy === true;
  const scoutId = asText(view.scoutId);
  const category = asText(view.category);
  const status = asText(view.status);
  const profiles = Array.isArray(view.profiles) ? view.profiles : [];

  /**
   * @param {string} name
   * @param {Array<{ value: string, label: string }>} options
   * @param {string} selected
   * @param {string} allLabel
   * @returns {string}
   */
  const select = (name, options, selected, allLabel) => {
    const id = `watcher-scout-inbox-${name}`;
    const rows = options.map((option) => (
      `<option value="${escapeWatcherAttr(option.value)}"${option.value === selected ? ' selected' : ''}>`
      + `${escapeWatcherHtml(option.label)}</option>`
    )).join('');
    const unknown = selected && !options.some((option) => option.value === selected)
      ? `<option value="${escapeWatcherAttr(selected)}" selected>${escapeWatcherHtml(selected)}</option>`
      : '';
    return '<div class="cr-field watcher-scout-inbox-filter">'
      + `<label class="cr-field-label" for="${escapeWatcherAttr(id)}">${escapeWatcherHtml(t(`settings.watcherScoutInboxFilter_${name}`))}</label>`
      + `<select id="${escapeWatcherAttr(id)}" class="watcher-scout-filter-control"`
      + ` data-scout-inbox-filter="${escapeWatcherAttr(name)}"${busy ? ' disabled' : ''}>`
      + `<option value="">${escapeWatcherHtml(allLabel)}</option>`
      + rows
      + unknown
      + '</select>'
      + '</div>';
  };

  return '<div class="watcher-scout-inbox-filters">'
    + select('scoutId', profiles.map((profile) => ({
      value: asText(profile?.id),
      label: asText(profile?.name) || asText(profile?.id),
    })).filter((option) => option.value), scoutId, t('settings.watcherScoutInboxAllProfiles'))
    + select('category', SCOUT_INBOX_CATEGORIES.map((key) => ({
      value: key,
      label: scoutFindingCategoryText(key),
    })), category, t('settings.watcherScoutInboxAllCategories'))
    + select('status', SCOUT_INBOX_STATUSES.map((key) => ({
      value: key,
      label: scoutFindingStatusText(key),
    })), status, t('settings.watcherScoutInboxAllStatuses'))
    + '<div class="cr-field watcher-scout-inbox-filter">'
    + `<span class="cr-field-label">${escapeWatcherHtml(t('settings.watcherScoutInboxActionsLabel'))}</span>`
    + '<div class="watcher-scout-profiles-actions">'
    + renderScoutInboxButton('inbox-reload', t('settings.watcherScoutInboxReload'), { icon: 'mdi-refresh', disabled: busy })
    + '</div>'
    + '</div>'
    + '</div>';
}

/**
 * The autoCreate notice. When the server already captured the submitted results
 * into `idea` TODOs, saying so replaces the "accept these" demand; when it did
 * not, the card explains that the decision is manual. The same text is used for
 * the inbox and (via the panel) the run message so the two cannot disagree.
 *
 * @param {boolean} autoCreate
 * @param {number} [pending]
 * @returns {string}
 */
export function renderScoutAutoCreateNotice(autoCreate, pending = 0) {
  const text = autoCreate === true
    ? t('settings.watcherScoutInboxAutoCreateOn')
    : t('settings.watcherScoutInboxAutoCreateOff');
  const leftover = autoCreate === true && pending > 0
    ? `<p class="cr-hint" data-scout-inbox-autocreate-pending>${escapeWatcherHtml(t('settings.watcherScoutInboxAutoCreatePending', { count: pending }))}</p>`
    : '';
  return `<p class="cr-hint watcher-scout-inbox-contract" data-scout-inbox-autocreate="${autoCreate === true ? 'on' : 'off'}" role="status">${escapeWatcherHtml(text)}</p>${leftover}`;
}

/**
 * One `<li>` of the mailbox: title, category, status, rationale, files, the full
 * (paginated) source attribution, the TODO it produced and the per-finding
 * accept/reject decision for a still-pending proposal.
 *
 * @param {object} finding
 * @param {{ profiles?: object[], sourceLimit?: number, busy?: boolean, autoCreate?: boolean, getTodoTitle?: (id: string) => string }} [options]
 * @returns {string}
 */
export function renderScoutFindingRow(finding, options = {}) {
  const id = asText(finding?.id);
  const status = asText(finding?.status);
  const busy = options.busy === true;
  const sources = scoutFindingSources(finding);
  const { visible, hidden } = scoutFindingSourceWindow(sources, options.sourceLimit);
  const getTodoTitle = typeof options.getTodoTitle === 'function' ? options.getTodoTitle : () => '';
  const todoId = asText(finding?.todoId);
  const files = Array.isArray(finding?.files) ? finding.files.filter(Boolean) : [];
  const shownFiles = files.slice(0, MAX_VISIBLE_FILES);
  const moreFiles = files.length - shownFiles.length;
  const sourceRows = visible.map((source) => {
    const detail = scoutSourceDetailText(source);
    const refs = [];
    if (asText(source?.scanId)) refs.push(`<code title="${escapeWatcherAttr(asText(source.scanId))}">${escapeWatcherHtml(shortId(source.scanId))}</code>`);
    if (asText(source?.chatId)) refs.push(`<code title="${escapeWatcherAttr(asText(source.chatId))}">${escapeWatcherHtml(shortId(source.chatId))}</code>`);
    if (asText(source?.runId)) refs.push(`<code title="${escapeWatcherAttr(asText(source.runId))}">${escapeWatcherHtml(shortId(source.runId))}</code>`);
    return '<li class="watcher-scout-finding-source"'
      + (asText(source?.scoutId) ? ` data-scout-source-profile="${escapeWatcherAttr(asText(source.scoutId))}"` : '')
      + '>'
      + `<span class="watcher-scout-finding-source-profile">${escapeWatcherHtml(scoutSourceProfileLabel(source, options.profiles))}</span>`
      + (detail ? `<span class="cr-hint">${escapeWatcherHtml(detail)}</span>` : '')
      + (refs.length ? `<span class="watcher-scout-finding-source-refs">${refs.join(' · ')}</span>` : '')
      + '</li>';
  }).join('');
  const sourcesHtml = sources.length
    ? '<div class="watcher-scout-finding-sources">'
      + `<span class="watcher-scout-meta-label">${escapeWatcherHtml(t('settings.watcherScoutInboxSources', { count: sources.length }))}</span>`
      + `<ul role="list">${sourceRows}</ul>`
      + (hidden > 0
        ? renderScoutInboxButton('inbox-sources-more', t('settings.watcherScoutInboxSourcesMore', { n: hidden }), {
          findingId: id,
          icon: 'mdi-dots-horizontal',
          disabled: busy,
        })
        : '')
      + '</div>'
    : `<p class="cr-hint watcher-scout-finding-nosources">${escapeWatcherHtml(t('settings.watcherScoutInboxSourcesNone'))}</p>`;
  const todoHtml = todoId
    ? '<p class="cr-hint watcher-scout-finding-todo">'
      + `<span class="watcher-scout-meta-label">${escapeWatcherHtml(t('settings.watcherScoutInboxTodo'))}:</span> `
      + `<span title="${escapeWatcherAttr(`cretli-ref todo=${todoId}`)}">${escapeWatcherHtml(getTodoTitle(todoId) || shortId(todoId))}</span> `
      + `<code title="${escapeWatcherAttr(todoId)}">${escapeWatcherHtml(shortId(todoId))}</code> `
      + renderScoutInboxButton('open-todo', t('settings.watcherScoutInboxOpenTodo'), { todoId, icon: 'mdi-open-in-new', disabled: busy })
      + '</p>'
    : '';
  const pendingDecision = status === 'pending';
  const actionsHtml = pendingDecision
    ? '<div class="cr-row watcher-scout-profile-actions watcher-scout-finding-actions">'
      + renderScoutInboxButton('inbox-accept', t('settings.watcherScoutInboxAccept'), { findingId: id, icon: 'mdi-check', variant: 'primary', disabled: busy })
      + renderScoutInboxButton('inbox-reject', t('settings.watcherScoutInboxReject'), { findingId: id, icon: 'mdi-close', disabled: busy })
      + '</div>'
    : '';
  const rationale = truncateScoutText(finding?.rationale, 400);
  return `<li class="watcher-scout-finding" data-scout-finding-id="${escapeWatcherAttr(id)}"`
    + ` data-scout-finding-status="${escapeWatcherAttr(status)}"${busy ? ' aria-busy="true"' : ''}>`
    + '<div class="watcher-scout-finding-head">'
    + `<span class="watcher-scout-finding-title" title="${escapeWatcherAttr(asText(finding?.title))}">${escapeWatcherHtml(asText(finding?.title) || id || '—')}</span>`
    + `<span class="watcher-scout-state" data-scout-finding-status="${escapeWatcherAttr(status)}">${escapeWatcherHtml(scoutFindingStatusText(status))}</span>`
    + (asText(finding?.category)
      ? `<span class="watcher-scout-state" data-scout-finding-category="${escapeWatcherAttr(asText(finding.category))}">${escapeWatcherHtml(scoutFindingCategoryText(finding.category))}</span>`
      : '')
    + '</div>'
    + `<p class="cr-hint"><span class="watcher-scout-meta-label">${escapeWatcherHtml(t('settings.watcherScoutInboxProposed'))}:</span> ${escapeWatcherHtml(asText(finding?.createdAt) || '—')}</p>`
    + (rationale
      ? `<p class="cr-hint watcher-scout-finding-rationale" title="${escapeWatcherAttr(asText(finding?.rationale))}">${escapeWatcherHtml(rationale)}</p>`
      : '')
    + (shownFiles.length
      ? `<p class="cr-hint watcher-scout-finding-files"><span class="watcher-scout-meta-label">${escapeWatcherHtml(t('settings.watcherScoutInboxFiles'))}:</span> `
        + `${shownFiles.map((file) => `<code>${escapeWatcherHtml(asText(file))}</code>`).join(' ')}${moreFiles > 0 ? ` ${escapeWatcherHtml(t('settings.watcherScoutInboxFilesMore', { n: moreFiles }))}` : ''}</p>`
      : '')
    + sourcesHtml
    + todoHtml
    + actionsHtml
    + '</li>';
}

/**
 * The shared inbox card: title, contract notice, filter bar, optional status
 * message, then one of the loading / error / empty / populated states and the
 * honest "shown of total" line with its "load more" step.
 *
 * @param {{
 *   loading?: boolean,
 *   error?: string,
 *   findings?: object[],
 *   total?: number,
 *   profiles?: object[],
 *   scoutId?: string,
 *   category?: string,
 *   status?: string,
 *   max?: number,
 *   autoCreate?: boolean,
 *   busy?: boolean,
 *   busyId?: string,
 *   expandedSources?: Record<string, number> | Map<string, number>,
 *   message?: string,
 *   messageTone?: 'ok' | 'error',
 *   getTodoTitle?: (id: string) => string,
 * }} [view]
 * @returns {string}
 */
export function renderScoutInboxHtml(view = {}) {
  const findings = Array.isArray(view.findings) ? view.findings.filter(Boolean) : [];
  const busy = view.busy === true;
  const busyId = asText(view.busyId);
  const error = asText(view.error);
  const message = asText(view.message);
  const messageTone = view.messageTone === 'error' ? 'error' : 'ok';
  const total = asCount(view.total);
  const hiddenTotal = total != null && total > findings.length ? total - findings.length : 0;
  const pending = findings.filter((finding) => asText(finding?.status) === 'pending').length;

  const header = '<div class="watcher-scout-profiles-head">'
    + `<h4 class="watcher-section-title">${escapeWatcherHtml(t('settings.watcherScoutInboxTitle'))}</h4>`
    + '</div>';
  const hint = `<p class="cr-hint">${escapeWatcherHtml(t('settings.watcherScoutInboxHint'))}</p>`;
  const notice = renderScoutAutoCreateNotice(view.autoCreate === true, pending);
  const filters = renderScoutInboxFilters({ ...view, busy });
  const statusHtml = message
    ? `<p class="cr-status watcher-scout-message" data-tone="${escapeWatcherAttr(messageTone)}" role="status">${escapeWatcherHtml(message)}</p>`
    : '';

  let body;
  if (view.loading === true) {
    body = `<p class="cr-hint" data-scout-inbox-loading role="status">${escapeWatcherHtml(t('settings.watcherScoutInboxLoading'))}</p>`;
  } else if (error) {
    body = '<div class="message watcher-scout-error" data-tone="error" role="alert" data-scout-inbox-error>'
      + escapeWatcherHtml(error)
      + '</div>';
  } else if (findings.length === 0) {
    body = `<p class="cr-hint" data-scout-inbox-empty>${escapeWatcherHtml(t('settings.watcherScoutInboxEmpty'))}</p>`;
  } else {
    const rows = findings.map((finding) => renderScoutFindingRow(finding, {
      profiles: view.profiles,
      sourceLimit: scoutFindingSourceLimit(finding, view.expandedSources),
      busy: Boolean(busyId) && busyId === asText(finding?.id),
      autoCreate: view.autoCreate === true,
      getTodoTitle: view.getTodoTitle,
    })).join('');
    body = `<ul class="watcher-scout-findings" role="list" aria-label="${escapeWatcherAttr(t('settings.watcherScoutInboxTitle'))}">${rows}</ul>`
      + `<p class="cr-hint" data-scout-inbox-count role="status">${escapeWatcherHtml(t('settings.watcherScoutInboxCount', {
        shown: findings.length,
        total: total != null ? total : findings.length,
      }))}</p>`
      + (hiddenTotal > 0
        ? `<div class="cr-row watcher-scout-profile-actions">${renderScoutInboxButton('inbox-more', t('settings.watcherScoutInboxMore', { n: Math.min(hiddenTotal, SCOUT_INBOX_PAGE_SIZE) }), { icon: 'mdi-database-plus', disabled: busy })}</div>`
        : '');
  }

  // A mailbox that reached the workspace capacity still shows every retained
  // proposal: the server refuses new ones with `capacity_exceeded` instead of
  // evicting the oldest pending, so the only honest signal here is the reason
  // recorded on the scan plus the "shown of total" line above.
  const capacityHint = view.capacityExceeded === true
    ? '<p class="cr-hint watcher-scout-inbox-overflow" data-scout-inbox-overflow="true" role="status">'
      + escapeWatcherHtml(t('settings.watcherScoutInboxCapacityHint'))
      + '</p>'
    : '';

  return `<div class="cr-card watcher-form watcher-scout-inbox-card" data-scout-inbox>${header}${hint}${notice}${filters}${statusHtml}${body}${capacityHint}</div>`;
}
