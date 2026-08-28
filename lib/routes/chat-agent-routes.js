import {
  loadChats,
  updateChat,
  getChatByCursorSessionId,
  createTemporaryForkChat,
  deleteTemporaryForkChats,
} from '../persist/chats-persist.js';
import { disposeSdkRoom } from '../sdk/cursor-agent-sdk-ws.js';
import { getEffectiveCursorApiKey } from '../sdk/cursor-api-key.js';
import { loadSettings } from '../persist/settings.js';
import {
  runAgentOneShot,
  runAgentPrintTitle,
  buildTitlePrompt,
  buildTitlePromptWithCallback,
  buildSummaryPromptWithCallback,
} from '../fork-title.js';
import { resolveCompressionSourceText } from '../context-compression-source.js';
import { runMapReduceContextCompression } from '../context-compression-run.js';
import { resolveForkSourceText, MIN_FORK_TEXT_LEN } from '../fork-chat-text.js';
import { updateTodo } from '../persist/todos-persist.js';
import { msg } from '../messages.js';
import {
  executePageCommandForChat,
  getPageSessionForChat,
} from '../page-bridge.js';

const TITLE_FORK_TIMEOUT_MS = 45000;

/**
 * @param {import('express').Response} res
 * @param {Error & { code?: string }} err
 */
function jsonTodosError(res, err) {
  const code = err && err.code;
  if (code === 'NOT_FOUND') {
    return res.status(404).json({ ok: false, error: err.message });
  }
  if (code === 'LIMIT') {
    return res.status(422).json({ ok: false, error: err.message });
  }
  if (code === 'VALIDATION' || code === 'NO_WORKSPACE') {
    return res.status(400).json({ ok: false, error: err.message });
  }
  return res.status(500).json({ ok: false, error: err.message || 'Failed to save Todo' });
}

/**
 * @typedef {Object} ChatAgentRoutesContext
 * @property {string} dataDir
 * @property {string} agentCmd
 * @property {string} agentModel
 * @property {(workspacePath: string|null|undefined) => string} workspaceDirForAgent
 * @property {() => string|null} getCurrentWorkspaceFile
 * @property {() => string} getCurrentCwd
 * @property {() => string} getLocalCallbackBaseUrl
 * @property {boolean} useHttps
 * @property {(req: import('express').Request) => boolean} verifyAgentCallback
 */

/**
 * @param {import('express').Express} app
 * @param {ChatAgentRoutesContext} ctx
 */
