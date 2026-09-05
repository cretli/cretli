import { AUTO_TITLE_PROMPT, TITLE_FORK_PROMPT_MAX_CHARS, SUMMARY_FORK_TIMEOUT_MS } from '../../config.js';
import { stripAnsi } from './chatTitleParsing.js';
import { t } from '../../i18n/index.js';
import { SUMMARY_FORK_META_LINE_PATTERNS } from '../../../lib/notices.js';

export { SUMMARY_FORK_META_LINE_PATTERNS };
export const AUTO_TITLE_TIMEOUT_MS = 60000;
export const AUTO_TITLE_RESPONSE_AFTER_MS = 800;
export const PASSIVE_TITLE_DEDUP_MS = 15000;
export const TITLE_FORK_BUFFER_SLICE = 6000;
export const FORK_MIN_TEXT_LEN = 80;
export const TITLE_CALLBACK_POLL_INTERVAL_MS = 3000;
export const TITLE_CALLBACK_POLL_TIMEOUT_MS = 60000;
export const SUMMARY_CALLBACK_POLL_INTERVAL_MS = 3000;
export const SUMMARY_CALLBACK_POLL_TIMEOUT_MS = SUMMARY_FORK_TIMEOUT_MS;

/**
 * @typedef {Object} ChatTitleForkDeps
 * @property {typeof import('../../core/api/index.js')} api
 * @property {import('../../logger.js').AppLogger} appLogger
 * @property {() => string|null} getActiveChatId
 * @property {() => object[]} getChats
 * @property {(chat: object, text: string, opts?: object) => void} sendTextToAgent
 * @property {() => HTMLInputElement|null} getActiveSendInput
 * @property {(tag: string, ...args: unknown[]) => void} debugFork
 * @property {(tag: string, ...args: unknown[]) => void} debugAutoTitle
 * @property {() => object|null} getWorkspaceContextForChat
 * @property {(chatId: string) => string} readChatBufferFromLocalStorage
 * @property {() => void} renderChatList
 * @property {(tempChat: object, opts?: object) => void} openTemporaryForkChat
 * @property {(tempChatId?: string|null, parentChatId?: string|null) => void} dismissTemporaryForkChat
 */

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSummaryForkMetaOnlyText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) =>
    SUMMARY_FORK_META_LINE_PATTERNS.some((pattern) => pattern.test(line)),
  );
}

/**
 * @param {object|null|undefined} res
 * @returns {string}
 */
export function forkApiErrorMessage(res) {
  if (res && typeof res.error === 'string' && res.error.trim()) {
    return res.error.trim();
  }
  return t('chat.timeout');
}

/**
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateForPrompt(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  const half = Math.floor(maxLen / 2);
  return `${str.slice(0, half)}\n... [truncated] ...\n${str.slice(-half)}`;
}

/**
 * @param {ChatTitleForkDeps} deps
 */
