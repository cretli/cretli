/** New-chat modal: harness readiness, model catalogs, usage limits and picker sync. */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import {
  buildNewChatModelOptions,
  encodeNewChatModelChoice,
  decodeNewChatModelChoice,
} from '../newChatModelOptions.js';
import { resolveNewChatUsageLimit, getNewChatLimitResetTime } from '../newChatUsageLimit.js';
import { resolveHarnessSelectValue } from '../harnessSettingsLoad.js';
import { getHarnessUiMeta, normalizeHarnessUiId, resolveHarnessUiMeta } from '../../../core/harness/harnessUiRegistry.js';
import {
  resolveCatalogConfirmedReadiness,
  createNewChatHarnessStatusTracker,
  createNewChatCatalogCache,
  normalizeNewChatHarnessId,
  listEnabledLocalChatHarnessOptions,
  resolveNewChatHarnessUiState,
} from '../newChatHarnessStatus.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { newChatModalState } from '../state/newChatModalState.js';
import { chatHost } from './chatHost.js';

/**
 * Open the “New chat” modal. Workspace comes from the header/sidebar context,
 * and in the form the user can change only the folder.
 */
/** New-chat readiness per harness id: true ready, false not ready, null/undefined not checked yet. */
const harnessReadyCache = new Map();

/**
 * Enabled local `capabilities.chat` plugin ids, refreshed from the harness
 * catalog. Only ids in this set survive `normalizeNewChatHarness`; everything
 * else still collapses to `sdk`. The create request itself is verified again on
 * the server, so this list is a UI convenience, not a trust boundary.
 */
export const localChatHarnessIds = new Set();

/**
 * Resolve whether the given harness is known ready, unknown (null) or known not ready.
 * A `null` cache must not be reported as an error.
 * @param {string} harness
 * @returns {boolean | null}
 */
function getNewChatHarnessReadiness(harness) {
  // The server loads and verifies the plugin at create time; the only UI
  // precondition is that the id is an enabled local chat plugin.
  if (localChatHarnessIds.has(harness)) return true;
  if (getHarnessUiMeta(harness)?.catalogConfirmedReadiness) {
    // The catalog must confirm models for the current catalog/settings generation; a cleared
    // catalog downgrades a stale `true` to unknown.
    return resolveCatalogConfirmedReadiness(readHarnessReady(harness), newChatCatalogCache.get(harness));
  }
  return readHarnessReady(harness);
}

/**
 * @param {string} harness
 * @returns {boolean | null}
 */
export function readHarnessReady(harness) {
  const id = normalizeHarnessUiId(harness, 'sdk');
  return harnessReadyCache.has(id) ? harnessReadyCache.get(id) : null;
}

/**
 * @param {string} harness
 * @param {boolean | null} ready
 */
export function setNewChatHarnessReadyCache(harness, ready) {
  if (localChatHarnessIds.has(harness)) return;
  harnessReadyCache.set(normalizeHarnessUiId(harness, 'sdk'), ready);
}

/**
 * Status-request generation, tracked per harness. A response may always update its own harness'
 * readiness cache, but only reaches the hint/button/model picker while that harness is selected
 * and its token is still the newest for that harness.
 */
export const newChatHarnessStatusTracker = createNewChatHarnessStatusTracker();

export const newChatCatalogCache = createNewChatCatalogCache();

const newChatHarnessErrors = new Map();

let newChatUsageLockouts = [];

let newChatUsageCheckFailed = false;

/**
 * Replace the usage lockouts without a network round trip (test seam).
 * @param {object[]} lockouts
 */
export function setNewChatUsageLockoutsForTest(lockouts) {
  newChatUsageLockouts = lockouts;
}

export const newChatModelCatalogChecked = new Set();

/**
 * Last built picker options with the signature of every input that shaped them. The expensive
 * part (strength sorting) reruns only when the signature changes, so unchanged chat-state
 * refreshes hand the picker the same object references and Lit skips the update.
 * @type {{ key: string, result: { harnesses: Array<{ id: string, label: string }>, options: object[], harnessLabels: Record<string, string> } } | null}
 */