export function registerChatAgentRoutes(app, ctx) {
  /** Generate chat title. With chatId = temporary SDK chat + callback to update source. */
  app.post('/api/generate-chat-title', async (req, res) => {
    try {
      const workspaceFile = (req.body && req.body.workspaceFile) || ctx.getCurrentWorkspaceFile();
      const workspaceFolder = (req.body && req.body.workspaceFolder) || null;
      const model = (req.body && req.body.model) || ctx.agentModel || '';
      const text = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim() : '';
      const chatId = req.body && req.body.chatId;
      const agentDir = workspaceFolder || ctx.workspaceDirForAgent(workspaceFile);
      const cliModel = model === 'Auto' ? 'auto' : model;
      if (chatId) {
        if (!getEffectiveCursorApiKey()) {
          return res.status(503).json({
            ok: false,
            error: msg(req, 'chat.tempAgentRequiresApiKey'),
          });
        }
        const sourceText = await resolveForkSourceText(chatId, text);
        if (!sourceText || sourceText.length < MIN_FORK_TEXT_LEN) {
          return res.status(400).json({
            ok: false,
            error: `Not enough chat content (min. ${MIN_FORK_TEXT_LEN} chars). Write something with the agent and try again.`,
          });
        }
        const parentChat = loadChats().find((c) => c.id === chatId);
        const forkWorkspaceFile = parentChat?.workspaceFile || workspaceFile;
        const forkWorkspaceFolder = parentChat?.workspaceFolder ?? workspaceFolder;
        const forkModel = parentChat?.model || cliModel;
        const baseUrl = ctx.getLocalCallbackBaseUrl();
        const textShort =
          sourceText.length > 1200
            ? sourceText.slice(0, 600) + '\n... [truncated] ...\n' + sourceText.slice(-600)
            : sourceText;
        const fullPrompt = buildTitlePromptWithCallback(chatId, textShort, baseUrl, {
          insecureTls: ctx.useHttps,
        });
        const tempChat = createTemporaryForkChat(
          chatId,
          'title',
          forkWorkspaceFile,
          forkWorkspaceFolder,
          forkModel,
        );
        console.log(
          '[generate-chat-title tempChat] parentChatId=%s tempChatId=%s sourceLen=%d promptLen=%d',
          chatId,
          tempChat.id,
          sourceText.length,
          fullPrompt.length,
        );
        return res.json({ ok: true, mode: 'tempChat', tempChat, initialPrompt: fullPrompt });
      }
      if (!text) {
        return res.status(400).json({ ok: false, error: msg(req, 'chat.missingTextField') });
      }
      const settings = loadSettings();
      const useAgentTitlePrint =
        process.env.CURSOR_AGENT_TITLE_PRINT === '1' ||
        process.env.CURSOR_AGENT_TITLE_PRINT === 'true' ||
        settings.agentTitlePrint === true;
      if (useAgentTitlePrint) {
        const textForPrint =
          text.length > 8000 ? text.slice(0, 4000) + '\n... [truncated] ...\n' + text.slice(-600) : text;
        const fullPrompt = buildTitlePrompt(textForPrint);
        const printTitle = runAgentPrintTitle(ctx.agentCmd, agentDir, cliModel, fullPrompt);
        if (printTitle) {
          console.log('[generate-chat-title print] title=%s', printTitle.slice(0, 60));
          return res.json({ ok: true, title: printTitle, mode: 'print' });
        }
      }
      const fullPrompt = buildTitlePrompt(text);
      const result = await runAgentOneShot(ctx.agentCmd, agentDir, cliModel, fullPrompt, TITLE_FORK_TIMEOUT_MS);
      if (result && result.title) {
        return res.json({ ok: true, title: result.title });
      }
      return res.json({ ok: false });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Run map-reduce context compression; fallback = temporary SDK chat + callback. */
  app.post('/api/generate-chat-summary', async (req, res) => {
    try {
      const workspaceFile = (req.body && req.body.workspaceFile) || ctx.getCurrentWorkspaceFile();
      const workspaceFolder = (req.body && req.body.workspaceFolder) || null;
      const model = (req.body && req.body.model) || ctx.agentModel || '';
      const text = typeof (req.body && req.body.text) === 'string' ? req.body.text.trim() : '';
      const chatId = req.body && req.body.chatId;
      if (!chatId) {
        return res.status(400).json({ ok: false, error: msg(req, 'chat.missingChatId') });
      }
      const sourceText = await resolveCompressionSourceText(chatId, text);
      if (!sourceText || sourceText.length < MIN_FORK_TEXT_LEN) {
        return res.status(400).json({
          ok: false,
          error: `Not enough chat content (min. ${MIN_FORK_TEXT_LEN} chars). Write something with the agent and try again.`,
        });
      }
      const parentChat = loadChats().find((c) => c.id === chatId);
      const forkWorkspaceFile = parentChat?.workspaceFile || workspaceFile;
      const forkWorkspaceFolder = parentChat?.workspaceFolder ?? workspaceFolder;
      const agentDir = forkWorkspaceFolder || ctx.workspaceDirForAgent(forkWorkspaceFile);
      const cliModel = model === 'Auto' ? 'auto' : model;
      const forkModel = parentChat?.model || cliModel;
      const printResult = runMapReduceContextCompression({
        sourceText,
        existingSummaries: Array.isArray(parentChat?.summaries) ? parentChat.summaries : [],
        agentCmd: ctx.agentCmd,
        agentDir,
        model: forkModel,
      });
      if (printResult?.summary) {
        const updates = {
          summary: printResult.summary,
          summaryTitle: printResult.title || '',
        };
        if (printResult.title) updates.title = printResult.title;
        const chat = updateChat(chatId, updates);
        if (!chat) return res.status(404).json({ ok: false, error: msg(req, 'chat.notFound') });
        console.log(
          '[generate-chat-summary print] chatId=%s sourceLen=%d summaryLen=%d title=%s',
          chatId,
          sourceText.length,
          printResult.summary.length,
          (printResult.title || '').slice(0, 60),
        );
        return res.json({
          ok: true,
          mode: 'print',
          summary: printResult.summary,
          title: printResult.title || '',
          chat,
          sourceLen: sourceText.length,
        });
      }
      console.warn(
        '[generate-chat-summary print] failed chatId=%s agentCmd=%s sourceLen=%d — falling back to tempChat',
        chatId,
        ctx.agentCmd,
        sourceText.length,
      );
      if (!getEffectiveCursorApiKey()) {
        return res.status(503).json({
          ok: false,
          error: msg(req, 'chat.tempAgentRequiresApiKey'),
        });
      }
      const baseUrl = ctx.getLocalCallbackBaseUrl();
      const fallbackText = await resolveForkSourceText(chatId, sourceText);
      const fullPrompt = buildSummaryPromptWithCallback(chatId, fallbackText, baseUrl, {
        insecureTls: ctx.useHttps,
      });
      const tempChat = createTemporaryForkChat(
        chatId,
        'summary',
        forkWorkspaceFile,
        forkWorkspaceFolder,
        forkModel,
      );
      console.log(
        '[generate-chat-summary tempChat] parentChatId=%s tempChatId=%s sourceLen=%d promptLen=%d',
        chatId,
        tempChat.id,
        sourceText.length,
        fullPrompt.length,
      );
      return res.json({ ok: true, mode: 'tempChat', tempChat, initialPrompt: fullPrompt });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Agent callback: update Todo linked to chat. Body: { todoId, chatId?, title?, body?, status?, plan?, appendChangelog? }. */
  app.post('/api/set-todo-from-agent', (req, res) => {
    try {
      if (!ctx.verifyAgentCallback(req)) {
        return res.status(401).json({ ok: false, error: msg(req, 'callback.invalidToken') });
      }
      const todoId = req.body && req.body.todoId;
      const chatId = req.body && req.body.chatId;
      if (!todoId) {
        return res.status(400).json({ ok: false, error: msg(req, 'callback.requiredTodoId') });
      }
      const patch = {};
      if (typeof (req.body && req.body.title) === 'string' && req.body.title.trim()) {
        patch.title = req.body.title.trim();
      }
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'body')) {
        patch.body = req.body.body;
      }
      if (typeof (req.body && req.body.status) === 'string' && req.body.status.trim()) {
        patch.status = req.body.status.trim();
      }
      if (chatId) {
        patch.chatId = chatId;
        patch.linkedChatId = chatId;
      }
      if (req.body?.plan && typeof req.body.plan === 'object') {
        patch.plan = req.body.plan;
      }
      if (req.body?.appendChangelog && typeof req.body.appendChangelog === 'object') {
        patch.appendChangelog = req.body.appendChangelog;
      }
      if (!Object.keys(patch).length) {
        return res.status(400).json({ ok: false, error: msg(req, 'callback.noFieldsToUpdate') });
      }
      const cwd = ctx.getCurrentCwd();
      const data = updateTodo(ctx.dataDir, cwd, String(todoId), patch);
      const todo = data.items.find((it) => it.id === String(todoId)) || null;
      console.log('[set-todo-from-agent] todoId=%s status=%s', todoId, todo?.status || '');
      return res.json({ ok: true, todo, items: data.items });
    } catch (err) {
      return jsonTodosError(res, err);
    }
  });

  /** Agent tool: pin chat to host page URL. Body: { chatId?, cursorSessionId?, url, navigate? }. */
  app.post('/api/set-chat-pinned-url-from-agent', async (req, res) => {
    try {
      if (!ctx.verifyAgentCallback(req)) {
        return res.status(401).json({ ok: false, error: msg(req, 'callback.invalidToken') });
      }
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!url) {
        return res.status(400).json({ ok: false, error: 'url is required' });
      }
      const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId.trim() : '';
      const cursorSessionId = typeof req.body?.cursorSessionId === 'string'
        ? req.body.cursorSessionId.trim()
        : '';
      let chat = null;
      if (chatId) {
        chat = loadChats().find((item) => item.id === chatId) || null;
      } else if (cursorSessionId) {
        chat = getChatByCursorSessionId(cursorSessionId);
      }
      if (!chat) {
        return res.status(404).json({ ok: false, error: msg(req, 'chat.notFound') });
      }
      const updated = updateChat(chat.id, { widgetPinnedUrl: url });
      const shouldNavigate = req.body?.navigate !== false;
      const sessionKey = typeof updated?.cursorSessionId === 'string'
        ? updated.cursorSessionId.trim()
        : '';
      const pageBound = sessionKey ? Boolean(getPageSessionForChat(sessionKey)) : false;
      let navigated = false;
      let navigateError = '';
      if (shouldNavigate && sessionKey && pageBound) {
        try {
          await executePageCommandForChat(sessionKey, 'navigate', { url });
          navigated = true;
        } catch (error) {
          navigateError = error instanceof Error ? error.message : String(error);
        }
      }
      console.log(
        '[set-chat-pinned-url-from-agent] chatId=%s url=%s pageBound=%s navigated=%s',
        chat.id,
        url.slice(0, 120),
        pageBound,
        navigated,
      );
      return res.json({
        ok: true,
        chat: updated || chat,
        pageBound,
        navigated,
        navigateError: navigateError || undefined,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Agent tool: set chat title by id. Body: { chatId, title }. */
  app.post('/api/set-chat-title-from-agent', (req, res) => {
    try {
      if (!ctx.verifyAgentCallback(req)) {
        return res.status(401).json({ ok: false, error: msg(req, 'callback.invalidToken') });
      }
      const chatId = req.body && req.body.chatId;
      const title = typeof (req.body && req.body.title) === 'string' ? req.body.title.trim() : '';
      if (!chatId || !title) {
        return res.status(400).json({ ok: false, error: msg(req, 'callback.requiredChatIdTitle') });
      }
      const chat = updateChat(chatId, { title });
      if (!chat) return res.status(404).json({ ok: false, error: msg(req, 'chat.notFound') });
      const removedTemp = deleteTemporaryForkChats(chatId, 'title');
      for (const temp of removedTemp) {
        if (temp?.cursorSessionId) disposeSdkRoom(temp.cursorSessionId);
      }
      console.log('[set-chat-title-from-agent] chatId=%s title=%s removedTemp=%d', chatId, title.slice(0, 80), removedTemp.length);
      res.json({ ok: true, chat, removedTempChatIds: removedTemp.map((c) => c.id) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Agent callback: save batch summary + optional new source chat title. */
  app.post('/api/set-chat-summary-from-agent', (req, res) => {
    try {
      if (!ctx.verifyAgentCallback(req)) {
        return res.status(401).json({ ok: false, error: msg(req, 'callback.invalidToken') });
      }
      const chatId = req.body && req.body.chatId;
      const summary = typeof (req.body && req.body.summary) === 'string' ? req.body.summary.trim() : '';
      const title = typeof (req.body && req.body.title) === 'string' ? req.body.title.trim() : '';
      if (!chatId) {
        return res.status(400).json({ ok: false, error: msg(req, 'callback.requiredChatId') });
      }
      if (!summary && !title) {
        return res.status(400).json({ ok: false, error: msg(req, 'callback.requiredSummaryOrTitle') });
      }
      const updates = {};
      if (title) updates.title = title;
      if (summary) {
        updates.summary = summary;
        updates.summaryTitle = title || '';
      }
      const chat = updateChat(chatId, updates);
      if (!chat) return res.status(404).json({ ok: false, error: msg(req, 'chat.notFound') });
      const removedTemp = deleteTemporaryForkChats(chatId, 'summary');
      for (const temp of removedTemp) {
        if (temp?.cursorSessionId) disposeSdkRoom(temp.cursorSessionId);
      }
      console.log(
        '[set-chat-summary-from-agent] chatId=%s removedTemp=%d',
        chatId,
        removedTemp.length,
      );
      return res.json({ ok: true, chat, removedTempChatIds: removedTemp.map((c) => c.id) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
