/** New-chat modal: per-harness status refreshers and late default harness selection. */
import * as api from '../../../core/api/index.js';
import { applyDefaultNewChatHarnessToModal } from '../../settings/models/harnessSettings.js';
import { readDelegationExecutionMode } from '../chatDelegations.js';
import { t } from '../../../i18n/index.js';
import {
  fetchOpenCodeModelsCatalog,
  refreshSdkModeBarCombinedPicker,
  resolveOpenCodeCatalogParamCandidates,
  syncPendingHarnessBarModels,
} from './harnessModelCatalog.js';
import {
  applyNewChatHarnessStatus,
  beginNewChatHarnessStatusCheck,
  getSelectedNewChatHarness,
  isNewChatHarnessStatusLatest,
  localChatHarnessIds,
  newChatCatalogCache,
  newChatHarnessStatusTracker,
  normalizeNewChatHarness,
  setNewChatHarnessReadyCache,
  syncNewChatAgentModelPicker,
  syncNewChatHarnessUi,
} from './newChatHarnessState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { newChatModalState } from '../state/newChatModalState.js';

function applySdkStatusToUi(r, token) {
  if (token && !isNewChatHarnessStatusLatest(token)) return;
  // The backend localises this error, so match both languages it can return.
  if (
    r &&
    r.ok === false &&
    /unavailable in a widget session|niedostępny w sesji widgetu/i.test(String(r.error || ''))
  ) {
    applyNewChatHarnessStatus('sdk', false, t('chat.sdkWidgetNeedsServerUpdate'), token);
    return;
  }
  const modelsChanged = chatRuntime.chatModelSelectApi.applyAvailableModelsFromSdkStatus(r);
  if (getSelectedNewChatHarness() === 'sdk') {
    chatRuntime.chatModelSelectApi.refreshNewChatModelPicker('sdk');
  } else if (modelsChanged) {
    chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
  }
  const ready = !!(r && r.ok && r.ready);
  applyNewChatHarnessStatus('sdk', ready, undefined, token);
}

/**
 * @param {string} harness
 * @returns {boolean}
 */
function isNewChatHarnessSelected(harness) {
  return getSelectedNewChatHarness() === harness;
}

/**
 * Rebuilds the new-chat model picker when `harness` is the one selected in the modal.
 *
 * @param {string} harness
 * @param {{ forceCloseDropdown?: boolean }} [pickerOptions]
 */
function refreshNewChatModelPickerIfSelected(harness, pickerOptions) {
  if (!isNewChatHarnessSelected(harness)) return;
  chatRuntime.chatModelSelectApi.refreshNewChatModelPicker(harness, pickerOptions);
}

function applyOpenRouterStatusToUi(r, token) {
  if (token && !isNewChatHarnessStatusLatest(token)) return;
  if (Array.isArray(r?.models)) {
    chatRuntime.chatModelSelectApi.applyAvailableModels('openrouter', r);
  }
  const invalidFormat = !!r?.openrouterApiKeyInvalidFormat;
  const ready = !!(r && r.openrouterApiKeyEffective);
  refreshNewChatModelPickerIfSelected('openrouter');
  applyNewChatHarnessStatus(
    'openrouter',
    ready,
    invalidFormat
      ? 'Invalid OpenRouter API key format — use a key from openrouter.ai/keys (starts with sk-or-v1-).'
      : undefined,
    token,
  );
}

function refreshNewChatSdkStatus(token) {
  return api
    .getAgentSdkStatus()
    .then((r) => applySdkStatusToUi(r, token))
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('sdk', false, t('chat.sdkCheckFailed'), token);
    });
}

function refreshNewChatOpenRouterStatus(token) {
  return api
    .getOpenRouterStatus()
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      applyOpenRouterStatusToUi(status, token);
      if (!status?.openrouterApiKeyEffective) return null;
      return newChatCatalogCache
        .fetchDeduped('openrouter', () => api.getOpenRouterModels())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok || Array.isArray(models?.models)) {
            chatRuntime.chatModelSelectApi.applyAvailableModels('openrouter', models);
          }
          refreshNewChatModelPickerIfSelected('openrouter');
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('openrouter', false, t('chat.openrouterStatusFailed'), token);
    });
}

