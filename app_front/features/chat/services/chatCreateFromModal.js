/** Chat creation from the new-chat modal (plain, fork, build-plan). */
import { normalizeNewChatHarness, getSelectedNewChatHarness, syncNewChatHarnessUi, setNewChatCreateBusy, isEmbedWidgetMode } from './newChatHarnessState.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../../../../lib/sdk/sdk-ui-mode.ts';
import { t } from '../../../i18n/index.js';
import { closeNewChatModal, readTodoPlanReviewerCooperationModeFromModal } from '../views/newChatModal.js';
import { flushPendingPush } from '../../../lib/sdk-chat-history-store.js';
import { readChatTranscriptForHandoff } from './harnessSwitch.js';
import * as api from '../../../core/api/index.js';
import { startDelegationFromParent, getDelegationApprovedPlanRevision, readDelegationPreviewExtra, readDelegationExecutionMode } from '../chatDelegations.js';
import { newChatModalState } from '../state/newChatModalState.js';
import { normalizeModelValue, saveLastSelectedModel, saveLastSelectedHarness } from '../chatSettingsPrefs.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { resolveNewChatWorktreeTodoId } from './newChatLocation.js';
import { adoptCreatedChat, attachWidgetHostPinToCreatePayload, openCreatedForkChat, pinCreatedChatToHostIfWidget } from './chatCreation.js';
import { notifyWidgetParentPagePinChanged, syncWidgetPinUrlUi } from './chatWidgetPin.js';
import { notifySidebar } from './chatSidebarHooks.js';
import { resolveChatCreationWorkspaceContext } from './chatWorkspaceContext.js';
import { chatHost } from './chatHost.js';

/**
 * Create a conversation fork or an agent-analysis sub-chat from the new-chat modal.
 *
 * @param {object} parentChat
 * @param {{
 *   title: string,
 *   harness: string,
 *   model: string,
 *   workspaceFile: string,
 *   workspaceFolder: string,
 *   message?: string,
 *   displayText?: string,
 *   analyze?: boolean,
 *   upToCreatedAt?: string,
 * }} values
 * @returns {Promise<void>}
 */
export async function createForkChatFromModal(parentChat, values) {
  const analyze = values.analyze === true;
  const cutPoint = typeof values.upToCreatedAt === 'string' ? values.upToCreatedAt.trim() : '';
  if (!analyze) {
    const historySynced = await flushPendingPush(
      parentChat.id,
      parentChat.cursorSessionId || ''
    );
    if (!historySynced) {
      alert(t('sendBar.forkSyncFailed'));
      return;
    }
  }
  const workspaceFile = values.workspaceFile || parentChat.workspaceFile;
  const workspaceFolder = values.workspaceFolder || parentChat.workspaceFolder;
  const payload = {
    agentTransport: values.harness,
    model: values.model,
    workspaceFile,
    workspaceFolder,
  };
  if (!analyze && cutPoint) payload.upToCreatedAt = cutPoint;
  if (!analyze && !cutPoint) {
    payload.sourceText = await readChatTranscriptForHandoff(parentChat);
  }
  if (values.title) payload.title = values.title;
  if (values.message) payload.message = values.message;
  if (analyze) payload.analyze = true;
  let data;
  try {
    data = await api.postChatFork(parentChat.id, payload);
  } catch (_) {
    alert(t('chat.serverConnectionError'));
    return;
  }
  if (!data?.ok || !data.chat) {
    alert(data?.error || t('chat.createFailed', { detail: t('chat.unknownError') }));
    return;
  }
  const created = data.chat;
  created.agentTransport = normalizeNewChatHarness(created.agentTransport || values.harness);
  created.sdkMode = normalizeSdkMode(created.sdkMode);
  created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode);
  created.workspaceFile ||= workspaceFile;
  created.workspaceFolder ||= workspaceFolder;
  await pinCreatedChatToHostIfWidget(created);
  const sameHarness =
    normalizeNewChatHarness(parentChat.agentTransport || 'sdk') === created.agentTransport;
  const displayText =
    values.displayText ||
    (sameHarness ? t('chat.forkContinueDisplayText') : t('chat.harnessHandoffDisplayText'));
  const initialPrompt = data.initialPrompt || values.message || '';
  // Analysis sub-chats start empty. Keep only the parent reference as an
  // inherited instruction and send it together with the user's first message.
  const live = openCreatedForkChat(created, initialPrompt, analyze ? '' : displayText);
  syncWidgetPinUrlUi(live || created);
  notifyWidgetParentPagePinChanged();
  notifySidebar();
  closeNewChatModal();
}

