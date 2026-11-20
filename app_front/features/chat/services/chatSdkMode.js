/** SDK mode bar, mode/model changes and plan approval. */
import * as api from '../../../core/api/index.js';
import { readLastDelegationExecutor, startDelegationFromParent } from '../chatDelegations.js';
import { isActiveDelegationStatus } from '../../../../lib/delegation-status.js';
import { isReviewDelegationRow } from '../../../../lib/delegation-width.js';
import { t } from '../../../i18n/index.js';
import { openNewChatModal } from '../views/newChatModal.js';
import { normalizeNewChatHarness, localChatHarnessIds, syncSdkModeBarPicker, loadNewChatModelCatalogs } from './newChatHarnessState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { getEnabledHarnessIds } from '../../settings/models/harnessSettings.js';
import { buildApprovedPlanImplementPrompt } from '../../../../lib/chat-plan-path.js';
import { beginPendingHarnessSwitch, clearPendingHarnessSwitch, isPendingHarnessSwitch, loadModelsForPendingHarness } from './harnessModelCatalog.js';
import { switchChatHarnessInWidget } from './harnessSwitch.js';
import { decodeNewChatModelChoice } from '../newChatModelOptions.js';
import { openChatContextDetailsModal } from '../views/chatContextDetails.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { normalizeModelValue, saveLastSelectedModel } from '../chatSettingsPrefs.js';
import { buildHarnessLaunchLabel } from '../sdk-transport-labels.js';
import { appLogger } from '../../../core/logging/logger.js';
import { stripAnsi } from '../chatTitleParsing.js';
import { sendTextToAgent, syncChatTodoChip } from './chatComposer.js';
import { notifySidebar } from './chatSidebarHooks.js';
import { adoptCreatedChat } from './chatCreation.js';
import { processAgentOutput } from './chatTitlesOutput.js';
import { forceReconnectChat } from './chatContextCompression.js';
import { chatHost } from './chatHost.js';

/**
 * Persist an approved plan to the linked Todo when present.
 * Best-effort: implementation can still proceed if sync fails.
 *
 * @param {object} chat
 * @returns {Promise<void>}
 */
export async function approveChatPlan(chat) {
  if (!chat?.id) return;
  try {
    const data = await api.postChatSyncTodoPlan(chat.id, { approved: true });
    const nextTodoId = typeof data?.chat?.todoId === 'string' ? data.chat.todoId.trim() : '';
    if (nextTodoId) {
      chat.todoId = nextTodoId;
      syncChatTodoChip(chat);
    }
  } catch {
    // Plan sync is best-effort; implementation can still proceed.
  }
}

/**
 * @param {object} chat
 * @param {string} extraInstructions
 */