function refreshNewChatOpenCodeStatus(options = {}, token) {
  const params = resolveOpenCodeCatalogParamCandidates()[0] || {};
  const pickerOptions = { forceCloseDropdown: options.forceCloseDropdown === true };
  return api
    .getOpenCodeStatus(params)
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      const keyOk = !!status?.opencodeCredentialsEffective;
      const ready = !!(status && status.opencodeReady);
      applyNewChatHarnessStatus(
        'opencode',
        ready,
        keyOk ? status?.error : t('chat.opencodeKeyMissing'),
        token,
      );
      if (!keyOk) return null;
      return newChatCatalogCache
        .fetchDeduped('opencode', () => fetchOpenCodeModelsCatalog())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('opencode', models);
          const hasModels = !!(models?.ok && Array.isArray(models.models) && models.models.length > 0);
          applyNewChatHarnessStatus(
            'opencode',
            ready && hasModels,
            models?.error || (hasModels ? undefined : t('chat.opencodeNoModels')),
            token,
          );
          if (isNewChatHarnessSelected('opencode')) {
            chatRuntime.chatModelSelectApi.refreshNewChatModelPicker('opencode', pickerOptions);
          } else {
            chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
            void refreshSdkModeBarCombinedPicker();
          }
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('opencode', false, t('chat.opencodeStatusFailed'), token);
    });
}

function refreshNewChatCodeBuddyStatus(token) {
  return api
    .getCodeBuddyStatus()
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      const ready = !!(status && status.ready);
      applyNewChatHarnessStatus(
        'codebuddy',
        ready,
        status?.error
          || (!status?.sdkAvailable
            ? t('chat.codebuddySdkMissing')
            : (!status?.cliFound ? t('chat.codebuddyCliMissing') : undefined)),
        token,
      );
      if (!status?.codebuddyApiKeyEffective) return null;
      return newChatCatalogCache
        .fetchDeduped('codebuddy', () => api.getCodeBuddyModels())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('codebuddy', models);
          refreshNewChatModelPickerIfSelected('codebuddy');
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('codebuddy', false, t('chat.codebuddyStatusFailed'), token);
    });
}

function refreshNewChatDeepSeekStatus(token) {
  return api
    .getDeepSeekStatus()
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      const ready = !!(status && status.ready);
      applyNewChatHarnessStatus(
        'deepseek',
        ready,
        status?.error
          || (!status?.sdkAvailable
            ? t('chat.deepseekSdkMissing')
            : (!status?.cliFound ? t('chat.deepseekCliMissing') : undefined)),
        token,
      );
      if (!status?.deepseekApiKeyEffective) return null;
      return newChatCatalogCache
        .fetchDeduped('deepseek', () => api.getDeepSeekModels())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('deepseek', models);
          refreshNewChatModelPickerIfSelected('deepseek');
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('deepseek', false, t('chat.deepseekStatusFailed'), token);
    });
}

function refreshNewChatMistralStatus(token) {
  return api
    .getMistralStatus()
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      const ready = !!(status && status.ready);
      applyNewChatHarnessStatus(
        'mistral',
        ready,
        status?.error || (!status?.sdkAvailable ? t('chat.mistralSdkMissing') : undefined),
        token,
      );
      if (!status?.mistralApiKeyEffective) return null;
      return newChatCatalogCache
        .fetchDeduped('mistral', () => api.getMistralModels())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('mistral', models);
          refreshNewChatModelPickerIfSelected('mistral');
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('mistral', false, t('chat.mistralStatusFailed'), token);
    });
}