/**
 * Create a fresh Agent chat that implements the approved plan from the source chat.
 *
 * @param {object} parentChat
 * @param {{
 *   title: string,
 *   harness: string,
 *   model: string,
 *   workspaceFile: string,
 *   workspaceFolder: string,
 * }} values
 * @returns {Promise<void>}
 */
export async function createBuildPlanChatFromModal(parentChat, values) {
  if (!parentChat?.id) return;
  const result = await startDelegationFromParent(parentChat, {
    title: values.title,
    harness: values.harness,
    model: values.model,
    planRevision: getDelegationApprovedPlanRevision(),
    extraInstructions: readDelegationPreviewExtra(),
    sourceKind: values.sourceKind,
    historySeq: values.historySeq,
    createdAt: values.createdAt,
    textSnapshot: values.textSnapshot,
    contentHash: values.contentHash,
    executionMode: values.executionMode || readDelegationExecutionMode(parentChat),
  });
  if (!result?.ok) {
    if (result?.code === 'plan_revision_conflict') {
      alert(result.error || t('chat.delegationPlanConflict'));
      return;
    }
    alert(result?.error || t('chat.createFailed', { detail: t('chat.unknownError') }));
    return;
  }
  const created = result.chat;
  if (created?.id) {
    created.agentTransport = normalizeNewChatHarness(created.agentTransport || values.harness);
    created.sdkMode = created.sdkMode || values.executionMode || 'agent';
    created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode || parentChat.sdkUiMode);
    adoptCreatedChat(created);
  }
  notifySidebar();
  closeNewChatModal();
}

/**
 * Create a new chat from the modal values (folder and model; workspace from context).
 */
