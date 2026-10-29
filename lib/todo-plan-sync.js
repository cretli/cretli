/**
 * Sync SDK plan / implementation summaries into linked Todo items.
 */

import { pickRicherPlanMarkdown, readChatPlanFile, stripChatPlanComment, writeChatPlanFile } from './chat-plan-persist.js';
import { getChatAgentTransport } from './agent-transport.js';
import { loadChats, updateChat } from './persist/chats-persist.js';
import { buildChangelogExcerpt, stripTitleJsonTrailer } from './todo-changelog-text.js';
import { loadChatHistory } from './persist/chat-history-service.js';
import {
  createRunAssistantStreamCapture,
  extractLatestPlanMarkdownFromEvents,
  noteRunAssistantStreamEvent,
  readRunAssistantStreamCombinedText,
  resetRunAssistantStreamCapture,
} from './sdk/sdk-plan-text.ts';
import { isSdkRunFailureStatus } from './sdk/sdk-run-outcome.ts';
import { addTodo, getTodo as getTodoById, listTodos as loadTodosData, updateTodo } from './persist/todos-store.js';
import { syncTodoReviewTarget } from './todo-review-sync-hooks.js';
import { stalePlanReviewerSessionsForTodoPlanChange } from './plan-reviewer-cooperation-service.js';

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
 * @param {{ events?: unknown[] } | null | undefined} store
 * @returns {string}
 */
export function extractLatestAssistantTextFromHistoryStore(store) {
  if (!store?.events?.length) return '';
  const sorted = [.../** @type {any[]} */ (store.events)].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  const turnCapture = createRunAssistantStreamCapture();
  let lastAssistantTurn = '';
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (rec);
    if (record.kind === 'localUser') {
      lastAssistantTurn = readRunAssistantStreamCombinedText(turnCapture) || lastAssistantTurn;
      resetRunAssistantStreamCapture(turnCapture);
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    const event = /** @type {Record<string, unknown>} */ (record.event);
    if (event.type === 'user') {
      lastAssistantTurn = readRunAssistantStreamCombinedText(turnCapture) || lastAssistantTurn;
      resetRunAssistantStreamCapture(turnCapture);
      continue;
    }
    noteRunAssistantStreamEvent(turnCapture, event);
    lastAssistantTurn = readRunAssistantStreamCombinedText(turnCapture) || lastAssistantTurn;
  }
  return readRunAssistantStreamCombinedText(turnCapture) || lastAssistantTurn;
}

/**
 * Wait until the room's buffered history records are acknowledged by the history adapter. Never throws: a flush that
 * cannot commit leaves the records retained in the room and the caller reads whatever is stored.
 *
 * @param {any} room
 * @returns {Promise<{ ok: boolean, pending?: number } | undefined>} the flush outcome; `ok: false` means not durable yet
 */
export async function awaitRoomHistoryCommit(room) {
  if (typeof room?._flushHistory !== 'function') return undefined;
  try {
    return await room._flushHistory();
  } catch {
    // flush outcomes never reject; this only guards a foreign implementation
    return { ok: false };
  }
}

/**
 * @param {string} chatId
 * @returns {Promise<string>}
 */
export async function extractLatestAssistantTextFromChatHistory(chatId) {
  const normalizedChatId = normalizeTrimmedString(chatId);
  if (!normalizedChatId) return '';
  const store = await loadChatHistory(normalizedChatId);
  return extractLatestAssistantTextFromHistoryStore(store);
}

/**
 * @param {string} chatId
 * @returns {Promise<string>}
 */
export async function extractLatestPlanMarkdownFromChatHistory(chatId) {
  const normalizedChatId = normalizeTrimmedString(chatId);
  if (!normalizedChatId) return '';
  const store = await loadChatHistory(normalizedChatId);
  return extractLatestPlanMarkdownFromEvents(store?.events);
}

/**
 * @param {any} room
 * @returns {Promise<string>}
 */
export async function readCurrentRunAssistantText(room) {
  const fromRoom = normalizeTrimmedString(room?._currentRunAssistantText);
  const chatId = normalizeTrimmedString(room?.chatId);
  const fromHistory = chatId ? await extractLatestAssistantTextFromChatHistory(chatId) : '';
  return pickRicherPlanMarkdown(fromRoom, fromHistory);
}

/**
 * @param {any} room
 * @returns {Promise<string>}
 */
export async function readCurrentRunPlanMarkdown(room) {
  const fromRoomPlan = normalizeTrimmedString(room?._currentRunPlanMarkdown);
  const fromAssistant = await readCurrentRunAssistantText(room);
  const chatId = normalizeTrimmedString(room?.chatId);
  const fromHistory = chatId ? await extractLatestPlanMarkdownFromChatHistory(chatId) : '';
  return pickRicherPlanMarkdown(pickRicherPlanMarkdown(fromRoomPlan, fromAssistant), fromHistory);
}

/**
 * @param {any} room
 * @returns {Promise<string>}
 */