function refreshNewChatZaiStatus(token) {
  return api.getZaiStatus().then((status) => {
    if (token && !isNewChatHarnessStatusLatest(token)) return null;
    const ready = !!status?.ready;
    applyNewChatHarnessStatus('zai', ready, !status?.sdkAvailable ? t('chat.zaiSdkMissing') : undefined, token);
    if (!status?.zaiApiKeyEffective || !status?.sdkAvailable) return null;
    return newChatCatalogCache.fetchDeduped('zai', () => api.getZaiModels()).then((models) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('zai', models);
      refreshNewChatModelPickerIfSelected('zai');
    });
  }).catch(() => {
    if (token && !isNewChatHarnessStatusLatest(token)) return;
    applyNewChatHarnessStatus('zai', false, t('chat.zaiStatusFailed'), token);
  });
}

function refreshNewChatMimoStatus(token) {
  return api.getMimoStatus().then((status) => {
    if (token && !isNewChatHarnessStatusLatest(token)) return null;
    const ready = !!status?.ready;
    applyNewChatHarnessStatus('mimo', ready, !status?.mimoApiKeyEffective ? t('chat.mimoDisabled') : undefined, token);
    if (!status?.mimoApiKeyEffective) return null;
    return newChatCatalogCache.fetchDeduped('mimo', () => api.getMimoModels()).then((models) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('mimo', models);
      refreshNewChatModelPickerIfSelected('mimo');
    });
  }).catch(() => {
    if (token && !isNewChatHarnessStatusLatest(token)) return;
    applyNewChatHarnessStatus('mimo', false, t('chat.mimoStatusFailed'), token);
  });
}

function refreshNewChatQwenStatus(token) {
  return api
    .getQwenStatus()
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      const ready = !!(status && status.ready);
      applyNewChatHarnessStatus(
        'qwen',
        ready,
        status?.error
          || (!status?.sdkAvailable ? t('chat.qwenSdkMissing') : undefined),
        token,
      );
      if (!status?.qwenApiKeyEffective) return null;
      return newChatCatalogCache
        .fetchDeduped('qwen', () => api.getQwenModels())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('qwen', models);
          refreshNewChatModelPickerIfSelected('qwen');
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('qwen', false, t('chat.qwenStatusFailed'), token);
    });
}

function refreshNewChatClaudeStatus(token) {
  return api
    .getClaudeStatus()
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      const ready = !!(status && status.ready);
      applyNewChatHarnessStatus(
        'claude',
        ready,
        status?.error
          || (!status?.sdkAvailable ? t('chat.claudeSdkMissing') : undefined),
        token,
      );
      if (!status?.sdkAvailable) return null;
      return newChatCatalogCache
        .fetchDeduped('claude', () => api.getClaudeModels())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('claude', models);
          refreshNewChatModelPickerIfSelected('claude');
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('claude', false, t('chat.claudeStatusFailed'), token);
    });
}

