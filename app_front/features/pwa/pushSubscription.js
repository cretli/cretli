/**
 * Push notifications subscription (Web Push + VAPID) and the Notifications
 * section of Settings → App.
 *
 * Design notes:
 * - The toggle state is derived from `Notification.permission` plus
 *   `pushManager.getSubscription()`, never from the legacy `cretli-push-enabled`
 *   localStorage flag alone. That flag is still written for older code, but the
 *   UI reads the real device state.
 * - `unsubscribe()` errors are NOT swallowed: a subscription that is still live
 *   must never be shown as "disabled".
 * - `setPushEnabled()` returns `{ ok:false }` when the browser or the server
 *   write fails; a failed save never looks like a success.
 * - The legacy `cretli-push-enabled` flag is migrated into the local preferences
 *   store (see `pushPreferencesStore.js`).
 */
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import {
  LEGACY_PUSH_ENABLED_STORAGE_KEY,
  NOTIFICATION_SOUND_PRESETS,
  PUSH_VIBRATE_PRESET_IDS,
  resolveNotificationProfile,
  resolvePushVibratePattern,
} from '../../../lib/push-preferences.js';
import {
  readStorageValueWithAlias,
  removeStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import {
  clampPushInAppVolume,
  createIndexedDbPersistence,
  createPushPreferencesStore,
} from './pushPreferencesStore.js';
import { sendPushTest } from './pushTestClient.js';
import { createInAppSignalPlayer, getInAppSignalController, IN_APP_SIGNAL_TONE } from './inAppSignals.js';

const LS_KEY = LEGACY_PUSH_ENABLED_STORAGE_KEY;
const VAPID_PUBLIC_PATH = '/api/push/vapid-public';
const SUBSCRIBE_PATH = '/api/push/subscribe';
const DANGER_COLOR = 'var(--cr-danger, #b91c1c)';

/** Push state names shown in the panel. */
export const PUSH_STATES = Object.freeze({
  UNSUPPORTED: 'unsupported',
  BLOCKED: 'blocked',
  PERMISSION_REQUIRED: 'permission-required',
  INACTIVE: 'inactive',
  ACTIVE: 'active',
});

const PUSH_STATE_LABEL_KEYS = Object.freeze({
  [PUSH_STATES.UNSUPPORTED]: 'pwa.pushStateUnsupported',
  [PUSH_STATES.BLOCKED]: 'pwa.pushStateBlocked',
  [PUSH_STATES.PERMISSION_REQUIRED]: 'pwa.pushStatePermissionRequired',
  [PUSH_STATES.INACTIVE]: 'pwa.pushStateInactive',
  [PUSH_STATES.ACTIVE]: 'pwa.pushStateActive',
});

const VIBRATE_LABEL_KEYS = Object.freeze({
  off: 'settings.notificationsVibrateOff',
  short: 'settings.notificationsVibrateShort',
  default: 'settings.notificationsVibrateDefault',
  long: 'settings.notificationsVibrateLong',
});

/** @type {ReturnType<typeof createPushPreferencesStore> | null} */
let preferencesStore = null;

/**
 * @returns {ReturnType<typeof createPushPreferencesStore>}
 */
export function getPushPreferencesStore() {
  if (!preferencesStore) {
    preferencesStore = createPushPreferencesStore(createIndexedDbPersistence(), {
      readLegacyEnabled: () => {
        try {
          if (typeof localStorage === 'undefined') return '';
          return readStorageValueWithAlias(localStorage, LS_KEY, '');
        } catch (_) {
          return '';
        }
      },
    });
  }
  return preferencesStore;
}

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * @returns {{ hasServiceWorker: boolean, hasPushManager: boolean, hasNotifications: boolean, supported: boolean }}
 */
export function getPushSupport() {
  const hasServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const hasPushManager = typeof window !== 'undefined' && 'PushManager' in window;
  const hasNotifications = typeof Notification !== 'undefined';
  return {
    hasServiceWorker,
    hasPushManager,
    hasNotifications,
    supported: hasServiceWorker && hasPushManager && hasNotifications,
  };
}

/**
 * Pure state derivation. Kept separate so it can be unit tested without a DOM.
 *
 * @param {{ supported?: boolean, permission?: string, hasSubscription?: boolean }} [input]
 * @returns {string}
 */
export function derivePushState(input = {}) {
  if (input.supported !== true) return PUSH_STATES.UNSUPPORTED;
  if (input.permission === 'denied') return PUSH_STATES.BLOCKED;
  if (input.permission !== 'granted') return PUSH_STATES.PERMISSION_REQUIRED;
  return input.hasSubscription === true ? PUSH_STATES.ACTIVE : PUSH_STATES.INACTIVE;
}

async function getVapidPublicKey() {
  const res = await cretliApiFetch(VAPID_PUBLIC_PATH);
  if (!res.ok) throw new Error(`vapid-public HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.publicKey) throw new Error('vapid-public: missing publicKey');
  return String(data.publicKey);
}

async function getSwRegistration(waitUntilReady = false) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (typeof window === 'undefined' || !('PushManager' in window)) return null;
  try {
    // Reading/saving in-app settings must work even if no worker is active.
    if (!waitUntilReady && typeof navigator.serviceWorker.getRegistration === 'function') {
      return await navigator.serviceWorker.getRegistration();
    }
    return await navigator.serviceWorker.ready;
  } catch (_) {
    return null;
  }
}

/**
 * @returns {Promise<PushSubscription | null>}
 */
export async function getPushSubscription() {
  const reg = await getSwRegistration();
  if (!reg?.pushManager?.getSubscription) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch (_) {
    return null;
  }
}

/**
 * Real device push state: permission + live subscription.
 *
 * @returns {Promise<{ state: string, permission: string, endpoint: string, supported: boolean }>}
 */
export async function readPushState() {
  const support = getPushSupport();
  const permission = typeof Notification !== 'undefined' && typeof Notification.permission === 'string'
    ? Notification.permission
    : 'default';
  let endpoint = '';
  if (support.supported && permission === 'granted') {
    const subscription = await getPushSubscription();
    if (subscription?.endpoint) endpoint = String(subscription.endpoint);
  }
  return {
    state: derivePushState({
      supported: support.supported,
      permission,
      hasSubscription: !!endpoint,
    }),
    permission,
    endpoint,
    supported: support.supported,
  };
}

/**
 * @param {PushSubscription} subscription
 * @param {unknown} preferences
 * @returns {Promise<void>}
 */
async function postSubscription(subscription, preferences) {
  const payload = { subscription, endpoint: subscription.endpoint };
  if (preferences && typeof preferences === 'object') payload.preferences = preferences;
  const res = await cretliApiFetch(SUBSCRIBE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`subscribe HTTP ${res.status}`);
}

/**
 * @param {string} endpoint
 * @returns {Promise<void>}
 */
async function deleteSubscription(endpoint) {
  const res = await cretliApiFetch(SUBSCRIBE_PATH, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) throw new Error(`unsubscribe HTTP ${res.status}`);
}

async function subscribeNew() {
  const reg = await getSwRegistration(true);
  if (!reg) throw new Error('service worker not ready');
  const publicKey = await getVapidPublicKey();
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey),
  });
}

/**
 * @param {unknown} err
 * @param {string} state
 * @returns {{ ok: false, state: string, message: string }}
 */
function failure(err, state) {
  return {
    ok: false,
    state,
    message: t('pwa.pushError', { detail: err?.message || String(err) }),
  };
}

export function isPushEnabled() {
  try {
    if (typeof localStorage === 'undefined') return false;
    return readStorageValueWithAlias(localStorage, LS_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function setStored(flag) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (flag) writeStorageValueWithAlias(localStorage, LS_KEY, '1');
    else removeStorageValueWithAlias(localStorage, LS_KEY);
  } catch (_) {
    // The legacy mirror is best-effort; the local preferences store is the
    // source of truth.
  }
}

async function enablePush() {
  const support = getPushSupport();
  if (!support.supported || typeof Notification.requestPermission !== 'function') {
    return { ok: false, state: PUSH_STATES.UNSUPPORTED, message: t('pwa.pushUnsupported') };
  }
  let permission;
  try {
    permission = await Notification.requestPermission();
  } catch (err) {
    return failure(err, PUSH_STATES.PERMISSION_REQUIRED);
  }
  if (permission !== 'granted') {
    const blocked = permission === 'denied';
    return {
      ok: false,
      state: blocked ? PUSH_STATES.BLOCKED : PUSH_STATES.PERMISSION_REQUIRED,
      message: blocked ? t('pwa.pushPermissionDenied') : t('pwa.pushPermissionRequired'),
    };
  }

  let subscription;
  try {
    subscription = await subscribeNew();
  } catch (err) {
    return failure(err, PUSH_STATES.INACTIVE);
  }

  try {
    const store = getPushPreferencesStore();
    const preferences = await store.load(subscription.endpoint);
    // Server first, then the local copy: if either fails the whole enable fails
    // and the just-created subscription is rolled back.
    await postSubscription(subscription, { ...preferences, enabled: true });
    await store.save(subscription.endpoint, { enabled: true });
    setStored(true);
    return {
      ok: true,
      state: PUSH_STATES.ACTIVE,
      message: t('pwa.pushOn'),
      endpoint: subscription.endpoint,
    };
  } catch (err) {
    try {
      await subscription.unsubscribe();
    } catch (_) {
      // Best effort rollback; the reported error is the original one.
    }
    setStored(false);
    return failure(err, PUSH_STATES.INACTIVE);
  }
}

async function disablePush() {
  const reg = await getSwRegistration();
  if (!reg) {
    setStored(false);
    return { ok: true, state: PUSH_STATES.INACTIVE, message: t('pwa.pushOff') };
  }
  let subscription;
  try {
    subscription = await reg.pushManager.getSubscription();
  } catch (err) {
    return failure(err, PUSH_STATES.INACTIVE);
  }
  if (!subscription) {
    setStored(false);
    return { ok: true, state: PUSH_STATES.INACTIVE, message: t('pwa.pushOff') };
  }

  const endpoint = subscription.endpoint;
  let removed;
  try {
    removed = await subscription.unsubscribe();
  } catch (err) {
    // The subscription is still live: never report it as disabled.
    return {
      ok: false,
      state: PUSH_STATES.ACTIVE,
      message: t('pwa.pushError', { detail: err?.message || String(err) }),
    };
  }
  if (!removed) {
    return { ok: false, state: PUSH_STATES.ACTIVE, message: t('pwa.pushOffFailed') };
  }

  // The browser subscription is gone. A server/local save failure is still a
  // failure (`ok:false`), but the device genuinely is no longer subscribed.
  let saveError = null;
  try {
    await deleteSubscription(endpoint);
  } catch (err) {
    saveError = err;
  }
  try {
    const store = getPushPreferencesStore();
    await store.save(endpoint, { enabled: false });
  } catch (err) {
    if (!saveError) saveError = err;
  }
  setStored(false);
  if (saveError) {
    return {
      ok: false,
      state: PUSH_STATES.INACTIVE,
      message: t('pwa.pushSaveFailed', { detail: saveError?.message || String(saveError) }),
    };
  }
  return { ok: true, state: PUSH_STATES.INACTIVE, message: t('pwa.pushOff') };
}

/**
 * Enables/disables notifications. Returns { ok, state, message }.
 *
 * @param {boolean} enabled
 */
export async function setPushEnabled(enabled) {
  const support = getPushSupport();
  if (!support.supported) {
    return { ok: false, state: PUSH_STATES.UNSUPPORTED, message: t('pwa.pushUnsupported') };
  }
  return enabled ? enablePush() : disablePush();
}

/**
 * Test the device vibration with the given preset. Never throws.
 *
 * @param {unknown} presetId
 * @returns {{ ok: boolean, reason: string, skipped?: boolean, detail?: string }}
 */
export function vibrateWithPattern(presetId) {
  const pattern = resolvePushVibratePattern(presetId);
  if (!Array.isArray(pattern) || pattern.length === 0) {
    // Nothing to test: no API needed for the "off" preset.
    return { ok: true, reason: 'off', skipped: true };
  }
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return { ok: false, reason: 'unsupported' };
  }
  try {
    const accepted = navigator.vibrate(Array.from(pattern));
    return accepted ? { ok: true, reason: '' } : { ok: false, reason: 'unsupported' };
  } catch (err) {
    return { ok: false, reason: 'failed', detail: err?.message || String(err) };
  }
}

/**
 * @returns {boolean}
 */
export function isWebAudioSupported() {
  if (typeof window === 'undefined') return false;
  return typeof (window.AudioContext || window.webkitAudioContext) === 'function';
}

/** Reuse one AudioContext for all profile previews. */
let previewPlayer = null;

/**
 * Play a short Web Audio preview (no audio file shipped in the repo). Returns a
 * result object instead of throwing so a blocked autoplay never breaks the UI.
 *
 * @param {unknown} volume 0..1
 * @param {string} [soundPreset]
 * @returns {Promise<{ ok: boolean, reason: string, detail?: string }>}
 */
export async function playTestTone(volume, soundPreset = 'default') {
  if (!previewPlayer) previewPlayer = createInAppSignalPlayer();
  return previewPlayer.playSound({
    soundPreset,
    gain: clampPushInAppVolume(volume) * IN_APP_SIGNAL_TONE.gain,
  });
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
 * @param {HTMLElement | null} select
 */
function fillVibrateOptions(select) {
  if (!select) return;
  const options = PUSH_VIBRATE_PRESET_IDS.map((id) => ({
    value: id,
    label: t(VIBRATE_LABEL_KEYS[id] || id),
  }));
  if (select.tagName === 'CR-BAR-SELECT') {
    /** @type {any} */ (select).options = options;
    return;
  }
  select.replaceChildren();
  for (const item of options) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    select.appendChild(opt);
  }
}

/**
 * @param {HTMLElement | null} element
 * @param {() => void} handler
 */
function bindChange(element, handler) {
  if (!element) return;
  element.addEventListener('change', handler);
}

function setStatus(element, message, isError) {
  if (!element) return;
  element.textContent = message || '';
  element.style.color = isError ? DANGER_COLOR : '';
}

function renderPushState(main, status, stateEl, info) {
  if (!main) return;
  const unsupported = info.state === PUSH_STATES.UNSUPPORTED;
  main.disabled = unsupported;
  main.checked = info.state === PUSH_STATES.ACTIVE;
  if (stateEl) {
    stateEl.textContent = t(PUSH_STATE_LABEL_KEYS[info.state] || 'pwa.pushStateInactive');
  }
  if (unsupported && status) {
    status.textContent = t('pwa.pushUnsupported');
  }
}

function renderPreferences(els, preferences) {
  if (els.eventFinished) els.eventFinished.checked = preferences.events.finished;
  if (els.eventQuestion) els.eventQuestion.checked = preferences.events.question;
  if (els.eventPermission) els.eventPermission.checked = preferences.events.permission;
  if (els.eventNewChat) els.eventNewChat.checked = preferences.events.newChat;
  const profile = resolveNotificationProfile(preferences, { notificationScope: 'chat' });
  if (els.vibrateSelect) els.vibrateSelect.value = profile.pushVibrate;
  if (els.inAppVibrate) els.inAppVibrate.checked = profile.inAppVibrate;
  if (els.inAppSound) els.inAppSound.checked = profile.inAppSound;
  if (els.vibratePreset) els.vibratePreset.value = profile.vibratePreset;
  if (els.soundPreset) els.soundPreset.value = profile.soundPreset;
}

function renderVolume(range, label, value) {
  const clamped = clampPushInAppVolume(value);
  if (range) range.value = String(Math.round(clamped * 100));
  if (label) label.textContent = `${Math.round(clamped * 100)}%`;
}

/**
 * @param {{ enabled?: HTMLElement | null, start?: HTMLInputElement | null, end?: HTMLInputElement | null }} els
 * @param {{ enabled: boolean, start: string, end: string }} quietHours
 */
function renderQuietHours(els, quietHours) {
  const enabledBox = els.enabled;
  if (enabledBox && 'checked' in enabledBox) enabledBox.checked = !!quietHours.enabled;
  if (els.start) els.start.value = quietHours.start;
  if (els.end) els.end.value = quietHours.end;
}

/**
 * @param {{ enabled?: HTMLElement | null, start?: HTMLInputElement | null, end?: HTMLInputElement | null }} els
 * @returns {{ enabled?: boolean, start?: string, end?: string }}
 */
function readQuietHoursPatch(els) {
  const patch = {};
  const enabledBox = els.enabled;
  if (enabledBox && 'checked' in enabledBox) patch.enabled = !!enabledBox.checked;
  if (els.start && typeof els.start.value === 'string') patch.start = els.start.value;
  if (els.end && typeof els.end.value === 'string') patch.end = els.end.value;
  return patch;
}

function readEventPatch(els) {
  return {
    events: {
      finished: !!els.eventFinished?.checked,
      question: !!els.eventQuestion?.checked,
      permission: !!els.eventPermission?.checked,
      newChat: !!els.eventNewChat?.checked,
    },
  };
}

let pendingPreferenceWrite = Promise.resolve();

/**
 * Persist one preference patch locally and (when subscribed) on the server.
 * Returns the saved preferences, or null when a write failed.
 *
 * @param {Record<string, unknown>} patch
 * @param {HTMLElement | null} status
 */
function applyPreferencePatch(patch, status) {
  // Serialize local saves, server writes and controller updates as one operation.
  const result = pendingPreferenceWrite.catch(() => {}).then(() => savePreferencePatch(patch, status));
  pendingPreferenceWrite = result;
  return result;
}

async function savePreferencePatch(patch, status) {
  try {
    const subscription = await getPushSubscription();
    const effective = subscription ? { ...patch, enabled: true } : patch;
    const store = getPushPreferencesStore();
    const saved = await store.save(subscription?.endpoint || '', effective);
    if (subscription) {
      await postSubscription(subscription, saved);
      setStored(true);
    }
    setStatus(status, t('pwa.pushPrefsSaved'), false);
    // Keep the live in-app signal controller in sync with the saved record so a
    // toggle takes effect immediately (not only after the next app start).
    const controller = getInAppSignalController();
    if (controller && saved) controller.setPreferences(saved);
    return saved;
  } catch (err) {
    setStatus(status, t('pwa.pushSaveFailed', { detail: err?.message || String(err) }), true);
    return null;
  }
}

/**
 * Initializes the whole Notifications section: main toggle, device state, event
 * presets, push vibration, in-app signals and the local test buttons.
 *
 * @returns {Promise<void>}
 */
export async function initPushSettingsToggle() {
  try {
    await initPushSettingsToggleInner();
  } catch (err) {
    // Settings must never break app boot; report and continue.
    console.warn('[push] notifications settings init failed:', err?.message || err);
  }
}

async function initPushSettingsToggleInner() {
  if (typeof document === 'undefined') return;
  const main = el('pwa-push-checkbox');
  const status = el('pwa-push-status');
  if (!main || !status) return;

  const stateEl = el('pwa-push-state');
  const eventFinished = el('pwa-push-event-finished');
  const eventQuestion = el('pwa-push-event-question');
  const eventPermission = el('pwa-push-event-permission');
  const eventNewChat = el('pwa-push-event-new-chat');
  const vibrateSelect = el('pwa-push-vibrate-select');
  const inAppVibrate = el('pwa-inapp-vibrate-checkbox');
  const inAppSound = el('pwa-inapp-sound-checkbox');
  const vibratePreset = el('pwa-inapp-vibrate-select');
  const soundPreset = el('pwa-inapp-sound-select');
  const volumeRange = el('pwa-inapp-volume-range');
  const volumeValue = el('pwa-inapp-volume-value');
  const vibrateTestBtn = el('pwa-push-vibrate-test-btn');
  const soundPreviewBtn = el('pwa-push-sound-preview-btn');
  const pushTestBtn = el('pwa-push-test-btn');
  const testStatus = el('pwa-push-test-status');
  const quietEnabled = el('pwa-quiet-enabled-checkbox');
  const quietStart = el('pwa-quiet-start');
  const quietEnd = el('pwa-quiet-end');
  const quietStatus = el('pwa-quiet-status');
  const quietEls = {
    enabled: quietEnabled,
    start: quietStart,
    end: quietEnd,
  };

  const preferenceEls = {
    eventFinished,
    eventQuestion,
    eventPermission,
    eventNewChat,
    vibrateSelect,
    inAppVibrate,
    inAppSound,
    vibratePreset,
    soundPreset,
  };

  const subchatEls = {
    pushVibrate: el('pwa-subchat-push-vibrate-select'),
    inAppVibrate: el('pwa-subchat-vibrate-checkbox'),
    inAppSound: el('pwa-subchat-sound-checkbox'),
    vibratePreset: el('pwa-subchat-vibrate-select'),
    soundPreset: el('pwa-subchat-sound-select'),
    volumeRange: el('pwa-subchat-volume-range'),
    volumeValue: el('pwa-subchat-volume-value'),
  };
  const chatTestStatus = el('pwa-chat-test-status');
  const subchatTestStatus = el('pwa-subchat-test-status');
  function fillProfileOptions() {
    for (const select of [vibrateSelect, vibratePreset, subchatEls.pushVibrate, subchatEls.vibratePreset]) {
      fillVibrateOptions(select);
    }
    for (const select of [soundPreset, subchatEls.soundPreset]) {
      if (select) select.options = Object.keys(NOTIFICATION_SOUND_PRESETS).map((id) => ({
        value: id,
        label: t(`settings.notificationsSound${id[0].toUpperCase()}${id.slice(1)}`),
      }));
    }
  }
  fillProfileOptions();
  if (typeof window !== 'undefined') {
    window.addEventListener('cr-lang-changed', fillProfileOptions);
  }

  const store = getPushPreferencesStore();
  const stateInfo = await readPushState();
  renderPushState(main, status, stateEl, stateInfo);

  const preferences = await store.load(stateInfo.endpoint || '');
  renderPreferences(preferenceEls, preferences);
  const volume = await store.loadVolume();
  renderVolume(volumeRange, volumeValue, resolveNotificationProfile(preferences, {}).volume ?? volume);
  function renderSubchatPreferences(saved) {
    const profile = resolveNotificationProfile(saved, { notificationScope: 'subchat' });
    for (const key of ['pushVibrate', 'vibratePreset', 'soundPreset']) {
      if (subchatEls[key]) subchatEls[key].value = profile[key];
    }
    for (const key of ['inAppVibrate', 'inAppSound']) {
      if (subchatEls[key]) subchatEls[key].checked = profile[key];
    }
    renderVolume(subchatEls.volumeRange, subchatEls.volumeValue, profile.volume ?? volume);
  }
  renderSubchatPreferences(preferences);
  const quietHours = await store.loadQuietHours();
  renderQuietHours(quietEls, quietHours);
  getInAppSignalController()?.setQuietHours(quietHours);

  async function saveQuietHoursFromUi() {
    try {
      const saved = await store.saveQuietHours(readQuietHoursPatch(quietEls));
      renderQuietHours(quietEls, saved);
      getInAppSignalController()?.setQuietHours(saved);
      setStatus(quietStatus, t('pwa.pushPrefsSaved'), false);
    } catch (err) {
      setStatus(quietStatus, t('pwa.pushSaveFailed', { detail: err?.message || String(err) }), true);
    }
  }

  main.addEventListener('change', async () => {
    main.disabled = true;
    const result = await setPushEnabled(!!main.checked);
    const next = await readPushState();
    renderPushState(main, status, stateEl, next);
    setStatus(status, result.message, !result.ok);
    main.disabled = next.state === PUSH_STATES.UNSUPPORTED;
    if (result.ok) {
      const saved = await store.load(next.endpoint || '');
      renderPreferences(preferenceEls, saved);
      renderSubchatPreferences(saved);
    }
  });

  const onEventChange = () => {
    void applyPreferencePatch(readEventPatch(preferenceEls), status);
  };
  bindChange(eventFinished, onEventChange);
  bindChange(eventQuestion, onEventChange);
  bindChange(eventPermission, onEventChange);
  bindChange(eventNewChat, onEventChange);

  const chatFields = { pushVibrate: vibrateSelect, inAppVibrate, inAppSound, vibratePreset, soundPreset };
  for (const [scope, fields] of [['chat', chatFields], ['subchat', subchatEls]]) {
    for (const key of ['pushVibrate', 'inAppVibrate', 'inAppSound', 'vibratePreset', 'soundPreset']) {
      const element = fields[key];
      bindChange(element, () => {
        const value = key === 'inAppVibrate' || key === 'inAppSound' ? !!element.checked : element.value;
        void applyPreferencePatch({ profiles: { [scope]: { [key]: value } } }, status);
      });
    }
  }

  bindChange(quietEnabled, () => {
    void saveQuietHoursFromUi();
  });
  if (quietStart) {
    quietStart.addEventListener('change', () => {
      void saveQuietHoursFromUi();
    });
  }
  if (quietEnd) {
    quietEnd.addEventListener('change', () => {
      void saveQuietHoursFromUi();
    });
  }

  for (const [scope, range, label] of [
    ['chat', volumeRange, volumeValue],
    ['subchat', subchatEls.volumeRange, subchatEls.volumeValue],
  ]) {
    if (!range) continue;
    range.addEventListener('input', () => renderVolume(range, label, Number(range.value) / 100));
    range.addEventListener('change', () => {
      void applyPreferencePatch({ profiles: { [scope]: { volume: Number(range.value) / 100 } } }, status);
    });
  }

  for (const [button, select, output] of [
    [vibrateTestBtn, vibratePreset, chatTestStatus],
    [el('pwa-subchat-vibrate-test-btn'), subchatEls.vibratePreset, subchatTestStatus],
  ]) {
    button?.addEventListener('click', () => {
      const result = vibrateWithPattern(select?.value || 'default');
      const key = result.skipped ? 'pwa.pushVibrateOff' : result.ok ? 'pwa.pushVibrateTested' : 'pwa.pushVibrateUnsupported';
      setStatus(output, t(key), !result.ok);
    });
  }

  for (const [button, select, range, output] of [
    [soundPreviewBtn, soundPreset, volumeRange, chatTestStatus],
    [el('pwa-subchat-sound-preview-btn'), subchatEls.soundPreset, subchatEls.volumeRange, subchatTestStatus],
  ]) {
    button?.addEventListener('click', async () => {
      const result = await playTestTone(Number(range?.value ?? volume * 100) / 100, select?.value || 'default');
      const key = result.ok ? 'pwa.pushSoundTested'
        : result.reason === 'unsupported' ? 'pwa.pushSoundUnsupported'
          : result.reason === 'blocked' ? 'pwa.pushSoundBlocked' : 'pwa.pushError';
      setStatus(output, t(key, { detail: result.detail || result.reason }), !result.ok);
    });
  }

  if (pushTestBtn) {
    pushTestBtn.addEventListener('click', async () => {
      pushTestBtn.disabled = true;
      setStatus(testStatus, t('pwa.pushTestSending'), false);
      try {
        const endpoint = (await readPushState()).endpoint;
        if (!endpoint) {
          setStatus(testStatus, t('pwa.pushTestNoSubscription'), true);
          return;
        }
        const result = await sendPushTest(endpoint);
        setStatus(
          testStatus,
          result.ok
            ? t('pwa.pushTestSent')
            : t('pwa.pushTestFailed', { detail: result.error || result.detail || '' }),
          !result.ok
        );
      } finally {
        pushTestBtn.disabled = false;
      }
    });
  }
}