export function createChatFromModal() {
  if (newChatModalState.chatCreateInFlight) return;
  const modelSel = document.getElementById('chat-new-model-select');
  const titleInput = document.getElementById('chat-new-title-input');
  const title = (titleInput?.value || '').trim();
  const chosenModel = normalizeModelValue(modelSel?.value);
  const harness = getSelectedNewChatHarness();
  syncNewChatHarnessUi(harness);
  const createBtn = document.getElementById('chat-new-create');
  if (createBtn?.disabled) {
    document.getElementById('chat-new-sdk-hint')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  chatRuntime.selectedModel = chosenModel;
  chatRuntime.selectedHarness = normalizeNewChatHarness(harness);
  saveLastSelectedModel(chosenModel);
  saveLastSelectedHarness(chatRuntime.selectedHarness);
  if (newChatModalState.todoAgentModalSubmit) {
    const submit = newChatModalState.todoAgentModalSubmit;
    const cooperationMode = newChatModalState.todoAgentModalPlanReviewerMode
      ? readTodoPlanReviewerCooperationModeFromModal()
      : undefined;
    newChatModalState.todoAgentModalSubmit = null;
    newChatModalState.todoAgentModalPlanReviewerMode = false;
    closeNewChatModal();
    void submit({
      harness: chatRuntime.selectedHarness,
      model: chosenModel,
      ...(cooperationMode ? { planReviewerCooperationMode: cooperationMode } : {}),
    });
    return;
  }
  chatHost.ensureEmbedNewChatFolderSelect();
  const createCtx = resolveChatCreationWorkspaceContext();
  if (!createCtx.workspaceFile) {
    alert(t('chat.noWorkspaceSelected'));
    return;
  }
  if (!createCtx.workspaceFolder) {
    if (isEmbedWidgetMode()) {
      alert(t('chat.widgetMissingWorkspaceFolder'));
    } else {
      alert(t('chat.selectFolderInNewChatForm'));
    }
    return;
  }
  const monitorParent = newChatModalState.monitorSourceChatId
    ? chats.find((entry) => entry.id === newChatModalState.monitorSourceChatId)
    : null;
  const forkParent = newChatModalState.forkSourceChatId
    ? chats.find((entry) => entry.id === newChatModalState.forkSourceChatId)
    : null;
  const sourceParent = monitorParent || forkParent;
  if (sourceParent?.id) {
    newChatModalState.chatCreateInFlight = true;
    setNewChatCreateBusy(true);
    const values = {
      title,
      harness,
      model: chosenModel,
      workspaceFile: createCtx.workspaceFile,
      workspaceFolder: createCtx.workspaceFolder,
    };
    if (forkParent?.id && newChatModalState.forkUpToCreatedAt) values.upToCreatedAt = newChatModalState.forkUpToCreatedAt;
    if (monitorParent?.id) {
      values.analyze = true;
      if (!values.title) {
        values.title = t('chat.monitorDefaultTitle', { title: monitorParent.title || 'Chat' });
      }
    }
    void createForkChatFromModal(sourceParent, values).finally(() => {
      newChatModalState.chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
    return;
  }
  const passMessageParent = newChatModalState.passMessageSourceChatId
    ? chats.find((entry) => entry.id === newChatModalState.passMessageSourceChatId)
    : null;
  if (passMessageParent?.id) {
    newChatModalState.chatCreateInFlight = true;
    setNewChatCreateBusy(true);
    const values = {
      title,
      harness,
      model: chosenModel,
      workspaceFile: createCtx.workspaceFile,
      workspaceFolder: createCtx.workspaceFolder,
      sourceKind: 'message',
      historySeq: newChatModalState.passMessageMeta.historySeq,
      createdAt: newChatModalState.passMessageMeta.createdAt,
      textSnapshot: newChatModalState.passMessageMeta.text,
      executionMode: readDelegationExecutionMode(passMessageParent),
    };
    if (!values.title) {
      values.title = t('chat.passMessageDefaultTitle', { title: passMessageParent.title || 'Chat' });
    }
    void createBuildPlanChatFromModal(passMessageParent, values).finally(() => {
      newChatModalState.chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
    return;
  }
  const buildPlanParent = newChatModalState.buildPlanSourceChatId
    ? chats.find((entry) => entry.id === newChatModalState.buildPlanSourceChatId)
    : null;
  if (buildPlanParent?.id) {
    newChatModalState.chatCreateInFlight = true;
    setNewChatCreateBusy(true);
    const values = {
      title,
      harness,
      model: chosenModel,
      workspaceFile: createCtx.workspaceFile,
      workspaceFolder: createCtx.workspaceFolder,
    };
    if (!values.title) {
      values.title = t('chat.buildPlanDefaultTitle', { title: buildPlanParent.title || 'Chat' });
    }
    void createBuildPlanChatFromModal(buildPlanParent, values).finally(() => {
      newChatModalState.chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
    return;
  }
  newChatModalState.chatCreateInFlight = true;
  setNewChatCreateBusy(true);
  const payload = {
    workspaceFile: createCtx.workspaceFile,
    workspaceFolder: createCtx.workspaceFolder,
    model: chosenModel,
    agentTransport: harness,
    sdkMode: 'agent',
    sdkUiMode: 'compact',
  };
  if (title) payload.title = title;
  const worktreeTodoId = resolveNewChatWorktreeTodoId();
  if (worktreeTodoId) payload.worktreeTodoId = worktreeTodoId;
  void attachWidgetHostPinToCreatePayload(payload)
    .then(() => api.postChat(payload))
    .then((data) => {
      if (!data.ok) {
        alert(t('chat.createFailed', { detail: data.error || t('chat.unknownError') }));
        return;
      }
      const chat = data.chat;
      chat.agentTransport = normalizeNewChatHarness(chat.agentTransport);
      chat.sdkMode = normalizeSdkMode(chat.sdkMode);
      chat.sdkUiMode = normalizeSdkUiMode(chat.sdkUiMode);
      if (typeof data.chat?.widgetPinnedUrl === 'string' && data.chat.widgetPinnedUrl.trim()) {
        chat.widgetPinnedUrl = data.chat.widgetPinnedUrl.trim();
      }
      const live = adoptCreatedChat(chat);
      syncWidgetPinUrlUi(live);
      notifyWidgetParentPagePinChanged();
      closeNewChatModal();
    })
    .catch(() => alert(t('chat.serverConnectionError')))
    .finally(() => {
      newChatModalState.chatCreateInFlight = false;
      setNewChatCreateBusy(false);
    });
}