function refreshNewChatCodexStatus(token) {
  return api
    .getCodexStatus()
    .then((status) => {
      if (token && !isNewChatHarnessStatusLatest(token)) return null;
      const ready = !!(status && status.ready);
      applyNewChatHarnessStatus(
        'codex',
        ready,
        status?.error
          || (!status?.sdkAvailable
            ? t('chat.codexSdkMissing')
            : (!status?.cliFound ? (status?.cliHint || t('chat.codexCliMissing')) : undefined)),
        token,
      );
      if (!status?.ready) return null;
      return newChatCatalogCache
        .fetchDeduped('codex', () => api.getCodexModels())
        .then((models) => {
          if (token && !isNewChatHarnessStatusLatest(token)) return;
          if (models?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels('codex', models);
          refreshNewChatModelPickerIfSelected('codex');
        });
    })
    .catch(() => {
      if (token && !isNewChatHarnessStatusLatest(token)) return;
      applyNewChatHarnessStatus('codex', false, t('chat.codexStatusFailed'), token);
    });
}

/**
 * Per-harness new-chat status/catalog checks, keyed by transport id. The checks differ in the
 * status fields and error texts they read, so they stay here until harnesses own their UI code.
 *
 * @type {Record<string, (options: { forceCloseDropdown?: boolean }, token: object) => Promise<unknown>>}
 */
const NEW_CHAT_STATUS_REFRESHERS = {
  sdk: (_options, token) => refreshNewChatSdkStatus(token),
  openrouter: (_options, token) => refreshNewChatOpenRouterStatus(token),
  opencode: (options, token) => refreshNewChatOpenCodeStatus(options, token),
  codebuddy: (_options, token) => refreshNewChatCodeBuddyStatus(token),
  deepseek: (_options, token) => refreshNewChatDeepSeekStatus(token),
  mistral: (_options, token) => refreshNewChatMistralStatus(token),
  zai: (_options, token) => refreshNewChatZaiStatus(token),
  mimo: (_options, token) => refreshNewChatMimoStatus(token),
  qwen: (_options, token) => refreshNewChatQwenStatus(token),
  claude: (_options, token) => refreshNewChatClaudeStatus(token),
  codex: (_options, token) => refreshNewChatCodexStatus(token),
};

export function reloadOpenCodeModelsCatalog(chat = null) {
  return fetchOpenCodeModelsCatalog(chat).then(async (data) => {
    if (data?.ok) {
      newChatCatalogCache.set('opencode', data);
      chatRuntime.chatModelSelectApi.applyAvailableModels('opencode', data);
    }
    chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
    const bar = document.querySelector('cr-sdk-mode-bar');
    const pendingHarness = String(bar?.pendingHarness || '').trim();
    if (bar && pendingHarness) {
      syncPendingHarnessBarModels(bar, pendingHarness);
    }
    await refreshSdkModeBarCombinedPicker({
      reopenDropdown: !!pendingHarness && bar?.pickerStep === 'model',
    });
    return data;
  });
}

/**
 * Run (or join) one status/catalog check for a harness and track it per harness.
 *
 * The token is created here, so event listeners cannot dispatch an untracked status request.
 * The finalizer only releases the in-flight slot when this promise still owns it, so an older
 * check settling cannot delete a newer one.
 *
 * @param {string} harness
 * @param {{ forceCloseDropdown?: boolean }} [options]
 * @returns {Promise<unknown>}
 */
export function runNewChatHarnessStatusCheck(harness, options = {}) {
  const resolvedHarness = normalizeNewChatHarness(harness);
  if (localChatHarnessIds.has(resolvedHarness)) {
    // Local plugins have no vendor status/model check in this slice; the create
    // endpoint performs the only real verification. Never route them through the
    // SDK credential check.
    syncNewChatHarnessUi(resolvedHarness);
    return Promise.resolve();
  }
  const inFlight = newChatHarnessStatusTracker.getInFlight(resolvedHarness);
  if (inFlight) return inFlight;
  const token = beginNewChatHarnessStatusCheck(resolvedHarness);
  const refreshStatus = NEW_CHAT_STATUS_REFRESHERS[resolvedHarness] || NEW_CHAT_STATUS_REFRESHERS.sdk;
  const refreshPromise = refreshStatus(options, token);
  /** @type {Promise<unknown>} */
  const tracked = Promise.resolve(refreshPromise).finally(() => {
    newChatHarnessStatusTracker.clearInFlight(resolvedHarness, tracked);
    syncNewChatAgentModelPicker();
    if (resolvedHarness === getSelectedNewChatHarness()) {
      syncNewChatHarnessUi();
      syncNewChatAgentModelPicker();
    }
  });
  newChatHarnessStatusTracker.setInFlight(resolvedHarness, tracked);
  return tracked;
}

export function refreshNewChatHarnessStatus(options = {}) {
  const harness = getSelectedNewChatHarness();
  if (localChatHarnessIds.has(harness)) {
    // Bypass the per-harness status tracker and model picker: a local id must
    // never be conflated with the SDK selection key, and its readiness is
    // decided by the server at create time.
    syncNewChatHarnessUi(harness);
    return Promise.resolve();
  }
  // Mirror the cached readiness first so a harness switch cannot keep a stale hint/button.
  syncNewChatHarnessUi(harness);
  chatRuntime.chatModelSelectApi.refreshNewChatModelPicker(harness, {
    forceCloseDropdown: options.forceCloseDropdown === true,
  });
  if (!options.force && newChatHarnessStatusTracker.isSelectionSettled(harness)) {
    return newChatHarnessStatusTracker.getInFlight(harness) || Promise.resolve();
  }
  newChatHarnessStatusTracker.markSelectionSettled(harness);
  return runNewChatHarnessStatusCheck(harness, options);
}

export function refreshModelCatalogFromServer() {
  return api
    .getAgentSdkStatus()
    .then((r) => {
      const changed = chatRuntime.chatModelSelectApi.applyAvailableModelsFromSdkStatus(r);
      if (changed) chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
      setNewChatHarnessReadyCache('sdk', !!(r && r.ok && r.ready));
    })
    .catch(() => {});
}

export function applyNewChatModalForkLabels() {
  const heading = document.getElementById('chat-new-heading');
  const createBtn = document.getElementById('chat-new-create');
  let headingText = t('chat.new');
  let createText = t('chat.create');
  if (newChatModalState.monitorSourceChatId) {
    headingText = t('chat.monitorHeading');
    createText = t('chat.monitorCreate');
  } else if (newChatModalState.passMessageSourceChatId) {
    headingText = t('chat.passMessageHeading');
    const parent = getNewChatModalSourceChat();
    createText = readDelegationExecutionMode(parent) === 'agent' && String(parent?.sdkMode || '') === 'plan'
      ? t('chat.passMessageCreateAgent')
      : t('chat.passMessageCreate');
  } else if (newChatModalState.buildPlanSourceChatId) {
    headingText = t('chat.buildPlanHeading');
    const parent = getNewChatModalSourceChat();
    createText = readDelegationExecutionMode(parent) === 'agent' && String(parent?.sdkMode || '') === 'plan'
      ? t('chat.buildPlanCreateAgent')
      : t('chat.buildPlanCreate');
  } else if (newChatModalState.forkSourceChatId) {
    headingText = newChatModalState.forkUpToCreatedAt ? t('chat.forkFromMessageHeading') : t('chat.forkHeading');
    createText = t('chat.forkCreate');
  }
  if (heading) heading.textContent = headingText;
  // Never overwrite the in-flight “Creating…” label with a mode label; the busy
  // state restores the original label when the request settles.
  if (createBtn && createBtn.getAttribute('aria-busy') !== 'true') createBtn.textContent = createText;
}

export function getNewChatModalSourceChat() {
  const id = newChatModalState.monitorSourceChatId || newChatModalState.passMessageSourceChatId || newChatModalState.buildPlanSourceChatId || newChatModalState.forkSourceChatId;
  if (!id) return null;
  return chats.find((entry) => entry.id === id) || null;
}

/**
 * Apply a server/default harness after the modal is already open.
 *
 * Only runs while the user has not made (or inherited) an explicit harness choice. When the
 * select actually changes, the tracker selection is advanced so the previous token no longer
 * drives the UI, and the newly selected harness is checked immediately — a late default must
 * never leave Create disabled without a request for that harness.
 */
export function applyLateDefaultNewChatHarness() {
  if (newChatModalState.newChatHarnessUserTouched || newChatModalState.newChatHarnessExplicitChoice) return;
  if (!newChatModalState.chatNewModalApi?.isOpen?.()) return;
  const before = getSelectedNewChatHarness();
  applyDefaultNewChatHarnessToModal();
  const after = getSelectedNewChatHarness();
  if (after === before) {
    syncNewChatHarnessUi(after);
    return;
  }
  if (!localChatHarnessIds.has(after)) newChatHarnessStatusTracker.selectHarness(after);
  syncNewChatHarnessUi(after);
  void refreshNewChatHarnessStatus({ force: true });
}
