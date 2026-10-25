/** Harness picker state: pending switch, model catalogs for the shared SDK mode bar. */
import * as api from '../../../core/api/index.js';
import { getHarnessUiMeta } from '../../../core/harness/harnessUiRegistry.js';
import { normalizeNewChatHarness } from './newChatHarnessState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatHost } from './chatHost.js';

export function normalizeHarnessActionChoice(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'd' || raw === 'delete' || raw === 'remove') return 'delete';
  if (raw === 'k' || raw === 'keep' || raw === 'skip') return 'keep';
  return 'archive';
}

export function resolvePendingHarnessSwitch(bar, chat) {
  const fromBar = String(bar?.pendingHarness || '').trim();
  const fromState = chatRuntime.pendingWidgetHarnessSwitch?.chatId === chat?.id
    ? String(chatRuntime.pendingWidgetHarnessSwitch.harness || '').trim()
    : '';
  const pending = fromBar || fromState;
  if (!pending) return '';
  const nextHarness = normalizeNewChatHarness(pending);
  const currentHarness = normalizeNewChatHarness(chat?.agentTransport || 'sdk');
  if (nextHarness === currentHarness) return '';
  return nextHarness;
}

export function isPendingHarnessSwitch(bar, chat) {
  return resolvePendingHarnessSwitch(bar, chat) !== '';
}

export async function refreshSdkModeBarCombinedPicker(options = {}) {
  const bar = document.querySelector('cr-sdk-mode-bar');
  if (!bar) return;
  await bar.updateComplete;
  const picker = bar.shadowRoot?.querySelector('.combined-picker');
  picker?.refreshOptions?.();
  if (options.reopenDropdown === true) {
    picker?.openDropdown?.();
  }
}

export function resolveOpenCodeCatalogParamCandidates(chat = null) {
  const activeChat = chat || (chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null);
  const ctx = chatHost.getWorkspaceContextForChat();
  const seen = new Set();
  /** @type {Array<{ workspaceFolder?: string }>} */
  const candidates = [];
  const pushFolder = (folder) => {
    const trimmed = String(folder || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ workspaceFolder: trimmed });
  };
  pushFolder(chatRuntime.serverSettingsWorkspaceFolder);
  // Server default folder before embed/chat folders — OpenCode runs per folder and the
  // widget embed folder may not have a warm instance while the server workspace does.
  candidates.push({});
  pushFolder(activeChat?.workspaceFolder);
  pushFolder(ctx?.workspaceFolder);
  pushFolder(chatRuntime.selectedWorkspaceFolder);
  return candidates;
}

export function syncPendingHarnessBarModels(bar, harness) {
  if (!bar) return;
  const nextHarness = normalizeNewChatHarness(harness);
  chatRuntime.chatModelSelectApi.setModelPickerHarness(nextHarness);
  bar.models = chatRuntime.chatModelSelectApi.getSdkModeBarModelOptions();
}

export async function fetchOpenCodeModelsCatalog(chat = null) {
  const candidates = resolveOpenCodeCatalogParamCandidates(chat);
  let lastOk = null;
  let lastResult = null;
  for (const params of candidates) {
    try {
      const data = await api.getOpenCodeModels(params);
      lastResult = data;
      if (!data?.ok) continue;
      lastOk = data;
      if (Array.isArray(data.models) && data.models.length > 0) return data;
    } catch (err) {
      lastResult = { ok: false, error: err?.message || 'fetch failed' };
    }
  }
  return lastOk || lastResult;
}

export function loadModelsForPendingHarness(bar, harness, resetModel = true) {
  const nextHarness = normalizeNewChatHarness(harness);
  bar.pendingHarness = nextHarness;
  bar.pickerStep = 'model';
  if (resetModel) bar.model = '';
  syncPendingHarnessBarModels(bar, nextHarness);
  const catalogFetchAlreadyAttempted = bar._pendingModelCatalogFetchHarness === nextHarness;
  if (bar.models.length === 0 && !catalogFetchAlreadyAttempted) {
    bar._pendingModelCatalogFetchHarness = nextHarness;
    void refreshPendingHarnessModelCatalog(nextHarness);
  }
}

function refreshPendingHarnessModelCatalog(harness) {
  const nextHarness = normalizeNewChatHarness(harness);
  const syncLoadedModelsToModeBar = async () => {
    const bar = document.querySelector('cr-sdk-mode-bar');
    const pendingHarness = String(bar?.pendingHarness || '').trim();
    if (!bar || normalizeNewChatHarness(pendingHarness) !== nextHarness) return;
    syncPendingHarnessBarModels(bar, nextHarness);
    await refreshSdkModeBarCombinedPicker({
      reopenDropdown: bar.pickerStep === 'model',
    });
  };
  const harnessMeta = getHarnessUiMeta(nextHarness);
  if (harnessMeta?.scopedCatalogReload) {
    if (chatRuntime.pendingOpenCodeCatalogFetch) return chatRuntime.pendingOpenCodeCatalogFetch;
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    chatRuntime.pendingOpenCodeCatalogFetch = chatHost.reloadOpenCodeModelsCatalog(chat).finally(() => {
      chatRuntime.pendingOpenCodeCatalogFetch = null;
    });
    return chatRuntime.pendingOpenCodeCatalogFetch;
  }
  if (harnessMeta?.modelsApiMethod) {
    return api[harnessMeta.modelsApiMethod]().then((data) => {
      if (data?.ok) chatRuntime.chatModelSelectApi.applyAvailableModels(nextHarness, data);
      chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
      return syncLoadedModelsToModeBar();
    }).catch(() => {});
  }
  return chatHost.refreshModelCatalogFromServer().then(syncLoadedModelsToModeBar);
}

export function rememberPendingHarnessSwitch(chat, harness) {
  const nextHarness = normalizeNewChatHarness(harness);
  chatRuntime.pendingWidgetHarnessSwitch = chat?.id
    ? { chatId: chat.id, harness: nextHarness }
    : null;
}

export function beginPendingHarnessSwitch(chat, harness) {
  rememberPendingHarnessSwitch(chat, harness);
  const bar = chat?.sdkModeBarEl || chatRuntime.sharedSdkModeBar;
  if (bar) loadModelsForPendingHarness(bar, harness, true);
}

export function clearPendingHarnessSwitch(chat) {
  chatRuntime.pendingWidgetHarnessSwitch = null;
  const bar = chat?.sdkModeBarEl || chatRuntime.sharedSdkModeBar;
  if (bar) {
    bar.pendingHarness = '';
    bar.pickerStep = 'harness';
    delete bar._pendingModelCatalogFetchHarness;
  }
  if (chat) chatHost.syncChatSdkModeUi(chat);
}