export async function handleExecuteDelegationCommand(chat, extraInstructions) {
  if (!chat?.id) return;
  try {
    const listed = await api.getChatDelegations(chat.id);
    const activeRows = Array.isArray(listed?.delegations)
      ? listed.delegations.filter((row) => {
        if (row?.active === true) return true;
        return isActiveDelegationStatus(row?.status);
      })
      : [];
    const mutatingActive = activeRows.some((row) => !isReviewDelegationRow(row));
    if (mutatingActive) {
      chat._sdkRichView?.appendMetaNotice?.(t('chat.delegationAlreadyActive'));
      return;
    }
  } catch {
    // listing is best-effort; start may still succeed
  }
  const saved = readLastDelegationExecutor();
  if (!saved.harness || !saved.model) {
    await approveChatPlan(chat);
    openNewChatModal({
      buildPlanFromChatId: chat.id,
      workspaceFile: chat.workspaceFile,
      workspaceFolder: chat.workspaceFolder,
    });
    return;
  }
  await approveChatPlan(chat);
  const result = await startDelegationFromParent(chat, {
    harness: saved.harness,
    model: saved.model,
    extraInstructions,
  });
  if (!result?.ok) {
    if (result?.code === 'plan_missing') {
      alert(result.error || t('chat.delegationNoPlan'));
      return;
    }
    if (result?.code === 'plan_revision_conflict' || !saved.harness) {
      openNewChatModal({
        buildPlanFromChatId: chat.id,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
      return;
    }
    alert(result?.error || t('chat.delegationStartFailed'));
    return;
  }
  if (result.chat?.id) {
    result.chat.agentTransport = normalizeNewChatHarness(result.chat.agentTransport || saved.harness);
    result.chat.sdkMode = 'agent';
    adoptCreatedChat(result.chat);
  }
  notifySidebar();
}

export function getSharedSdkModeBar() {
  if (chatRuntime.sharedSdkModeBar) return chatRuntime.sharedSdkModeBar;
  const bar = document.createElement('cr-sdk-mode-bar');
  bar.addEventListener('cr-sdk-mode-change', (event) => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat) return;
    const nextMode = event?.detail?.mode;
    void setChatSdkMode(chat, nextMode);
  });
  bar.addEventListener('cr-sdk-build-plan', () => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat) return;
    void (async () => {
      await approveChatPlan(chat);
      await setChatSdkMode(chat, 'agent');
      sendTextToAgent(chat, buildApprovedPlanImplementPrompt(chat.id), {
        sdkMode: 'agent',
        displayText: t('chat.buildPlanDisplayText'),
      });
    })();
  });
  bar.addEventListener('cr-sdk-build-plan-new-agent', () => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat?.id) return;
    void (async () => {
      await approveChatPlan(chat);
      openNewChatModal({
        buildPlanFromChatId: chat.id,
        workspaceFile: chat.workspaceFile,
        workspaceFolder: chat.workspaceFolder,
      });
    })();
  });
  bar.addEventListener('cr-sdk-model-change', (event) => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat) return;
    const nextModel = event?.detail?.model;
    void setChatModel(chat, nextModel);
  });
  bar.addEventListener('cr-sdk-harness-intent', (event) => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat) return;
    beginPendingHarnessSwitch(chat, event?.detail?.harness);
  });
  bar.addEventListener('cr-sdk-harness-cancel', () => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat) return;
    clearPendingHarnessSwitch(chat);
  });
  bar.addEventListener('cr-sdk-harness-commit', (event) => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat) return;
    void switchChatHarnessInWidget(chat, event?.detail?.harness, event?.detail?.model);
  });
  bar.addEventListener('cr-sdk-favorite-toggle', (event) => {
    const choice = decodeNewChatModelChoice(event.detail?.value);
    if (!choice?.model || localChatHarnessIds.has(choice.harness)) return;
    chatHost.chatPresets.toggleFavorite(choice);
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    syncSdkModeBarPicker(bar, chat);
  });
  bar.addEventListener('cr-sdk-picker-open', () => {
    void loadNewChatModelCatalogs({ fromToolbar: true });
  });
  bar.addEventListener('cr-context-details-open', () => {
    const chat = chatRuntime.activeChatId ? chats.find((c) => c.id === chatRuntime.activeChatId) : null;
    if (!chat) return;
    openChatContextDetailsModal(chat);
  });
  bar.enabledHarnesses = getEnabledHarnessIds();
  chatRuntime.sharedSdkModeBar = bar;
  return bar;
}

export function mountSdkModeBarInToolbar() {
  const toolbar = document.querySelector('.chat-fullscreen-bar');
  if (!toolbar) return;
  const bar = getSharedSdkModeBar();
  const moreActionsBtn = toolbar.querySelector('#chat-toolbar-more-btn');
  if (bar.parentNode === toolbar) {
    if (!moreActionsBtn) return;
    if (bar.nextElementSibling === moreActionsBtn) return;
    toolbar.insertBefore(bar, moreActionsBtn);
    return;
  }
  if (!moreActionsBtn) {
    toolbar.appendChild(bar);
    return;
  }
  toolbar.insertBefore(bar, moreActionsBtn);
}

export function bindChatToSharedSdkModeBar(chat) {
  if (!chat) return;
  const bar = getSharedSdkModeBar();
  chat.sdkModeBarEl = bar;
  if (!chat.sdkMode) chat.sdkMode = 'agent';
  mountSdkModeBarInToolbar();
  syncChatSdkModeUi(chat);
}

