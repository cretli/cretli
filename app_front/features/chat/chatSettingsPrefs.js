import {
  AUTO_NAME_CHAT_KEY,
  SKIP_CATCHUP_ON_RESUME_KEY,
  MAINTAIN_SESSIONS_KEY,
  CONNECT_ALL_CHATS_ON_START_KEY,
  CHAT_CANVAS_ADDON_KEY,
  CHAT_READ_BUFFER_FROM_LOCALSTORAGE_KEY,
} from '../../config.js';
import { readLocalStorageSafe, writeLocalStorageSafe } from './chatLocalStorage.js';

export const AUTO_UPDATE_CHAT_TITLE_KEY = 'cretli-auto-update-chat-title';
export const SHOW_SEND_FIELD_KEY = 'cretli-chat-show-send-field';
/** Opt-in hide. Absence or any value other than `'1'` means the send bar is shown. */
export const HIDE_SEND_FIELD_KEY = 'cretli-chat-hide-send-field';
export const SHOW_CHAT_DIAG_KEY = 'cretli-chat-show-diag';
export const SDK_VERBOSE_LOGS_KEY = 'cretli-chat-sdk-verbose-logs';
export const LAST_SELECTED_MODEL_KEY = 'cretli-last-selected-model';
export const LAST_SELECTED_HARNESS_KEY = 'cretli-last-selected-harness';

/**
 * @param {unknown} model
 * @returns {string}
 */
export function normalizeModelValue(model) {
  if (typeof model !== 'string') return 'auto';
  const normalized = model.trim();
  if (!normalized) return 'auto';
  return normalized;
}

/**
 * @param {unknown} harness
 * @returns {'' | 'sdk' | 'openrouter' | 'opencode'}
 */
export function normalizeHarnessValue(harness) {
  if (typeof harness !== 'string') return '';
  const normalized = harness.trim().toLowerCase();
  if (normalized === 'sdk') return 'sdk';
  if (normalized === 'openrouter') return 'openrouter';
  if (normalized === 'opencode') return 'opencode';
  return '';
}

/** @returns {string} */
export function readLastSelectedModel() {
  return normalizeModelValue(readLocalStorageSafe(LAST_SELECTED_MODEL_KEY, 'auto'));
}

/** @param {unknown} model */
export function saveLastSelectedModel(model) {
  writeLocalStorageSafe(LAST_SELECTED_MODEL_KEY, normalizeModelValue(model), 'saveLastSelectedModel');
}

/** @returns {'' | 'sdk' | 'openrouter' | 'opencode'} */
export function readLastSelectedHarness() {
  return normalizeHarnessValue(readLocalStorageSafe(LAST_SELECTED_HARNESS_KEY, ''));
}

/** @param {unknown} harness */
export function saveLastSelectedHarness(harness) {
  writeLocalStorageSafe(
    LAST_SELECTED_HARNESS_KEY,
    normalizeHarnessValue(harness),
    'saveLastSelectedHarness',
  );
}

export function getAutoNameChatEnabled() {
  return readLocalStorageSafe(AUTO_NAME_CHAT_KEY, '0') === '1';
}

/** @param {boolean} value */
export function setAutoNameChatEnabled(value) {
  writeLocalStorageSafe(AUTO_NAME_CHAT_KEY, value ? '1' : '0', 'setAutoNameChatEnabled');
}

export function getAutoUpdateChatTitleEnabled() {
  return readLocalStorageSafe(AUTO_UPDATE_CHAT_TITLE_KEY, '0') === '1';
}

/** @param {boolean} value */
export function setAutoUpdateChatTitleEnabled(value) {
  writeLocalStorageSafe(AUTO_UPDATE_CHAT_TITLE_KEY, value ? '1' : '0', 'setAutoUpdateChatTitleEnabled');
}

export function getSkipCatchUpOnResume() {
  return readLocalStorageSafe(SKIP_CATCHUP_ON_RESUME_KEY, '0') === '1';
}

/** @param {boolean} value */
export function setSkipCatchUpOnResume(value) {
  writeLocalStorageSafe(SKIP_CATCHUP_ON_RESUME_KEY, value ? '1' : '0', 'setSkipCatchUpOnResume');
}

export function getMaintainSessionsEnabled() {
  return readLocalStorageSafe(MAINTAIN_SESSIONS_KEY, '1') !== '0';
}

/** @param {boolean} value */
export function setMaintainSessionsEnabled(value) {
  writeLocalStorageSafe(MAINTAIN_SESSIONS_KEY, value ? '1' : '0', 'setMaintainSessionsEnabled');
}

export function getConnectAllChatsOnStartEnabled() {
  return true;
}

/** @param {boolean} value */
export function setConnectAllChatsOnStartEnabled(value) {
  writeLocalStorageSafe(CONNECT_ALL_CHATS_ON_START_KEY, value ? '1' : '0', 'setConnectAllChatsOnStartEnabled');
}

/** Canvas renderer is off by default; enabled only when setting is `'1'`. */
export function getChatCanvasAddonEnabled() {
  return readLocalStorageSafe(CHAT_CANVAS_ADDON_KEY, '0') === '1';
}

/** @param {boolean} value */
export function setChatCanvasAddonEnabled(value) {
  writeLocalStorageSafe(CHAT_CANVAS_ADDON_KEY, value ? '1' : '0', 'setChatCanvasAddonEnabled');
}

export function getReadChatBufferFromLocalStorageEnabled() {
  return readLocalStorageSafe(CHAT_READ_BUFFER_FROM_LOCALSTORAGE_KEY, '0') === '1';
}

/** @param {boolean} value */
export function setReadChatBufferFromLocalStorageEnabled(value) {
  writeLocalStorageSafe(
    CHAT_READ_BUFFER_FROM_LOCALSTORAGE_KEY,
    value ? '1' : '0',
    'setReadChatBufferFromLocalStorageEnabled',
  );
}

export function isChatDiagEnabled() {
  const value = readLocalStorageSafe(SHOW_CHAT_DIAG_KEY, 'false');
  return value === 'true' || value === '1';
}

export function getSdkVerboseLogsEnabled() {
  const value = readLocalStorageSafe(SDK_VERBOSE_LOGS_KEY, 'false');
  return value === 'true' || value === '1';
}

/**
 * Whether the chat send bar should be visible.
 * The legacy `cretli-chat-show-send-field=false` value is ignored: iOS/WebKit
 * reported an unchecked box when Chat settings were saved from another tab
 * (`display:none` parent), which hid the bar until storage was cleared.
 *
 * @returns {boolean}
 */
export function getShowSendFieldEnabled() {
  return readLocalStorageSafe(HIDE_SEND_FIELD_KEY, '') !== '1';
}

/**
 * @param {boolean} show
 */
export function setShowSendFieldEnabled(show) {
  writeLocalStorageSafe(HIDE_SEND_FIELD_KEY, show ? '0' : '1', 'setShowSendFieldEnabled');
  if (show) {
    writeLocalStorageSafe(SHOW_SEND_FIELD_KEY, 'true', 'setShowSendFieldEnabled.legacy');
  }
}

/**
 * Drop a poisoned legacy hide flag so older readers cannot keep the bar hidden.
 */
export function healLegacyShowSendFieldPreference() {
  if (!getShowSendFieldEnabled()) return;
  if (readLocalStorageSafe(SHOW_SEND_FIELD_KEY, '') !== 'false') return;
  writeLocalStorageSafe(SHOW_SEND_FIELD_KEY, 'true', 'healLegacyShowSendFieldPreference');
}