let combinedPickerMemo = null;

/** Drop the memoized picker options (test seam; production relies on the content signature). */
export function resetCombinedModelPickerMemo() {
  combinedPickerMemo = null;
  pickerLabelsMemo = null;
}

/**
 * Grouped harness+model rows shared by the new-chat modal and the chat toolbar picker.
 * Memoized on a content signature of its inputs: harness list/labels, model catalogs,
 * enabled flags, readiness, in-flight/catalog-checked, errors, usage lockouts, limitsPending,
 * locale and favorite presets. Gathering the inputs is cheap; sorting is what is skipped.
 * @returns {{ harnesses: Array<{ id: string, label: string }>, options: object[], harnessLabels: Record<string, string> } | null}
 */
function buildCombinedModelPickerOptions() {
  const select = document.getElementById('chat-new-harness-select');
  if (!(select instanceof HTMLSelectElement) || !chatRuntime.chatModelSelectApi) return null;
  const harnesses = Array.from(select.options, (option) => ({
    id: option.value,
    label: option.dataset.baseLabel || option.textContent,
    models: localChatHarnessIds.has(option.value)
      ? [{ value: 'auto', label: t('chat.newPluginDefault') }]
      : chatRuntime.chatModelSelectApi.getModelOptionsForHarness(option.value, { includeDisabled: true }).map((model) => ({
        ...model, settingsDisabled: !chatRuntime.chatModelSelectApi.isModelEnabled(option.value, model.value),
      })),
    ready: getNewChatHarnessReadiness(option.value),
    checking: !!newChatHarnessStatusTracker.getInFlight(option.value)
      || (!localChatHarnessIds.has(option.value) && !newChatModelCatalogChecked.has(option.value)
        && getNewChatHarnessReadiness(option.value) === null),
    error: newChatHarnessErrors.get(option.value) || getNewChatHarnessError(option.value),
  }));
  const locale = document.documentElement.lang || undefined;
  const limitsPending = newChatModalState.newChatUsageCheckPending;
  const favoriteChoices = chatHost.chatPresets.getPresets().map((preset) => encodeNewChatModelChoice(preset.harness, preset.model));
  const key = JSON.stringify([
    harnesses, newChatUsageLockouts, !!limitsPending, locale || '', favoriteChoices,
    // Membership drives `favoriteable` of the mapped rows even when the harness data is identical.
    Array.from(localChatHarnessIds).sort(),
    // Translated strings feed the rows; a probe pair catches an i18n language switch.
    t('chat.newNoModels'), t('chat.newChecking'),
    // Limit countdowns read the clock, so live lockouts re-key once a minute.
    newChatUsageLockouts.length ? Math.floor(Date.now() / 60000) : 0,
  ]);
  if (combinedPickerMemo?.key === key) return combinedPickerMemo.result;
  const built = buildNewChatModelOptions(harnesses, newChatUsageLockouts, t, { limitsPending, locale });
  const favoriteSet = new Set(favoriteChoices);
  const options = built.map((row) => {
    const choice = decodeNewChatModelChoice(row.value);
    return { ...row, favoriteable: !!choice?.model && !localChatHarnessIds.has(choice.harness),
      favorite: favoriteSet.has(row.value) };
  });
  const result = {
    harnesses, options,
    harnessLabels: Object.fromEntries(harnesses.map((row) => [row.id, row.label])),
  };
  combinedPickerMemo = { key, result };
  return result;
}

/** Cached toolbar picker label bundle; same strings (and favorites default) => same object. */
let pickerLabelsMemo = null;

/**
 * @param {boolean} defaultFavoritesOnly
 * @returns {Record<string, string | boolean>}
 */