export function syncChatSdkModeUi(chat) {
  const bar = chat?.sdkModeBarEl;
  if (!bar) return;
  if (chat.id !== chatRuntime.activeChatId) return;
  bar.activeChatId = chat.id;
  const mode = normalizeSdkMode(chat?.sdkMode);
  bar.mode = mode;
  bar.showBuild = mode === 'plan';
  if (isPendingHarnessSwitch(bar, chat)) {
    loadModelsForPendingHarness(bar, bar.pendingHarness, false);
    return;
  }
  bar.pendingHarness = '';
  bar.model = normalizeModelValue(chat?.model || bar.model || 'auto');
  bar.harness = normalizeNewChatHarness(chat?.agentTransport || 'sdk');
  chatRuntime.chatDiagnosticsApi?.updateChatContextMeter?.(
    chat,
    chatRuntime.chatDiagnosticsApi.resolveContextMeterModelId(chat, chat?.model || bar.model || 'auto'),
  );
  chatRuntime.chatModelSelectApi.setModelPickerHarness(normalizeNewChatHarness(chat?.agentTransport));
  bar.models = chatRuntime.chatModelSelectApi.getSdkModeBarModelOptions();
  syncSdkModeBarPicker(bar, chat);
}

export function sdkModeLaunchCommand(chat, mode) {
  const normalized = normalizeSdkMode(mode);
  const sessionRef =
    (chat?.cursorSessionId && String(chat.cursorSessionId).slice(0, 8)) ||
    (chat?.id && String(chat.id).slice(0, 8)) ||
    '?';
  return buildHarnessLaunchLabel({
    transport: chat?.agentTransport,
    mode: normalized,
    sessionRef,
  });
}

/**
 * Voice tools and other callers switch Plan/Agent on the active chat.
 * @param {unknown} mode
 * @returns {Promise<{ ok: boolean, mode?: string, error?: string }>}
 */
export async function setActiveChatSdkMode(mode) {
  const normalized = mode === 'plan' || mode === 'agent' || mode === 'ask' ? mode : '';
  if (!normalized) return { ok: false, error: 'Mode must be plan, agent, or ask' };
  const chat = chatRuntime.activeChatId ? chats.find((item) => item.id === chatRuntime.activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  await setChatSdkMode(chat, normalized);
  return { ok: true, mode: normalizeSdkMode(chat.sdkMode) };
}

export async function setChatSdkMode(chat, mode) {
  if (!chat) return;
  const normalized = normalizeSdkMode(mode);
  if (chat.sdkMode === normalized) {
    syncChatSdkModeUi(chat);
    return;
  }
  chat.sdkMode = normalized;
  chat._sdkModeUserSetAt = Date.now();
  syncChatSdkModeUi(chat);
  chatHost.setLaunchCommand(chat, sdkModeLaunchCommand(chat, normalized), '');
  if (chat._sdkRichView) {
    chat._sdkRichView.appendModeChange(normalized);
  }
  if (chat.ws?.readyState === WebSocket.OPEN) {
    chat.ws.send(JSON.stringify({ type: 'setSdkMode', mode: normalized }));
  }
  try {
    await api.patchChat(chat.id, { sdkMode: normalized });
  } catch (_) {}
}

export async function setChatModel(chat, model) {
  if (!chat) return false;
  const nextModel = normalizeModelValue(model);
  const prevModel = normalizeModelValue(chat.model || 'auto');
  if (nextModel === prevModel) {
    syncChatSdkModeUi(chat);
    return true;
  }
  appLogger.log('api-request', 'PATCH /api/chats/' + chat.id + ' (model)', { model: nextModel });
  let data = null;
  try {
    data = await api.patchChat(chat.id, { model: nextModel });
  } catch (err) {
    appLogger.log('api-error', 'PATCH /api/chats/' + chat.id + ' (model)', String(err));
    syncChatSdkModeUi(chat);
    return false;
  }
  appLogger.log('api-response', 'PATCH /api/chats/' + chat.id + ' (model)', data);
  if (!data?.ok) {
    syncChatSdkModeUi(chat);
    return false;
  }
  chat.model = nextModel;
  chatRuntime.selectedModel = nextModel;
  saveLastSelectedModel(nextModel);
  chat._pendingModelChange = {
    requestedModel: nextModel,
    requestedAt: Date.now(),
  };
  const line = `\r\n\x1b[33m${t('chat.modelChangeNotice', { model: nextModel })}\x1b[0m\r\n`;
  processAgentOutput(chat, line);
  if (chat._sdkRichView) {
    chat._sdkRichView.appendMetaNotice(stripAnsi(line).trim());
  }
  delete chat._sdkWarmupRequestedForStream;
  forceReconnectChat(chat);
  chatRuntime.chatModelSelectApi.refreshModelSelectLabels();
  return true;
}

export function onChatSdkModeChange(chat, mode) {
  if (!chat) return;
  chat.sdkMode = normalizeSdkMode(mode);
  syncChatSdkModeUi(chat);
}
