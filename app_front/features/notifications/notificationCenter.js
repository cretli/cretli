/**
 * Header notification bell and in-app notification centre panel.
 *
 * The store (`notificationStore.js`) owns state; this module owns the DOM: the
 * bell badge, the dropdown panel rendered through `initDropdown` (Floating UI,
 * outside-click + Escape), the notification list and the Settings → App →
 * Notifications fieldset.
 *
 * Accessibility choices:
 * - the trigger is a real `<button aria-haspopup="true" aria-expanded>` managed by
 *   `initDropdown`;
 * - the panel is a labelled `role="region"` (not `role="dialog"`: it is a
 *   non-modal list of actions), focusable with `tabindex="-1"`;
 * - the list uses `role="list"`/`role="listitem"`, the item body is a real button
 *   when it has a safe `actionUrl`, and every action is a labelled `<button>`;
 * - focus moves into the panel when it opens and returns to the bell on close.
 *
 * Server-provided title/body are always written as `textContent`.
 */

import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { initDropdown } from '../../lib/dropdown.js';
import { noteNotificationCenterSignal } from '../pwa/inAppSignals.js';
import {
  NOTIFICATION_CENTER_CATEGORIES,
  createNotificationStore,
  formatNotificationRelativeTime,
  normalizeNotificationCenterPreferences,
  resolveNotificationActionUrl,
  setNotificationStore,
} from './notificationStore.js';

const NOTIFICATIONS_PATH = '/api/notifications';
const SETTINGS_PATH = '/api/settings';

/**
 * Whether the centre has unread rows for mark-all / bulk actions (independent of badge prefs).
 *
 * @param {{ items?: Array<{ readAt?: unknown }> }} [state]
 * @returns {boolean}
 */
export function hasUnreadNotificationItems(state) {
  return Array.isArray(state?.items) && state.items.some((row) => !row.readAt);
}

/** @type {Record<string, string>} */
const CATEGORY_ICONS = Object.freeze({
  chat: 'mdi-forum-outline',
  models: 'mdi-robot-outline',
  cli: 'mdi-console-line',
  system: 'mdi-alert-circle-outline',
});

/**
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<object>}
 */
async function requestJson(url, init) {
  const response = await cretliApiFetch(url, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `http_${response.status}`);
    /** @type {any} */ (error).status = response.status;
    /** @type {any} */ (error).payload = payload;
    throw error;
  }
  return payload || {};
}

/**
 * Browser implementation of the store request contract. Uses the shared
 * authenticated fetch helper, so session + CSRF and the CSRF retry are handled.
 *
 * @returns {import('./notificationStore.js').NotificationStoreApi & { savePreferences: (prefs: object) => Promise<object> }}
 */