function getSdkModeBarPickerLabels(defaultFavoritesOnly) {
  const labels = {
    favoritesEnabled: true, favoritesFilterEnabled: true, availableFilterEnabled: true,
    defaultFavoritesOnly,
    availableOptionsLabel: t('chat.newAvailableModels'), allOptionsLabel: t('chat.newAllModels'),
    favoriteOptionsLabel: t('chat.newFavoriteModels'), emptyFavoritesLabel: t('chat.favoritePresetEmpty'),
    addFavoriteLabel: t('chat.addFavoritePreset'), removeFavoriteLabel: t('chat.removeFavoritePreset'),
    searchPlaceholder: t('chat.newSearchModels'), emptyLabel: t('chat.newNoMatchingModels'),
  };
  const key = JSON.stringify(labels);
  if (pickerLabelsMemo?.key === key) return pickerLabelsMemo.labels;
  pickerLabelsMemo = { key, labels };
  return labels;
}

/** Apply shared labels and filter flags to a `cr-searchable-select` model picker. */
function applyCombinedModelPickerLabels(picker) {
  picker.favoritesEnabled = true;
  picker.favoritesFilterEnabled = true;
  picker.availableFilterEnabled = true;
  picker.availableOptionsLabel = t('chat.newAvailableModels');
  picker.allOptionsLabel = t('chat.newAllModels');
  picker.favoriteOptionsLabel = t('chat.newFavoriteModels');
  picker.emptyFavoritesLabel = t('chat.favoritePresetEmpty');
  picker.addFavoriteLabel = t('chat.addFavoritePreset');
  picker.removeFavoriteLabel = t('chat.removeFavoritePreset');
  picker.searchPlaceholder = t('chat.newSearchModels');
  picker.emptyLabel = t('chat.newNoMatchingModels');
}

/** Feed the toolbar picker with the same grouped options as the new-chat modal. */
export function syncSdkModeBarPicker(bar, chat) {
  const combined = buildCombinedModelPickerOptions();
  if (!bar || !combined) return;
  // Assign only changed references: every assignment of a new object makes Lit re-render the bar.
  if (bar.pickerOptions !== combined.options) bar.pickerOptions = combined.options;
  if (bar.pickerHarnessLabels !== combined.harnessLabels) bar.pickerHarnessLabels = combined.harnessLabels;
  bar.pickerHarness = normalizeNewChatHarness(chat?.agentTransport || bar.harness || 'sdk');
  const labels = getSdkModeBarPickerLabels(chatHost.chatPresets.getPresets().length > 0);
  if (bar.pickerLabels !== labels) bar.pickerLabels = labels;
}

/** Mirror the selected pair and all known catalogs into the combined Lit picker. */
export function syncNewChatAgentModelPicker() {
  const picker = document.getElementById('chat-new-agent-model');
  const combined = buildCombinedModelPickerOptions();
  if (!picker || !combined) return;
  const { harnesses, options } = combined;
  const pickerEl = /** @type {any} */ (picker);
  if (pickerEl.options !== options) pickerEl.options = options;
  const harness = getSelectedNewChatHarness();
  const model = document.getElementById('chat-new-model-select')?.value || '';
  const choice = encodeNewChatModelChoice(harness, model);
  const selected = picker.options.find((row) => row.value === choice);
  const label = harnesses.find((row) => row.id === harness)?.label || harness;
  picker.value = choice;
  picker.displayLabel = `${label} · ${selected?.label || chatRuntime.chatModelSelectApi.getModelLabelByValue(model, harness) || t('chat.newNoModels')}`;
  picker.displayDescription = document.getElementById('chat-new-sdk-hint')?.textContent || selected?.status || '';
  applyCombinedModelPickerLabels(picker);
}