export function createChatTitleFork(deps) {
  /**
   * @param {object} chat
   * @param {string} textForPrompt
   */
  function buildForkRequestPayload(chat, textForPrompt) {
    const ctx = deps.getWorkspaceContextForChat();
    const payload = { text: textForPrompt, chatId: chat.id };
    payload.workspaceFile = chat.workspaceFile || ctx?.workspaceFile || undefined;
    payload.workspaceFolder = chat.workspaceFolder || ctx?.workspaceFolder || undefined;
    if (chat.model) payload.model = chat.model;
    return payload;
  }

  /**
   * @param {object} chat
   * @returns {Promise<string>}
   */
  async function resolveChatTextForFork(chat) {
    if (!chat?.id) return '';
    let text = (chat._buffer || deps.readChatBufferFromLocalStorage(chat.id) || '').trim();
    if (text.length >= FORK_MIN_TEXT_LEN && !isSummaryForkMetaOnlyText(text)) {
      return text.slice(-TITLE_FORK_BUFFER_SLICE);
    }
    if (chat._sdkRichView && typeof chat._sdkRichView.getCopyText === 'function') {
      const fromView = stripAnsi(chat._sdkRichView.getCopyText()).trim();
      if (fromView.length > text.length) {
        text = fromView;
      }
    }
    if (text.length >= FORK_MIN_TEXT_LEN && !isSummaryForkMetaOnlyText(text)) {
      return text.slice(-TITLE_FORK_BUFFER_SLICE);
    }
    try {
      const response = await deps.api.getChatSdkMessages(chat.id, { limit: 200 });
      if (response?.ok && typeof response.formatted === 'string') {
        const fromApi = response.formatted.trim();
        if (fromApi.length > text.length) {
          text = fromApi;
        }
      }
    } catch (_) {}
    return text.slice(-TITLE_FORK_BUFFER_SLICE).trim();
  }

  /**
   * @param {object} chat
   * @param {(title: string|null, error?: string) => void} onDone
   * @param {string|null|undefined} tempChatId
   */
  function pollForChatTitleChange(chat, onDone, tempChatId) {
    const initialTitle = chat.title || '';
    const deadline = Date.now() + TITLE_CALLBACK_POLL_TIMEOUT_MS;
    deps.appLogger.log('fork-title', 'callback mode, polling for title change', { chatId: chat.id, tempChatId });
    function finish(result) {
      if (result !== null) {
        deps.dismissTemporaryForkChat(tempChatId, chat.id);
      }
      onDone(result);
    }
    function tick() {
      if (Date.now() >= deadline) {
        deps.appLogger.log('fork-title', 'callback polling timeout');
        finish(null);
        return;
      }
      deps.api.getChats().then((data) => {
        const list = data && data.chats ? data.chats : [];
        const entry = list.find((item) => item.id === chat.id);
        if (entry && entry.title && entry.title !== initialTitle) {
          chat.title = entry.title;
          deps.appLogger.log('chat-title', 'fork (agent callback):', entry.title);
          deps.renderChatList();
          finish(entry.title);
          return;
        }
        setTimeout(tick, TITLE_CALLBACK_POLL_INTERVAL_MS);
      }).catch(() => setTimeout(tick, TITLE_CALLBACK_POLL_INTERVAL_MS));
    }
    setTimeout(tick, TITLE_CALLBACK_POLL_INTERVAL_MS);
  }

  /**
   * @param {object} chat
   * @param {(result: { summary: string, title: string }|null, error?: string) => void} onDone
   * @param {string|null|undefined} tempChatId
   */
  function pollForChatSummaryChange(chat, onDone, tempChatId) {
    const initialTitle = chat.title || '';
    const initialSummaries = Array.isArray(chat.summaries) ? chat.summaries.length : 0;
    const deadline = Date.now() + SUMMARY_CALLBACK_POLL_TIMEOUT_MS;
    deps.appLogger.log('fork-summary', 'callback mode, polling for summary/title change', {
      chatId: chat.id,
      tempChatId,
    });
    function finish(result) {
      deps.dismissTemporaryForkChat(tempChatId, chat.id);
      onDone(result);
    }
    function tick() {
      if (Date.now() >= deadline) {
        deps.appLogger.log('fork-summary', 'callback polling timeout');
        finish(null);
        return;
      }
      deps.api.getChats().then((data) => {
        const list = data && data.chats ? data.chats : [];
        const entry = list.find((item) => item.id === chat.id);
        if (!entry) {
          setTimeout(tick, SUMMARY_CALLBACK_POLL_INTERVAL_MS);
          return;
        }
        const nextTitle = typeof entry.title === 'string' ? entry.title : '';
        const nextSummaries = Array.isArray(entry.summaries) ? entry.summaries : [];
        const summaryChanged = nextSummaries.length > initialSummaries;
        const titleChanged = !!nextTitle && nextTitle !== initialTitle;
        if (!summaryChanged && !titleChanged) {
          setTimeout(tick, SUMMARY_CALLBACK_POLL_INTERVAL_MS);
          return;
        }
        if (titleChanged) chat.title = nextTitle;
        chat.summaries = nextSummaries;
        deps.renderChatList();
        const latestSummary = summaryChanged ? nextSummaries[nextSummaries.length - 1] : null;
        finish({
          summary: latestSummary?.summary || '',
          title: titleChanged ? nextTitle : (latestSummary?.title || ''),
        });
      }).catch(() => setTimeout(tick, SUMMARY_CALLBACK_POLL_INTERVAL_MS));
    }
    setTimeout(tick, SUMMARY_CALLBACK_POLL_INTERVAL_MS);
  }

  /**
   * @param {object} chat
   * @param {(title: string|null, error?: string) => void} onDone
   * @param {(tempChat: object) => void} [onTempChat]
   */
  async function requestTitleFromFork(chat, onDone, onTempChat) {
    const text = await resolveChatTextForFork(chat);
    const textForPrompt = truncateForPrompt(text, TITLE_FORK_PROMPT_MAX_CHARS);
    deps.debugFork('title', 'start', { chatId: chat.id, textLen: text.length, promptLen: textForPrompt.length });
    deps.appLogger.log('fork-title', 'start', { chatId: chat.id, textLen: text.length, promptLen: textForPrompt.length });
    const payload = buildForkRequestPayload(chat, textForPrompt);
    deps.appLogger.log('api-request', 'POST /api/generate-chat-title', { textLen: textForPrompt.length, chatId: chat.id });
    try {
      const res = await deps.api.postGenerateChatTitle(payload);
      deps.appLogger.log('api-response', 'POST /api/generate-chat-title', res);
      if (res && res.ok && res.mode === 'tempChat' && res.tempChat) {
        deps.openTemporaryForkChat(res.tempChat, { initialPrompt: res.initialPrompt });
        if (typeof onTempChat === 'function') onTempChat(res.tempChat);
        pollForChatTitleChange(chat, (title) => onDone(title), res.tempChat.id);
        return;
      }
      if (res && res.ok && res.mode === 'callback') {
        pollForChatTitleChange(chat, (title) => onDone(title));
        return;
      }
      if (res && res.ok && res.title) {
        const titlePatch = { title: res.title };
        deps.appLogger.log('api-request', `PATCH /api/chats/${chat.id} (fork title)`, titlePatch);
        const patchRes = await deps.api.patchChat(chat.id, titlePatch);
        deps.appLogger.log('api-response', `PATCH /api/chats/${chat.id} (fork title)`, patchRes);
        if (patchRes && patchRes.ok) {
          chat.title = res.title;
          deps.appLogger.log('chat-title', 'fork (generated from content):', res.title);
          deps.renderChatList();
          onDone(res.title);
          return;
        }
        onDone(null, forkApiErrorMessage(patchRes));
        return;
      }
      onDone(null, forkApiErrorMessage(res));
    } catch (err) {
      deps.appLogger.log('api-error', 'POST /api/generate-chat-title', String(err));
      onDone(null, t('chat.networkErrorFork'));
    }
  }

  /**
   * @param {object} chat
   * @param {(result: { summary: string, title: string }|null, error?: string) => void} onDone
   * @param {(tempChat: object) => void} [onTempChat]
   */
  async function requestSummaryFromFork(chat, onDone, onTempChat) {
    const text = '';
    deps.debugFork('summary', 'start', { chatId: chat.id, serverSideHistory: true });
    deps.appLogger.log('fork-summary', 'start', { chatId: chat.id, serverSideHistory: true });
    const payload = buildForkRequestPayload(chat, text);
    deps.appLogger.log('api-request', 'POST /api/generate-chat-summary', { chatId: chat.id, serverSideHistory: true });
    try {
      const res = await deps.api.postGenerateChatSummary(payload);
      deps.appLogger.log('api-response', 'POST /api/generate-chat-summary', res);
      if (res && res.ok && res.mode === 'tempChat' && res.tempChat) {
        deps.openTemporaryForkChat(res.tempChat, { initialPrompt: res.initialPrompt });
        if (typeof onTempChat === 'function') onTempChat(res.tempChat);
        pollForChatSummaryChange(chat, (result) => onDone(result), res.tempChat.id);
        return;
      }
      if (res && res.ok && res.mode === 'callback') {
        pollForChatSummaryChange(chat, (result) => onDone(result));
        return;
      }
      if (res && res.ok && (res.mode === 'print' || res.summary)) {
        const summary = typeof res.summary === 'string' ? res.summary.trim() : '';
        const title = typeof res.title === 'string' ? res.title.trim() : '';
        if (summary) {
          if (res.chat && Array.isArray(res.chat.summaries)) {
            chat.summaries = res.chat.summaries;
          } else {
            if (!Array.isArray(chat.summaries)) chat.summaries = [];
            chat.summaries.push({
              summary,
              title: title || undefined,
              at: new Date().toISOString(),
            });
          }
          if (title) chat.title = title;
          deps.renderChatList();
          deps.appLogger.log('fork-summary', 'print mode applied', { chatId: chat.id, summaryLen: summary.length });
          onDone({ summary, title });
          return;
        }
      }
      onDone(null, forkApiErrorMessage(res));
    } catch (err) {
      deps.appLogger.log('api-error', 'POST /api/generate-chat-summary', String(err));
      onDone(null, t('chat.networkErrorFork'));
    }
  }

  function requestAutoTitleFromAgent() {
    const activeChatId = deps.getActiveChatId();
    const chat = activeChatId ? deps.getChats().find((entry) => entry.id === activeChatId) : null;
    const hint = document.getElementById('chat-settings-update-title-hint');
    if (!chat) {
      if (hint) hint.textContent = t('chat.noActiveChat');
      return;
    }
    if (chat._autoTitleTimeout) {
      clearTimeout(chat._autoTitleTimeout);
      chat._autoTitleTimeout = null;
    }
    chat._pendingAutoTitle = true;
    chat._autoTitleBuffer = '';
    deps.debugAutoTitle('request', { chatId: chat.id, hasWs: !!chat.ws, wsReady: chat.ws?.readyState });
    const sendViaWs = () => {
      if (!chat.ws || chat.ws.readyState !== WebSocket.OPEN) return false;
      deps.sendTextToAgent(chat, AUTO_TITLE_PROMPT, { internal: true });
      chat._autoTitleRequestAt = Date.now();
      return true;
    };
    if (sendViaWs()) {
      if (hint) hint.textContent = t('chat.sent');
    } else {
      const input = deps.getActiveSendInput();
      if (input) {
        input.value = AUTO_TITLE_PROMPT;
        input.focus();
        const sendBtn = input.closest('.chat-tab-pane')?.querySelector('.send-keys-btn');
        if (sendBtn) sendBtn.click();
        if (hint) hint.textContent = t('chat.sentOrType');
      } else if (hint) {
        hint.textContent = t('chat.noConnection');
      }
    }
    chat._autoTitleTimeout = setTimeout(() => {
      deps.debugAutoTitle('timeout (button)', { chatId: chat.id, msg: 'expired - stop waiting for JSON' });
      chat._pendingAutoTitle = false;
      chat._autoTitleBuffer = '';
      chat._autoTitleTimeout = null;
      if (hint) hint.textContent = '';
    }, AUTO_TITLE_TIMEOUT_MS);
  }

  /**
   * @param {object} chat
   * @param {(tempChat: object) => void} [onTempChat]
   */
  function requestSummaryFromForkAsync(chat, onTempChat) {
    return new Promise((resolve) => {
      requestSummaryFromFork(
        chat,
        (result, error) => resolve({ result, error }),
        onTempChat,
      );
    });
  }

  return {
    requestTitleFromFork,
    requestSummaryFromFork,
    requestSummaryFromForkAsync,
    requestAutoTitleFromAgent,
    resolveChatTextForFork,
  };
}