export function createNotificationCenterApi() {
  return {
    fetchList: () => requestJson(NOTIFICATIONS_PATH, { cache: 'no-store' }),
    markRead: (payload) => requestJson(`${NOTIFICATIONS_PATH}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }),
    dismiss: (payload) => requestJson(`${NOTIFICATIONS_PATH}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }),
    savePreferences: (prefs) => requestJson(SETTINGS_PATH, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationCenter: prefs }),
    }),
  };
}

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
function el(id) {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

/**
 * @param {string} id
 * @param {string} i18nKey
 * @param {string} icon
 * @returns {HTMLButtonElement}
 */
function createActionButton(id, i18nKey, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'notification-item-action';
  button.dataset.action = id;
  button.setAttribute('aria-label', t(i18nKey));
  button.title = t(i18nKey);
  const glyph = document.createElement('span');
  glyph.className = `mdi ${icon}`;
  glyph.setAttribute('aria-hidden', 'true');
  button.appendChild(glyph);
  return button;
}

/**
 * Initialize the bell, its panel, the live store and the settings fieldset.
 *
 * @param {{
 *   api?: object,
 *   onNavigate?: (url: string) => void,
 *   logger?: { log?: Function } | null,
 * }} [options]
 * @returns {{ store: ReturnType<typeof createNotificationStore>, api: object, open: () => void, close: () => void } | null}
 */
export function initNotificationCenter(options = {}) {
  if (typeof document === 'undefined') return null;
  const trigger = el('header-notifications-btn');
  const panel = el('header-notifications-panel');
  if (!trigger || !panel) return null;
  if (/** @type {any} */ (trigger)._cretliNotificationCenterBound === true) {
    return /** @type {any} */ (trigger)._cretliNotificationCenterApi || null;
  }
  /** @type {any} */ (trigger)._cretliNotificationCenterBound = true;

  const api = options.api || createNotificationCenterApi();
  const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : null;
  const onNavigate = typeof options.onNavigate === 'function'
    ? options.onNavigate
    : (url) => {
      if (typeof window !== 'undefined' && url) window.location.assign(url);
    };

  const badgeEl = el('header-notifications-badge');
  const listEl = el('notifications-list');
  const emptyEl = el('notifications-empty');
  const markAllBtn = el('notifications-mark-all-btn');
  const settingsBtn = el('notifications-settings-btn');

  const presetSelect = el('notification-center-preset');
  const badgeToggle = el('notification-center-badge');
  const soundToggle = el('notification-center-sound');
  const categoryToggles = new Map();
  for (const category of NOTIFICATION_CENTER_CATEGORIES) {
    const toggle = el(`notification-center-category-${category}`);
    if (toggle) categoryToggles.set(category, toggle);
  }
  const settingsMarkAllBtn = el('notification-center-mark-all-btn');
  const settingsStatusEl = el('notification-center-status');

  let savingSettings = false;
  /** @type {ReturnType<typeof initDropdown> | null} */
  let dropdownApi = null;

  /** @type {ReturnType<typeof createNotificationStore>} */
  let store;
  store = createNotificationStore({
    api,
    logger,
    onNewItems: ({ ids }) => {
      noteNotificationCenterSignal({ ids, soundEnabled: store.getPreferences().sound });
    },
    onChange: (state) => {
      renderBadge(state);
      if (dropdownApi?.isOpen?.()) renderList(state);
      if (!savingSettings) renderPreferences(state.preferences, state);
      renderMarkAllState(state);
    },
  });
  setNotificationStore(store);

  // Keep the panel out of the header stacking context (same as other Floating UI panels).
  if (panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }

  dropdownApi = initDropdown({
    triggerEl: trigger,
    floatingEl: panel,
    placement: 'bottom-end',
    offsetPx: 6,
    viewportPadding: 8,
    minWidthPx: 240,
    maxHeightPx: 480,
    optionSelector: 'button:not([disabled])',
    onOpen: () => {
      renderList();
      renderMarkAllState(store.getState());
      requestAnimationFrame(() => panel.focus());
      // Opening the panel is an explicit user refresh: force a full GET so a
      // server-side revision reset (or a missed frame) cannot leave it stale.
      void store.fetchNow({ reason: 'panel-open', force: true });
    },
    onClose: () => {
      const active = document.activeElement;
      if (active === panel || panel.contains(active)) trigger.focus();
    },
  });
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    dropdownApi?.toggle();
  });

  function closePanel() {
    dropdownApi?.close();
  }

  /**
   * @param {object} state
   */
  function renderBadge(state) {
    if (!badgeEl) return;
    const count = state?.initialized === true ? Math.max(0, Number(state.unreadCount) || 0) : 0;
    badgeEl.textContent = count > 99 ? '99+' : String(count);
    badgeEl.hidden = count <= 0;
    const label = count > 0
      ? t('notifications.bellAriaCount', { count: String(count) })
      : t('notifications.bellAria');
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('title', label);
  }

  /**
   * @param {object} item
   * @returns {HTMLLIElement}
   */
  function renderItem(item) {
    const li = document.createElement('li');
    li.className = 'notification-item';
    li.dataset.id = item.id;
    li.dataset.category = item.category;
    li.dataset.severity = item.severity;
    li.setAttribute('role', 'listitem');
    if (!item.readAt) li.dataset.unread = 'true';

    const icon = document.createElement('span');
    icon.className = `mdi ${CATEGORY_ICONS[item.category] || 'mdi-bell-outline'} notification-item-icon`;
    icon.setAttribute('aria-hidden', 'true');
    icon.title = t(`notifications.category${item.category[0].toUpperCase()}${item.category.slice(1)}`);

    const actionUrl = resolveNotificationActionUrl(item.actionUrl);
    if (actionUrl) li.dataset.actionUrl = actionUrl;
    const main = document.createElement(actionUrl ? 'button' : 'div');
    main.className = 'notification-item-main';
    if (actionUrl) {
      main.type = 'button';
      main.dataset.action = 'open';
      main.dataset.actionUrl = actionUrl;
      main.setAttribute('aria-label', t('notifications.openAria', { title: item.title }));
    }

    const titleRow = document.createElement('span');
    titleRow.className = 'notification-item-title-row';
    const title = document.createElement('span');
    title.className = 'notification-item-title';
    title.textContent = item.title;
    titleRow.appendChild(title);
    if (!item.readAt) {
      const dot = document.createElement('span');
      dot.className = 'notification-item-unread-dot';
      dot.setAttribute('aria-hidden', 'true');
      titleRow.appendChild(dot);
      const sr = document.createElement('span');
      sr.className = 'cr-visually-hidden';
      sr.textContent = t('notifications.unread');
      titleRow.appendChild(sr);
    }

    main.appendChild(titleRow);
    if (item.body) {
      const body = document.createElement('span');
      body.className = 'notification-item-body';
      body.textContent = item.body;
      main.appendChild(body);
    }
    const meta = document.createElement('span');
    meta.className = 'notification-item-meta';
    const time = document.createElement('time');
    time.className = 'notification-item-time';
    time.dateTime = item.createdAt || '';
    time.textContent = formatNotificationRelativeTime(item.createdAt, Date.now(), t);
    meta.appendChild(time);
    main.appendChild(meta);

    const actions = document.createElement('span');
    actions.className = 'notification-item-actions';
    if (!item.readAt) actions.appendChild(createActionButton('read', 'notifications.markRead', 'mdi-email-open-outline'));
    actions.appendChild(createActionButton('dismiss', 'notifications.dismiss', 'mdi-close'));

    li.append(icon, main, actions);
    return li;
  }

  /**
   * @param {object} [state]
   */
  function renderList(state = store.getState()) {
    if (!listEl) return;
    listEl.replaceChildren();
    const items = Array.isArray(state?.items) ? state.items : [];
    if (emptyEl) {
      emptyEl.hidden = items.length > 0;
      emptyEl.textContent = state?.error ? t('notifications.loadFailed') : t('notifications.empty');
    }
    for (const item of items) listEl.appendChild(renderItem(item));
  }

  /**
   * @param {object} state
   */
  function renderMarkAllState(state) {
    const hasUnread = hasUnreadNotificationItems(state);
    if (markAllBtn) markAllBtn.disabled = !hasUnread;
    if (settingsMarkAllBtn) settingsMarkAllBtn.disabled = !hasUnread;
  }

  function fillPresetOptions() {
    if (!presetSelect) return;
    if (presetSelect.tagName === 'CR-BAR-SELECT') {
      /** @type {any} */ (presetSelect).options = [
        { value: 'all', label: t('settings.notificationCenterPresetAll') },
        { value: 'important', label: t('settings.notificationCenterPresetImportant') },
        { value: 'custom', label: t('settings.notificationCenterPresetCustom') },
      ];
      return;
    }
    presetSelect.replaceChildren();
    for (const [value, label] of [
      ['all', t('settings.notificationCenterPresetAll')],
      ['important', t('settings.notificationCenterPresetImportant')],
      ['custom', t('settings.notificationCenterPresetCustom')],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      presetSelect.appendChild(option);
    }
  }

  /**
   * @param {object} prefs
   * @param {object} [state]
   */
  function renderPreferences(prefs, state = store.getState()) {
    const normalized = normalizeNotificationCenterPreferences(prefs || state?.preferences);
    if (presetSelect) presetSelect.value = normalized.preset;
    const custom = normalized.preset === 'custom';
    for (const [category, toggle] of categoryToggles) {
      toggle.checked = custom ? normalized.categories[category] === true : true;
      toggle.disabled = !custom;
    }
    if (badgeToggle) badgeToggle.checked = normalized.showBadge;
    if (soundToggle) soundToggle.checked = normalized.sound;
  }

  /**
   * @param {string} message
   * @param {boolean} isError
   */
  function setSettingsStatus(message, isError) {
    if (!settingsStatusEl) return;
    settingsStatusEl.textContent = message || '';
    settingsStatusEl.style.color = isError ? 'var(--cr-error)' : '';
  }

  /**
   * @param {object} next
   */
  async function savePreferences(next) {
    savingSettings = true;
    setSettingsStatus('', false);
    try {
      const response = await api.savePreferences(next);
      const saved = response?.notificationCenter || next;
      store.applyPreferences(saved, { refetch: true });
      savingSettings = false;
      renderPreferences(store.getState().preferences);
      setSettingsStatus(t('settings.notificationCenterSaved'), false);
    } catch (err) {
      savingSettings = false;
      renderPreferences(store.getState().preferences);
      setSettingsStatus(
        t('settings.notificationCenterSaveFailed', { detail: err?.message || String(err) }),
        true,
      );
    }
  }

  function readPreferencesFromUi() {
    const current = store.getPreferences();
    const preset = presetSelect?.value || current.preset;
    /** @type {Record<string, boolean>} */
    const categories = { ...current.categories };
    // The category checkboxes are disabled outside "custom": keep the stored
    // custom selection instead of flattening it to the preset display.
    if (preset === 'custom') {
      for (const [category, toggle] of categoryToggles) {
        categories[category] = toggle.checked === true;
      }
    }
    return normalizeNotificationCenterPreferences({
      preset,
      categories,
      showBadge: badgeToggle ? badgeToggle.checked === true : current.showBadge,
      sound: soundToggle ? soundToggle.checked === true : current.sound,
    });
  }

  presetSelect?.addEventListener('change', () => {
    const prefs = readPreferencesFromUi();
    renderPreferences(prefs);
    void savePreferences(prefs);
  });
  for (const [, toggle] of categoryToggles) {
    toggle.addEventListener('change', () => {
      const prefs = readPreferencesFromUi();
      void savePreferences(prefs);
    });
  }
  badgeToggle?.addEventListener('change', () => void savePreferences(readPreferencesFromUi()));
  soundToggle?.addEventListener('change', () => void savePreferences(readPreferencesFromUi()));

  async function runMarkAll() {
    const result = await store.markAllRead();
    if (result && result.ok === false) {
      setSettingsStatus(t('settings.notificationCenterSaveFailed', { detail: result.error || '' }), true);
    }
  }
  markAllBtn?.addEventListener('click', () => void runMarkAll());
  settingsMarkAllBtn?.addEventListener('click', () => void runMarkAll());

  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      closePanel();
      onNavigate('/?panel=settings&tab=interface-notifications');
    });
  }

  listEl?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const li = target.closest('.notification-item');
    const id = li instanceof HTMLElement ? li.dataset.id || '' : '';
    if (!id) return;
    const actionButton = target.closest('button[data-action]');
    if (!actionButton) {
      // The whole row is clickable when it carries a safe actionUrl; action
      // buttons keep their own handlers below.
      const rowUrl = resolveNotificationActionUrl(li instanceof HTMLElement ? li.dataset.actionUrl || '' : '');
      if (!rowUrl) return;
      void store.markRead(id);
      closePanel();
      onNavigate(rowUrl);
      return;
    }
    const action = actionButton.dataset.action || '';
    if (action === 'read') {
      void store.markRead(id);
      return;
    }
    if (action === 'dismiss') {
      void store.dismiss(id);
      return;
    }
    if (action === 'open') {
      const url = resolveNotificationActionUrl(actionButton.dataset.actionUrl || '');
      void store.markRead(id);
      if (!url) return;
      closePanel();
      onNavigate(url);
    }
  });

  // A dropped socket means the fan-out frame never arrived, so a reconnect does a full GET.
  let connectionWasDown = false;
  if (typeof window !== 'undefined') {
    window.addEventListener('cretli-connection-status', (event) => {
      const status = event?.detail?.displayStatus || '';
      if (status && status !== 'connected') {
        connectionWasDown = true;
        return;
      }
      if (status === 'connected' && connectionWasDown) {
        connectionWasDown = false;
        void store.fetchNow({ reason: 'reconnect', force: true });
      }
    });
    window.addEventListener('online', () => void store.fetchNow({ reason: 'online', force: true }));
    window.addEventListener('cr-lang-changed', () => {
      fillPresetOptions();
      renderPreferences(store.getState().preferences);
      renderList();
      renderBadge(store.getState());
    });
  }

  fillPresetOptions();
  renderPreferences(store.getState().preferences);
  renderBadge(store.getState());
  renderList(store.getState());
  renderMarkAllState(store.getState());
  void store.fetchNow({ reason: 'init' }).catch((err) => {
    logger?.log?.('notifications', 'initial load failed', { error: String(err?.message || err) });
  });

  const centerApi = {
    store,
    api,
    open: () => dropdownApi.open(),
    close: () => dropdownApi.close(),
  };
  /** @type {any} */ (trigger)._cretliNotificationCenterApi = centerApi;
  return centerApi;
}