async function buildImplementationSummaryFromRoom(room) {
  const assistantText = truncateText(await readCurrentRunAssistantText(room), 1500);
  if (assistantText) return assistantText;
  const chatId = normalizeTrimmedString(room?.chatId);
  if (!chatId) return '';
  return truncateText(await extractLatestAssistantTextFromChatHistory(chatId), 1500);
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
export async function persistTodoPlan(input) {
  const planMarkdown = truncateText(
    stripChatPlanComment(stripTitleJsonTrailer(input.planMarkdown)),
    TODO_PLAN_MAX_MARKDOWN_LEN
  );
  if (!planMarkdown) return null;
  /** @type {any} */
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
  const todo = await getTodoById(input.dataDir, input.cwd, input.todoId);
  if (!todo) return null;
  if (input.promoteStatus && (todo.status === 'idea' || todo.status === 'ready')) {
    patch.status = input.approvedAt ? 'doing' : 'ready';
  }
  patch.expectedUpdatedAt = todo.updatedAt;
  const updated = await updateTodo(input.dataDir, input.cwd, input.todoId, patch);
  if (updated) {
    try {
      stalePlanReviewerSessionsForTodoPlanChange({
        dataDir: input.dataDir,
        workspaceFolder: input.cwd,
        todoId: input.todoId,
      });
    } catch {
      // Plan persist must succeed even if cooperation session stale marking fails.
    }
    await syncTodoReviewTarget({ todoId: input.todoId, workspaceFolder: input.cwd, dataDir: input.dataDir }, { source: 'plan-sync' });
  }
  return updated ? await loadTodosData(input.dataDir, input.cwd) : updated;
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
export async function persistTodoImplementationSummary(input) {
  const summaryText = buildChangelogExcerpt(input.summaryText, TODO_CHANGELOG_MAX_TEXT_LEN);
  if (!summaryText) return null;
  /** @type {any} */
  const patch = {
    appendChangelog: {
      kind: 'implement',
      text: summaryText,
      chatId: input.chatId,
    },
    linkedChatId: input.chatId,
  };
  if (input.markDone) patch.status = 'done';
  const todo = await getTodoById(input.dataDir, input.cwd, input.todoId);
  if (!todo) return null;
  patch.expectedUpdatedAt = todo.updatedAt;
  return await updateTodo(input.dataDir, input.cwd, input.todoId, patch);
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
 * @returns {Promise<string>}
 */
export async function ensureLinkedTodoForPlan(input) {
  const dataDir = normalizeTrimmedString(input.dataDir);
  const cwd = normalizeTrimmedString(input.cwd);
  const chatId = normalizeTrimmedString(input.chatId);
  if (!dataDir || !cwd || !chatId) return '';
  const chat = /** @type {any} */ (loadChats().find((entry) => entry.id === chatId) || null);
  const existingTodoId = normalizeTrimmedString(chat?.todoId);
  if (existingTodoId && await getTodoById(dataDir, cwd, existingTodoId)) return existingTodoId;
  const title = normalizeTrimmedString(input.title || chat?.title) || 'Chat plan';
  // Use the item returned by addTodo — items[0] is not guaranteed to be the
  // freshly created todo (replays and tree ordering break that assumption).
  const created = await addTodo(dataDir, cwd, { title, status: 'ready', idempotencyKey: `chat-plan:${chatId}` });
  const todoId = normalizeTrimmedString(created?.item?.id);
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
 * @returns {Promise<boolean>}
 */
export async function syncTodoAfterSdkRunFinished(input) {
  // The room keeps running (a new prompt resets its plan capture): work on the state of the moment the run finished.
  const snapshot = input.room && typeof input.room === 'object' ? { ...input.room } : input.room;
  const flushRoom = input.room;
  // The plan and the summary are read back from the history store: wait for the run's records to be durable first.
  const committed = await awaitRoomHistoryCommit(flushRoom);
  // Records not durable yet: the stored transcript is incomplete, so do not derive plan/done state from it.
  if (committed && committed.ok === false) return false;
  const dataDir = normalizeTrimmedString(input.dataDir);
  const chatId = normalizeTrimmedString(input.chatId || snapshot?.chatId);
  const cwd = normalizeTrimmedString(snapshot?.cwd);
  if (!chatId || !cwd) return false;
  const chat = /** @type {any} */ (loadChats().find((entry) => entry.id === chatId) || null);
  const sdkMode = normalizeTrimmedString(input.sdkMode || snapshot?.sdkMode).toLowerCase();
  const status = normalizeTrimmedString(input.status);
  if (sdkMode === 'plan') {
    const fromFile = stripTitleJsonTrailer(readChatPlanFile({ cwd, chatId }));
    const fromRun = stripTitleJsonTrailer(await readCurrentRunPlanMarkdown(snapshot));
    const planMarkdown = pickRicherPlanMarkdown(fromFile, fromRun);
    if (!planMarkdown) return false;
    writeChatPlanFile({
      cwd,
      chatId,
      title: chat?.title || snapshot?.chatTitle || 'Chat plan',
      markdown: planMarkdown,
      sourceTurnId: String(snapshot?._planCaptureTurnId || '').trim(),
      runStatus: status,
    });
    if (!dataDir) return true;
    const todoId = await ensureLinkedTodoForPlan({
      dataDir,
      cwd,
      chatId,
      title: chat?.title || snapshot?.chatTitle || 'Chat plan',
    });
    if (!todoId) return true;
    await persistTodoPlan({
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
  const summaryText = await buildImplementationSummaryFromRoom(snapshot);
  if (!summaryText) return false;
  await persistTodoImplementationSummary({
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
 *   chat: { id?: string, todoId?: string, title?: string },
 *   approvedAt?: string|null,
 * }} input
 * @returns {Promise<boolean>}
 */
export async function exportTodoPlanFromChat(input) {
  const chatId = normalizeTrimmedString(input.chat?.id);
  const todoId = normalizeTrimmedString(input.chat?.todoId);
  const cwd = normalizeTrimmedString(input.cwd);
  const dataDir = normalizeTrimmedString(input.dataDir);
  if (!chatId || !todoId || !cwd || !dataDir) return false;
  const planMarkdown = await extractLatestAssistantTextFromChatHistory(chatId);
  if (!planMarkdown) return false;
  writeChatPlanFile(/** @type {any} */ ({
    cwd,
    chatId,
    title: input.chat?.title || 'Chat plan',
    markdown: planMarkdown,
    force: true,
  }));
  await persistTodoPlan({
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