/** Warm grouped catalogs lazily, with a small concurrency bound and existing request deduplication. */
export async function loadNewChatModelCatalogs({ fromToolbar = false } = {}) {
  const sequence = ++newChatModalState.newChatModelCatalogLoadSequence;
  const select = document.getElementById('chat-new-harness-select');
  const queue = Array.from(select?.options || [], (option) => option.value)
    .filter((id) => !localChatHarnessIds.has(id) && (
      !newChatModelCatalogChecked.has(id) || getNewChatHarnessReadiness(id) !== true
      || chatRuntime.chatModelSelectApi.getModelOptionsForHarness(id, { includeDisabled: true }).length === 0
    ));
  async function loadNext() {
    while (queue.length && sequence === newChatModalState.newChatModelCatalogLoadSequence
      && (fromToolbar || document.getElementById('chat-new-modal')?.hidden === false)) {
      const id = queue.shift();
      newChatModelCatalogChecked.add(id);
      if (chatRuntime.chatModelSelectApi.getModelOptionsForHarness(id, { includeDisabled: true }).length === 0) newChatCatalogCache.clear(id);
      const pending = chatHost.runNewChatHarnessStatusCheck(id);
      syncNewChatAgentModelPicker();
      await pending;
      syncNewChatAgentModelPicker();
      if (fromToolbar) {
        syncSdkModeBarPicker(chatRuntime.sharedSdkModeBar, chats.find((c) => c.id === chatRuntime.activeChatId) || null);
      }
    }
  }
  await Promise.allSettled(Array.from({ length: 3 }, loadNext));
}

/** Mark harness-wide limits in the picker while keeping their explanation accessible. */
function syncNewChatHarnessLimitLabels() {
  const select = document.getElementById('chat-new-harness-select');
  if (!(select instanceof HTMLSelectElement)) return;
  for (const option of select.options) {
    const label = option.dataset.baseLabel || option.textContent;
    option.dataset.baseLabel = label;
    const limit = resolveNewChatUsageLimit(newChatUsageLockouts, option.value, '');
    option.textContent = limit ? `${label} · ${t('chat.newLimitedBadge')}` : label;
  }
}

/** Re-enable expired selections while the dialog stays open, without polling the server. */
function scheduleNewChatLimitExpiry() {
  clearTimeout(newChatModalState.newChatLimitExpiryTimer);
  const now = Date.now();
  const resets = newChatUsageLockouts.map((row) => Date.parse(row?.resetAt)).filter((time) => time > now);
  if (!resets.length) return;
  newChatModalState.newChatLimitExpiryTimer = setTimeout(() => {
    syncNewChatHarnessLimitLabels();
    syncNewChatHarnessUi();
    syncNewChatAgentModelPicker();
    syncSdkModeBarPicker(chatRuntime.sharedSdkModeBar, chats.find((c) => c.id === chatRuntime.activeChatId) || null);
    scheduleNewChatLimitExpiry();
  // Wake at least every 30 s so the visible reset countdown stays current.
  }, Math.min(Math.min(...resets) - now + 100, 30000));
}

/** Read all known provider limits once per open, without probing each harness. */
export async function refreshNewChatUsageLimits() {
  const sequence = ++newChatModalState.newChatUsageCheckSequence;
  newChatModalState.newChatUsageCheckPending = !isEmbedWidgetMode();
  newChatUsageCheckFailed = false;
  syncNewChatHarnessUi();
  if (isEmbedWidgetMode()) return;
  try {
    const result = await api.getUsagePlanLimits();
    if (sequence !== newChatModalState.newChatUsageCheckSequence) return;
    if (!result?.ok || !Array.isArray(result.lockouts)) throw new Error('Limit check failed');
    newChatUsageLockouts = result.lockouts;
  } catch {
    if (sequence !== newChatModalState.newChatUsageCheckSequence) return;
    newChatUsageCheckFailed = true;
  } finally {
    if (sequence === newChatModalState.newChatUsageCheckSequence) {
      newChatModalState.newChatUsageCheckPending = false;
      syncNewChatHarnessLimitLabels();
      scheduleNewChatLimitExpiry();
      syncNewChatHarnessUi();
    }
  }
}

/**
 * @param {string} harness
 * @returns {{ harness: string, seq: number }}
 */
export function beginNewChatHarnessStatusCheck(harness) {
  return newChatHarnessStatusTracker.begin(harness);
}

