/** Voice-assistant chat actions: models, harness switch, fork. */
import * as api from '../../../core/api/index.js';
import { isHarnessEnabledInSettings, getEnabledHarnessIds } from '../../settings/models/harnessSettings.js';
import { AGENT_TRANSPORTS } from '../../../../lib/agent-transport.js';
import { t } from '../../../i18n/index.js';
import { normalizeSdkMode } from '../../../../lib/sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../../../../lib/sdk/sdk-ui-mode.ts';
import { flushPendingPush } from '../../../lib/sdk-chat-history-store.js';
import { normalizeModelValue } from '../chatSettingsPrefs.js';
import { executeHarnessSwitch, readChatTranscriptForHandoff } from './harnessSwitch.js';
import { normalizeNewChatHarness, readHarnessReady } from './newChatHarnessState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatHost } from './chatHost.js';

function isVoiceHarnessUsable(harness) {
  if (!isHarnessEnabledInSettings(harness)) return false;
  return readHarnessReady(harness) !== false;
}

function listReadyVoiceHarnesses() {
  return getEnabledHarnessIds().filter((id) => isVoiceHarnessUsable(id));
}

function isVoiceToolConfirm(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * @param {object} chat
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForVoiceModelCatalog(chat, timeoutMs = 8000) {
  if (!chat || !chatRuntime.chatModelSelectApi) return false;
  const harness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    chatRuntime.chatModelSelectApi.setModelPickerHarness(harness);
    const models = chatRuntime.chatModelSelectApi.getSdkModeBarModelOptions();
    if (models.length > 0) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  chatRuntime.chatModelSelectApi.setModelPickerHarness(harness);
  return chatRuntime.chatModelSelectApi.getSdkModeBarModelOptions().length > 0;
}

/**
 * @param {object} chat
 * @param {{ timeoutMs?: number, waitForAgentIdle?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function waitForVoiceChatReady(chat, options = {}) {
  if (!chat) return false;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 15000;
  const waitForAgentIdle = options.waitForAgentIdle !== false;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const connected = chat.ws?.readyState === WebSocket.OPEN;
    const connecting = chat._connectionStatus === 'connecting' || chat._connectionStatus === 'reconnecting';
    if (connected && !connecting) {
      if (!waitForAgentIdle) return true;
      if (chatHost.getChatListAgentState(chat) !== 'active') return true;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  const connected = chat.ws?.readyState === WebSocket.OPEN;
  if (!connected) return false;
  if (!waitForAgentIdle) return true;
  return chatHost.getChatListAgentState(chat) !== 'active';
}

/**
 * @returns {Promise<{ ok: boolean, harness?: string, current?: string, models?: Array<{ id: string, label: string, active: boolean }>, error?: string }>}
 */
export async function listVoiceModels() {
  const chat = chatRuntime.activeChatId ? chats.find((entry) => entry.id === chatRuntime.activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  if (!chatRuntime.chatModelSelectApi) return { ok: false, error: 'Model list is not available' };
  const harness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (!isHarnessEnabledInSettings(harness)) {
    return {
      ok: true,
      harness,
      current: normalizeModelValue(chat.model || 'auto'),
      models: [],
      harnessEnabled: false,
      hint: 'This harness is disabled in settings. Enable it to offer its models.',
    };
  }
  chatRuntime.chatModelSelectApi.setModelPickerHarness(harness);
  let models = chatRuntime.chatModelSelectApi.getSdkModeBarModelOptions();
  if (models.length === 0) {
    const ready = await waitForVoiceModelCatalog(chat, 8000);
    if (!ready) return { ok: false, error: 'Model list is still loading — try again in a moment' };
    models = chatRuntime.chatModelSelectApi.getSdkModeBarModelOptions();
  }
  const current = normalizeModelValue(chat.model || 'auto');
  return {
    ok: true,
    harness,
    current,
    models: models.map((model) => ({
      id: model.value,
      label: String(model.label || model.value || '').trim() || model.value,
      active: model.value === current,
    })),
    harnessEnabled: true,
  };
}

/**
 * @param {{ model?: string }} [options]
 * @returns {Promise<object>}
 */
export async function setVoiceChatModel(options = {}) {
  const model = String(options.model || '').trim();
  if (!model) return { ok: false, error: 'Missing model' };
  const chat = chatRuntime.activeChatId ? chats.find((entry) => entry.id === chatRuntime.activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  if (!chatRuntime.chatModelSelectApi) return { ok: false, error: 'Model switch is not available' };
  const harness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  chatRuntime.chatModelSelectApi.setModelPickerHarness(harness);
  if (chatRuntime.chatModelSelectApi.getSdkModeBarModelOptions().length === 0) {
    const catalogReady = await waitForVoiceModelCatalog(chat, 10000);
    if (!catalogReady) {
      return { ok: false, error: 'Model list is still loading — try again in a moment' };
    }
  }
  const ready = await waitForVoiceChatReady(chat, { timeoutMs: 12000, waitForAgentIdle: true });
  if (!ready) {
    if (chat.ws?.readyState !== WebSocket.OPEN) {
      return { ok: false, error: 'Chat is still connecting — try again in a moment' };
    }
    if (chatHost.getChatListAgentState(chat) === 'active') {
      return { ok: false, error: 'Agent is still working — stop the run first or wait a moment' };
    }
  }
  const changed = await chatHost.setChatModel(chat, model);
  if (!changed) return { ok: false, error: 'Could not change the model' };
  return {
    ok: true,
    model: normalizeModelValue(chat.model || model),
    harness,
  };
}

/**
 * @param {{
 *   harness?: string,
 *   confirm?: boolean,
 *   handoff?: unknown,
 *   keep_old?: unknown,
 * }} [options]
 * @returns {Promise<object>}
 */
export async function switchVoiceHarness(options = {}) {
  const nextHarness = String(options.harness || '').trim().toLowerCase();
  if (!AGENT_TRANSPORTS.includes(nextHarness)) {
    return {
      ok: false,
      error: 'Unknown harness. Try cursor, opencode, openrouter, codebuddy, deepseek, mistral, zai, mimo, codex, qwen, claude.',
      harnesses: listReadyVoiceHarnesses(),
    };
  }
  const chat = chatRuntime.activeChatId ? chats.find((entry) => entry.id === chatRuntime.activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  const currentHarness = normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (nextHarness === currentHarness) {
    return { ok: true, harness: nextHarness, unchanged: true };
  }
  if (!isVoiceHarnessUsable(nextHarness)) {
    return {
      ok: false,
      error: `Harness ${nextHarness} is not ready`,
      harnesses: listReadyVoiceHarnesses(),
    };
  }
  const keepOld = isVoiceToolConfirm(options.keep_old);
  const includeContext = options.handoff !== false && options.handoff !== 'false';
  if (!isVoiceToolConfirm(options.confirm)) {
    return {
      ok: false,
      needsConfirm: true,
      from: currentHarness,
      to: nextHarness,
      keepOld,
      handoff: includeContext,
      error: keepOld
        ? `Confirm switch from ${currentHarness} to ${nextHarness}. The current chat stays open. Call switch_harness again with confirm=true.`
        : `Confirm switch from ${currentHarness} to ${nextHarness}. The current chat will be archived. Call switch_harness again with confirm=true.`,
    };
  }
  if (chatRuntime.switchHarnessInFlight) return { ok: false, error: 'A harness switch is already in progress' };
  const nextModel = normalizeModelValue(chat.model || chatRuntime.selectedModel || 'auto');
  chatRuntime.switchHarnessInFlight = true;
  try {
    const result = await executeHarnessSwitch(chat, nextHarness, nextModel, {
      action: keepOld ? 'keep' : 'archive',
      includeContext,
    });
    return result;
  } finally {
    chatRuntime.switchHarnessInFlight = false;
    chatRuntime.pendingWidgetHarnessSwitch = null;
    if (chatRuntime.sharedSdkModeBar) chatRuntime.sharedSdkModeBar.pendingHarness = '';
  }
}

/**
 * @param {{ title?: string, harness?: string }} [options]
 * @returns {Promise<object>}
 */
export async function forkVoiceChat(options = {}) {
  const chat = chatRuntime.activeChatId ? chats.find((entry) => entry.id === chatRuntime.activeChatId) : null;
  if (!chat) return { ok: false, error: 'No chat is open' };
  const historySynced = await flushPendingPush(chat.id, chat.cursorSessionId || '');
  if (!historySynced) return { ok: false, error: 'Could not sync chat history' };
  const sourceText = await readChatTranscriptForHandoff(chat);
  const nextHarness = String(options.harness || '').trim()
    ? normalizeNewChatHarness(options.harness)
    : normalizeNewChatHarness(chat.agentTransport || 'sdk');
  if (!isHarnessEnabledInSettings(nextHarness)) {
    return { ok: false, error: `Harness ${nextHarness} is disabled in settings` };
  }
  const title = String(options.title || '').trim();
  const payload = {
    sourceText,
    agentTransport: nextHarness,
    model: normalizeModelValue(chat.model || chatRuntime.selectedModel || 'auto'),
    workspaceFile: chat.workspaceFile,
    workspaceFolder: chat.workspaceFolder,
  };
  if (title) payload.title = title;
  let data;
  try {
    data = await api.postChatFork(chat.id, payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!data?.ok || !data.chat?.id) {
    return { ok: false, error: data?.error || 'Could not fork the chat' };
  }
  const created = data.chat;
  created.agentTransport = normalizeNewChatHarness(created.agentTransport || nextHarness);
  created.sdkMode = normalizeSdkMode(created.sdkMode);
  created.sdkUiMode = normalizeSdkUiMode(created.sdkUiMode);
  created.workspaceFile ||= chat.workspaceFile;
  created.workspaceFolder ||= chat.workspaceFolder;
  const sameHarness =
    normalizeNewChatHarness(chat.agentTransport || 'sdk') === created.agentTransport;
  const displayText = sameHarness
    ? t('chat.forkContinueDisplayText')
    : t('chat.harnessHandoffDisplayText');
  chatHost.openCreatedForkChat(created, data.initialPrompt || '', displayText);
  chatHost.notifySidebar();
  return {
    ok: true,
    chatId: created.id,
    title: String(created.title || title || '').trim() || 'untitled',
    harness: nextHarness,
  };
}
