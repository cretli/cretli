/**
 * Sync SDK plan / implementation summaries into linked Todo items.
 */

import { pickRicherPlanMarkdown, readChatPlanFile, stripChatPlanComment, writeChatPlanFile } from './chat-plan-persist.js';
import { getChatAgentTransport } from './agent-transport.js';
import { loadChats, updateChat } from './persist/chats-persist.js';
import { buildChangelogExcerpt, stripTitleJsonTrailer } from './todo-changelog-text.js';
import { loadChatHistory } from './persist/chat-history-persist.js';
import { extractAssistantPlainText } from './context-compression.js';
import {
  accumulateStreamText,
  extractLatestPlanMarkdownFromEvents,
} from './sdk/sdk-plan-text.js';
import { isSdkRunFailureStatus } from './sdk/sdk-run-outcome.js';
import { addTodo, getTodoById, loadTodosData, updateTodo } from './persist/todos-persist.js';

export const TODO_PLAN_MAX_MARKDOWN_LEN = 32000;
export const TODO_CHANGELOG_MAX_ENTRIES = 100;
export const TODO_CHANGELOG_MAX_TEXT_LEN = 4000;

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTrimmedString(value) {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * @param {unknown} value
 * @param {number} maxLen
 * @returns {string}
 */
function truncateText(value, maxLen) {
  const text = normalizeTrimmedString(value);
  if (!text || text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function extractLatestAssistantTextFromChatHistory(chatId) {
  const normalizedChatId = normalizeTrimmedString(chatId);
  if (!normalizedChatId) return '';
  const store = loadChatHistory(normalizedChatId);
  if (!store?.events?.length) return '';
  const sorted = [...store.events].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  let lastAssistantTurn = '';
  let currentAssistant = '';
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (rec);
    if (record.kind === 'localUser') {
      currentAssistant = '';
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    const event = /** @type {Record<string, unknown>} */ (record.event);
    if (event.type === 'user') {
      currentAssistant = '';
      continue;
    }
    if (event.type !== 'assistant') continue;
    const assistantText = extractAssistantPlainText(event).trim();
    if (!assistantText) continue;
    currentAssistant = accumulateStreamText(currentAssistant, assistantText);
    lastAssistantTurn = currentAssistant;
  }
  return lastAssistantTurn;
}

/**
 * @param {string} chatId
 * @returns {string}
 */
export function extractLatestPlanMarkdownFromChatHistory(chatId) {
  const normalizedChatId = normalizeTrimmedString(chatId);
  if (!normalizedChatId) return '';
  const store = loadChatHistory(normalizedChatId);
  return extractLatestPlanMarkdownFromEvents(store?.events);
}

/**
 * @param {any} room
 * @returns {string}
 */
export function readCurrentRunAssistantText(room) {
  const fromRoom = normalizeTrimmedString(room?._currentRunAssistantText);
  const chatId = normalizeTrimmedString(room?.chatId);
  const fromHistory = chatId ? extractLatestAssistantTextFromChatHistory(chatId) : '';
  return pickRicherPlanMarkdown(fromRoom, fromHistory);
}

/**
 * @param {any} room
 * @returns {string}
 */
export function readCurrentRunPlanMarkdown(room) {
  const fromRoomPlan = normalizeTrimmedString(room?._currentRunPlanMarkdown);
  const fromAssistant = readCurrentRunAssistantText(room);
  const chatId = normalizeTrimmedString(room?.chatId);
  const fromHistory = chatId ? extractLatestPlanMarkdownFromChatHistory(chatId) : '';
  return pickRicherPlanMarkdown(pickRicherPlanMarkdown(fromRoomPlan, fromAssistant), fromHistory);
}

/**
 * @param {any} room
 * @returns {string}
 */
function buildImplementationSummaryFromRoom(room) {
  const assistantText = truncateText(readCurrentRunAssistantText(room), 1500);
  if (assistantText) return assistantText;
  const chatId = normalizeTrimmedString(room?.chatId);
  if (!chatId) return '';
  return truncateText(extractLatestAssistantTextFromChatHistory(chatId), 1500);
}

/**
 * @param {{
 *   dataDir: string,
 *   cwd: string,
 *   todoId: string,
 *   chatId: string,
 *   planMarkdown: string,
 *   approvedAt?: string|null,
 *   promoteStatus?: boolean,
 *   sourceHarness?: string,
 * }} input
 */
export function persistTodoPlan(input) {
  const planMarkdown = truncateText(
    stripChatPlanComment(stripTitleJsonTrailer(input.planMarkdown)),
    TODO_PLAN_MAX_MARKDOWN_LEN
  );
  if (!planMarkdown) return null;
  const patch = {
    plan: {
      markdown: planMarkdown,
      sourceChatId: input.chatId,
      updatedAt: new Date().toISOString(),
    },
    appendChangelog: {
      kind: 'plan',
      text: buildChangelogExcerpt(planMarkdown),
      chatId: input.chatId,
    },
    linkedChatId: input.chatId,
  };
  if (input.sourceHarness) patch.sourceHarness = input.sourceHarness;
  if (input.approvedAt) {
    patch.plan.approvedAt = input.approvedAt;
  }
  const todo = getTodoById(input.dataDir, input.cwd, input.todoId);
  if (!todo) return null;
  if (input.promoteStatus && (todo.status === 'idea' || todo.status === 'ready')) {
    patch.status = input.approvedAt ? 'doing' : 'ready';
  }
  return updateTodo(input.dataDir, input.cwd, input.todoId, patch);
}

/**
 * @param {{
 *   dataDir: string,
 *   cwd: string,
 *   todoId: string,
 *   chatId: string,
 *   summaryText: string,
 *   markDone?: boolean,
 * }} input
 */
export function persistTodoImplementationSummary(input) {
  const summaryText = buildChangelogExcerpt(input.summaryText, TODO_CHANGELOG_MAX_TEXT_LEN);
  if (!summaryText) return null;
  const patch = {
    appendChangelog: {
      kind: 'implement',
      text: summaryText,
      chatId: input.chatId,
    },
    linkedChatId: input.chatId,
  };
  if (input.markDone) patch.status = 'done';
  return updateTodo(input.dataDir, input.cwd, input.todoId, patch);
}

/**
 * Creates a Todo for a Plan-mode chat when none is linked yet.
 *
 * @param {{
 *   dataDir: string,
 *   cwd: string,
 *   chatId: string,
 *   title?: string,
 * }} input
 * @returns {string}
 */
export function ensureLinkedTodoForPlan(input) {
  const dataDir = normalizeTrimmedString(input.dataDir);
  const cwd = normalizeTrimmedString(input.cwd);
  const chatId = normalizeTrimmedString(input.chatId);
  if (!dataDir || !cwd || !chatId) return '';
  const chat = loadChats().find((entry) => entry.id === chatId) || null;
  const existingTodoId = normalizeTrimmedString(chat?.todoId);
  if (existingTodoId && getTodoById(dataDir, cwd, existingTodoId)) return existingTodoId;
  const title = normalizeTrimmedString(input.title || chat?.title) || 'Chat plan';
  addTodo(dataDir, cwd, { title, status: 'ready' });
  const created = loadTodosData(dataDir, cwd).items[0];
  const todoId = normalizeTrimmedString(created?.id);
  if (!todoId) return '';
  updateChat(chatId, { todoId });
  return todoId;
}

/**
 * @param {{
 *   dataDir: string,
 *   room?: any,
 *   chatId?: string,
 *   sessionKey?: string,
 *   status?: string,
 *   sdkMode?: string,
 *   approvedAt?: string|null,
 *   markImplementationDone?: boolean,
 * }} input
 * @returns {boolean}
 */
export function syncTodoAfterSdkRunFinished(input) {
  const dataDir = normalizeTrimmedString(input.dataDir);
  const chatId = normalizeTrimmedString(input.chatId || input.room?.chatId);
  const cwd = normalizeTrimmedString(input.room?.cwd);
  if (!chatId || !cwd) return false;
  const chat = loadChats().find((entry) => entry.id === chatId) || null;
  const sdkMode = normalizeTrimmedString(input.sdkMode || input.room?.sdkMode).toLowerCase();
  const status = normalizeTrimmedString(input.status);
  if (sdkMode === 'plan') {
    const fromFile = stripTitleJsonTrailer(readChatPlanFile({ cwd, chatId }));
    const fromRun = stripTitleJsonTrailer(readCurrentRunPlanMarkdown(input.room));
    const planMarkdown = pickRicherPlanMarkdown(fromFile, fromRun);
    if (!planMarkdown) return false;
    writeChatPlanFile({
      cwd,
      chatId,
      title: chat?.title || input.room?.chatTitle || 'Chat plan',
      markdown: planMarkdown,
    });
    if (!dataDir) return true;
    const todoId = ensureLinkedTodoForPlan({
      dataDir,
      cwd,
      chatId,
      title: chat?.title || input.room?.chatTitle || 'Chat plan',
    });
    if (!todoId) return true;
    persistTodoPlan({
      dataDir,
      cwd,
      todoId,
      chatId,
      planMarkdown,
      approvedAt: input.approvedAt || null,
      promoteStatus: true,
      sourceHarness: getChatAgentTransport(chat),
    });
    return true;
  }
  if (!dataDir) return false;
  const todoId = normalizeTrimmedString(chat?.todoId);
  if (!todoId) return false;
  if (sdkMode !== 'agent') return false;
  if (isSdkRunFailureStatus(status)) return false;
  const summaryText = buildImplementationSummaryFromRoom(input.room);
  if (!summaryText) return false;
  persistTodoImplementationSummary({
    dataDir,
    cwd,
    todoId,
    chatId,
    summaryText,
    markDone: input.markImplementationDone === true,
  });
  return true;
}

/**
 * @param {{
 *   dataDir: string,
 *   cwd: string,
 *   chat: { id?: string, todoId?: string },
 *   approvedAt?: string|null,
 * }} input
 * @returns {boolean}
 */
export function exportTodoPlanFromChat(input) {
  const chatId = normalizeTrimmedString(input.chat?.id);
  const todoId = normalizeTrimmedString(input.chat?.todoId);
  const cwd = normalizeTrimmedString(input.cwd);
  const dataDir = normalizeTrimmedString(input.dataDir);
  if (!chatId || !todoId || !cwd || !dataDir) return false;
  const planMarkdown = extractLatestAssistantTextFromChatHistory(chatId);
  if (!planMarkdown) return false;
  writeChatPlanFile({
    cwd,
    chatId,
    title: input.chat?.title || 'Chat plan',
    markdown: planMarkdown,
  });
  persistTodoPlan({
    dataDir,
    cwd,
    todoId,
    chatId,
    planMarkdown,
    approvedAt: input.approvedAt || null,
    promoteStatus: true,
  });
  return true;
}