/**
 * Whether a token is the newest request for its own harness, independent of the current
 * selection. Use this to gate cache writes; UI writes additionally require it to be selected.
 *
 * @param {{ harness: string, seq: number } | null | undefined} token
 * @returns {boolean}
 */
export function isNewChatHarnessStatusLatest(token) {
  return newChatHarnessStatusTracker.isLatest(token);
}

/**
 * Toggle the loading/disabled state of the “Create chat” button while a chat is being created.
 * @param {boolean} busy
 */
export function setNewChatCreateBusy(busy) {
  const btn = document.getElementById('chat-new-create');
  if (!btn) return;
  btn.classList.toggle('is-loading', busy);
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (busy) {
    if (btn.dataset.originalLabel === undefined) btn.dataset.originalLabel = btn.textContent;
    btn.textContent = t('chat.creating');
    btn.disabled = true;
  } else {
    if (btn.dataset.originalLabel !== undefined) {
      btn.textContent = btn.dataset.originalLabel;
      delete btn.dataset.originalLabel;
    }
    syncNewChatHarnessUi();
  }
}

/**
 * @param {unknown} value
 * @returns {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'mistral' | 'zai' | 'mimo' | 'codex' | 'qwen' | 'claude'}
 */
export function normalizeNewChatHarness(value) {
  return normalizeNewChatHarnessId(value, { localIds: localChatHarnessIds });
}

export function getSelectedNewChatHarness() {
  const harnessSel = document.getElementById('chat-new-harness-select');
  return normalizeNewChatHarness(harnessSel?.value || 'sdk');
}

/**
 * Keep a visible selection when an inherited harness is disabled or not loaded yet.
 * @param {HTMLSelectElement} select
 * @param {string} harness
 */
export function selectNewChatHarness(select, harness) {
  select.value = resolveHarnessSelectValue({
    current: harness,
    options: Array.from(select.options, (option) => option.value),
    fallback: select.value,
  });
}

/**
 * Rebuild the injected local `<option>` rows from enabled local `capabilities.chat`
 * plugins and update the allowlist used by {@link normalizeNewChatHarness}.
 * Labels come from the plugin manifest and are written as textContent only.
 *
 * @param {unknown} catalog `{ items: [...] }` GET /api/harness-catalog/harnesses
 */
function applyLocalChatHarnessOptions(catalog) {
  const options = listEnabledLocalChatHarnessOptions(catalog);
  localChatHarnessIds.clear();
  for (const option of options) {
    localChatHarnessIds.add(option.id);
  }
  const select = document.getElementById('chat-new-harness-select');
  if (!(select instanceof HTMLSelectElement)) return;
  const previousValue = select.value;
  for (const existing of Array.from(select.querySelectorAll('option[data-local-harness="1"]'))) {
    existing.remove();
  }
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = option.label;
    element.dataset.localHarness = '1';
    select.appendChild(element);
  }
  if (Array.from(select.options).some((option) => option.value === previousValue)) select.value = previousValue;
  syncNewChatAgentModelPicker();
}

/**
 * Fetch and apply the enabled local chat plugins. Best-effort: a catalog failure
 * keeps the previous allowlist and never breaks the new-chat modal.
 *
 * @returns {Promise<void>}
 */
export async function refreshLocalChatHarnessOptions() {
  try {
    const catalog = await api.getHarnessCatalog();
    applyLocalChatHarnessOptions(catalog);
  } catch {
    // Keep the previous allowlist.
  }
}

/** Harness readiness error shown in the new-chat modal. Resolved lazily so i18n is initialized. */
function getNewChatHarnessError(harness) {
  return t(resolveHarnessUiMeta(harness).newChatErrorKey);
}

/**
 * Write readiness to the new-chat hint and Create button.
 * `null` (status unknown) shows no warning and keeps Create disabled until a check answers.
 * @param {string} resolvedHarness
 * @param {boolean | null} readiness
 * @param {string} [errorMessage]
 */
function renderNewChatHarnessUi(resolvedHarness, readiness, errorMessage) {
  const model = document.getElementById('chat-new-model-select')?.value || '';
  const hasModel = localChatHarnessIds.has(resolvedHarness)
    || chatRuntime.chatModelSelectApi?.getModelOptionsForHarness(resolvedHarness).some((row) => row.value === model);
  const limit = resolveNewChatUsageLimit(newChatUsageLockouts, resolvedHarness, model);
  const statusPending = !!newChatHarnessStatusTracker.getInFlight(resolvedHarness)
    || (readiness === null && !newChatHarnessStatusTracker.isSelectionSettled(resolvedHarness));
  const checking = (readiness === null && statusPending) || newChatModalState.newChatUsageCheckPending;
  const uiState = resolveNewChatHarnessUiState(limit || !hasModel ? false : readiness, newChatModalState.chatCreateInFlight || checking);
  const createBtn = document.getElementById('chat-new-create');
  const hint = document.getElementById('chat-new-sdk-hint');
  if (createBtn) {
    createBtn.disabled = uiState.disableCreate;
    createBtn.setAttribute('aria-describedby', 'chat-new-sdk-hint');
  }
  if (!hint) return;
  hint.hidden = false;
  hint.dataset.tone = limit || readiness === false || ((!hasModel || readiness === null) && !checking)
    ? 'error' : checking ? 'checking' : 'success';
  if (limit) {
    const time = getNewChatLimitResetTime(limit);
    hint.textContent = limit.code === 'model_unavailable'
      ? t('chat.newUnavailable')
      : time ? t('chat.newLimitReset', { time }) : t('chat.newLimit');
  } else if (readiness === false) {
    hint.textContent = errorMessage || newChatHarnessErrors.get(resolvedHarness) || getNewChatHarnessError(resolvedHarness);
  } else {
    hint.textContent = checking ? t('chat.newChecking')
      : readiness === null || !hasModel ? t('chat.newAvailabilityUnknown')
        : t(newChatUsageCheckFailed ? 'chat.newLimitsUnknown' : 'chat.newReady');
  }
  syncNewChatAgentModelPicker();
}

/**
 * Synchronously mirror the cached readiness of a harness into the hint and Create button.
 * Used on modal open and on harness change, before the status request resolves.
 * @param {string} [harness]
 * @returns {boolean | null}
 */
export function syncNewChatHarnessUi(harness = getSelectedNewChatHarness()) {
  const resolvedHarness = normalizeNewChatHarness(harness);
  const readiness = getNewChatHarnessReadiness(resolvedHarness);
  renderNewChatHarnessUi(resolvedHarness, readiness);
  return readiness;
}

/**
 * Apply a status response for a harness.
 *
 * A superseded response (a newer request for the same harness exists) is dropped entirely.
 * Otherwise the harness' readiness cache is always updated — even when it is not selected —
 * while only the selected harness reaches the hint/button/model picker.
 *
 * @param {string} harness
 * @param {boolean | null} ready
 * @param {string} [errorMessage]
 * @param {{ harness: string, seq: number } | null} [token]
 */
export function applyNewChatHarnessStatus(harness, ready, errorMessage, token) {
  const resolvedHarness = normalizeNewChatHarness(harness);
  if (token && !isNewChatHarnessStatusLatest(token)) return;
  if (errorMessage) newChatHarnessErrors.set(resolvedHarness, errorMessage);
  else newChatHarnessErrors.delete(resolvedHarness);
  setNewChatHarnessReadyCache(resolvedHarness, ready);
  syncNewChatAgentModelPicker();
  if (resolvedHarness !== getSelectedNewChatHarness()) return;
  // Render the effective readiness: for OpenCode a raw `true` stays unknown until its catalog
  // confirmed models for the current catalog/settings generation.
  renderNewChatHarnessUi(resolvedHarness, getNewChatHarnessReadiness(resolvedHarness), errorMessage);
}

export function isEmbedWidgetMode() {
  return typeof document !== 'undefined' && document.body?.classList.contains('embed-mode');
}
